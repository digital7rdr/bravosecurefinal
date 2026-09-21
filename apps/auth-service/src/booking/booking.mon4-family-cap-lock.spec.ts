import {readFileSync} from 'fs';
import {join} from 'path';
import {BadRequestException} from '@nestjs/common';
import {BookingService} from './booking.service';
import type {DatabaseService} from '../database/database.service';
import type {PricingService} from './pricing.service';
import type {ConfigService} from '@nestjs/config';

/**
 * MON-4 — family spend-cap TOCTOU. resolvePayer reads `spent_credits` off a
 * SEPARATE, unlocked connection (it also serves pre-flight soft checks), so two
 * concurrent charges for the SAME member both read a stale under-cap total and
 * both pass — breaching the cap (no overdraft; the real balance still gates).
 *
 * The fix: at the authoritative charge site, re-read the member row FOR UPDATE
 * inside the charge txn. That serializes concurrent charges — the second blocks
 * until the first commits its spent_credits bump, then reads the fresh total and
 * correctly trips the cap. These tests pin: (1) behaviourally, that the LOCKED
 * value (not resolvePayer's stale one) is the authoritative gate in the legacy
 * payWithCredits path; (2) by source scan, that both charge sites lock the row.
 */
function fullBookingRow(over: Record<string, unknown> = {}) {
  return {
    id: 'bk1', client_id: 'c1', status: 'OPS_APPROVED', dispatch_mode: null,
    region_code: 'AE', region_label: 'Dubai', service: 'secure_transfer',
    booking_mode: 'now', pickup_address: 'X', pickup_lat: 25, pickup_lng: 55,
    dropoff_address: null, dropoff_lat: null, dropoff_lng: null,
    pickup_time: new Date(), passengers: 1, cpo_count: 1, vehicle_count: 1,
    driver_only: false, add_ons: [], total_eur: 50, duration_hours: 4,
    total_aed: 184, conversation_id: null, created_at: new Date(),
    payer_user_id: null, payment_captured: false, confirmed_at: null,
    ...over,
  };
}

/**
 * resolvePayer returns a STALE, under-cap spend (0 of 100, cost 50 → passes the
 * cheap early-out). `lockedSpent` is what the in-txn FOR UPDATE read returns —
 * the value that must actually decide.
 */
function mkPay(lockedSpent: number, cap: number | null = 100) {
  const dbQOne = jest.fn().mockImplementation((sql: string) => {
    if (/FROM lite_bookings WHERE id = \$1 AND client_id = \$2 FOR UPDATE/.test(sql)) {
      return Promise.resolve(fullBookingRow());
    }
    if (/FROM public\.family_members\s+WHERE id = \$1 FOR UPDATE/.test(sql)) {
      return Promise.resolve({spent_credits: lockedSpent, spend_limit_credits: cap});
    }
    if (/FROM wallet_balances WHERE user_id = \$1 FOR UPDATE/.test(sql)) {
      return Promise.resolve({bravo_credits: 10_000, currency: 'AED'});
    }
    if (/UPDATE lite_bookings[\s\S]*RETURNING \*/.test(sql)) {
      return Promise.resolve(fullBookingRow({status: 'CONFIRMED', payment_captured: true, payer_user_id: 'holder1'}));
    }
    return Promise.resolve(null);
  });
  const tx = {q: jest.fn().mockResolvedValue([]), qOne: dbQOne};
  const db = {
    qOne: dbQOne, q: jest.fn().mockResolvedValue([]),
    withTransaction: (fn: (t: unknown) => unknown) => fn(tx),
  } as unknown as DatabaseService;
  const pricing = {calculate: jest.fn()} as unknown as PricingService;
  // Stale under-cap read — the bug would let this decide.
  // B-843: the booking fixture carries NO stamped payer, so payWithCredits falls
  // through to `resolvePayer(client, null)` exactly as it did before.
  const family = {
    resolvePayer: jest.fn().mockResolvedValue({
      payerId: 'holder1', familyRowId: 'fr1', spendLimit: cap, spent: 0,
      holderSuspended: false, holderId: 'holder1', holderName: 'Root A',
    }),
    payerOptions: jest.fn().mockResolvedValue([]),
    notifyUsageThreshold: jest.fn().mockResolvedValue(undefined),
  };
  const svc = new BookingService(
    db, pricing, {assert: jest.fn()} as never, {} as never, {} as never,
    {} as never, family as never, {} as never, {get: () => undefined} as unknown as ConfigService,
  );
  // Silence the best-effort audit rows (they run outside the txn on success).
  (svc as unknown as {audit: jest.Mock}).audit = jest.fn().mockResolvedValue(undefined);
  return {svc, tx};
}

describe('MON-4 — family cap is gated on the FOR UPDATE-locked member row, not the stale read', () => {
  it('trips the cap from the LOCKED spent even though resolvePayer reported under-cap', async () => {
    // Locked spend 80 + cost 50 = 130 > cap 100. resolvePayer said spent=0 (stale),
    // so the ONLY thing that can reject here is the in-txn locked re-read. Revert
    // the FOR UPDATE gate and this call debits — the mutation this test proves dead.
    const {svc, tx} = mkPay(80);
    await expect(svc.payWithCredits('c1', 'bk1'))
      .rejects.toMatchObject({message: 'family_spend_limit_exceeded'});
    // Never reached the wallet debit.
    expect(tx.q).not.toHaveBeenCalledWith(
      expect.stringContaining('UPDATE wallet_balances SET bravo_credits = bravo_credits - $1'),
      expect.anything(),
    );
  });

  it('proceeds when the LOCKED spend is under the cap (positive control)', async () => {
    // Locked spend 10 + cost 50 = 60 <= 100 → charge proceeds to the debit.
    const {svc, tx} = mkPay(10);
    await expect(svc.payWithCredits('c1', 'bk1')).resolves.toBeDefined();
    expect(tx.q).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE wallet_balances SET bravo_credits = bravo_credits - $1'),
      [50, 'holder1'],
    );
  });

  it('rejects on an unknown/absent locked row when a cap is claimed by resolvePayer', async () => {
    // Belt-and-braces: a null locked row means spent defaults to 0, so an under-cap
    // cost still proceeds — but the locked read is the gate that runs regardless.
    const {svc} = mkPay(200);
    await expect(svc.payWithCredits('c1', 'bk1'))
      .rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('MON-4 — both authoritative charge sites lock the member row (source scan)', () => {
  const strip = (s: string) => s.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

  it('the legacy payWithCredits cap re-read uses FOR UPDATE', () => {
    const src = strip(readFileSync(join(__dirname, 'booking.service.ts'), 'utf8'));
    expect(src).toMatch(/spent_credits, spend_limit_credits FROM public\.family_members\s+WHERE id = \$1 FOR UPDATE/);
  });

  it('the escrow-accept cap read (dispatch) uses FOR UPDATE', () => {
    const src = strip(readFileSync(join(__dirname, '..', 'dispatch', 'dispatch.service.ts'), 'utf8'));
    // The member row read that feeds the overCap gate at accept time.
    //
    // RE-POINTED, not relaxed. Spec §21 added `JOIN public.users h` to the same
    // statement so the holder's suspension is read under the same lock, which
    // aliased the columns (`fm.spend_limit_credits`) and turned the lock clause
    // into `FOR UPDATE OF fm`. The invariant is unchanged and still fails if the
    // lock is dropped: the cap must be read from a LOCKED member row.
    expect(src).toMatch(/fm\.spend_limit_credits, fm\.spent_credits[\s\S]{0,200}FROM public\.family_members fm[\s\S]{0,200}FOR UPDATE OF fm/);
  });

  // B-843 (A10) — the legacy pay path grew a SECOND family lock: the stamped
  // payer's (member, holder) row. MON-4's rule is about ORDER, and it must hold
  // for that one too — every family_members lock precedes the wallet lock.
  it('B-843: the stamped-payer re-validation locks the member row and locks ONLY it', () => {
    const src = strip(readFileSync(join(__dirname, 'booking.service.ts'), 'utf8'));
    const at = src.indexOf('FROM public.family_members fm');
    expect(at).toBeGreaterThan(-1);
    const stmt = src.slice(at, at + 400);
    expect(stmt).toMatch(/FOR UPDATE OF fm/);
  });

  it('B-843: in payWithCredits every family_members lock still precedes the wallet lock', () => {
    const src = strip(readFileSync(join(__dirname, 'booking.service.ts'), 'utf8')).replace(/\r?\n/g, '\n');
    // Anchor INSIDE payWithCredits, not the whole file: `create()` above it also
    // reads wallet_balances (unlocked), and a whole-file scan would compare the
    // wrong pair of offsets and pass vacuously.
    const fnAt = src.indexOf('async payWithCredits(');
    expect(fnAt).toBeGreaterThan(-1);
    const body = src.slice(fnAt, src.indexOf('async confirmComplete(', fnAt) > -1
      ? src.indexOf('async confirmComplete(', fnAt) : fnAt + 12000);
    const walletLockAt = body.indexOf('FROM wallet_balances WHERE user_id = $1 FOR UPDATE');
    expect(walletLockAt).toBeGreaterThan(-1);
    const lastFamilyLock = body.lastIndexOf('public.family_members', walletLockAt);
    expect(lastFamilyLock).toBeGreaterThan(-1);
    expect(lastFamilyLock).toBeLessThan(walletLockAt);
    // ...and no family lock is taken AFTER the wallet lock inside this method.
    expect(body.indexOf('public.family_members\n            WHERE id = $1 FOR UPDATE', walletLockAt)).toBe(-1);
  });

  // ── B-854 — the chained charge grew a THIRD family lock ──────────────────
  //
  // Both of this file's escrow anchors, and `auditFixPins`'s B-384 block, take
  // the FIRST occurrence of a literal. B-854 adds a second, taller charge path
  // to both files, so "first occurrence" is now a claim that has to be pinned
  // rather than assumed — a chained statement written above the non-chained one
  // would silently re-point every money pin in the repo at the wrong code.

  it('B-854: the FIRST `FROM public.family_members fm` in dispatch is still the B-384 statement', () => {
    const src = strip(readFileSync(join(__dirname, '..', 'dispatch', 'dispatch.service.ts'), 'utf8'))
      .replace(/\r?\n/g, '\n');
    const first = src.indexOf('FROM public.family_members fm');
    const chained = src.indexOf('} else if (b.payer_via_user_id) {');
    expect(first).toBeGreaterThan(-1);
    expect(chained).toBeGreaterThan(-1);
    // The B-384 read comes first, and the chained branch never re-uses the alias.
    expect(first).toBeLessThan(chained);
    expect(src.slice(chained)).not.toContain('FROM public.family_members fm');
    // …and the cap-column literal the B-384 pin anchors on, likewise.
    const capLiteral = src.indexOf('fm.spend_limit_credits, fm.spent_credits');
    expect(capLiteral).toBeGreaterThan(-1);
    expect(capLiteral).toBeLessThan(chained);
    expect(src.slice(chained)).not.toContain('fm.spend_limit_credits, fm.spent_credits');
  });

  it('B-854: the FIRST `FROM public.family_members fm` in booking is still validateStampedPayer', () => {
    const src = strip(readFileSync(join(__dirname, 'booking.service.ts'), 'utf8')).replace(/\r?\n/g, '\n');
    const first = src.indexOf('FROM public.family_members fm');
    const stamped = src.indexOf('private async validateStampedPayer(');
    const chained = src.indexOf('private async validateChainedPayer(');
    expect(stamped).toBeGreaterThan(-1);
    expect(chained).toBeGreaterThan(stamped);
    expect(first).toBeGreaterThan(stamped);
    expect(first).toBeLessThan(chained);
  });

  it('B-854: the chained lock is ONE ordered statement, and precedes the wallet lock', () => {
    const src = strip(readFileSync(join(__dirname, 'booking.service.ts'), 'utf8')).replace(/\r?\n/g, '\n');
    const helper = src.indexOf('private async lockFamilyRowsInOrder(');
    expect(helper).toBeGreaterThan(-1);
    const stmt = src.slice(helper, helper + 600);
    // ORDER BY the primary key inside ONE statement is a TOTAL order. The
    // "upstream row first, then the member row" rule the plan opened with is
    // only a LOCAL one: two members of the same intermediary, or a pair of
    // mutual funders, still deadlock under it.
    expect(stmt).toMatch(/WHERE fr\.id = ANY\(\$1::uuid\[\]\)/);
    expect(stmt).toMatch(/ORDER BY fr\.id/);
    expect(stmt).toMatch(/FOR UPDATE OF fr/);
    // MON-4's rule is about ORDER, and it holds for this one too.
    const fnAt = src.indexOf('async payWithCredits(');
    const lockAt = src.indexOf('lockFamilyRowsInOrder(tx', fnAt);
    const walletAt = src.indexOf('FROM wallet_balances WHERE user_id = $1 FOR UPDATE', fnAt);
    expect(lockAt).toBeGreaterThan(fnAt);
    expect(walletAt).toBeGreaterThan(lockAt);
  });

  it('...and locks ONLY the member row, never the joined users row', () => {
    // `FOR UPDATE` without `OF fm` would also lock `public.users` for the
    // holder — a lock this path has never held, taken in an order no other
    // path uses. That is a deadlock waiting for the first concurrent profile
    // write, so the `OF fm` is load-bearing, not stylistic.
    const src = strip(readFileSync(join(__dirname, '..', 'dispatch', 'dispatch.service.ts'), 'utf8'));
    const at = src.indexOf('FROM public.family_members fm');
    expect(at).toBeGreaterThan(-1);
    const stmt = src.slice(at, at + 400);
    expect(stmt).toMatch(/FOR UPDATE OF fm/);
    expect(stmt).not.toMatch(/FOR UPDATE`/);
  });
});
