/**
 * FamilyQuotaService — the rules that need a database, a lock or an actor.
 *
 * The arithmetic is pinned separately (family-quota.util.spec.ts) and the
 * both-limits gate on the real charge path by booking.mon4-family-cap-lock.spec.ts.
 * What is pinned HERE is everything a pure function cannot see: that the §19
 * check reads a LOCKED row, that approving is atomic and one-shot, that the
 * §12 duplicate gate is the database index rather than a check-then-insert, and
 * that authorisation is derived from stored rows and never from an argument a
 * client controls.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {Test, TestingModule} from '@nestjs/testing';
import {BadRequestException, ForbiddenException, NotFoundException} from '@nestjs/common';
import {DatabaseService}      from '../database/database.service';
import {BookingPushBridge}    from '../ops/booking-push-bridge.service';
import {OpsAuditService}      from '../ops/ops-audit.service';
import {FamilyQuotaService}   from './family-quota.service';

const tx = {q: jest.fn(), qOne: jest.fn()};
const mockDb = {
  q: jest.fn(),
  qOne: jest.fn(),
  // Model the REAL contract: the callback runs, and a throw propagates (the
  // caller still sees it) after a rollback. A double that swallowed the throw
  // would make every "is it refused?" test pass vacuously.
  withTransaction: jest.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
};
const mockPush = {
  familyCreditRequested: jest.fn().mockResolvedValue(undefined),
  familyCreditDecided:   jest.fn().mockResolvedValue(undefined),
  familyQuotaChanged:    jest.fn().mockResolvedValue(undefined),
  familyQuotaThreshold:  jest.fn().mockResolvedValue(undefined),
};
const mockOpsAudit = {record: jest.fn().mockResolvedValue(undefined)};

/** Every SQL statement the code ran, whitespace-collapsed for matching. */
const sqlLog = (): string[] =>
  [...tx.q.mock.calls, ...tx.qOne.mock.calls, ...mockDb.q.mock.calls, ...mockDb.qOne.mock.calls]
    .map(c => String(c[0]).replace(/\s+/g, ' ').trim());

const ranSql = (re: RegExp): boolean => sqlLog().some(s => re.test(s));

const memberRow = (over: Partial<Record<string, unknown>> = {}) => ({
  id: 'fm-1', holder_id: 'u-holder', member_id: 'u-member', status: 'active',
  spend_limit_credits: 5000, spent_credits: 3000, quota_notified_pct: 0, ...over,
});

const requestRow = (over: Partial<Record<string, unknown>> = {}) => ({
  id: 'req-1', family_row_id: 'fm-1', member_id: 'u-member', holder_id: 'u-holder',
  requested_credits: 2000, status: 'pending',
  expires_at: new Date(Date.now() + 86_400_000), ...over,
});

describe('FamilyQuotaService', () => {
  let svc: FamilyQuotaService;

  beforeEach(async () => {
    jest.clearAllMocks();
    // mockReset, not just clearAllMocks: `clearAllMocks` empties the call log but
    // leaves QUEUED `mockResolvedValueOnce` values in place, so a test that
    // queued more values than it consumed silently fed them to the next test.
    // That produced a failure in a test whose own arrangement was correct —
    // exactly the kind of false signal a financial suite must not have.
    for (const m of [tx.q, tx.qOne, mockDb.q, mockDb.qOne, mockDb.withTransaction]) {m.mockReset();}
    tx.q.mockResolvedValue([]);
    tx.qOne.mockResolvedValue(null);
    mockDb.q.mockResolvedValue([]);
    mockDb.qOne.mockResolvedValue(null);
    mockDb.withTransaction.mockImplementation(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx));
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FamilyQuotaService,
        {provide: DatabaseService, useValue: mockDb},
        {provide: BookingPushBridge, useValue: mockPush},
        {provide: OpsAuditService, useValue: mockOpsAudit},
      ],
    }).compile();
    svc = module.get(FamilyQuotaService);
  });

  // ── §19 · the rule this whole change exists for ────────────────────────────

  describe('§19 — a quota can never be reduced below the amount already spent', () => {
    it('REFUSES 5,000 → 4,000 when 4,500 is already spent', async () => {
      tx.qOne.mockResolvedValueOnce(memberRow({spend_limit_credits: 5000, spent_credits: 4500}));
      await expect(svc.setQuota('u-holder', 'fm-1', 4000, 'u-holder'))
        .rejects.toThrow(BadRequestException);
    });

    it('...and the error carries the floor, so §44 can render it', async () => {
      tx.qOne.mockResolvedValueOnce(memberRow({spent_credits: 4500}));
      await svc.setQuota('u-holder', 'fm-1', 4000, 'u-holder').then(
        () => { throw new Error('should have thrown'); },
        (e: BadRequestException) => {
          expect(e.getResponse()).toMatchObject({
            code: 'QUOTA_BELOW_SPENT', minimumCredits: 4500, spentCredits: 4500,
          });
        },
      );
    });

    it('...and writes NOTHING — not the quota, not an audit row', async () => {
      tx.qOne.mockResolvedValueOnce(memberRow({spent_credits: 4500}));
      await expect(svc.setQuota('u-holder', 'fm-1', 4000, 'u-holder')).rejects.toThrow();
      expect(tx.q).not.toHaveBeenCalled();
    });

    it('ALLOWS the legal reduction 5,000 → 4,000 with 3,000 spent', async () => {
      tx.qOne.mockResolvedValueOnce(memberRow({spend_limit_credits: 5000, spent_credits: 3000}));
      const res = await svc.setQuota('u-holder', 'fm-1', 4000, 'u-holder');
      expect(res).toMatchObject({previousLimit: 5000, newLimit: 4000, spent: 3000, remaining: 1000});
    });

    it('allows reducing to exactly the spent amount (the minimum)', async () => {
      tx.qOne.mockResolvedValueOnce(memberRow({spent_credits: 4500}));
      const res = await svc.setQuota('u-holder', 'fm-1', 4500, 'u-holder');
      expect(res).toMatchObject({newLimit: 4500, remaining: 0});
    });

    it('reads the member row FOR UPDATE — the check is against a LOCKED value', async () => {
      // Without the lock a concurrent charge can bump spent_credits between the
      // read and the write, and the decision is made on a stale number.
      tx.qOne.mockResolvedValueOnce(memberRow());
      await svc.setQuota('u-holder', 'fm-1', 4000, 'u-holder');
      expect(ranSql(/SELECT .*FROM public\.family_members.*FOR UPDATE/i)).toBe(true);
    });

    it('runs the whole change inside ONE transaction (§7)', async () => {
      tx.qOne.mockResolvedValueOnce(memberRow());
      await svc.setQuota('u-holder', 'fm-1', 6000, 'u-holder');
      expect(mockDb.withTransaction).toHaveBeenCalledTimes(1);
    });
  });

  describe('§18/§37 — quota changes are audited, never silently overwritten', () => {
    it('writes a family_quota_audit row with previous AND new values', async () => {
      tx.qOne.mockResolvedValueOnce(memberRow({spend_limit_credits: 5000, spent_credits: 3000}));
      await svc.setQuota('u-holder', 'fm-1', 7000, 'u-holder', 'birthday');
      const audit = tx.q.mock.calls.find(c => /family_quota_audit/i.test(String(c[0])));
      expect(audit).toBeDefined();
      // [family_row, holder, member, actor, action, prev, next, delta, spent, req, reason, metadata]
      // A3 — metadata is where the ops-vs-holder discriminator lives; the app
      // path sends none, so it is an empty object, never NULL (the column is NOT NULL).
      expect(audit![1]).toEqual(
        ['fm-1', 'u-holder', 'u-member', 'u-holder', 'QUOTA_INCREASED', 5000, 7000, 2000, 3000, null, 'birthday', '{}'],
      );
    });

    it('records a DECREASE as such, with a negative delta', async () => {
      tx.qOne.mockResolvedValueOnce(memberRow({spend_limit_credits: 5000, spent_credits: 1000}));
      await svc.setQuota('u-holder', 'fm-1', 4000, 'u-holder');
      const audit = tx.q.mock.calls.find(c => /family_quota_audit/i.test(String(c[0])));
      expect(audit![1][4]).toBe('QUOTA_DECREASED');
      expect(audit![1][7]).toBe(-1000);
    });

    it('audits in the SAME transaction as the quota write (§7 — all or nothing)', async () => {
      tx.qOne.mockResolvedValueOnce(memberRow());
      await svc.setQuota('u-holder', 'fm-1', 6000, 'u-holder');
      // Both statements ran on the tx handle, not the pooled connection.
      expect(tx.q.mock.calls.filter(c => /family_members|family_quota_audit/i.test(String(c[0]))).length).toBe(2);
      expect(mockDb.q).not.toHaveBeenCalled();
    });

    it('notifies the member that their limit changed (§33)', async () => {
      tx.qOne.mockResolvedValueOnce(memberRow());
      await svc.setQuota('u-holder', 'fm-1', 7000, 'u-holder');
      expect(mockPush.familyQuotaChanged).toHaveBeenCalledWith('u-member', 'fm-1');
    });
  });

  describe('§38/§40 — a foreign member row is not reachable', () => {
    it('404s rather than revealing that another family\'s row exists', async () => {
      // The lock query is scoped `id = $1 AND holder_id = $2`, so a wrong holder
      // simply finds nothing.
      tx.qOne.mockResolvedValueOnce(null);
      await expect(svc.setQuota('u-attacker', 'fm-1', 9999, 'u-attacker'))
        .rejects.toThrow(NotFoundException);
    });

    it('scopes the lock by holder_id, not by member row id alone', async () => {
      tx.qOne.mockResolvedValueOnce(memberRow());
      await svc.setQuota('u-holder', 'fm-1', 6000, 'u-holder');
      expect(ranSql(/WHERE id = \$1 AND holder_id = \$2/i)).toBe(true);
    });
  });

  // ── §11/§12 · requesting ───────────────────────────────────────────────────

  describe('§11 — a member requests additional credit', () => {
    // B-843 — the membership lookup is now a LIST (`db.q`), because "the
    // member's membership" is ambiguous once they belong to several roots.
    const membershipRows = (...rows: Array<Record<string, unknown>>) =>
      mockDb.q.mockResolvedValueOnce(rows);
    const requestRowOut = (over: Record<string, unknown> = {}) => ({
      id: 'req-1', family_row_id: 'fm-1', holder_id: 'u-holder', member_id: 'u-member',
      member_name: 'Alice', holder_name: 'Root A', requested_credits: 2000,
      approved_credits: null, reason: null, status: 'pending', decision_reason: null,
      created_at: new Date(), decided_at: null, expires_at: new Date(), ...over,
    });

    it('resolves the membership from the AUTHENTICATED user, not the body (§38)', async () => {
      membershipRows(memberRow({holder_name: 'Root A', held_until: null, holder_suspended_at: null}));
      mockDb.qOne.mockResolvedValueOnce({id: 'req-1'});                       // insert
      mockDb.q.mockResolvedValueOnce([]).mockResolvedValueOnce([requestRowOut()]);
      await svc.requestCredit('u-member', 2000, 'school fees');
      const membershipQuery = mockDb.q.mock.calls[0];
      expect(String(membershipQuery[0]).replace(/\s+/g, ' '))
        .toMatch(/fm\.member_id = \$1 AND fm\.status = 'active'/);
      expect(membershipQuery[1]).toEqual(['u-member']);
    });

    it('rejects a non-member', async () => {
      membershipRows();
      await expect(svc.requestCredit('u-stranger', 2000)).rejects.toThrow(NotFoundException);
    });

    it.each([0, -100, 1.5, NaN, Infinity])('rejects the invalid amount %p (§30)', async amount => {
      await expect(svc.requestCredit('u-member', amount as number)).rejects.toThrow(BadRequestException);
      // Refused before any lookup — nothing about the family is even read.
      expect(mockDb.qOne).not.toHaveBeenCalled();
      expect(mockDb.q).not.toHaveBeenCalled();
    });

    it('wakes the holder (§33)', async () => {
      membershipRows(memberRow({holder_name: 'Root A', held_until: null, holder_suspended_at: null}));
      mockDb.qOne.mockResolvedValueOnce({id: 'req-1'});
      mockDb.q.mockResolvedValue([requestRowOut({member_name: null})]);
      await svc.requestCredit('u-member', 2000);
      expect(mockPush.familyCreditRequested).toHaveBeenCalledWith('u-holder', 'req-1');
    });

    // ── B-843 (A13) — WHICH root am I asking? ────────────────────────────────

    it('B-843: TWO roots and no holderId → HOLDER_REQUIRED with options and human copy', async () => {
      membershipRows(
        memberRow({holder_name: 'Root A', held_until: null, holder_suspended_at: null}),
        memberRow({id: 'fm-2', holder_id: 'u-root-b', holder_name: 'Root B', held_until: null,
                   spend_limit_credits: null, spent_credits: 0, holder_suspended_at: null}),
      );
      await svc.requestCredit('u-member', 2000).then(
        () => { throw new Error('should have thrown'); },
        (e: BadRequestException) => {
          const body = e.getResponse() as {code: string; message: string; options: unknown[]};
          expect(body.code).toBe('HOLDER_REQUIRED');
          expect(body.message).toBe('Choose which account to ask.');
          expect(body.options).toEqual([
            {holderId: 'u-holder', holderName: 'Root A', spendLimit: 5000, spent: 3000, remaining: 2000, held: false, rootSuspended: false},
            {holderId: 'u-root-b', holderName: 'Root B', spendLimit: null, spent: 0, remaining: null, held: false, rootSuspended: false},
          ]);
        },
      );
      // Nothing was filed — asking the WRONG root is a request the right root
      // never sees, so the refusal must come before the insert.
      expect(ranSql(/INSERT INTO public\.family_credit_requests/i)).toBe(false);
    });

    it('B-843: ONE root and no holderId still works (the pre-B-843 behaviour)', async () => {
      membershipRows(memberRow({holder_name: 'Root A', held_until: null, holder_suspended_at: null}));
      mockDb.qOne.mockResolvedValueOnce({id: 'req-1'});
      mockDb.q.mockResolvedValue([requestRowOut()]);
      await expect(svc.requestCredit('u-member', 2000)).resolves.toMatchObject({id: 'req-1'});
    });

    it('B-843: a holderId scopes the lookup to (member, holder) and files against THAT row', async () => {
      membershipRows(memberRow({id: 'fm-2', holder_id: 'u-root-b', holder_name: 'Root B',
                                held_until: null, holder_suspended_at: null}));
      mockDb.qOne.mockResolvedValueOnce({id: 'req-9'});
      mockDb.q.mockResolvedValue([requestRowOut({id: 'req-9', family_row_id: 'fm-2', holder_id: 'u-root-b'})]);
      await svc.requestCredit('u-member', 2000, null, 'u-root-b');
      const [sql, params] = mockDb.q.mock.calls[0] as [string, unknown[]];
      // Without the holder predicate the "choice" is decorative.
      expect(sql.replace(/\s+/g, ' ')).toContain('AND fm.holder_id = $2');
      expect(params).toEqual(['u-member', 'u-root-b']);
      const ins = mockDb.qOne.mock.calls
        .find(c => /INSERT INTO public\.family_credit_requests/.test(String(c[0]))) as [string, unknown[]];
      expect(ins[1][0]).toBe('fm-2');
      expect(ins[1][1]).toBe('u-root-b');
    });

    it('B-843: a holder the member is NOT under is a 404 NOT_A_FAMILY_MEMBER, never a cross-family file', async () => {
      membershipRows(); // the (member, holder) scope matched nothing
      await svc.requestCredit('u-member', 2000, null, 'u-someone-elses-root').then(
        () => { throw new Error('should have thrown'); },
        (e: NotFoundException) => {
          expect(e).toBeInstanceOf(NotFoundException);
          expect(e.getResponse()).toEqual({
            code: 'NOT_A_FAMILY_MEMBER',
            message: "You're not a member of that account.",
          });
        },
      );
      expect(ranSql(/INSERT INTO public\.family_credit_requests/i)).toBe(false);
    });
  });

  describe('§12 — no duplicate pending requests', () => {
    const oneMembership = () =>
      mockDb.q.mockResolvedValueOnce([memberRow({holder_name: 'Root A', held_until: null, holder_suspended_at: null})]);

    it('refuses a second request while one is open', async () => {
      oneMembership();
      mockDb.qOne
        .mockResolvedValueOnce(null)           // insert lost the ON CONFLICT race
        .mockResolvedValueOnce({id: 'req-existing', requested_credits: 2000}); // findPending
      await expect(svc.requestCredit('u-member', 5000)).rejects.toThrow(BadRequestException);
    });

    it('...and returns the OPEN request id so the UI shows "View Request" (§42)', async () => {
      oneMembership();
      mockDb.qOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({id: 'req-existing', requested_credits: 2000});
      await svc.requestCredit('u-member', 5000).then(
        () => { throw new Error('should have thrown'); },
        (e: BadRequestException) => {
          expect(e.getResponse()).toMatchObject({
            code: 'CREDIT_REQUEST_PENDING', requestId: 'req-existing', requestedCredits: 2000,
          });
        },
      );
    });

    it('enforces it with the partial UNIQUE INDEX, not a check-then-insert', async () => {
      // THE race-safety property: two simultaneous taps both pass any preceding
      // SELECT, but only one can win a unique index.
      oneMembership();
      mockDb.qOne.mockResolvedValueOnce(null)
        .mockResolvedValueOnce({id: 'r', requested_credits: 1});
      await expect(svc.requestCredit('u-member', 5000)).rejects.toThrow();
      expect(ranSql(/INSERT INTO public\.family_credit_requests.*ON CONFLICT \(family_row_id\) WHERE status = 'pending' DO NOTHING/i)).toBe(true);
    });
  });

  // B-843 (A13) — a member under several roots sees several requests in one
  // list and cannot otherwise tell which root each one was addressed to.
  describe('B-843 — every request projection names its ROOT', () => {
    const dbRow = (over: Record<string, unknown> = {}) => ({
      id: 'req-1', family_row_id: 'fm-1', holder_id: 'u-holder', member_id: 'u-member',
      member_name: 'Alice', holder_name: 'Root A', requested_credits: 2000,
      approved_credits: null, reason: null, status: 'pending', decision_reason: null,
      created_at: new Date('2026-09-01T00:00:00Z'), decided_at: null,
      expires_at: new Date('2026-09-08T00:00:00Z'), ...over,
    });

    it.each([
      ['myRequests',   (s: FamilyQuotaService) => s.myRequests('u-member')],
      ['listRequests', (s: FamilyQuotaService) => s.listRequests('u-holder')],
    ])('%s projects holderName from a LEFT JOIN on the holder', async (_name, call) => {
      mockDb.q.mockResolvedValueOnce([]).mockResolvedValueOnce([dbRow()]);
      const [out] = await call(svc);
      expect(out.holderName).toBe('Root A');
      expect(out.memberName).toBe('Alice');
      // Both joins present and distinct — aliasing them the same way would make
      // holder_name silently echo the member's name.
      expect(ranSql(/LEFT JOIN public\.users u ON u\.id = r\.member_id/i)).toBe(true);
      expect(ranSql(/LEFT JOIN public\.users h ON h\.id = r\.holder_id/i)).toBe(true);
      expect(ranSql(/h\.display_name AS holder_name/i)).toBe(true);
    });

    it('a nameless holder projects null, never the member\'s name', async () => {
      mockDb.q.mockResolvedValueOnce([]).mockResolvedValueOnce([dbRow({holder_name: null})]);
      const [out] = await svc.myRequests('u-member');
      expect(out.holderName).toBeNull();
      expect(out.memberName).toBe('Alice');
    });
  });

  // B-843 (A9) — deleted: it read "the member's active row", which with several
  // roots picks an arbitrary one and can warn a holder about a charge that never
  // touched them. The escrow accept now carries the charged row id out instead.
  describe('B-843 — notifyUsageThresholdForMember is gone', () => {
    it('the member-keyed threshold hook no longer exists', () => {
      expect((svc as unknown as Record<string, unknown>).notifyUsageThresholdForMember).toBeUndefined();
      const strip = (s: string) => s.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
      const src = strip(readFileSync(join(__dirname, 'family-quota.service.ts'), 'utf8'));
      expect(src).not.toContain('notifyUsageThresholdForMember');
      expect(src).toContain('async notifyUsageThreshold(');
    });
  });

  // ── §13-§17 · deciding ─────────────────────────────────────────────────────

  describe('§13/§14 — approval', () => {
    it('adds the approved amount to the quota and records the full audit shape', async () => {
      tx.qOne
        .mockResolvedValueOnce(requestRow({requested_credits: 2000}))
        .mockResolvedValueOnce(memberRow({spend_limit_credits: 5000, spent_credits: 5000}));
      const res = await svc.approveRequest('u-holder', 'req-1');
      // The §13 worked example: 5,000 + 2,000 = 7,000, used stays 5,000.
      expect(res).toMatchObject({approvedCredits: 2000, previousLimit: 5000, newLimit: 7000, partial: false});
      const audit = tx.q.mock.calls.find(c => /family_quota_audit/i.test(String(c[0])));
      expect(audit![1]).toEqual(
        ['fm-1', 'u-holder', 'u-member', 'u-holder', 'CREDIT_APPROVED', 5000, 7000, 2000, 5000, 'req-1', null, '{}'],
      );
    });

    it('supports PARTIAL approval — requested 5,000, approved 2,000 (§14)', async () => {
      tx.qOne
        .mockResolvedValueOnce(requestRow({requested_credits: 5000}))
        .mockResolvedValueOnce(memberRow({spend_limit_credits: 5000, spent_credits: 5000}));
      const res = await svc.approveRequest('u-holder', 'req-1', 2000);
      expect(res).toMatchObject({approvedCredits: 2000, newLimit: 7000, partial: true});
      expect(mockPush.familyCreditDecided).toHaveBeenCalledWith('u-member', 'req-1', 'partially_approved');
    });

    it('refuses approving MORE than was requested', async () => {
      tx.qOne.mockResolvedValueOnce(requestRow({requested_credits: 2000}));
      await expect(svc.approveRequest('u-holder', 'req-1', 9000)).rejects.toThrow(BadRequestException);
    });

    it('locks BOTH the request and the member row before writing (§5)', async () => {
      tx.qOne.mockResolvedValueOnce(requestRow()).mockResolvedValueOnce(memberRow());
      await svc.approveRequest('u-holder', 'req-1');
      expect(ranSql(/FROM public\.family_credit_requests WHERE id = \$1 AND holder_id = \$2 FOR UPDATE/i)).toBe(true);
      expect(ranSql(/FROM public\.family_members WHERE id = \$1 AND holder_id = \$2 FOR UPDATE/i)).toBe(true);
    });

    it('is one-shot: a double tap finds the request already decided', async () => {
      tx.qOne.mockResolvedValueOnce(requestRow({status: 'approved'}));
      await expect(svc.approveRequest('u-holder', 'req-1')).rejects.toThrow(BadRequestException);
      expect(tx.q).not.toHaveBeenCalled();
    });

    it('§51 — approval NEVER touches the root wallet balance', async () => {
      // Raising a quota raises a permission, not a reservation. This is what
      // makes two fast approvals of ৳800 each against a ৳1,000 root balance
      // safe: the balance is enforced again, under a lock, at spend time.
      tx.qOne.mockResolvedValueOnce(requestRow()).mockResolvedValueOnce(memberRow());
      await svc.approveRequest('u-holder', 'req-1');
      expect(ranSql(/wallet_balances|wallet_transactions|escrow/i)).toBe(false);
    });

    it('refuses to "top up" an UNLIMITED quota rather than pretending to', async () => {
      tx.qOne.mockResolvedValueOnce(requestRow()).mockResolvedValueOnce(memberRow({spend_limit_credits: null}));
      await expect(svc.approveRequest('u-holder', 'req-1')).rejects.toThrow(BadRequestException);
    });

    it('refuses to approve for a member who is no longer active (§20)', async () => {
      tx.qOne.mockResolvedValueOnce(requestRow()).mockResolvedValueOnce(memberRow({status: 'revoked'}));
      await expect(svc.approveRequest('u-holder', 'req-1')).rejects.toThrow(BadRequestException);
    });

    it('another holder cannot approve a request that is not theirs (§39)', async () => {
      tx.qOne.mockResolvedValueOnce(null);   // holder-scoped lookup finds nothing
      await expect(svc.approveRequest('u-other-holder', 'req-1')).rejects.toThrow(NotFoundException);
    });
  });

  describe('§15 — rejection', () => {
    it('marks it rejected and does NOT modify the quota', async () => {
      tx.qOne.mockResolvedValueOnce(requestRow());
      await svc.rejectRequest('u-holder', 'req-1', 'not this month');
      expect(ranSql(/UPDATE public\.family_credit_requests SET status = 'rejected'/i)).toBe(true);
      expect(ranSql(/UPDATE public\.family_members/i)).toBe(false);
      expect(mockPush.familyCreditDecided).toHaveBeenCalledWith('u-member', 'req-1', 'rejected');
    });
  });

  describe('§16/§17 — cancellation', () => {
    it('the HOLDER can cancel a pending request', async () => {
      tx.qOne.mockResolvedValueOnce(requestRow());
      await expect(svc.cancelRequest('u-holder', 'req-1')).resolves.toEqual({ok: true});
      expect(mockPush.familyCreditDecided).toHaveBeenCalledWith('u-member', 'req-1', 'cancelled');
    });

    it('the MEMBER can cancel their own pending request', async () => {
      tx.qOne.mockResolvedValueOnce(requestRow());
      await expect(svc.cancelRequest('u-member', 'req-1')).resolves.toEqual({ok: true});
    });

    it('a stranger cannot — 403, because the row exists but is not theirs (§39)', async () => {
      tx.qOne.mockResolvedValueOnce(requestRow());
      await expect(svc.cancelRequest('u-stranger', 'req-1')).rejects.toThrow(ForbiddenException);
      expect(tx.q).not.toHaveBeenCalled();
    });

    it.each(['approved', 'rejected', 'expired', 'cancelled'])(
      'a %s request cannot be cancelled (§17)', async status => {
        tx.qOne.mockResolvedValueOnce(requestRow({status}));
        await expect(svc.cancelRequest('u-member', 'req-1')).rejects.toThrow(BadRequestException);
      },
    );

    it('§16 — a CANCELLED request can never later be approved', async () => {
      tx.qOne.mockResolvedValueOnce(requestRow({status: 'cancelled'}));
      await expect(svc.approveRequest('u-holder', 'req-1')).rejects.toThrow(BadRequestException);
      expect(tx.q).not.toHaveBeenCalled();
    });
  });

  describe('§50 — expiry', () => {
    it('refuses to approve an expired request, and marks it expired', async () => {
      tx.qOne.mockResolvedValueOnce(requestRow({expires_at: new Date(Date.now() - 1000)}));
      await expect(svc.approveRequest('u-holder', 'req-1')).rejects.toThrow(BadRequestException);
      expect(ranSql(/UPDATE public\.family_credit_requests SET status = 'expired' WHERE id = \$1/i)).toBe(true);
      // …and definitely no quota change.
      expect(ranSql(/UPDATE public\.family_members SET spend_limit_credits/i)).toBe(false);
    });
  });

  // ── §20 · lifecycle ────────────────────────────────────────────────────────

  describe('§20 — removing a member', () => {
    it('cancels the open request without deleting any financial history', async () => {
      mockDb.q.mockResolvedValueOnce([{id: 'req-1', member_id: 'u-member'}]);
      await svc.cancelPendingOnRevoke('fm-1', 'u-holder');
      expect(ranSql(/UPDATE public\.family_credit_requests SET status = 'cancelled'.*WHERE family_row_id = \$1 AND status = 'pending'/i)).toBe(true);
      // Nothing is DELETEd anywhere (§45).
      expect(ranSql(/DELETE FROM/i)).toBe(false);
      expect(mockPush.familyCreditDecided).toHaveBeenCalledWith('u-member', 'req-1', 'cancelled');
    });
  });

  // ── §33/§34 · threshold warnings ───────────────────────────────────────────

  describe('§33/§34 — usage-threshold warnings', () => {
    it('warns the holder on an upward band crossing', async () => {
      mockDb.qOne
        .mockResolvedValueOnce(memberRow({spend_limit_credits: 5000, spent_credits: 4100, quota_notified_pct: 0}))
        .mockResolvedValueOnce({id: 'fm-1'});   // the marker claim succeeded
      await svc.notifyUsageThreshold('fm-1');
      expect(mockPush.familyQuotaThreshold).toHaveBeenCalledWith('u-holder', 'fm-1', 80);
    });

    it('stays silent inside a band already announced', async () => {
      mockDb.qOne.mockResolvedValueOnce(
        memberRow({spend_limit_credits: 5000, spent_credits: 4200, quota_notified_pct: 80}),
      );
      await svc.notifyUsageThreshold('fm-1');
      expect(mockPush.familyQuotaThreshold).not.toHaveBeenCalled();
    });

    it('claims the band with a CONDITIONAL update, so two racing charges send once', async () => {
      mockDb.qOne
        .mockResolvedValueOnce(memberRow({spent_credits: 4100}))
        .mockResolvedValueOnce(null);           // lost the claim to a sibling
      await svc.notifyUsageThreshold('fm-1');
      expect(ranSql(/UPDATE public\.family_members SET quota_notified_pct = \$2 WHERE id = \$1 AND quota_notified_pct < \$2/i)).toBe(true);
      expect(mockPush.familyQuotaThreshold).not.toHaveBeenCalled();
    });

    it('never throws — a notification failure may not affect a committed charge', async () => {
      mockDb.qOne.mockRejectedValueOnce(new Error('db down'));
      await expect(svc.notifyUsageThreshold('fm-1')).resolves.toBeUndefined();
    });

    it('says nothing for a member who is no longer active', async () => {
      mockDb.qOne.mockResolvedValueOnce(memberRow({status: 'revoked', spent_credits: 5000}));
      await svc.notifyUsageThreshold('fm-1');
      expect(mockPush.familyQuotaThreshold).not.toHaveBeenCalled();
    });

    it('§26 — a refund re-arms the bands rather than announcing anything', async () => {
      await svc.rearmUsageThreshold('fm-1');
      expect(ranSql(/UPDATE public\.family_members SET quota_notified_pct = CASE/i)).toBe(true);
      expect(mockPush.familyQuotaThreshold).not.toHaveBeenCalled();
    });
  });

  /**
   * B-854 — the FUNDING audit trail must not bind its id to `request_id`.
   *
   * `family_quota_audit.request_id` is FK'd to `family_credit_requests(id)`
   * (20260830190000). A funding ask lives in a DIFFERENT table
   * (`family_funding_requests`), so writing its id there violates
   * `family_quota_audit_request_id_fkey` — a 500 on approve, found only on
   * staging because NO unit test in this repo executes SQL.
   *
   * The id is not dropped: it moves into `metadata.funding_request_id`, which
   * is where the ops-vs-holder discriminator already lives and which no
   * constraint can reject. Forced in `recordFundingAudit` rather than at the
   * four call sites, so a fifth caller cannot reintroduce it.
   */
  describe('B-854 — recordFundingAudit and the request_id foreign key', () => {
    const auditInsert = () =>
      [...mockDb.q.mock.calls, ...tx.q.mock.calls]
        .find(c => /INSERT INTO public\.family_quota_audit/.test(String(c[0])));

    it('binds NULL for request_id and carries the funding id in metadata', async () => {
      await svc.recordFundingAudit({
        familyRowId: 'fm-1', holderId: 'u-holder', memberId: 'u-member', actorId: 'u-member',
        action: 'FUND_MEMBERS_REQUESTED', spent: 300, requestId: 'ffr-1',
        metadata: {actor_role: 'CLIENT', actor_call: null},
      });
      const call = auditInsert();
      expect(call).toBeTruthy();
      const params = call![1] as unknown[];
      // $10 is `request_id` in the twelve-param INSERT.
      expect(params[9]).toBeNull();
      const meta = JSON.parse(params[11] as string) as Record<string, unknown>;
      expect(meta.funding_request_id).toBe('ffr-1');
      // …and the actor discriminator it shares the column with is untouched.
      expect(meta.actor_role).toBe('CLIENT');
    });

    it('omits the key entirely when there is no funding request (an ops flip)', async () => {
      await svc.recordFundingAudit({
        familyRowId: 'fm-1', holderId: 'u-holder', memberId: 'u-member', actorId: 'adm-1',
        action: 'FUND_MEMBERS_OFF', spent: 300,
        metadata: {actor_role: 'SUPERVISOR', actor_call: 'BRV-1'},
      });
      const params = auditInsert()![1] as unknown[];
      expect(params[9]).toBeNull();
      const meta = JSON.parse(params[11] as string) as Record<string, unknown>;
      expect(meta).not.toHaveProperty('funding_request_id');
      expect(meta.actor_role).toBe('SUPERVISOR');
    });

    it.each(['FUND_MEMBERS_REQUESTED', 'FUND_MEMBERS_APPROVED', 'FUND_MEMBERS_DECLINED', 'FUND_MEMBERS_OFF'] as const)
      ('%s never binds a funding id to request_id', async action => {
        for (const m of [mockDb.q, tx.q]) {m.mockClear();}
        await svc.recordFundingAudit({
          familyRowId: 'fm-1', holderId: 'u-holder', memberId: 'u-member', actorId: 'u-holder',
          action, spent: 0, requestId: 'ffr-9',
        });
        const params = auditInsert()![1] as unknown[];
        expect(params[9]).toBeNull();
        expect(JSON.parse(params[11] as string).funding_request_id).toBe('ffr-9');
      });

    it('a QUOTA audit still binds its credit-request id (that FK is real and correct)', async () => {
      // CREDIT_APPROVED rows point at `family_credit_requests`, which is exactly
      // what the column references — blanket-nulling `request_id` would break
      // the §13 trail this constraint exists to protect.
      tx.qOne
        .mockResolvedValueOnce(requestRow())
        .mockResolvedValueOnce(memberRow());
      await svc.approveRequest('u-holder', 'req-1', 2000);
      const params = auditInsert()![1] as unknown[];
      expect(params[4]).toBe('CREDIT_APPROVED');
      expect(params[9]).toBe('req-1');
    });
  });

  describe('B-854 — the callers do not re-bind it either (source scan)', () => {
    const src = () =>
      readFileSync(join(__dirname, 'family.service.ts'), 'utf8')
        .replace(/\r?\n/g, '\n')
        .split('\n')
        .filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
        .join('\n');

    it('no FUND_MEMBERS_* call site writes `request_id` into the audit metadata key', () => {
      // The first cut used `request_id` in `requestFundMembers`'s metadata,
      // which reads as the FK column it is NOT. One spelling, everywhere.
      const s = src();
      for (const m of s.matchAll(/recordFundingAudit\(\{([\s\S]{0,600}?)\}\)/g)) {
        expect(m[1]).not.toMatch(/\brequest_id:/);
      }
    });
  });
});
