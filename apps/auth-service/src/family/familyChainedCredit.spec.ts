/**
 * B-854 — chained family credit, the resolver + the approval loop.
 *
 * A linked member B (member of root A) who holds their own members C: C's
 * bookings may be paid from A's wallet, inside B's allowance on A's plan AND
 * inside C's own limit under B. Exactly ONE hop.
 *
 * Two kinds of pin live here, because the rule is split across two layers:
 *   · JS decisions (which wallet, which rows, what the member is allowed to
 *     see) are exercised against row fixtures;
 *   · the SQL predicates that DROP a chain (held / revoked / suspended
 *     intermediary / erased) cannot be executed — no database runs in unit
 *     tests — so they are source scans, comment-stripped and `\r?\n`-safe.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {Test, TestingModule} from '@nestjs/testing';
import {BadRequestException, ConflictException, NotFoundException} from '@nestjs/common';
import {DatabaseService}     from '../database/database.service';
import {GeocodeService}      from '../vbg/geocode.service';
import {BookingPushBridge}   from '../ops/booking-push-bridge.service';
import {OpsAuditService}     from '../ops/ops-audit.service';
import {FamilyService, familyCapRefusal} from './family.service';
import {FamilyQuotaService}  from './family-quota.service';

const src = (): string =>
  readFileSync(join(__dirname, 'family.service.ts'), 'utf8')
    .replace(/\r?\n/g, '\n')
    .split('\n')
    .filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*'))
    .join('\n');

const mockDb = {q: jest.fn(), qOne: jest.fn(), withTransaction: jest.fn()};
const mockGeocode = {reverse: jest.fn().mockResolvedValue({region: 'X', context: '', country: 'AE', lat: 0, lng: 0})};
const mockPush = {
  familyFundingRequested: jest.fn().mockResolvedValue(undefined),
  familyFundingDecided:   jest.fn().mockResolvedValue(undefined),
  familyFundingChanged:   jest.fn().mockResolvedValue(undefined),
};
const mockOpsAudit = {emit: jest.fn().mockResolvedValue(undefined), record: jest.fn().mockResolvedValue(undefined)};
const mockQuota = {
  setQuota: jest.fn(), cancelPendingOnRevoke: jest.fn().mockResolvedValue(undefined),
  notifyUsageThreshold: jest.fn().mockResolvedValue(undefined),
  rearmUsageThreshold: jest.fn().mockResolvedValue(undefined),
  recordFundingAudit: jest.fn().mockResolvedValue(undefined),
};

/** The member's own row under the SHOWN root (B) — chain OFF. */
function plainRow(over: Record<string, unknown> = {}) {
  return {
    id: 'fr-bc', holder_id: 'B', holder_name: 'Bee', status: 'active', held_until: null,
    spend_limit_credits: 500, spent_credits: 100, holder_suspended_at: null,
    accepted_at: null,
    root_credits: 9000,
    funding_row_id: null, funding_holder_id: null,
    funding_spend_limit_credits: null, funding_spent_credits: null,
    funding_holder_suspended_at: null, funding_wallet_credits: null,
    ...over,
  };
}

/** The same row with B funded by root A. */
function chainedRow(over: Record<string, unknown> = {}) {
  return plainRow({
    funding_row_id: 'fr-ab', funding_holder_id: 'A',
    funding_spend_limit_credits: 300, funding_spent_credits: 50,
    funding_holder_suspended_at: null, funding_wallet_credits: 8000,
    ...over,
  });
}

async function build(): Promise<FamilyService> {
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      FamilyService,
      {provide: DatabaseService, useValue: mockDb},
      {provide: GeocodeService, useValue: mockGeocode},
      {provide: BookingPushBridge, useValue: mockPush},
      {provide: OpsAuditService, useValue: mockOpsAudit},
      {provide: FamilyQuotaService, useValue: mockQuota},
    ],
  }).compile();
  return module.get(FamilyService);
}

describe('B-854 — resolvePayer, the chain matrix', () => {
  let svc: FamilyService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockDb.q.mockReset();
    mockDb.qOne.mockReset();
    mockDb.withTransaction.mockReset();
    mockDb.q.mockResolvedValue([]);
    svc = await build();
  });

  it('OFF — no funding row is today, unchanged: the member\'s own root pays', async () => {
    mockDb.q.mockResolvedValue([plainRow()]);
    const p = await svc.resolvePayer('C');
    expect(p.payerId).toBe('B');
    expect(p.holderId).toBe('B');
    expect(p.familyRowId).toBe('fr-bc');
    expect(p.fundingRowId).toBeNull();
    expect(p.fundingHolderId).toBeNull();
    expect(p.viaUserId).toBeNull();
  });

  it('ON — the WALLET is the higher root, the SHOWN root stays the member\'s own', async () => {
    mockDb.q.mockResolvedValue([chainedRow()]);
    const p = await svc.resolvePayer('C');
    // A4 — the split. `payerId` is the wallet the debit lands on…
    expect(p.payerId).toBe('A');
    expect(p.fundingHolderId).toBe('A');
    expect(p.fundingRowId).toBe('fr-ab');
    expect(p.viaUserId).toBe('B');
    // …and every SHOWN field is still the intermediary (LM-B7).
    expect(p.holderId).toBe('B');
    expect(p.holderName).toBe('Bee');
    expect(p.familyRowId).toBe('fr-bc');
    // A5 — the second ceiling rides out so the charge sites can check both.
    expect(p.fundingSpendLimit).toBe(300);
    expect(p.fundingSpent).toBe(50);
  });

  it('A SUSPENDED — chained, and `holderSuspended` is the WALLET owner\'s', async () => {
    // A5 / B-843 A21 inverted: this must NOT silently hop to the intermediary's
    // wallet. It stays chained, and the charge site answers
    // ROOT_ACCOUNT_SUSPENDED naming the member's own root.
    mockDb.q.mockResolvedValue([chainedRow({funding_holder_suspended_at: new Date()})]);
    const p = await svc.resolvePayer('C');
    expect(p.payerId).toBe('A');
    expect(p.holderSuspended).toBe(true);
    expect(p.holderId).toBe('B');
  });

  it('B SUSPENDED — the chain is already gone in SQL, so the plain hop answers', async () => {
    // The lateral filters `h.suspended_at IS NULL`, so a suspended intermediary
    // arrives with no funding columns at all; `holderSuspended` is then theirs.
    mockDb.q.mockResolvedValue([plainRow({holder_suspended_at: new Date()})]);
    const p = await svc.resolvePayer('C');
    expect(p.payerId).toBe('B');
    expect(p.fundingRowId).toBeNull();
    expect(p.holderSuspended).toBe(true);
  });

  it('A2 — a chain whose WALLET is the SPENDER is refused: plain hop, never a self-charge', async () => {
    // Mutual funders make this reachable (A funds B's members, B funds A's
    // members, and A is itself a member of B). Charging C for C's own booking
    // would consume two caps and then strand both: `reverseFamilySpend`'s
    // (member === holder) early return never reverses them.
    mockDb.q.mockResolvedValue([chainedRow({funding_holder_id: 'C'})]);
    const p = await svc.resolvePayer('C');
    expect(p.payerId).toBe('B');
    expect(p.fundingRowId).toBeNull();
    expect(p.viaUserId).toBeNull();
  });

  it('P2-5 — a chain whose SHOWN root is the spender is refused too, symmetric with the charge sites', async () => {
    // The charge sites reject `via === client` alongside `wallet === client`;
    // the resolver rejected only the second. A membership row cannot have
    // holder === member by construction, so this is depth rather than a live
    // hole — but a resolver that would happily HAND the charge sites a shape
    // they refuse is the asymmetry that gets "fixed" in the wrong place later.
    mockDb.q.mockResolvedValue([chainedRow({holder_id: 'C'})]);
    const p = await svc.resolvePayer('C');
    expect(p.fundingRowId).toBeNull();
    expect(p.viaUserId).toBeNull();
    expect(p.payerId).toBe('C');
  });

  it('a chosen root resolves the chain too (the member picks B, the money comes from A)', async () => {
    mockDb.q.mockResolvedValue([chainedRow()]);
    const p = await svc.resolvePayer('C', 'B');
    expect(p.payerId).toBe('A');
    expect(p.holderId).toBe('B');
    expect(p.viaUserId).toBe('B');
  });
});

describe('B-854 (A12) — PayerOption.effectiveSpendable is the three-way min', () => {
  let svc: FamilyService;
  beforeEach(async () => {
    jest.clearAllMocks();
    mockDb.q.mockReset(); mockDb.qOne.mockReset();
    mockDb.q.mockResolvedValue([]);
    svc = await build();
  });

  it('min(member remaining, funding remaining, paying wallet)', async () => {
    // remaining C = 500 - 100 = 400; remaining B = 300 - 50 = 250; wallet A = 8000.
    mockDb.q.mockResolvedValue([chainedRow()]);
    const [opt] = await svc.payerOptions('C');
    expect(opt.effectiveSpendable).toBe(250);
    // The member's OWN quota figures are unchanged — they are B's row, not A's.
    expect(opt.spendLimit).toBe(500);
    expect(opt.remaining).toBe(400);
    expect(opt.holderId).toBe('B');
  });

  it('the paying WALLET is the ceiling when it is the smallest', async () => {
    mockDb.q.mockResolvedValue([chainedRow({funding_wallet_credits: 90})]);
    const [opt] = await svc.payerOptions('C');
    expect(opt.effectiveSpendable).toBe(90);
  });

  it('a suspended WALLET owner makes it 0 — but never appears as `rootSuspended`', async () => {
    mockDb.q.mockResolvedValue([chainedRow({funding_holder_suspended_at: new Date()})]);
    const [opt] = await svc.payerOptions('C');
    expect(opt.effectiveSpendable).toBe(0);
    // LM-B7 — naming it would tell the member about an account above their own.
    expect(opt.rootSuspended).toBe(false);
  });

  it('un-chained, it is the pre-B-854 two-way min against the shown root\'s wallet', async () => {
    mockDb.q.mockResolvedValue([plainRow({root_credits: 250})]);
    const [opt] = await svc.payerOptions('C');
    expect(opt.effectiveSpendable).toBe(250);
  });

  it('an UNLIMITED funding quota drops out of the min instead of zeroing it', async () => {
    mockDb.q.mockResolvedValue([chainedRow({funding_spend_limit_credits: null})]);
    const [opt] = await svc.payerOptions('C');
    expect(opt.effectiveSpendable).toBe(400);
  });
});

describe('B-854 (A5) — familyCapRefusal reports the TIGHTER cap', () => {
  const base = {familyRowId: 'fr-bc', spendLimit: 500, spent: 100, fundingRowId: 'fr-ab'};

  it('null when both caps clear', () => {
    expect(familyCapRefusal({...base, fundingSpendLimit: 300, fundingSpent: 50}, 10)).toBeNull();
  });

  it('the MEMBER cap blocks — its figures are the ones reported', () => {
    const r = familyCapRefusal({...base, spent: 480, fundingSpendLimit: 300, fundingSpent: 0}, 50);
    expect(r).toEqual({required: 50, allocated: 500, used: 480, remaining: 20});
  });

  it('the FUNDING cap blocks — the member is not sent to ask the wrong person', () => {
    const r = familyCapRefusal({...base, spent: 0, fundingSpendLimit: 300, fundingSpent: 290}, 50);
    expect(r).toEqual({required: 50, allocated: 300, used: 290, remaining: 10});
  });

  it('BOTH block — the smaller REMAINING wins, not the smaller limit', () => {
    // Member: limit 500, spent 480 → remaining 20. Funding: limit 300, spent
    // 295 → remaining 5. The generous-but-exhausted allowance blocks sooner.
    const r = familyCapRefusal({...base, spent: 480, fundingSpendLimit: 300, fundingSpent: 295}, 50);
    expect(r?.allocated).toBe(300);
    expect(r?.remaining).toBe(5);
  });

  it('no funding ROW means the funding figures are ignored entirely', () => {
    const r = familyCapRefusal(
      {familyRowId: 'fr-bc', spendLimit: 500, spent: 0, fundingRowId: null,
       fundingSpendLimit: 1, fundingSpent: 1}, 50,
    );
    expect(r).toBeNull();
  });

  it('a self-paid booking has no family cap at all', () => {
    expect(familyCapRefusal({familyRowId: null, spendLimit: 1, spent: 99}, 50)).toBeNull();
  });
});

describe('B-854 (A11) — request / approve / decline / off', () => {
  let svc: FamilyService;

  /** The membership row a funding action is about: (holder = A, member = B). */
  const AB = {
    id: 'fr-ab', holder_id: 'A', member_id: 'B', status: 'active',
    funds_sub_members: false, spent_credits: 50,
  };

  function route(opts: {
    row?: Record<string, unknown> | null;
    checks?: {holds: number; cycle: number; other: number};
    insert?: {id: string} | null;
    decided?: {id: string} | null;
    inflight?: number;
  } = {}) {
    const checks = opts.checks ?? {holds: 2, cycle: 0, other: 0};
    mockDb.qOne.mockImplementation(async (sql: string) => {
      const s = String(sql).replace(/\s+/g, ' ');
      if (/SELECT id, holder_id, member_id, status, funds_sub_members, spent_credits FROM public\.family_members/.test(s)) {
        return opts.row === undefined ? AB : opts.row;
      }
      if (/INSERT INTO public\.family_funding_requests/.test(s)) {
        return opts.insert === undefined ? {id: 'req-1'} : opts.insert;
      }
      if (/SELECT id FROM public\.family_funding_requests/.test(s)) {return {id: 'req-open'};}
      if (/UPDATE public\.family_funding_requests/.test(s)) {
        return opts.decided === undefined ? {id: 'req-1'} : opts.decided;
      }
      if (/COUNT\(\*\)::int AS n FROM public\.lite_bookings/.test(s)) {
        return {n: opts.inflight ?? 0};
      }
      return null;
    });
    mockDb.q.mockImplementation(async (sql: string) => {
      const s = String(sql).replace(/\s+/g, ' ');
      if (/AS holds/.test(s)) {return [checks];}
      if (/FROM public\.family_funding_requests r/.test(s)) {
        return [{
          id: 'req-1', family_row_id: 'fr-ab', holder_id: 'A', member_id: 'B',
          holder_name: 'Ay', member_name: 'Bee', status: 'pending', reason: null,
          decision_reason: null, created_at: new Date(), decided_at: null, expires_at: new Date(),
        }];
      }
      return [];
    });
    mockDb.withTransaction.mockImplementation((fn: (t: unknown) => unknown) =>
      fn({q: mockDb.q, qOne: mockDb.qOne}));
  }

  beforeEach(async () => {
    jest.clearAllMocks();
    mockDb.q.mockReset(); mockDb.qOne.mockReset(); mockDb.withTransaction.mockReset();
    svc = await build();
  });

  it('the member asks, and the ROOT is the one woken', async () => {
    route();
    const dto = await svc.requestFundMembers('B', 'fr-ab');
    expect(dto.id).toBe('req-1');
    // The ROW id rides along so the holder's tap focuses the right roster row.
    expect(mockPush.familyFundingRequested).toHaveBeenCalledWith('A', 'fr-ab', 'req-1');
    // The switch is NOT flipped by asking — that is the whole point of A11.
    const flips = mockDb.q.mock.calls.filter(c => /funds_sub_members = true/.test(String(c[0])));
    expect(flips).toHaveLength(0);
    expect(mockQuota.recordFundingAudit).toHaveBeenCalledWith(
      expect.objectContaining({action: 'FUND_MEMBERS_REQUESTED', familyRowId: 'fr-ab', actorId: 'B'}),
    );
  });

  it('a member who holds NOBODY has nothing to fund', async () => {
    route({checks: {holds: 0, cycle: 0, other: 0}});
    await expect(svc.requestFundMembers('B', 'fr-ab')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('A2 — a reciprocal funding row is a 409 funding_cycle', async () => {
    route({checks: {holds: 2, cycle: 1, other: 0}});
    await expect(svc.requestFundMembers('B', 'fr-ab'))
      .rejects.toMatchObject({response: {code: 'FUNDING_CYCLE'}});
  });

  it('D1 — a SECOND funding root is a 409 funding_source_already_set', async () => {
    route({checks: {holds: 2, cycle: 0, other: 1}});
    await expect(svc.requestFundMembers('B', 'fr-ab'))
      .rejects.toMatchObject({response: {code: 'FUNDING_SOURCE_ALREADY_SET'}});
  });

  it('a NON-ACTIVE row cannot be asked about', async () => {
    route({row: {...AB, status: 'revoked'}});
    await expect(svc.requestFundMembers('B', 'fr-ab'))
      .rejects.toMatchObject({response: {code: 'MEMBER_NOT_ACTIVE'}});
  });

  it('a foreign membership row is a 404, never a request against another family', async () => {
    route({row: null});
    await expect(svc.requestFundMembers('B', 'fr-ab')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('a second ask while one is open carries the OPEN request id', async () => {
    route({insert: null});
    await expect(svc.requestFundMembers('B', 'fr-ab'))
      .rejects.toMatchObject({response: {code: 'FUNDING_REQUEST_PENDING', requestId: 'req-open'}});
  });

  it('approve flips the switch, closes the request and tells BOTH sides', async () => {
    route();
    const r = await svc.approveFundMembers('A', 'fr-ab', {actorId: 'A', actorRole: 'CLIENT'});
    expect(r).toMatchObject({ok: true, fundsSubMembers: true, requestId: 'req-1'});
    const flips = mockDb.q.mock.calls.filter(c => /funds_sub_members = true/.test(String(c[0])));
    expect(flips).toHaveLength(1);
    // The card the member is looking at is addressed by ROW id — they may be
    // under several roots, and a request id alone highlights nothing.
    expect(mockPush.familyFundingDecided).toHaveBeenCalledWith('B', 'fr-ab', 'req-1', 'approved');
    expect(mockPush.familyFundingChanged).toHaveBeenCalledWith('B', 'fr-ab', true);
    expect(mockPush.familyFundingChanged).toHaveBeenCalledWith('A', 'fr-ab', true);
    // The audit row is written INSIDE the transaction that flips the switch.
    expect(mockQuota.recordFundingAudit).toHaveBeenCalledWith(
      expect.objectContaining({action: 'FUND_MEMBERS_APPROVED', on: expect.anything()}),
    );
  });

  it('approve RE-CHECKS eligibility under the lock — a stale request cannot slip through', async () => {
    route({checks: {holds: 2, cycle: 0, other: 1}});
    await expect(svc.approveFundMembers('A', 'fr-ab', {actorId: 'A', actorRole: 'CLIENT'}))
      .rejects.toBeInstanceOf(ConflictException);
    expect(mockDb.q.mock.calls.filter(c => /funds_sub_members = true/.test(String(c[0])))).toHaveLength(0);
  });

  it('decline closes the ask and leaves the switch alone', async () => {
    route();
    await svc.declineFundMembers('A', 'fr-ab', {actorId: 'A', actorRole: 'CLIENT'});
    expect(mockDb.q.mock.calls.filter(c => /funds_sub_members = true/.test(String(c[0])))).toHaveLength(0);
    expect(mockPush.familyFundingDecided).toHaveBeenCalledWith('B', 'fr-ab', 'req-1', 'declined');
    expect(mockQuota.recordFundingAudit).toHaveBeenCalledWith(
      expect.objectContaining({action: 'FUND_MEMBERS_DECLINED'}),
    );
  });

  it('A10 — OFF is REFUSED with the count while chained bookings are in flight', async () => {
    route({inflight: 3});
    await expect(svc.setFundMembersOff('A', 'fr-ab', {actorId: 'A', actorRole: 'CLIENT'}))
      .rejects.toMatchObject({response: {code: 'CHAINED_BOOKINGS_IN_FLIGHT', count: 3}});
    expect(mockDb.q.mock.calls.filter(c => /funds_sub_members = false/.test(String(c[0])))).toHaveLength(0);
  });

  it('A10 — only OPS may force it through, and the audit says so', async () => {
    route({inflight: 3});
    const r = await svc.setFundMembersOff('A', 'fr-ab',
      {actorId: 'admin-1', actorRole: 'SUPERVISOR', actorCall: 'BRV-1', force: true});
    expect(r).toMatchObject({ok: true, fundsSubMembers: false});
    expect(mockQuota.recordFundingAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'FUND_MEMBERS_OFF',
      metadata: expect.objectContaining({actor_role: 'SUPERVISOR', actor_call: 'BRV-1', forced: true}),
    }));
  });

  it('B-832 trap — an OPS flip files the ops-feed row with the REAL role', async () => {
    route();
    await svc.approveFundMembers('A', 'fr-ab',
      {actorId: 'admin-1', actorRole: 'ADMIN', actorCall: 'BRV-9'});
    const feed = mockOpsAudit.record.mock.calls.map(c => c[0] as {actor_role: string});
    expect(feed.length).toBeGreaterThan(0);
    expect(feed.every(f => f.actor_role === 'ADMIN')).toBe(true);
    // Hard-coding CLIENT on the mirror is the live defect this guards.
    expect(feed.some(f => f.actor_role === 'CLIENT')).toBe(false);
  });

  /**
   * P1-2 — consent. The switch is a grant of the ROOT's money, and A11 says it
   * is off until the root COMMITS to an ask that was actually made. A holder
   * route that flips it with no request on file is a second, weaker door to the
   * same grant: it can be driven by a stale client, and it leaves the member
   * with no record that they ever asked. Ops keeps the requestless path because
   * a support desk acts for a root who asked by phone, and that act is audited
   * against an operator.
   */
  it('P1-2 — a CLIENT approve with NO request on file is refused, and flips nothing', async () => {
    route({decided: null});
    await expect(svc.approveFundMembers('A', 'fr-ab', {actorId: 'A', actorRole: 'CLIENT'}))
      .rejects.toMatchObject({response: {code: 'NO_FUNDING_REQUEST'}});
    expect(mockDb.q.mock.calls.filter(c => /funds_sub_members = true/.test(String(c[0])))).toHaveLength(0);
    expect(mockPush.familyFundingChanged).not.toHaveBeenCalled();
  });

  it('P1-2 — OPS may still approve with no request (the support-desk lane)', async () => {
    route({decided: null});
    const r = await svc.approveFundMembers('A', 'fr-ab',
      {actorId: 'admin-1', actorRole: 'SUPERVISOR', actorCall: 'BRV-1'});
    expect(r).toMatchObject({ok: true, fundsSubMembers: true, requestId: null});
    expect(mockDb.q.mock.calls.filter(c => /funds_sub_members = true/.test(String(c[0])))).toHaveLength(1);
  });

  /**
   * P1-2 — the MEMBER may switch it off too.
   *
   * The allowance the chain spends is the member's own. A grant they asked for
   * and can no longer supervise, that only the root can withdraw, is a
   * one-way door — and the root is the party least likely to notice that the
   * member's own members have gone rogue.
   */
  it('P1-2 — the MEMBER can switch their own chain off', async () => {
    route({inflight: 0});
    const r = await svc.setFundMembersOffAsMember('B', 'fr-ab', {actorId: 'B', actorRole: 'CLIENT'});
    expect(r).toMatchObject({ok: true, fundsSubMembers: false});
    expect(mockDb.q.mock.calls.filter(c => /funds_sub_members = false/.test(String(c[0])))).toHaveLength(1);
    // BOTH sides hear it — the root owns the money, the member owns the ask.
    expect(mockPush.familyFundingChanged).toHaveBeenCalledWith('B', 'fr-ab', false);
    expect(mockPush.familyFundingChanged).toHaveBeenCalledWith('A', 'fr-ab', false);
    expect(mockQuota.recordFundingAudit).toHaveBeenCalledWith(
      expect.objectContaining({action: 'FUND_MEMBERS_OFF', actorId: 'B'}),
    );
  });

  it('P1-2 — the member\'s OFF obeys the SAME in-flight refusal, and cannot force', async () => {
    route({inflight: 2});
    await expect(svc.setFundMembersOffAsMember('B', 'fr-ab',
      {actorId: 'B', actorRole: 'CLIENT', force: true}))
      .rejects.toMatchObject({response: {code: 'CHAINED_BOOKINGS_IN_FLIGHT', count: 2}});
  });

  it('P1-2 — the member route is scoped by MEMBER id, so a root\'s row is a 404', () => {
    const s = src();
    const at = s.indexOf('async setFundMembersOffAsMember(');
    expect(at).toBeGreaterThan(-1);
    const body = s.slice(at, at + 700);
    expect(body).toMatch(/memberId: memberUserId/);
    expect(body).not.toMatch(/holderId: memberUserId/);
    // `force` is an OPS override; a member must not be able to send it.
    expect(body).toMatch(/force: false/);
  });

  it('P3 — decline and OFF refuse a NON-ACTIVE row, with no audit and no push', async () => {
    route({row: {...AB, status: 'revoked'}});
    await expect(svc.declineFundMembers('A', 'fr-ab', {actorId: 'A', actorRole: 'CLIENT'}))
      .rejects.toMatchObject({response: {code: 'MEMBER_NOT_ACTIVE'}});
    await expect(svc.setFundMembersOff('A', 'fr-ab', {actorId: 'A', actorRole: 'CLIENT'}))
      .rejects.toMatchObject({response: {code: 'MEMBER_NOT_ACTIVE'}});
    expect(mockQuota.recordFundingAudit).not.toHaveBeenCalled();
    expect(mockPush.familyFundingDecided).not.toHaveBeenCalled();
    expect(mockPush.familyFundingChanged).not.toHaveBeenCalled();
  });

  it('P2-3 — the OFF in-flight check and the flip are ONE transaction, row locked', () => {
    const s = src();
    const at = s.indexOf('private async turnFundingOff(');
    expect(at).toBeGreaterThan(-1);
    const body = s.slice(at, at + 2200);
    // A check-then-write across two connections lets a charge land between
    // them: the count reads 0, the accept charges, the flip commits, and the
    // booking is cancelled hours later with the switch already off.
    expect(body).toMatch(/withTransaction/);
    const lockAt = body.indexOf('FOR UPDATE');
    const countAt = body.indexOf('COUNT(*)::int AS n FROM public.lite_bookings');
    const flipAt = body.indexOf('funds_sub_members = false');
    expect(lockAt).toBeGreaterThan(-1);
    expect(lockAt).toBeLessThan(countAt);
    expect(countAt).toBeLessThan(flipAt);
  });

  it('OFF with no chained bookings just flips it', async () => {
    route({inflight: 0});
    await svc.setFundMembersOff('A', 'fr-ab', {actorId: 'A', actorRole: 'CLIENT'});
    expect(mockDb.q.mock.calls.filter(c => /funds_sub_members = false/.test(String(c[0])))).toHaveLength(1);
    expect(mockPush.familyFundingChanged).toHaveBeenCalledWith('B', 'fr-ab', false);
    expect(mockPush.familyFundingChanged).toHaveBeenCalledWith('A', 'fr-ab', false);
  });
});

/**
 * B-854 — the funding ask, as the TWO rosters report it.
 *
 * Both sides show the LATEST ask whatever its state, not just an open one. A
 * declined ask has to be representable ("Declined — ask again"): reporting only
 * `pending` makes a decline indistinguishable from never having asked, so the
 * member's card offers a button that files a duplicate the root already said no
 * to. `funds_sub_members` being true implies approved regardless of what the
 * request row says — the switch is the authority, the ask is the history.
 *
 * The status is DERIVED from the expiry, never trusted from the column: the
 * expiry sweep is lazy (no cron), so a row sits at 'pending' long past it.
 */
describe('B-854 — the holder roster carries the latest ask + the chained spend', () => {
  let svc: FamilyService;

  const ROSTER = (over: Record<string, unknown> = {}) => ({
    id: 'fr-ab', member_id: 'B', invite_phone: null, status: 'active',
    held_until: null, spend_limit_credits: 500, spent_credits: 120,
    invited_at: new Date('2026-09-01T00:00:00Z'), accepted_at: null,
    display_name: 'Bee', avatar_url: null, email: null, phone_e164: '+971500000001',
    funds_sub_members: true, holds_members_count: 3, spent_by_members: 80,
    funding_request_id: 'req-1', funding_request_status: 'declined',
    funding_request_created_at: new Date('2026-09-05T00:00:00Z'),
    funding_request_expires_at: new Date('2026-09-12T00:00:00Z'),
    loc_lat: null, loc_lng: null, loc_label: null, loc_accuracy_m: null, loc_recorded_at: null,
    ...over,
  });

  function routeRoster(row: Record<string, unknown>): void {
    mockDb.q.mockResolvedValue([row]);
    mockDb.qOne.mockImplementation(async (sql: string) => {
      const s = String(sql).replace(/\s+/g, ' ');
      if (/FILTER \(WHERE status = 'active'\)/.test(s)) {return {active: 1, pending: 0, held: 0};}
      return {n: 1};
    });
  }

  beforeEach(async () => {
    jest.clearAllMocks();
    mockDb.q.mockReset(); mockDb.qOne.mockReset();
    svc = await build();
  });

  it('reports the LATEST ask with its state, not just an open one', async () => {
    routeRoster(ROSTER());
    const {members} = await svc.listMembers('A');
    expect(members[0].fundingRequest).toEqual({
      id: 'req-1', status: 'declined', createdAt: '2026-09-05T00:00:00.000Z',
    });
  });

  it('a PENDING row past its expiry reports `expired` (the sweep is lazy)', async () => {
    routeRoster(ROSTER({
      funding_request_status: 'pending',
      funding_request_expires_at: new Date(Date.now() - 86_400_000),
    }));
    const {members} = await svc.listMembers('A');
    expect(members[0].fundingRequest?.status).toBe('expired');
  });

  it('a PENDING row inside its window still reports `pending`', async () => {
    routeRoster(ROSTER({
      funding_request_status: 'pending',
      funding_request_expires_at: new Date(Date.now() + 86_400_000),
    }));
    const {members} = await svc.listMembers('A');
    expect(members[0].fundingRequest?.status).toBe('pending');
  });

  it('no ask at all is null, never a half-built object', async () => {
    routeRoster(ROSTER({
      funding_request_id: null, funding_request_status: null,
      funding_request_created_at: null, funding_request_expires_at: null,
    }));
    const {members} = await svc.listMembers('A');
    expect(members[0].fundingRequest).toBeNull();
  });

  it('carries spentByMembers so the root sees what the chain cost, on the same row', async () => {
    routeRoster(ROSTER());
    const {members} = await svc.listMembers('A');
    expect(members[0].spentByMembers).toBe(80);
    expect(members[0].fundsSubMembers).toBe(true);
    expect(members[0].holdsMembersCount).toBe(3);
  });

  it('spentByMembers is 0, never null, when the chain has never been used', async () => {
    routeRoster(ROSTER({funds_sub_members: false, spent_by_members: null}));
    const {members} = await svc.listMembers('A');
    expect(members[0].spentByMembers).toBe(0);
  });
});

describe('B-854 — the MEMBER card carries the latest ask too', () => {
  let svc: FamilyService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockDb.q.mockReset(); mockDb.qOne.mockReset();
    svc = await build();
  });

  function routeMemberships(funding: Record<string, unknown>[]): void {
    mockDb.q.mockImplementation(async (sql: string) => {
      const s = String(sql).replace(/\s+/g, ' ');
      if (/FROM public\.family_funding_requests/.test(s)) {return funding;}
      if (/FROM public\.family_credit_requests/.test(s)) {return [];}
      return [chainedRow({funds_sub_members: false, spent_by_members: 0, holds_members_count: 2})];
    });
  }

  it('a DECLINED ask is visible, so the card can say "ask again" instead of offering a duplicate', async () => {
    routeMemberships([{
      id: 'req-9', family_row_id: 'fr-bc', status: 'declined',
      created_at: new Date('2026-09-05T00:00:00Z'),
      expires_at: new Date('2026-09-12T00:00:00Z'),
    }]);
    const [m] = await svc.myMemberships('C');
    expect(m.fundingRequest).toEqual({
      id: 'req-9', status: 'declined', createdAt: '2026-09-05T00:00:00.000Z',
    });
  });

  it('a stale PENDING ask reports `expired` on this side too — ONE rule, not two', async () => {
    routeMemberships([{
      id: 'req-9', family_row_id: 'fr-bc', status: 'pending',
      created_at: new Date('2026-09-05T00:00:00Z'),
      expires_at: new Date(Date.now() - 1000),
    }]);
    const [m] = await svc.myMemberships('C');
    expect(m.fundingRequest?.status).toBe('expired');
  });

  it('the read is NOT filtered to pending — a decided ask must survive the query', () => {
    // The behavioural tests above pass a fixture straight through, so the
    // filter has to be pinned on the SQL itself or a `status = 'pending'`
    // predicate would make them vacuous.
    //
    // Anchored INSIDE `myMemberships`: the FIRST
    // `FROM public.family_funding_requests` in the file is now the holder
    // roster's lateral, and the naive anchor landed there and failed on code
    // that was already correct (the same first-occurrence trap the escrow scans
    // hit — CLAUDE.md's source-scan rule).
    const s = src();
    const fnAt = s.indexOf('async myMemberships(');
    expect(fnAt).toBeGreaterThan(-1);
    const at = s.indexOf('FROM public.family_funding_requests', fnAt);
    expect(at).toBeGreaterThan(fnAt);
    const stmt = s.slice(at - 400, at + 400);
    expect(stmt).not.toMatch(/family_funding_requests\s+WHERE family_row_id = ANY\(\$1::uuid\[\]\) AND status = 'pending'/);
    // Latest-per-row, deterministically.
    expect(stmt).toMatch(/DISTINCT ON \(family_row_id\)/);
    expect(stmt).toMatch(/ORDER BY family_row_id, created_at DESC, id DESC/);
  });

  it('the HOLDER roster reads the latest ask the same way — unfiltered, newest first', () => {
    const s = src();
    const fnAt = s.indexOf('async listMembers(');
    expect(fnAt).toBeGreaterThan(-1);
    const at = s.indexOf('FROM public.family_funding_requests', fnAt);
    expect(at).toBeGreaterThan(fnAt);
    const stmt = s.slice(at - 200, at + 300);
    // No status predicate at all — the row is chosen by recency, and the
    // reported state comes from `reportedFundingStatus`.
    expect(stmt).not.toMatch(/r\.status = 'pending'/);
    expect(stmt).not.toMatch(/r\.expires_at > NOW\(\)/);
    expect(stmt).toMatch(/ORDER BY r\.created_at DESC, r\.id DESC\s+LIMIT 1/);
  });

  it('ONE expiry rule, shared: both rosters map through reportedFundingStatus', () => {
    const s = src();
    // Two copies of `status === 'pending' && expires <= now` is how the two
    // screens start disagreeing about the same row.
    const uses = [...s.matchAll(/toFundingSummary\(/g)].length;
    expect(uses).toBeGreaterThanOrEqual(3); // the definition + both readers
    expect(s).toContain('export function reportedFundingStatus(');
  });
});

describe('B-854 — the funding-request list shape is identical on both routes', () => {
  let svc: FamilyService;
  const ROW = {
    id: 'req-1', family_row_id: 'fr-ab', holder_id: 'A', member_id: 'B',
    holder_name: 'Ay', member_name: 'Bee', status: 'pending', reason: null,
    decision_reason: null, created_at: new Date('2026-09-05T00:00:00Z'),
    decided_at: null, expires_at: new Date('2026-09-12T00:00:00Z'),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockDb.q.mockReset(); mockDb.qOne.mockReset();
    mockDb.q.mockResolvedValue([ROW]);
    svc = await build();
  });

  it('both carry the contract keys, and the holder/member routes agree field for field', async () => {
    const [h] = await svc.fundingRequestsForHolder('A');
    const [m] = await svc.myFundingRequests('B');
    for (const k of ['id', 'familyRowId', 'holderId', 'memberId', 'status', 'createdAt', 'decidedAt']) {
      expect(h).toHaveProperty(k);
      expect(m).toHaveProperty(k);
    }
    expect(Object.keys(h).sort()).toEqual(Object.keys(m).sort());
    expect(h).toEqual(m);
  });
});

describe('B-854 — the SQL the unit tests cannot execute (source scans)', () => {
  /**
   * The CHAIN lateral, sliced from its own const.
   *
   * `indexOf('LEFT JOIN LATERAL (')` is no longer safe: `listMembers` grew one
   * too (the latest-funding-ask read), and whichever appears first in the file
   * wins. Anchoring on the const name is unambiguous and cannot be re-pointed
   * by an unrelated edit.
   */
  function chainLateral(): string {
    const s = src();
    const at = s.indexOf('const FUNDING_LATERAL = `');
    expect(at).toBeGreaterThan(-1);
    const end = s.indexOf('`;', at);
    expect(end).toBeGreaterThan(at);
    return s.slice(at, end);
  }

  it('the chain read drops a held, inactive, unflagged, suspended or ERASED rung', () => {
    const lateral = chainLateral();
    // Self-check: this really is the chain lateral, not the roster's.
    expect(lateral).toContain('LEFT JOIN LATERAL (');
    expect(lateral).toContain('FROM public.family_members f');
    expect(lateral).toMatch(/AND f\.funds_sub_members/);
    expect(lateral).toMatch(/AND f\.status = 'active'/);
    expect(lateral).toMatch(/AND \(f\.held_until IS NULL OR f\.held_until <= NOW\(\)\)/);
    // The intermediary: suspended OR erased funds nothing. A soft delete clears
    // suspended_at, so BOTH columns are load-bearing (§7 round 1b).
    expect(lateral).toMatch(/AND h\.suspended_at IS NULL/);
    expect(lateral).toMatch(/AND h\.deleted_at IS NULL/);
    // The wallet owner: erased kills the chain, SUSPENDED deliberately does NOT
    // (§21 wants ROOT_ACCOUNT_SUSPENDED, not a silent hop to another wallet).
    expect(lateral).toMatch(/AND fh\.deleted_at IS NULL/);
    expect(lateral).not.toMatch(/AND fh\.suspended_at IS NULL/);
  });

  it('B with TWO roots resolves to exactly one funding row, deterministically', () => {
    expect(chainLateral()).toMatch(/ORDER BY f\.id\s+LIMIT 1/);
  });

  it('A9 — invite() and accept() never set the flag: it is APPROVED, never inherited', () => {
    const s = src();
    const invite = s.slice(s.indexOf('async invite('), s.indexOf('async requestSeats('));
    const accept = s.slice(s.indexOf('async accept('), s.indexOf('async decline('));
    // A membership that arrives already funding sub-members would be a grant
    // nobody made. The column's DEFAULT false is the only way it starts.
    expect(invite).not.toContain('funds_sub_members');
    expect(accept).not.toContain('funds_sub_members');
  });

  it('A9 — revoke clears the switch in the SAME statement that revokes', () => {
    // Two statements would leave a window where a revoked row still funds.
    expect(src()).toMatch(
      /UPDATE public\.family_members SET status = 'revoked', funds_sub_members = false/,
    );
  });

  it('A6 — memberSpend keys on the ROW ID, and the actor arm is legacy-ONLY', () => {
    const s = src();
    const at = s.indexOf('const scope = `');
    expect(at).toBeGreaterThan(-1);
    const scope = s.slice(at, at + 500);
    expect(scope).toMatch(/wt\.metadata->>'family_row_id' = \$2/);
    expect(scope).toMatch(/wt\.metadata->>'via_family_row_id' = \$2/);
    // Gated on the key being ABSENT, or a modern row is counted twice.
    expect(scope).toMatch(/wt\.actor_user_id = \$3 AND NOT \(wt\.metadata \? 'family_row_id'\)/);
  });

  it('A6 — usage() no longer drops a chained charge on the actor-membership test', () => {
    const s = src();
    // Anchored INSIDE `usage()`, not on the first `wt.type = 'payment'` in the
    // file: `myMemberships`'s `spent_by_members` subquery uses the same phrase
    // and a naive anchor lands there and passes VACUOUSLY (it cost this spec a
    // red run — CLAUDE.md's source-scan rule, demonstrated).
    const fnAt = s.indexOf('async usage(');
    expect(fnAt).toBeGreaterThan(-1);
    const at = s.indexOf("wt.type = 'payment' AND wt.amount_credits < 0", fnAt);
    expect(at).toBeGreaterThan(fnAt);
    const stmt = s.slice(at, at + 700);
    // The row-id arm is what lets a sub-member's charge appear on the root's
    // line at all: the actor is not a member of the root.
    expect(stmt).toMatch(/fm\.id::text = wt\.metadata->>'family_row_id'/);
    // …and the old actor test survives only where no metadata exists.
    expect(stmt).toMatch(/NOT \(wt\.metadata \? 'family_row_id'\)/);
    // Compared as TEXT: a ::uuid cast would 22P02 on any malformed historic value.
    expect(stmt).not.toMatch(/\(wt\.metadata->>'family_row_id'\)::uuid/);
  });

  it('A12 — spent_by_members counts only via-keyed rows, on BOTH rosters', () => {
    // The subquery is duplicated (holder roster + member card), so a whole-file
    // scan passes on either one alone. Anchored inside each method's slice.
    const s = src();
    for (const fn of ['async listMembers(', 'async myMemberships(']) {
      const at = s.indexOf(fn);
      expect(at).toBeGreaterThan(-1);
      const body = s.slice(at, at + 4000);
      expect(body).toMatch(/AND wt\.metadata \? 'via_family_row_id'\s+\), 0\)::int AS spent_by_members/);
    }
  });

  it('B-854 — the ops finance query names the ACTOR and the VIA, not just the wallet', () => {
    // A family charge lands on the ROOT's wallet, so without these the console's
    // finance list reads a sub-member's spend as the root's own — and `via_name`
    // is the only field that distinguishes "B spent this" from "C spent this
    // through B" on a row whose `user_id` is A either way.
    const s = readFileSync(join(__dirname, '..', 'ops', 'ops-data.service.ts'), 'utf8')
      .replace(/\r?\n/g, '\n');
    const at = s.indexOf('listWalletTransactions(');
    expect(at).toBeGreaterThan(-1);
    const body = s.slice(at, at + 1600);
    expect(body).toMatch(/au\.display_name AS actor_name/);
    expect(body).toMatch(/vu\.display_name AS via_name/);
    expect(body).toMatch(/LEFT JOIN users vu ON vu\.id = \(t\.metadata->>'via_user_id'\)::uuid/);
  });

  it('P2-1 — the row-id bound to the metadata comparison is lower-cased', () => {
    // `ParseUUIDPipe` accepts an UPPERCASE uuid and hands it through verbatim.
    // Postgres stores `uuid` canonically lower-cased, so `metadata->>'…' = $2`
    // against 'FR-AB…' matches nothing and the spend sheet comes back EMPTY —
    // a silent wrong answer on a money screen, which is worse than an error.
    const s = src();
    const at = s.indexOf('async memberSpend(');
    expect(at).toBeGreaterThan(-1);
    const end = s.indexOf('async usage(', at);
    expect(end).toBeGreaterThan(at);
    const body = s.slice(at, end);
    expect(body).toMatch(/const rowKey = String\(memberRowId\)\.toLowerCase\(\)/);
    // …and it is the lower-cased form that actually reaches Postgres, on BOTH
    // statements. Deriving it and then binding the raw id is the shape that
    // reads as fixed and is not.
    expect(body).toMatch(/\[holderId, rowKey, fm\.member_id, lim\]/);
    expect(body).toMatch(/\[holderId, rowKey, fm\.member_id\]/);
    expect(body).not.toMatch(/\[holderId, memberRowId,/);
  });
});

/**
 * P1-3 — the INTERMEDIARY's own usage rollup.
 *
 * When C spends the root's allowance through B, the ledger row sits on A's
 * wallet. B's `usage()` filters `wt.user_id = $1`, so B — whose `(B,C)` row was
 * bumped by exactly that charge — saw NOTHING in their line items while their
 * totals moved. The via arm drops the wallet predicate for the same reason
 * `memberSpend` does: the row id it matches is one of the caller's OWN family
 * rows, which is a narrower authorisation than the wallet it was paid from.
 */
describe('B-854 (P1-3) — usage() shows the intermediary what their members spent', () => {
  let svc: FamilyService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockDb.q.mockReset(); mockDb.qOne.mockReset();
    mockDb.qOne.mockResolvedValue({total: 300, n: 1});
    svc = await build();
  });

  it('the recent list is NOT confined to the caller\'s own wallet', async () => {
    mockDb.q
      .mockResolvedValueOnce([{id: 'fr-bc', member_id: 'C', invite_phone: null, spent_credits: 300, spend_limit_credits: 1000, display_name: 'Cee'}])
      .mockResolvedValueOnce([{
        amount_credits: -300, created_at: new Date('2026-09-06T00:00:00Z'),
        booking_id: 'b1', display_name: 'Cee', actor_user_id: 'C', via_user_id: 'B',
      }]);
    const out = await svc.usage('B');
    expect(out.recent[0]).toMatchObject({name: 'Cee', credits: 300, actorUserId: 'C', viaUserId: 'B'});
    const sql = (mockDb.q.mock.calls[1][0] as string).replace(/\s+/g, ' ');
    // The via arm exists, and it is OUTSIDE the wallet predicate.
    expect(sql).toContain(`wt.metadata->>'via_family_row_id'`);
    const viaAt = sql.indexOf(`wt.metadata->>'via_family_row_id'`);
    const walletAt = sql.indexOf('wt.user_id = $1');
    expect(walletAt).toBeGreaterThan(-1);
    expect(viaAt).toBeGreaterThan(walletAt);
    // The wallet predicate must no longer be a top-level AND for every row —
    // it is one arm of the OR, or the chained rows are still invisible.
    expect(sql).not.toMatch(/WHERE wt\.user_id = \$1 AND wt\.type = 'payment'/);
  });

  it('the via arm is scoped to the CALLER\'s own family rows, never any via key', async () => {
    mockDb.q.mockResolvedValue([]);
    await svc.usage('B');
    const sql = (mockDb.q.mock.calls[1][0] as string).replace(/\s+/g, ' ');
    // Scoped by an EXISTS over the caller's rows — without it, any ledger row
    // whose via key happened to match would surface on a stranger's rollup.
    //
    // `OR EXISTS`, with NOTHING between them: re-introducing a `wt.user_id = $1`
    // guard on this arm is exactly the bug (the chained row lives on the ROOT's
    // wallet, not the caller's), and it is invisible to a scan that only checks
    // the EXISTS body — which is how the first cut of this pin passed a
    // mutation that put the wallet predicate straight back.
    expect(sql).toMatch(/OR EXISTS \(SELECT 1 FROM public\.family_members (\w+) WHERE \1\.holder_id = \$1 AND \1\.id::text = wt\.metadata->>'via_family_row_id'\)/);
    expect(sql).not.toMatch(/OR \(wt\.user_id = \$1 AND EXISTS/);
  });
});
