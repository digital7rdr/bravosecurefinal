import {readFileSync} from 'fs';
import {join} from 'path';
import {BadRequestException} from '@nestjs/common';
import {BookingService} from './booking.service';
import type {DatabaseService} from '../database/database.service';
import type {PricingService} from './pricing.service';
import type {ConfigService} from '@nestjs/config';

/**
 * B-854 — the LEGACY pay path (`payWithCredits`) for a chained booking.
 *
 * The booking is stamped `payer_user_id = A` (the wallet), `payer_via_user_id =
 * B` (the intermediary), `client_id = C`. A3 says the chained branch is tested
 * BEFORE the stamped-non-self branch, both cap rows are locked in one ordered
 * statement, and the final UPDATE rewrites BOTH stamps from the resolution.
 */
function bookingRow(over: Record<string, unknown> = {}) {
  return {
    id: 'bk1', client_id: 'C', status: 'OPS_APPROVED', dispatch_mode: null,
    region_code: 'AE', region_label: 'Dubai', service: 'secure_transfer',
    booking_mode: 'now', pickup_address: 'X', pickup_lat: 25, pickup_lng: 55,
    dropoff_address: null, dropoff_lat: null, dropoff_lng: null,
    pickup_time: new Date(), passengers: 1, cpo_count: 1, vehicle_count: 1,
    driver_only: false, add_ons: [], total_eur: 50, duration_hours: 4,
    total_aed: 184, conversation_id: null, created_at: new Date(),
    payer_user_id: 'A', payer_via_user_id: 'B',
    payment_captured: false, confirmed_at: null,
    ...over,
  };
}

/** The (B,C) row — C's own membership under the intermediary. */
const MR = {
  id: 'fr-bc', holder_id: 'B', member_id: 'C', status: 'active', held_until: null,
  spend_limit_credits: null as number | null, spent_credits: 0, funds_sub_members: false,
  holder_name: 'Bee', holder_suspended_at: null as Date | null, holder_deleted_at: null as Date | null,
};
/** The (A,B) row — B's membership under the root whose wallet pays. */
const FU = {
  id: 'fr-ab', holder_id: 'A', member_id: 'B', status: 'active', held_until: null,
  spend_limit_credits: null as number | null, spent_credits: 0, funds_sub_members: true,
  holder_name: 'Ay', holder_suspended_at: null as Date | null, holder_deleted_at: null as Date | null,
};

function mk(opts: {
  row?: Record<string, unknown>;
  chain?: Array<Record<string, unknown>>;
  ids?: {member_row_id: string | null; funding_row_id: string | null} | null;
  lockedMine?: {spent_credits: number; spend_limit_credits: number | null} | null;
  lockedPair?: Array<{id: string; spend_limit_credits: number | null; spent_credits: number}>;
} = {}) {
  const qOne = jest.fn().mockImplementation((sql: string) => {
    const s = String(sql);
    if (/FROM lite_bookings WHERE id = \$1 AND client_id = \$2 FOR UPDATE/.test(s)) {
      return Promise.resolve(bookingRow(opts.row));
    }
    if (/AS member_row_id/.test(s)) {
      return Promise.resolve(opts.ids === undefined
        ? {member_row_id: 'fr-bc', funding_row_id: 'fr-ab'} : opts.ids);
    }
    if (/spent_credits, spend_limit_credits FROM public\.family_members\s+WHERE id = \$1 FOR UPDATE/.test(s)) {
      return Promise.resolve(opts.lockedMine === undefined
        ? {spent_credits: 0, spend_limit_credits: null} : opts.lockedMine);
    }
    if (/FROM wallet_balances WHERE user_id = \$1 FOR UPDATE/.test(s)) {
      return Promise.resolve({bravo_credits: 10_000, currency: 'AED'});
    }
    if (/UPDATE lite_bookings[\s\S]*RETURNING \*/.test(s)) {
      return Promise.resolve(bookingRow({status: 'CONFIRMED', payment_captured: true}));
    }
    return Promise.resolve(null);
  });
  const q = jest.fn().mockImplementation((sql: string) => {
    const s = String(sql);
    if (/SELECT fr\.id, fr\.holder_id, fr\.member_id/.test(s) && /FOR UPDATE OF fr/.test(s)) {
      return Promise.resolve(opts.chain ?? [MR, FU]);
    }
    if (/SELECT fr\.id, fr\.spend_limit_credits, fr\.spent_credits/.test(s)) {
      return Promise.resolve(opts.lockedPair ?? [
        {id: 'fr-bc', spend_limit_credits: null, spent_credits: 0},
        {id: 'fr-ab', spend_limit_credits: null, spent_credits: 0},
      ]);
    }
    return Promise.resolve([]);
  });
  const tx = {q, qOne};
  const db = {
    qOne, q, withTransaction: (fn: (t: unknown) => unknown) => fn(tx),
  } as unknown as DatabaseService;
  const pricing = {calculate: jest.fn()} as unknown as PricingService;
  const family = {
    resolvePayer: jest.fn(), payerOptions: jest.fn().mockResolvedValue([]),
    notifyUsageThreshold: jest.fn().mockResolvedValue(undefined),
  };
  const bookingPush = {familySpendDenied: jest.fn().mockResolvedValue(undefined)};
  // Positional and easy to get wrong: db, pricing, fsm, cpoAssign, vehicles,
  // wallet, family, settlement, config, THEN the optional bookingPush.
  const svc = new BookingService(
    db, pricing, {assert: jest.fn()} as never, {} as never, {} as never,
    {} as never, family as never, {} as never,
    {get: () => undefined} as unknown as ConfigService,
    bookingPush as never,
  );
  (svc as unknown as {audit: jest.Mock}).audit = jest.fn().mockResolvedValue(undefined);
  return {svc, tx, family, bookingPush};
}

function bumps(tx: {q: jest.Mock}): Array<[string, number]> {
  return tx.q.mock.calls
    .filter(c => /UPDATE public\.family_members SET spent_credits = spent_credits \+ \$2 WHERE id = \$1/.test(String(c[0])))
    .map(c => c[1] as [string, number]);
}

describe('B-854 (A3) — payWithCredits on a CHAINED stamp', () => {
  it('debits the ROOT wallet, never re-resolves (client, wallet)', async () => {
    const {svc, tx, family} = mk();
    await expect(svc.payWithCredits('C', 'bk1')).resolves.toBeDefined();
    // The chained branch runs FIRST, so the generic resolver is never consulted
    // for a stamped chain — the old order sent `(C, A)` to `validateStampedPayer`,
    // a pair with no membership row, and refused every chained booking.
    expect(family.resolvePayer).not.toHaveBeenCalled();
    expect(tx.q).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE wallet_balances SET bravo_credits = bravo_credits - $1'),
      [50, 'A'],
    );
  });

  it('bumps BOTH allowances', async () => {
    const {svc, tx} = mk();
    await svc.payWithCredits('C', 'bk1');
    const b = bumps(tx);
    expect(b.map(x => x[0]).sort()).toEqual(['fr-ab', 'fr-bc']);
    expect(b.every(x => x[1] === 50)).toBe(true);
  });

  it('the ledger row carries the funding row as the cap key and the member row as the VIA key', async () => {
    const {svc, tx} = mk();
    await svc.payWithCredits('C', 'bk1');
    const insert = tx.q.mock.calls.find(c => /INSERT INTO wallet_transactions/.test(String(c[0])));
    const meta = JSON.parse((insert![1] as unknown[])[5] as string) as Record<string, string>;
    expect(meta).toEqual({family_row_id: 'fr-ab', via_family_row_id: 'fr-bc', via_user_id: 'B'});
  });

  it('warns BOTH holders after the commit', async () => {
    const {svc, family} = mk();
    await svc.payWithCredits('C', 'bk1');
    expect(family.notifyUsageThreshold).toHaveBeenCalledWith('fr-bc');
    expect(family.notifyUsageThreshold).toHaveBeenCalledWith('fr-ab');
  });

  it('A3 — the final UPDATE rewrites BOTH stamps from the RESOLUTION', async () => {
    const {svc, tx} = mk();
    await svc.payWithCredits('C', 'bk1');
    const upd = tx.qOne.mock.calls.find(c => /UPDATE lite_bookings[\s\S]*RETURNING \*/.test(String(c[0])));
    expect(String(upd![0])).toContain('payer_via_user_id = $3');
    expect(upd![1]).toEqual(['bk1', 'A', 'B']);
  });

  it('A3 — an explicit payerUserId outranks the stamp and CLEARS the via column', async () => {
    // B-843 A10 keeps the body's choice on top. Leaving the via stamp behind
    // would make every later reader (refund, history, ops) believe a chain paid
    // for a booking that came out of the member's own wallet.
    const {svc, tx, family} = mk();
    family.resolvePayer.mockResolvedValue({
      payerId: 'C', familyRowId: null, spendLimit: null, spent: 0,
      holderSuspended: false, holderId: null, holderName: null,
    });
    await svc.payWithCredits('C', 'bk1', {payerUserId: 'C'});
    const upd = tx.qOne.mock.calls.find(c => /UPDATE lite_bookings[\s\S]*RETURNING \*/.test(String(c[0])));
    expect(upd![1]).toEqual(['bk1', 'C', null]);
    expect(bumps(tx)).toHaveLength(0);
  });

  /**
   * P1-1 — the CHOSEN-payer lane.
   *
   * `resolvePayer` reads the chain UNLOCKED (it also serves pre-flight soft
   * checks). The only lock that used to follow it on this lane was
   * `lockFamilyRowsInOrder`, whose projection is `id, spend_limit_credits,
   * spent_credits` — the flag, the status, the hold and both suspensions are
   * never re-read. So a root switching the chain OFF (or revoking, or holding)
   * between the resolve and the lock still got their wallet debited: the cap
   * gate passed, and nothing else looked. Same class as B-384, one rung up.
   */
  const CHAINED_RESOLUTION = {
    payerId: 'A', familyRowId: 'fr-bc', spendLimit: null, spent: 0,
    holderSuspended: false, holderId: 'B', holderName: 'Bee',
    fundingRowId: 'fr-ab', fundingHolderId: 'A', viaUserId: 'B',
    fundingSpendLimit: null, fundingSpent: 0,
  };

  it('P1-1 — a chained CHOSEN payer is re-read under the lock: an OFF between the two refuses', async () => {
    const {svc, tx, family} = mk({chain: [{...MR}, {...FU, funds_sub_members: false}]});
    family.resolvePayer.mockResolvedValue(CHAINED_RESOLUTION);
    await expect(svc.payWithCredits('C', 'bk1', {payerUserId: 'B'}))
      .rejects.toMatchObject({response: {code: 'PAYER_NOT_ELIGIBLE', holder_id: 'B'}});
    expect(tx.q).not.toHaveBeenCalledWith(
      expect.stringContaining('UPDATE wallet_balances SET bravo_credits = bravo_credits - $1'),
      expect.anything(),
    );
    expect(bumps(tx)).toHaveLength(0);
  });

  it.each([
    ['a revoke', [{...MR}, {...FU, status: 'revoked'}]],
    ['a hold', [{...MR}, {...FU, held_until: new Date(Date.now() + 86_400_000)}]],
    ['an erasure of the intermediary', [{...MR, holder_deleted_at: new Date()}, {...FU}]],
  ])('P1-1 — %s landing between the resolve and the lock also refuses', async (_n, chain) => {
    const {svc, tx, family} = mk({chain});
    family.resolvePayer.mockResolvedValue(CHAINED_RESOLUTION);
    await expect(svc.payWithCredits('C', 'bk1', {payerUserId: 'B'}))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(bumps(tx)).toHaveLength(0);
  });

  it('P1-1 — a healthy chained CHOSEN payer still charges the root and bumps both (positive control)', async () => {
    const {svc, tx, family} = mk();
    family.resolvePayer.mockResolvedValue(CHAINED_RESOLUTION);
    await expect(svc.payWithCredits('C', 'bk1', {payerUserId: 'B'})).resolves.toBeDefined();
    expect(tx.q).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE wallet_balances SET bravo_credits = bravo_credits - $1'),
      [50, 'A'],
    );
    expect(bumps(tx).map(x => x[0]).sort()).toEqual(['fr-ab', 'fr-bc']);
  });

  it('P1-1 — an UNCHAINED chosen payer is untouched by the re-validation', async () => {
    const {svc, tx, family} = mk();
    family.resolvePayer.mockResolvedValue({
      payerId: 'B', familyRowId: 'fr-bc', spendLimit: null, spent: 0,
      holderSuspended: false, holderId: 'B', holderName: 'Bee',
      fundingRowId: null, fundingHolderId: null, viaUserId: null,
    });
    await expect(svc.payWithCredits('C', 'bk1', {payerUserId: 'B'})).resolves.toBeDefined();
    expect(tx.q).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE wallet_balances SET bravo_credits = bravo_credits - $1'),
      [50, 'B'],
    );
    expect(bumps(tx)).toEqual([['fr-bc', 50]]);
  });

  it.each([
    ['the switch was turned off', [{...MR}, {...FU, funds_sub_members: false}]],
    ['the intermediary was revoked', [{...MR}, {...FU, status: 'revoked'}]],
    ['the intermediary is on hold', [{...MR}, {...FU, held_until: new Date(Date.now() + 86_400_000)}]],
    ['the intermediary was erased', [{...MR, holder_deleted_at: new Date()}, {...FU}]],
    ['the spender was revoked', [{...MR, status: 'revoked'}, {...FU}]],
  ])('fails CLOSED when %s — PAYER_NOT_ELIGIBLE naming the member\'s OWN root', async (_n, chain) => {
    const {svc, tx, bookingPush} = mk({chain});
    await svc.payWithCredits('C', 'bk1').then(
      () => { throw new Error('should have thrown'); },
      (e: BadRequestException) => {
        const body = e.getResponse() as {code: string; holder_id: string};
        expect(body.code).toBe('PAYER_NOT_ELIGIBLE');
        // LM-B7 — the refusal names B, never the wallet owner A.
        expect(body.holder_id).toBe('B');
        expect(JSON.stringify(body)).not.toContain('"A"');
      },
    );
    expect(bookingPush.familySpendDenied).toHaveBeenCalledWith('C', 'B');
    expect(tx.q).not.toHaveBeenCalledWith(
      expect.stringContaining('UPDATE wallet_balances SET bravo_credits = bravo_credits - $1'),
      expect.anything(),
    );
  });

  it('a SUSPENDED account on either rung is ROOT_ACCOUNT_SUSPENDED, named as the member\'s root', async () => {
    const {svc} = mk({chain: [{...MR}, {...FU, holder_suspended_at: new Date()}]});
    await svc.payWithCredits('C', 'bk1').then(
      () => { throw new Error('should have thrown'); },
      (e: BadRequestException) => {
        const body = e.getResponse() as {code: string; holder_id: string};
        expect(body.code).toBe('ROOT_ACCOUNT_SUSPENDED');
        expect(body.holder_id).toBe('B');
      },
    );
  });

  it('A5 — the FUNDING cap blocks with ITS figures, under the lock', async () => {
    const {svc, tx} = mk({
      lockedMine: {spent_credits: 0, spend_limit_credits: 10_000},
      lockedPair: [
        {id: 'fr-bc', spend_limit_credits: 10_000, spent_credits: 0},
        {id: 'fr-ab', spend_limit_credits: 60, spent_credits: 20},
      ],
      chain: [{...MR, spend_limit_credits: 10_000}, {...FU, spend_limit_credits: 60, spent_credits: 20}],
    });
    await svc.payWithCredits('C', 'bk1').then(
      () => { throw new Error('should have thrown'); },
      (e: BadRequestException) => {
        expect(e.getResponse()).toMatchObject({
          code: 'SPENDING_QUOTA_EXCEEDED', allocated: 60, used: 20, remaining: 40, required: 50,
        });
      },
    );
    expect(bumps(tx)).toHaveLength(0);
  });

  it('A2 — a stamp whose WALLET is the spender is refused outright', async () => {
    const {svc, tx} = mk({row: {payer_user_id: 'C', payer_via_user_id: 'B'}});
    await expect(svc.payWithCredits('C', 'bk1')).rejects.toMatchObject({
      response: {code: 'PAYER_NOT_ELIGIBLE'},
    });
    expect(tx.q).not.toHaveBeenCalledWith(
      expect.stringContaining('UPDATE wallet_balances SET bravo_credits = bravo_credits - $1'),
      expect.anything(),
    );
  });

  it('a missing row id is fail-closed (never a charge against one rung)', async () => {
    const {svc, tx} = mk({ids: {member_row_id: null, funding_row_id: 'fr-ab'}});
    await expect(svc.payWithCredits('C', 'bk1')).rejects.toBeInstanceOf(BadRequestException);
    expect(bumps(tx)).toHaveLength(0);
  });

  it('P2-4 — a row that VANISHES between the id read and the lock is fail-closed', async () => {
    // The ids resolved, the chain validated, and then the ordered lock comes
    // back one row short (a hard delete, or an id that no longer matches). The
    // missing row's cap is unchecked and its `spent` would go unbumped — an
    // uncapped draw on somebody's allowance, which is the opposite of what the
    // lock is for.
    const {svc, tx} = mk({lockedPair: [{id: 'fr-bc', spend_limit_credits: null, spent_credits: 0}]});
    await expect(svc.payWithCredits('C', 'bk1'))
      .rejects.toMatchObject({response: {code: 'PAYER_NOT_ELIGIBLE', holder_id: 'B'}});
    expect(tx.q).not.toHaveBeenCalledWith(
      expect.stringContaining('UPDATE wallet_balances SET bravo_credits = bravo_credits - $1'),
      expect.anything(),
    );
    expect(bumps(tx)).toHaveLength(0);
  });
});

describe('B-854 (A1) — the source invariants for booking.service.ts', () => {
  const strip = (s: string) => s.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const svcSrc = (): string =>
    strip(readFileSync(join(__dirname, 'booking.service.ts'), 'utf8')).replace(/\r?\n/g, '\n');

  it('A3 — the via branch is tested BEFORE the stamped-non-self branch', () => {
    const s = svcSrc();
    const via = s.indexOf('} else if (row.payer_via_user_id) {');
    const stamped = s.indexOf('} else if (row.payer_user_id && row.payer_user_id !== clientId) {');
    expect(via).toBeGreaterThan(-1);
    expect(stamped).toBeGreaterThan(-1);
    expect(via).toBeLessThan(stamped);
  });

  it('A1 — the chained code never introduces the `fm` literals the money pins anchor on', () => {
    const s = svcSrc();
    // The FIRST `FROM public.family_members fm` must stay validateStampedPayer's
    // (MON-4 / B-843 both take `indexOf` of it).
    const first = s.indexOf('FROM public.family_members fm');
    const stamped = s.indexOf('private async validateStampedPayer(');
    const chained = s.indexOf('private async validateChainedPayer(');
    expect(first).toBeGreaterThan(stamped);
    expect(first).toBeLessThan(chained);
    // …and the chained validator itself is `fr`/`fu`/`mr`-aliased.
    expect(s.slice(chained)).not.toContain('FROM public.family_members fm');
  });

  it('P1-1 — the chosen-payer lane routes a CHAINED result through the locked re-read', () => {
    const s = svcSrc();
    const fnAt = s.indexOf('async payWithCredits(');
    const laneAt = s.indexOf('if (offeredPayer) {', fnAt);
    expect(laneAt).toBeGreaterThan(fnAt);
    const lane = s.slice(laneAt, laneAt + 900);
    expect(lane).toMatch(/validateChainedPayer\(tx, clientId, payer\.payerId, payer\.viaUserId\)/);
  });

  it('P2-4 — the source still asserts BOTH rows came back', () => {
    const s = svcSrc();
    const at = s.indexOf('private async lockFamilyRowsInOrder(');
    const body = s.slice(at, at + 900);
    // A row that vanished between the id read and the lock (a hard delete, or
    // an id that never matched) would otherwise leave its cap unchecked and
    // its `spent` unbumped, i.e. an uncapped draw on somebody's allowance.
    // Shape-only — the BEHAVIOURAL pin is in the charge suite above, because a
    // scan for this line still matches a `false &&`-disabled one.
    expect(body).toMatch(/if \(rows\.length !== rowIds\.length\) \{return \[\];\}/);
  });

  it('A2 — the ordered two-row lock exists, `OF fr`, and precedes the wallet lock', () => {
    const s = svcSrc();
    const fnAt = s.indexOf('async payWithCredits(');
    const lock = s.indexOf('lockFamilyRowsInOrder', fnAt);
    const wallet = s.indexOf('FROM wallet_balances WHERE user_id = $1 FOR UPDATE', fnAt);
    expect(lock).toBeGreaterThan(fnAt);
    expect(wallet).toBeGreaterThan(lock);
    const helper = s.indexOf('private async lockFamilyRowsInOrder(');
    const stmt = s.slice(helper, helper + 600);
    expect(stmt).toMatch(/WHERE fr\.id = ANY\(\$1::uuid\[\]\)/);
    expect(stmt).toMatch(/ORDER BY fr\.id/);
    expect(stmt).toMatch(/FOR UPDATE OF fr/);
  });

  /**
   * B-854 (A4) — the MESSAGE_LOOP §5 caller-completeness sweep, pinned.
   *
   * `ResolvedPayer` has exactly four producers (`resolvePayer`, the self
   * literal, `validateStampedPayer`, `validateChainedPayer`) and every consumer
   * of it lives in this one file. Until B-854, `payerId === holderId` was an
   * UNSTATED invariant — the two fields were literally the same value — so
   * swapping one for the other was invisible. It is not any more: `payerId` is
   * the wallet, one rung above the account the member actually joined, and
   * handing them that id on a refusal, a push or a throttle key leaks a root
   * they have no relationship with (LM-B7).
   */
  it('A4 — every familySpendDenied names the SHOWN root, never the wallet', () => {
    const s = svcSrc();
    const args = [...s.matchAll(/familySpendDenied\(([^)]*)\)/g)].map(m => m[1]);
    // If this count collapses, the sweep stopped covering the call sites.
    expect(args.length).toBeGreaterThanOrEqual(8);
    for (const a of args) {
      expect(a).not.toMatch(/payer\.payerId/);
      expect(a).not.toMatch(/\bpayerId\b/);
      expect(a).not.toMatch(/payer\.fundingHolderId/);
      expect(a).not.toMatch(/\bwalletId\b/);
      // Each one names the member's own root (or the intermediary, which IS it).
      expect(a).toMatch(/payer\.holderId|payer\.viaUserId|holderId|viaId/);
    }
  });

  it('A4 — the refusal bodies carry holderId/holderName only', () => {
    const s = svcSrc();
    const at = s.indexOf('private async familyRefusalContext(');
    expect(at).toBeGreaterThan(-1);
    const body = s.slice(at, at + 1200);
    expect(body).toContain('holder_id:   payer.holderId ?? null');
    expect(body).toContain('holder_name: payer.holderName ?? null');
    expect(body).not.toMatch(/payer\.payerId|payer\.fundingHolderId|payer\.viaUserId/);
  });

  it('A4 — insufficientPayerContext still hides the payer\'s finances from a member', () => {
    const s = svcSrc();
    const at = s.indexOf('private async insufficientPayerContext(');
    expect(at).toBeGreaterThan(-1);
    const body = s.slice(at, at + 900);
    // Only the SELF branch discloses a balance; the family branch delegates to
    // the refusal context, which carries ids and names but no money.
    expect(body).toMatch(/if \(!payer\.familyRowId\) \{[\s\S]*balance: figures\.balance/);
    expect(body).toMatch(/return \{payer_is_self: false, \.\.\.\(await this\.familyRefusalContext\(/);
    expect(body).not.toMatch(/payer\.fundingHolderId|payer\.payerId/);
  });

  it('B-843 A1 — the via stamp comes from the RESOLUTION, never from a DTO', () => {
    const s = svcSrc();
    // There is no DTO field, and there must not be one.
    expect(s).not.toContain('dto.payer_via_user_id');
    expect(s).not.toContain('payer_via_user_id?:');
    expect(s).toContain('payer.viaUserId ?? null');
    const dto = strip(readFileSync(join(__dirname, 'dto', 'create-booking.dto.ts'), 'utf8'));
    expect(dto).not.toContain('payer_via_user_id');
  });
});
