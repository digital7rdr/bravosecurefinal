import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {BadRequestException} from '@nestjs/common';
import {BookingService} from './booking.service';
import type {DatabaseService} from '../database/database.service';
import type {PricingService} from './pricing.service';
import type {ConfigService} from '@nestjs/config';

/**
 * B-843 — one person, many root accounts; the member chooses which root pays.
 *
 * The rule this file exists to hold (plan A1) is one sentence: **the payer that
 * lands on `lite_bookings.payer_user_id` is ALWAYS the output of
 * `resolvePayer`, never the client-supplied `dto.payer_user_id`.** The DTO value
 * is a CHOICE; the resolution is what makes it safe. Ops profiles, refunds,
 * escrow and history all read that column as truth, so a raw client id reaching
 * it would let anyone bill another account by editing one request body.
 *
 * Second theme: LM-B7 (A7). When a ROOT pays, the refusal bodies must not carry
 * the root's `balance` / `committed` — a member is not entitled to read a root's
 * finances, and a cheap booking would otherwise be a probe.
 */

// $31 payer_user_id → 0-indexed 30. $25 status → 24.
const I_PAYER = 30;

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

const selfPayer = (uid: string) => ({
  payerId: uid, familyRowId: null, spendLimit: null, spent: 0,
  holderSuspended: false, holderId: null, holderName: null,
});
const rootPayer = (over: Record<string, unknown> = {}) => ({
  payerId: 'holder1', familyRowId: 'fr1', spendLimit: null, spent: 0,
  holderSuspended: false, holderId: 'holder1', holderName: 'Root A', ...over,
});
const TWO_OPTIONS = [
  {holderId: 'holder1', holderName: 'Root A', spendLimit: 900, spent: 400, remaining: 500, held: false, rootSuspended: false},
  {holderId: 'holder2', holderName: 'Root B', spendLimit: null, spent: 0, remaining: null, held: false, rootSuspended: false},
];

// ── create() harness ────────────────────────────────────────────────────────

function mkCreate(opts: {
  payer?: Record<string, unknown>;
  resolveThrows?: unknown;
  options?: unknown[];
  balance?: number;
  committedEur?: string;
} = {}) {
  const capture: {insertParams?: unknown[]} = {};
  const dbQOne = jest.fn().mockImplementation((sql: string, params?: unknown[]) => {
    if (/INSERT INTO lite_bookings/.test(sql)) {
      capture.insertParams = params;
      return Promise.resolve(fullBookingRow({status: 'PENDING_OPS'}));
    }
    if (/FROM wallet_balances/.test(sql)) {
      return Promise.resolve({bravo_credits: opts.balance ?? 10_000});
    }
    if (/committed_eur/.test(sql)) {
      return Promise.resolve({committed_eur: opts.committedEur ?? '0'});
    }
    return Promise.resolve(null);
  });
  const db = {
    qOne: dbQOne, q: jest.fn().mockResolvedValue([]),
    withTransaction: (fn: (t: unknown) => unknown) => fn({q: jest.fn().mockResolvedValue([]), qOne: dbQOne}),
  } as unknown as DatabaseService;
  const pricing = {calculate: jest.fn().mockReturnValue({
    rate_eur_per_hour: 25, rate_aed_per_hour: 91, total_eur: 100, total_aed: 367,
    total_bc: 100, breakdown: [],
  })} as unknown as PricingService;
  const config = {get: () => undefined} as unknown as ConfigService;
  const family = {
    resolvePayer: jest.fn(async (uid: string) => {
      if (opts.resolveThrows) {throw opts.resolveThrows;}
      return opts.payer ?? selfPayer(uid);
    }),
    payerOptions: jest.fn().mockResolvedValue(opts.options ?? []),
  };
  const bookingPush = {familySpendDenied: jest.fn().mockResolvedValue(undefined)};
  const svc = new BookingService(
    db, pricing, {assert: jest.fn()} as never, {} as never, {} as never,
    {} as never, family as never, {} as never, config, bookingPush as never,
  );
  (svc as unknown as {audit: jest.Mock}).audit = jest.fn().mockResolvedValue(undefined);
  (svc as unknown as {emitOpsFeed: jest.Mock}).emitOpsFeed = jest.fn().mockResolvedValue(undefined);
  return {svc, capture, family, bookingPush};
}

function dto(extra: Record<string, unknown> = {}) {
  return {
    type: 'transfer', region: 'AE', region_label: 'Dubai', service: 'secure_transfer',
    booking_mode: 'now', start_time: new Date(Date.now() + 4 * 3_600_000).toISOString(),
    pickup: {address: 'X', latitude: 25, longitude: 55}, add_ons: [],
    passengers: 1, cpo_count: 1, vehicle_count: 1, driver_only: false,
    payment_method: 'bravo_credits', duration_hours: 4, ...extra,
  } as never;
}
const autoDto = (extra: Record<string, unknown> = {}) =>
  dto({location_consent: true, terms_accepted: true, ...extra});

describe('B-843 (A1) — create() stamps the RESOLVED payer, never the DTO value', () => {
  it('the LEGACY path resolves too — the resolution is no longer inside `if (auto)`', async () => {
    const {svc, capture, family} = mkCreate();
    await svc.create('c1', dto());
    // Before B-843 this was zero: a legacy create stamped NULL and never asked.
    expect(family.resolvePayer).toHaveBeenCalledTimes(1);
    expect(family.resolvePayer).toHaveBeenCalledWith('c1', null);
    expect(capture.insertParams?.[I_PAYER]).toBe('c1');
  });

  it('the AUTO path resolves EXACTLY ONCE (hoisting must not double-charge the lookup)', async () => {
    const {svc, capture, family} = mkCreate();
    await svc.create('c1', autoDto(), {autoDispatch: true});
    expect(family.resolvePayer).toHaveBeenCalledTimes(1);
    expect(capture.insertParams?.[I_PAYER]).toBe('c1');
  });

  it('forwards the client\'s CHOICE to resolvePayer — and binds what came BACK', async () => {
    // The DTO says holder2. The resolver answers holder1. Whatever the resolver
    // says is what lands on the row: revert to binding `dto.payer_user_id` and
    // this reads 'holder2' → RED.
    const {svc, capture, family} = mkCreate({payer: rootPayer()});
    await svc.create('c1', autoDto({payer_user_id: 'holder2'}), {autoDispatch: true});
    expect(family.resolvePayer).toHaveBeenCalledWith('c1', 'holder2');
    expect(capture.insertParams?.[I_PAYER]).toBe('holder1');
  });

  it('a PAYER_CHOICE_REQUIRED refusal reaches the client and nothing is inserted', async () => {
    const {svc, capture} = mkCreate({
      resolveThrows: new BadRequestException({
        code: 'PAYER_CHOICE_REQUIRED',
        message: 'Choose which account pays for this booking.',
        options: TWO_OPTIONS,
      }),
    });
    await svc.create('c1', autoDto(), {autoDispatch: true}).then(
      () => { throw new Error('should have thrown'); },
      (e: BadRequestException) => {
        expect((e.getResponse() as {code: string}).code).toBe('PAYER_CHOICE_REQUIRED');
      },
    );
    // Fail CLOSED — a booking must not exist with a guessed payer.
    expect(capture.insertParams).toBeUndefined();
  });
});

describe('B-843 (A1) — source scan: the DTO value NEVER reaches the insert bind', () => {
  const strip = (s: string) => s.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const src = () => strip(readFileSync(join(__dirname, 'booking.service.ts'), 'utf8'));

  it('`dto.payer_user_id` appears ONLY as an argument to resolvePayer', () => {
    // Comments are stripped first: this file's own prose says the words
    // "dto.payer_user_id" several times, which is precisely how a scan like this
    // passes vacuously (CLAUDE.md source-scan rules).
    const hits = src().match(/dto\.payer_user_id/g) ?? [];
    expect(hits.length).toBe(1);
    expect(src()).toMatch(/resolvePayer\(clientId, dto\.payer_user_id \?\? null\)/);
  });

  it('the payer bound at the INSERT is derived from the resolver, not the request', () => {
    const s = src().replace(/\r?\n/g, '\n');
    expect(s).toMatch(/const payerUserId: string = payer\.payerId;/);
    // Anchor INSIDE the INSERT's bind array, not "somewhere in the file": the
    // bind list runs from the `[` after the INSERT template literal to the
    // `],` that closes it, and `payerUserId` must be the value in it.
    const insAt = s.indexOf('INSERT INTO lite_bookings');
    expect(insAt).toBeGreaterThan(-1);
    const binds = s.slice(insAt, insAt + 4500);
    expect(binds).toContain('\n        payerUserId,');
    expect(binds).not.toContain('dto.payer_user_id');
  });

  it('the resolution sits ABOVE the auto gate — the hoist is the whole fix', () => {
    const s = src().replace(/\r?\n/g, '\n');
    const resolveAt = s.indexOf('const payer = await this.family.resolvePayer(clientId, dto.payer_user_id');
    expect(resolveAt).toBeGreaterThan(-1);
    // The very next statements must be the payer binding and then the auto gate.
    // A regex over that exact window cannot pass with the resolution back inside
    // `if (auto) { … }`, which is where it lived before B-843.
    expect(s.slice(resolveAt, resolveAt + 260)).toMatch(
      /const payer = await this\.family\.resolvePayer\(clientId, dto\.payer_user_id \?\? null\);\n\s*const payerUserId: string = payer\.payerId;\n\s*if \(auto\) \{/,
    );
  });
});

describe('B-843 (A7 / LM-B7) — insufficient_credits never leaks a ROOT\'s balance', () => {
  it('a SELF payer keeps balance + committed (unchanged for everyone with no root)', async () => {
    const {svc} = mkCreate({balance: 5, committedEur: '10'});
    await svc.create('c1', autoDto(), {autoDispatch: true}).then(
      () => { throw new Error('should have thrown'); },
      (e: BadRequestException) => {
        const body = e.getResponse() as Record<string, unknown>;
        expect(body).toMatchObject({
          code: 'insufficient_credits', payer_is_self: true, balance: 5, committed: 10,
          this_booking: 100,
        });
      },
    );
  });

  it('a ROOT payer OMITS balance and committed, and names the root instead', async () => {
    const {svc} = mkCreate({payer: rootPayer(), balance: 5, options: TWO_OPTIONS});
    await svc.create('c1', autoDto(), {autoDispatch: true}).then(
      () => { throw new Error('should have thrown'); },
      (e: BadRequestException) => {
        const body = e.getResponse() as Record<string, unknown>;
        expect(body.code).toBe('insufficient_credits');
        expect(body.payer_is_self).toBe(false);
        // THE leak: a member could otherwise read a root's wallet by submitting
        // a booking they know is too expensive.
        expect(body).not.toHaveProperty('balance');
        expect(body).not.toHaveProperty('committed');
        expect(body.holder_id).toBe('holder1');
        expect(body.holder_name).toBe('Root A');
        expect(body.options).toEqual(TWO_OPTIONS);
      },
    );
  });

  it('options are OMITTED when the member has fewer than two roots (nothing to choose)', async () => {
    const {svc} = mkCreate({payer: rootPayer(), balance: 5, options: [TWO_OPTIONS[0]]});
    await svc.create('c1', autoDto(), {autoDispatch: true}).then(
      () => { throw new Error('should have thrown'); },
      (e: BadRequestException) => {
        expect(e.getResponse()).not.toHaveProperty('options');
      },
    );
  });
});

describe('B-843 (A11) — the quota / suspension refusals NAME the root', () => {
  it('SPENDING_QUOTA_EXCEEDED carries holder_id, holder_name and options', async () => {
    const {svc, bookingPush} = mkCreate({
      payer: rootPayer({spendLimit: 100, spent: 90}), options: TWO_OPTIONS,
    });
    await svc.create('c1', autoDto(), {autoDispatch: true}).then(
      () => { throw new Error('should have thrown'); },
      (e: BadRequestException) => {
        expect(e.getResponse()).toMatchObject({
          code: 'SPENDING_QUOTA_EXCEEDED',
          message: 'family_spend_limit_exceeded',
          holder_id: 'holder1', holder_name: 'Root A', options: TWO_OPTIONS,
        });
      },
    );
    // A11 — the durable wake is keyed per (member, ROOT), so a member refused by
    // root A is not then silent about root B.
    expect(bookingPush.familySpendDenied).toHaveBeenCalledWith('c1', 'holder1');
  });

  it('ROOT_ACCOUNT_SUSPENDED carries them too', async () => {
    const {svc, bookingPush} = mkCreate({
      payer: rootPayer({holderSuspended: true}), options: TWO_OPTIONS,
    });
    await svc.create('c1', autoDto(), {autoDispatch: true}).then(
      () => { throw new Error('should have thrown'); },
      (e: BadRequestException) => {
        expect(e.getResponse()).toMatchObject({
          code: 'ROOT_ACCOUNT_SUSPENDED', holder_id: 'holder1', holder_name: 'Root A',
          options: TWO_OPTIONS,
        });
      },
    );
    expect(bookingPush.familySpendDenied).toHaveBeenCalledWith('c1', 'holder1');
  });
});

// ── payWithCredits harness (A10) ────────────────────────────────────────────

function mkPay(opts: {
  stampedPayer?: string | null;
  famRow?: Record<string, unknown> | null;
  lockedCap?: {spent_credits: number; spend_limit_credits: number | null};
  resolved?: Record<string, unknown>;
} = {}) {
  const seen: string[] = [];
  const dbQOne = jest.fn().mockImplementation((sql: string) => {
    const s = String(sql).replace(/\s+/g, ' ');
    seen.push(s);
    if (/FROM lite_bookings WHERE id = \$1 AND client_id = \$2 FOR UPDATE/.test(s)) {
      return Promise.resolve(fullBookingRow({payer_user_id: opts.stampedPayer ?? null}));
    }
    // A10 — the stamped-payer re-validation: the LIVE (member, holder) row.
    if (/FROM public\.family_members fm .*FOR UPDATE OF fm/.test(s)) {
      return Promise.resolve(opts.famRow === undefined
        ? {id: 'fr1', held_until: null, holder_name: 'Root A', spend_limit_credits: null, spent_credits: 0, holder_suspended_at: null}
        : opts.famRow);
    }
    // MON-4 — the authoritative cap gate, untouched by B-843.
    if (/FROM public\.family_members WHERE id = \$1 FOR UPDATE/.test(s)) {
      return Promise.resolve(opts.lockedCap ?? {spent_credits: 0, spend_limit_credits: null});
    }
    if (/FROM wallet_balances WHERE user_id = \$1 FOR UPDATE/.test(s)) {
      return Promise.resolve({bravo_credits: 10_000, currency: 'AED'});
    }
    if (/UPDATE lite_bookings.*RETURNING \*/.test(s)) {
      return Promise.resolve(fullBookingRow({status: 'CONFIRMED', payment_captured: true}));
    }
    return Promise.resolve(null);
  });
  const tx = {q: jest.fn().mockResolvedValue([]), qOne: dbQOne};
  const db = {
    qOne: dbQOne, q: jest.fn().mockResolvedValue([]),
    withTransaction: (fn: (t: unknown) => unknown) => fn(tx),
  } as unknown as DatabaseService;
  const family = {
    resolvePayer: jest.fn(async (uid: string) => opts.resolved ?? selfPayer(uid)),
    payerOptions: jest.fn().mockResolvedValue([]),
    notifyUsageThreshold: jest.fn().mockResolvedValue(undefined),
  };
  const bookingPush = {familySpendDenied: jest.fn().mockResolvedValue(undefined)};
  const svc = new BookingService(
    db, {calculate: jest.fn()} as unknown as PricingService, {assert: jest.fn()} as never,
    {} as never, {} as never, {} as never, family as never, {} as never,
    {get: () => undefined} as unknown as ConfigService, bookingPush as never,
  );
  (svc as unknown as {audit: jest.Mock}).audit = jest.fn().mockResolvedValue(undefined);
  return {svc, tx, family, bookingPush, seen};
}

describe('B-843 (A10) — payWithCredits: body first, then the STAMP, then a fresh resolve', () => {
  it('an offered payerUserId wins over the stamp and is RE-RESOLVED (never trusted raw)', async () => {
    const {svc, family, tx} = mkPay({
      stampedPayer: 'holder1',
      resolved: rootPayer({payerId: 'holder2', familyRowId: 'fr2', holderId: 'holder2', holderName: 'Root B'}),
    });
    await svc.payWithCredits('c1', 'bk1', {payerUserId: 'holder2'});
    // The connection argument is F4's business — pinned in its own block below.
    expect(family.resolvePayer).toHaveBeenCalledWith('c1', 'holder2', expect.anything());
    // The DEBIT is what proves it: the wallet touched is the resolved one.
    expect(tx.q).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE wallet_balances SET bravo_credits = bravo_credits - $1'),
      [50, 'holder2'],
    );
  });

  it('with NO body it uses the STAMP and never asks the no-holder resolver', async () => {
    const {svc, family, tx, seen} = mkPay({stampedPayer: 'holder1'});
    await svc.payWithCredits('c1', 'bk1');
    // `resolvePayer(client, null)` at charge time would pick an ARBITRARY root
    // once the member has two — that is the bug this branch removes.
    expect(family.resolvePayer).not.toHaveBeenCalled();
    expect(seen.some(s => /FROM public\.family_members fm .*FOR UPDATE OF fm/.test(s))).toBe(true);
    expect(tx.q).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE wallet_balances SET bravo_credits = bravo_credits - $1'),
      [50, 'holder1'],
    );
  });

  it('the stamped re-validation is keyed on (member, holder) and locks ONLY the member row', async () => {
    const {svc, seen} = mkPay({stampedPayer: 'holder1'});
    await svc.payWithCredits('c1', 'bk1');
    const stmt = seen.find(s => /FOR UPDATE OF fm/.test(s))!;
    expect(stmt).toContain('WHERE fm.member_id = $1 AND fm.holder_id = $2');
    expect(stmt).toContain(`fm.status = 'active'`);
    // A bare FOR UPDATE would also lock the holder's `users` row — a lock this
    // path has never held, in an order no other path uses (MON-4 rationale).
    expect(stmt).toContain('FOR UPDATE OF fm');
    expect(stmt).not.toMatch(/FOR UPDATE\s*$/);
  });

  it('a REVOKED stamped membership is REFUSED — never a silent fallback to the member\'s own wallet', async () => {
    const {svc, tx, bookingPush} = mkPay({stampedPayer: 'holder1', famRow: null});
    await svc.payWithCredits('c1', 'bk1').then(
      () => { throw new Error('should have thrown'); },
      (e: BadRequestException) => {
        expect(e).toBeInstanceOf(BadRequestException);
        expect(e.getResponse()).toMatchObject({
          code: 'PAYER_NOT_ELIGIBLE',
          message: "That account can't pay for this booking right now.",
          holder_id: 'holder1',
        });
      },
    );
    // Pre-B-843 this charged the MEMBER for a booking the root had stopped.
    expect(tx.q).not.toHaveBeenCalledWith(
      expect.stringContaining('UPDATE wallet_balances SET bravo_credits = bravo_credits - $1'),
      expect.anything(),
    );
    expect(bookingPush.familySpendDenied).toHaveBeenCalledWith('c1', 'holder1');
  });

  it('a HELD stamped membership is refused the same way', async () => {
    const {svc, tx} = mkPay({
      stampedPayer: 'holder1',
      famRow: {
        id: 'fr1', held_until: new Date(Date.now() + 86_400_000), holder_name: 'Root A',
        spend_limit_credits: null, spent_credits: 0, holder_suspended_at: null,
      },
    });
    await expect(svc.payWithCredits('c1', 'bk1'))
      .rejects.toMatchObject({response: {code: 'PAYER_NOT_ELIGIBLE'}});
    expect(tx.q).not.toHaveBeenCalledWith(
      expect.stringContaining('UPDATE wallet_balances SET bravo_credits = bravo_credits - $1'),
      expect.anything(),
    );
  });

  it('an EXPIRED hold on the stamped membership still charges (the hold window closed)', async () => {
    const {svc, tx} = mkPay({
      stampedPayer: 'holder1',
      famRow: {
        id: 'fr1', held_until: new Date(Date.now() - 86_400_000), holder_name: 'Root A',
        spend_limit_credits: null, spent_credits: 0, holder_suspended_at: null,
      },
    });
    await svc.payWithCredits('c1', 'bk1');
    expect(tx.q).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE wallet_balances SET bravo_credits = bravo_credits - $1'),
      [50, 'holder1'],
    );
  });

  it('a SUSPENDED root on the stamped membership raises ROOT_ACCOUNT_SUSPENDED (§21 keeps its own reason)', async () => {
    const {svc} = mkPay({
      stampedPayer: 'holder1',
      famRow: {
        id: 'fr1', held_until: null, holder_name: 'Root A',
        spend_limit_credits: null, spent_credits: 0, holder_suspended_at: new Date(),
      },
    });
    await expect(svc.payWithCredits('c1', 'bk1'))
      .rejects.toMatchObject({response: {code: 'ROOT_ACCOUNT_SUSPENDED', holder_id: 'holder1'}});
  });

  it('a booking stamped SELF pays from the member and never touches the family tables', async () => {
    const {svc, family, tx, seen} = mkPay({stampedPayer: 'c1'});
    await svc.payWithCredits('c1', 'bk1');
    expect(family.resolvePayer).not.toHaveBeenCalled();
    expect(seen.some(s => /public\.family_members/.test(s))).toBe(false);
    expect(tx.q).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE wallet_balances SET bravo_credits = bravo_credits - $1'),
      [50, 'c1'],
    );
  });

  it('a PRE-STAMP legacy booking (null payer, no body) falls back to a fresh resolve', async () => {
    const {svc, family} = mkPay({stampedPayer: null});
    await svc.payWithCredits('c1', 'bk1');
    expect(family.resolvePayer).toHaveBeenCalledWith('c1', null, expect.anything());
  });

  // ── F4 — every family read in this txn runs on the TXN's connection ───────
  //
  // The refusals fire while the member row is held FOR UPDATE. Reading off the
  // pool there checks out a SECOND connection while locks are held, which under
  // pool pressure is a wait for a connection only this transaction can free.
  it('F4: the payer resolution runs on the TRANSACTION client, not the pool', async () => {
    const {svc, family, tx} = mkPay({
      stampedPayer: 'holder1',
      resolved: rootPayer({payerId: 'holder2', familyRowId: 'fr2', holderId: 'holder2', holderName: 'Root B'}),
    });
    await svc.payWithCredits('c1', 'bk1', {payerUserId: 'holder2'});
    expect(family.resolvePayer).toHaveBeenCalledWith('c1', 'holder2', tx);
  });

  it('F4: the pre-stamp fallback resolve runs on the transaction client too', async () => {
    const {svc, family, tx} = mkPay({stampedPayer: null});
    await svc.payWithCredits('c1', 'bk1');
    expect(family.resolvePayer).toHaveBeenCalledWith('c1', null, tx);
  });

  it('F4: a refusal decorates itself on the transaction client, never the pool', async () => {
    const {svc, family, tx} = mkPay({
      stampedPayer: 'holder1',
      famRow: {
        id: 'fr1', held_until: null, holder_name: 'Root A',
        spend_limit_credits: null, spent_credits: 0, holder_suspended_at: new Date(),
      },
    });
    await expect(svc.payWithCredits('c1', 'bk1'))
      .rejects.toMatchObject({response: {code: 'ROOT_ACCOUNT_SUSPENDED'}});
    expect(family.payerOptions).toHaveBeenCalledWith('c1', tx);
  });

  // create() is NOT inside a transaction, so its refusals must keep using the
  // pool — passing a connection that does not exist would be the mirror bug.
  it('F4: create()\'s refusal decoration takes NO connection (there is no txn there)', async () => {
    const {svc, family} = mkCreate({payer: rootPayer({holderSuspended: true}), options: TWO_OPTIONS});
    await expect(svc.create('c1', autoDto(), {autoDispatch: true})).rejects.toBeInstanceOf(BadRequestException);
    expect(family.payerOptions).toHaveBeenCalledWith('c1', undefined);
    expect(family.resolvePayer).toHaveBeenCalledWith('c1', null);
  });

  it('MON-4 lock order is unchanged: the family row is locked BEFORE the wallet row', async () => {
    const {svc, seen} = mkPay({stampedPayer: 'holder1'});
    await svc.payWithCredits('c1', 'bk1');
    const famAt = seen.findIndex(s => /public\.family_members/.test(s));
    const walletAt = seen.findIndex(s => /wallet_balances WHERE user_id = \$1 FOR UPDATE/.test(s));
    expect(famAt).toBeGreaterThan(-1);
    expect(walletAt).toBeGreaterThan(famAt);
  });
});

/**
 * B-847 — `payment_method` must say what was actually charged.
 *
 * There is no card lane for bookings: Stripe is wallet top-ups only, the escrow
 * hold at agency accept and `payWithCredits` both spend Bravo Credits, and
 * nothing in this service ever branches on the column. Clients <= 1.0.307 still
 * send the legacy 'card' default from the wizard draft, so the DTO keeps
 * ACCEPTING it (rejecting would break shipped clients) and `create()` normalises
 * it at the bind instead. Same harness as the A1 pin above — $23 is 0-indexed 22.
 */
const I_PAYMENT_METHOD = 22;

describe('B-847 — create() stores the method it actually charges', () => {
  it('a legacy client\'s \'card\' is stored as bravo_credits', async () => {
    const {svc, capture} = mkCreate();
    await svc.create('c1', dto({payment_method: 'card'}));
    expect(capture.insertParams?.[I_PAYMENT_METHOD]).toBe('bravo_credits');
  });

  it('the DTO still ACCEPTS \'card\' — an old client must not start failing to book', async () => {
    const {svc, capture} = mkCreate();
    // The normalisation is a rewrite, not a refusal: the create completes.
    await expect(svc.create('c1', dto({payment_method: 'card'}))).resolves.toBeDefined();
    expect(capture.insertParams).toBeDefined();
  });

  it('a current client\'s \'bravo_credits\' is bound unchanged', async () => {
    const {svc, capture} = mkCreate();
    await svc.create('c1', dto({payment_method: 'bravo_credits'}));
    expect(capture.insertParams?.[I_PAYMENT_METHOD]).toBe('bravo_credits');
  });

  it('the mapping is NARROW — \'corporate\' passes straight through', async () => {
    // Only 'card' is a lie about what was charged. Rewriting anything else would
    // erase a real distinction the moment one ships.
    const {svc, capture} = mkCreate();
    await svc.create('c1', dto({payment_method: 'corporate'}));
    expect(capture.insertParams?.[I_PAYMENT_METHOD]).toBe('corporate');
  });

  it('the auto path normalises too — both lanes share the one INSERT', async () => {
    const {svc, capture} = mkCreate();
    await svc.create('c1', autoDto({payment_method: 'card'}), {autoDispatch: true});
    expect(capture.insertParams?.[I_PAYMENT_METHOD]).toBe('bravo_credits');
  });
});

describe('B-847 — source scan: the raw DTO value never reaches the insert bind', () => {
  // Comments stripped first: the `// Why:` block this fix added names both
  // 'card' and dto.payment_method, which is exactly how a scan like this passes
  // vacuously (CLAUDE.md source-scan rules). CRLF-safe.
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const src = () => strip(readFileSync(join(__dirname, 'booking.service.ts'), 'utf8')).replace(/\r?\n/g, '\n');

  it('the normalisation exists and maps ONLY \'card\'', () => {
    expect(src()).toMatch(
      /const paymentMethod = dto\.payment_method === 'card' \? 'bravo_credits' : dto\.payment_method;/,
    );
  });

  it('the INSERT binds the normalised value, not `dto.payment_method`', () => {
    const s = src();
    const insAt = s.indexOf('INSERT INTO lite_bookings');
    expect(insAt).toBeGreaterThan(-1);
    // Anchored INSIDE the bind array, not "somewhere in the file" — the value is
    // the 23rd bind, immediately above `dto.notes`.
    const binds = s.slice(insAt, insAt + 4500);
    expect(binds).toMatch(/\n\s*paymentMethod,/);
    expect(binds).not.toContain('dto.payment_method');
  });
});
