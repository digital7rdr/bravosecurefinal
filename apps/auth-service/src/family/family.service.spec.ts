import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {Test, TestingModule} from '@nestjs/testing';
import {BadRequestException, NotFoundException} from '@nestjs/common';
import {DatabaseService}     from '../database/database.service';
import {GeocodeService}      from '../vbg/geocode.service';
import {BookingPushBridge}   from '../ops/booking-push-bridge.service';
import {OpsAuditService}     from '../ops/ops-audit.service';
import {FamilyService}       from './family.service';
import {FamilyQuotaService}  from './family-quota.service';

const mockDb = {q: jest.fn(), qOne: jest.fn()};
const mockGeocode = {
  reverse: jest.fn().mockResolvedValue({region: 'Benoni', context: 'Gauteng, South Africa', country: 'ZA', lat: 0, lng: 0}),
};
// R-3 — invite/accept wakes; fire-and-forget so resolved mocks suffice.
const mockPush = {
  familyInvite: jest.fn().mockResolvedValue(undefined),
  familyInviteAccepted: jest.fn().mockResolvedValue(undefined),
};
// #7 (D2) — the seat-increase request files an ops-feed row via emit().
const mockOpsAudit = {emit: jest.fn().mockResolvedValue(undefined)};
// Quota control plane. `setSpendLimit` now delegates here (spec §19 moved the
// guard + audit write into it), and `revoke` closes any open credit request.
// Its own rules are covered by family-quota.service.spec.ts.
const mockQuota = {
  setQuota: jest.fn().mockResolvedValue({ok: true, previousLimit: null, newLimit: 0, spent: 0, remaining: 0}),
  cancelPendingOnRevoke: jest.fn().mockResolvedValue(undefined),
  notifyUsageThreshold: jest.fn().mockResolvedValue(undefined),
  // B-843 (A9) — `notifyUsageThresholdForMember` is deliberately NOT here: it was
  // deleted, and leaving a double for it would let a resurrected caller pass.
  rearmUsageThreshold: jest.fn().mockResolvedValue(undefined),
};

describe('FamilyService', () => {
  let svc: FamilyService;

  beforeEach(async () => {
    jest.clearAllMocks();
    // clearAllMocks keeps IMPLEMENTATIONS — a router installed by one test would
    // otherwise answer every later one. Reset the db doubles explicitly.
    mockDb.q.mockReset();
    mockDb.qOne.mockReset();
    mockDb.q.mockResolvedValue([]);
    mockGeocode.reverse.mockResolvedValue({region: 'Benoni', context: 'Gauteng, South Africa', country: 'ZA', lat: 0, lng: 0});
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
    svc = module.get(FamilyService);
  });

  describe('invite', () => {
    // qOne order: target lookup → resolveAccountKind → same-holder dupe → insert.
    // (B-832 removed the active-count read; B-843 removed the cross-root read.)
    it('creates a pending invite for a registered phone', async () => {
      mockDb.qOne
        .mockResolvedValueOnce({id: 'u-member', phone_e164: '+971500000001'}) // phone → user
        .mockResolvedValueOnce(null)          // account-kind row (null → individual default)
        .mockResolvedValueOnce(null)          // no pending/active dupe under THIS holder
        .mockResolvedValueOnce({id: 'fm-1'}); // insert
      const res = await svc.invite('u-holder', '+971500000001', 200);
      expect(res).toEqual({id: 'fm-1', status: 'pending'});
    });

    // B-843 — one person, many roots. A user who is ACTIVE under someone else's
    // root is now an ordinary invitee. The router answers ANY cross-root query
    // with a live row, so re-adding the `holder_id <> $2` check turns this red.
    it('B-843: a user already active under ANOTHER root can still be invited', async () => {
      mockDb.qOne.mockImplementation(async (sql: string) => {
        const s = String(sql).replace(/\s+/g, ' ');
        if (/SELECT id, phone_e164 FROM public\.users/.test(s)) {
          return {id: 'u-member', phone_e164: '+971500000009'};
        }
        // The DELETED cross-root read — anything asking "is this member active
        // anywhere?" without naming THIS holder gets a hit.
        if (/holder_id <> \$2/.test(s)) {return {id: 'fm-elsewhere'};}
        if (/INSERT INTO public\.family_members/.test(s)) {return {id: 'fm-new'};}
        return null; // account-kind, same-holder dupe
      });
      await expect(svc.invite('u-holder', '+971500000009'))
        .resolves.toEqual({id: 'fm-new', status: 'pending'});
      const ranCrossRoot = mockDb.qOne.mock.calls
        .some(c => /holder_id <> \$2/.test(String(c[0]).replace(/\s+/g, ' ')));
      expect(ranCrossRoot).toBe(false);
    });

    // ...but a second OPEN row under the SAME root is still refused, and the
    // (holder_id, member_id) partial unique is what actually enforces it.
    it('B-843: a second open row under the SAME root is still refused', async () => {
      mockDb.qOne
        .mockResolvedValueOnce({id: 'u-member', phone_e164: '+971500000001'})
        .mockResolvedValueOnce(null)                 // account-kind → individual
        .mockResolvedValueOnce({id: 'fm-existing'}); // same-holder dupe
      await expect(svc.invite('u-holder', '+971500000001')).rejects.toThrow(/invite_already_pending/);
      const dupeSql = String(mockDb.qOne.mock.calls[2][0]).replace(/\s+/g, ' ');
      expect(dupeSql).toContain('WHERE holder_id = $1 AND member_id = $2');
      expect(dupeSql).toContain(`status IN ('pending','active')`);
    });

    it('rejects inviting yourself', async () => {
      mockDb.qOne.mockResolvedValueOnce({id: 'u-holder', phone_e164: '+971500000000'});
      await expect(svc.invite('u-holder', '+971500000000')).rejects.toThrow(BadRequestException);
    });

    it('rejects an unregistered phone (founder rule: must already be a Bravo user)', async () => {
      mockDb.qOne.mockResolvedValueOnce(null); // phone not registered
      await expect(svc.invite('u-holder', '+971500000009')).rejects.toThrow(/not_a_bravo_user/);
    });

    // B-832 — the 4-seat cap is GONE. The router below answers any resurrected
    // count query with 400, so re-adding the check turns this red immediately.
    it('B-832: does not cap — the invite lands with 400 already active, and no cap query runs', async () => {
      mockDb.qOne.mockImplementation(async (sql: string) => {
        const s = String(sql).replace(/\s+/g, ' ');
        if (/SELECT id, phone_e164 FROM public\.users/.test(s)) {return {id: 'u-member', phone_e164: '+971500000009'};}
        if (/COUNT\(\*\)/.test(s)) {return {n: 400};}
        if (/INSERT INTO public\.family_members/.test(s)) {return {id: 'fm-401'};}
        return null; // account-kind, in-another-family, dupe
      });
      await expect(svc.invite('u-holder', '+971500000009')).resolves.toEqual({id: 'fm-401', status: 'pending'});
      expect(mockDb.qOne.mock.calls.some(c => /COUNT\(\*\)/.test(String(c[0])))).toBe(false);
    });

    // B-833 — old APKs (≤1.0.304) still send a relationship. It is accepted at
    // the DTO edge and dropped here; the column stays but is never written.
    it('B-833: a relationship from a legacy client is not stored (the INSERT writes NULL)', async () => {
      mockDb.qOne
        .mockResolvedValueOnce({id: 'u-member', phone_e164: '+971500000001'})
        .mockResolvedValueOnce(null)          // account-kind → individual
        .mockResolvedValueOnce(null)          // no same-holder dupe
        .mockResolvedValueOnce({id: 'fm-1'}); // insert
      const legacyCall = svc.invite.bind(svc) as unknown as (...a: unknown[]) => Promise<unknown>;
      await legacyCall('u-holder', '+971500000001', 200, 'Brother');
      const ins = mockDb.qOne.mock.calls
        .find(c => /INSERT INTO public\.family_members/.test(String(c[0]))) as [string, unknown[]];
      expect(ins[1]).toEqual(['u-holder', 'u-member', 200]);
      expect(String(ins[0]).replace(/\s+/g, ' ')).toContain(`VALUES ($1, $2, NULL, 'pending', $3, NULL)`);
    });

    it('rejects an invalid phone', async () => {
      await expect(svc.invite('u-holder', 'nope')).rejects.toThrow(/invalid_phone/);
    });
  });

  // B-832 (plan D1 + A19) — the cap is gone, so this route is now only a shim
  // for ≤1.0.304 APKs, which compute `atCap` client-side and can therefore show
  // ONLY this CTA. It confirms ok and nudges ops to advise an update.
  describe('requestSeats (B-832 legacy shim)', () => {
    it('B-832: answers ok and files an INFO ops-feed row that says the cap is removed', async () => {
      mockDb.qOne.mockResolvedValueOnce({n: 4});
      const res = await svc.requestSeats('u-holder');
      expect(res).toEqual({ok: true});
      expect(mockOpsAudit.emit).toHaveBeenCalledTimes(1);
      const ev = mockOpsAudit.emit.mock.calls[0][0];
      expect(ev.kind).toBe('family');
      expect(ev.severity).toBe('info');
      expect(ev.subject).toBe('u-holder');
      expect(ev.message).toBe('Legacy client (≤1.0.304) requested seats — cap removed; advise update');
      expect(ev.metadata).toEqual({holderId: 'u-holder', activeCount: 4, legacy: true});
      // The old row claimed a 4/4 ceiling that no longer exists.
      expect(ev.message).not.toMatch(/4\/4/);
      expect(ev.metadata).not.toHaveProperty('maxSeats');
    });

    it('still emits (and returns ok) even if the count lookup comes back empty', async () => {
      mockDb.qOne.mockResolvedValueOnce(null);
      await expect(svc.requestSeats('u-holder')).resolves.toEqual({ok: true});
      expect(mockOpsAudit.emit).toHaveBeenCalledTimes(1);
      expect(mockOpsAudit.emit.mock.calls[0][0].metadata.activeCount).toBeNull();
    });
  });

  describe('accept', () => {
    it('binds the member and activates', async () => {
      mockDb.qOne
        .mockResolvedValueOnce(null)            // no open row under THIS holder
        .mockResolvedValueOnce({id: 'fm-1'});   // update returns row
      await expect(svc.accept('u-member', 'fm-1')).resolves.toEqual({ok: true});
    });

    // B-843 — WAS "refuses if already in a family". A member may now be active
    // under any number of roots; only a second open row under the SAME root is
    // refused, and the guard reads that holder FROM THE INVITE, never from a
    // bare "is this member active anywhere?".
    it('B-843: accept SUCCEEDS under a second root (a membership elsewhere is not a refusal)', async () => {
      mockDb.qOne.mockImplementation(async (sql: string) => {
        const s = String(sql).replace(/\s+/g, ' ');
        // The DELETED guard: member-only, no holder in the predicate.
        if (/WHERE member_id = \$1 AND status = 'active'$/.test(s.trim())) {
          return {id: 'fm-under-root-A'};
        }
        if (/UPDATE public\.family_members/.test(s)) {return {id: 'fm-2', holder_id: 'u-root-B'};}
        return null; // the same-holder guard finds nothing under root B
      });
      await expect(svc.accept('u-member', 'fm-2')).resolves.toEqual({ok: true});
      expect(mockPush.familyInviteAccepted).toHaveBeenCalledWith('u-root-B', 'fm-2');
    });

    it('B-843: the same-holder guard scopes on the INVITE\'s holder and excludes the invite row', async () => {
      mockDb.qOne.mockResolvedValueOnce(null).mockResolvedValueOnce({id: 'fm-2', holder_id: 'h'});
      await svc.accept('u-member', 'fm-2');
      const sql = String(mockDb.qOne.mock.calls[0][0]).replace(/\s+/g, ' ');
      expect(sql).toContain('holder_id = (SELECT holder_id FROM public.family_members WHERE id = $2)');
      expect(sql).toContain(`status IN ('pending','active')`);
      // Without `id <> $2` the invite being accepted matches itself and every
      // accept is refused.
      expect(sql).toContain('id <> $2');
      expect(mockDb.qOne.mock.calls[0][1]).toEqual(['u-member', 'fm-2']);
    });

    it('B-843: a second open row under the SAME root is refused with already_in_this_family', async () => {
      mockDb.qOne.mockResolvedValueOnce({id: 'fm-same-root'});
      await expect(svc.accept('u-member', 'fm-2')).rejects.toThrow(/already_in_this_family/);
    });

    // The read above cannot see a collision a LEGACY phone-bound row is about to
    // cause (member_id is NULL until this UPDATE binds it), so the partial unique
    // is the real gate — and its 23505 must not reach the member as a 500.
    it('B-843: a 23505 from the UPDATE maps to already_in_this_family, not a 500', async () => {
      mockDb.qOne
        .mockResolvedValueOnce(null)
        .mockRejectedValueOnce(Object.assign(new Error('duplicate key'), {code: '23505'}));
      const err = await svc.accept('u-member', 'fm-2').then(
        () => { throw new Error('should have thrown'); },
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(BadRequestException);
      // A 500 here reads to the member as "the app is broken", not "you are
      // already in this account".
      expect((err as Error).message).toMatch(/already_in_this_family/);
    });

    it('B-843: an UNRELATED database error is NOT swallowed into already_in_this_family', async () => {
      mockDb.qOne
        .mockResolvedValueOnce(null)
        .mockRejectedValueOnce(Object.assign(new Error('deadlock'), {code: '40P01'}));
      await expect(svc.accept('u-member', 'fm-2')).rejects.toThrow(/deadlock/);
    });
  });

  describe('resolvePayer (billing hook)', () => {
    // F2 — `status` and `held_until` are PROJECTED now and eligibility is decided
    // in JS, so a fixture without them is not a membership the resolver can spend.
    const famRow = (over: Record<string, unknown> = {}) => ({
      id: 'fm-1', holder_id: 'u-holder', holder_name: 'Root A', status: 'active', held_until: null,
      spend_limit_credits: 500, spent_credits: 100, holder_suspended_at: null, ...over,
    });

    it('returns the holder for a member with exactly ONE root', async () => {
      mockDb.q.mockResolvedValueOnce([famRow()]);
      const res = await svc.resolvePayer('u-member');
      expect(res).toEqual({
        payerId: 'u-holder', familyRowId: 'fm-1', spendLimit: 500, spent: 100,
        holderSuspended: false, holderId: 'u-holder', holderName: 'Root A',
        // B-854 — a row with no funding columns is an UNCHAINED payer, stated
        // explicitly rather than by omission: the charge sites branch on
        // `fundingRowId`, so "absent" and "null" must not be two answers.
        fundingRowId: null, fundingHolderId: null, viaUserId: null,
        fundingSpendLimit: null, fundingSpent: 0,
      });
    });

    it('returns the user themselves when not a member (identity)', async () => {
      mockDb.q.mockResolvedValueOnce([]);
      const res = await svc.resolvePayer('u-stranger');
      expect(res).toEqual({
        payerId: 'u-stranger', familyRowId: null, spendLimit: null, spent: 0,
        holderSuspended: false, holderId: null, holderName: null,
      });
    });

    // B-843 — the ≥2 case FAILS CLOSED. Picking one silently charges a root the
    // member never named, and a surprise charge is worse than a refusal.
    it('B-843: TWO roots and no choice → PAYER_CHOICE_REQUIRED with both options and human copy', async () => {
      mockDb.q.mockResolvedValueOnce([
        famRow(),
        famRow({id: 'fm-2', holder_id: 'u-root-b', holder_name: 'Root B', spend_limit_credits: null, spent_credits: 0}),
      ]);
      await svc.resolvePayer('u-member').then(
        () => { throw new Error('should have thrown'); },
        (e: BadRequestException) => {
          const body = e.getResponse() as {code: string; message: string; options: unknown[]};
          expect(body.code).toBe('PAYER_CHOICE_REQUIRED');
          // A raw machine code rendered to a human is the B-380 class.
          expect(body.message).toBe('Choose which account pays for this booking.');
          expect(body.options).toHaveLength(2);
          expect(body.options[0]).toEqual({
            holderId: 'u-holder', holderName: 'Root A', spendLimit: 500, spent: 100,
            remaining: 400, held: false, rootSuspended: false,
            // B-854 (A12) — the fixture carries no wallet column, so the paying
            // wallet reads 0 and the ceiling is 0. The figure is server-computed
            // and chain-aware; the raw balance is still never returned (LM-B7).
            effectiveSpendable: 0,
          });
          expect(body.options[1]).toMatchObject({holderId: 'u-root-b', remaining: null});
        },
      );
    });

    it('B-843: a CHOSEN root narrows the SQL to that holder and returns it', async () => {
      mockDb.q.mockResolvedValueOnce([famRow({id: 'fm-2', holder_id: 'u-root-b', holder_name: 'Root B'})]);
      const res = await svc.resolvePayer('u-member', 'u-root-b');
      expect(res).toMatchObject({payerId: 'u-root-b', familyRowId: 'fm-2', holderName: 'Root B'});
      const [sql, params] = mockDb.q.mock.calls[0] as [string, unknown[]];
      // Without the holder predicate the "choice" reads whatever row sorts first.
      expect(sql.replace(/\s+/g, ' ')).toContain('AND fm.holder_id = $2');
      expect(params).toEqual(['u-member', 'u-root-b']);
    });

    it('B-843: a FOREIGN root is PAYER_NOT_ELIGIBLE, never a silent fallback to self', async () => {
      mockDb.q.mockResolvedValueOnce([]);
      await svc.resolvePayer('u-member', 'u-root-x').then(
        () => { throw new Error('should have thrown'); },
        (e: BadRequestException) => {
          expect(e.getResponse()).toMatchObject({
            code: 'PAYER_NOT_ELIGIBLE',
            message: "That account can't pay for this booking right now.",
          });
        },
      );
    });

    // F3 — one shape per code. `booking.service.ts` throws PAYER_NOT_ELIGIBLE
    // WITH holder_id/holder_name from its stamped-payer check; a resolver body
    // carrying only code+message makes the same code render two different ways.
    it('F3: PAYER_NOT_ELIGIBLE names the root, with the name from ANY row under it', async () => {
      // Revoked / pending / held all still identify the account the member
      // chose — the name is what the client renders in "X can't pay right now".
      mockDb.q.mockResolvedValueOnce([{
        id: 'fm-9', holder_id: 'u-root-x', holder_name: 'Root X', status: 'revoked',
        held_until: null, spend_limit_credits: null, spent_credits: 0, holder_suspended_at: null,
      }]);
      await svc.resolvePayer('u-member', 'u-root-x').then(
        () => { throw new Error('should have thrown'); },
        (e: BadRequestException) => {
          expect(e.getResponse()).toEqual({
            code: 'PAYER_NOT_ELIGIBLE',
            message: "That account can't pay for this booking right now.",
            holder_id: 'u-root-x',
            holder_name: 'Root X',
          });
        },
      );
    });

    it('F3: a HELD row under the chosen root is refused, and still names it', async () => {
      mockDb.q.mockResolvedValueOnce([{
        id: 'fm-9', holder_id: 'u-root-x', holder_name: 'Root X', status: 'active',
        held_until: new Date(Date.now() + 86_400_000),
        spend_limit_credits: null, spent_credits: 0, holder_suspended_at: null,
      }]);
      await svc.resolvePayer('u-member', 'u-root-x').then(
        () => { throw new Error('should have thrown'); },
        (e: BadRequestException) => {
          expect(e.getResponse()).toMatchObject({
            code: 'PAYER_NOT_ELIGIBLE', holder_id: 'u-root-x', holder_name: 'Root X',
          });
        },
      );
    });

    it('F3: an UNKNOWN root still names the id it was given, with a null name', async () => {
      mockDb.q.mockResolvedValueOnce([]);
      await svc.resolvePayer('u-member', 'u-root-x').then(
        () => { throw new Error('should have thrown'); },
        (e: BadRequestException) => {
          expect(e.getResponse()).toMatchObject({holder_id: 'u-root-x', holder_name: null});
        },
      );
    });

    // ── F2 — the refusal's options come from the rows we ALREADY read ────────
    //
    // `payerOptions()` swallows a DB error into `[]`, so building the refusal
    // from a SECOND round-trip could ship `PAYER_CHOICE_REQUIRED` with
    // `options: []` — and the client renders "Choose which account pays" with
    // nothing to choose.
    it('F2: the CHOICE_REQUIRED options come from the SAME query, not a second round-trip', async () => {
      mockDb.q.mockResolvedValueOnce([
        {id: 'fm-1', holder_id: 'u-holder', holder_name: 'Root A', status: 'active', held_until: null,
         spend_limit_credits: 500, spent_credits: 100, holder_suspended_at: null},
        {id: 'fm-2', holder_id: 'u-root-b', holder_name: 'Root B', status: 'active', held_until: null,
         spend_limit_credits: null, spent_credits: 0, holder_suspended_at: null},
      ]);
      // Every LATER q call answers empty — if the options were built from a
      // second read, this is what the member would be asked to choose from.
      mockDb.q.mockResolvedValue([]);
      await svc.resolvePayer('u-member').then(
        () => { throw new Error('should have thrown'); },
        (e: BadRequestException) => {
          const body = e.getResponse() as {options: unknown[]};
          expect(body.options).toHaveLength(2);
        },
      );
      expect(mockDb.q).toHaveBeenCalledTimes(1);
    });

    it('F2: a HELD root is LISTED (flagged) but does not count toward the ask', async () => {
      // active-A + held-B → A pays. Held rows are not spendable, so there is
      // nothing to ask about; but a member who knows they are in B must still
      // see it, which is why it rides in `options` elsewhere.
      mockDb.q.mockResolvedValueOnce([
        {id: 'fm-1', holder_id: 'u-holder', holder_name: 'Root A', status: 'active', held_until: null,
         spend_limit_credits: 500, spent_credits: 100, holder_suspended_at: null},
        {id: 'fm-2', holder_id: 'u-root-b', holder_name: 'Root B', status: 'active',
         held_until: new Date(Date.now() + 86_400_000),
         spend_limit_credits: null, spent_credits: 0, holder_suspended_at: null},
      ]);
      const res = await svc.resolvePayer('u-member');
      expect(res).toMatchObject({payerId: 'u-holder', familyRowId: 'fm-1'});
      expect(mockDb.q).toHaveBeenCalledTimes(1);
    });

    it('F2: with two spendable roots plus a held one, ALL THREE are offered, held flagged', async () => {
      mockDb.q.mockResolvedValueOnce([
        {id: 'fm-1', holder_id: 'u-a', holder_name: 'Root A', status: 'active', held_until: null,
         spend_limit_credits: 500, spent_credits: 100, holder_suspended_at: null},
        {id: 'fm-2', holder_id: 'u-b', holder_name: 'Root B', status: 'active', held_until: null,
         spend_limit_credits: null, spent_credits: 0, holder_suspended_at: null},
        {id: 'fm-3', holder_id: 'u-c', holder_name: 'Root C', status: 'active',
         held_until: new Date(Date.now() + 86_400_000),
         spend_limit_credits: 200, spent_credits: 200, holder_suspended_at: null},
      ]);
      await svc.resolvePayer('u-member').then(
        () => { throw new Error('should have thrown'); },
        (e: BadRequestException) => {
          const body = e.getResponse() as {options: Array<{holderId: string; held: boolean}>};
          expect(body.options.map(o => o.holderId)).toEqual(['u-a', 'u-b', 'u-c']);
          expect(body.options.map(o => o.held)).toEqual([false, false, true]);
        },
      );
    });

    // §21 is NOT folded into eligibility: a member with ONE suspended root must
    // be told ROOT_ACCOUNT_SUSPENDED by the charge site, not silently charged to
    // their own wallet. The flag is what carries that.
    it('F2: a single SUSPENDED root still resolves to that root (so §21 can speak)', async () => {
      mockDb.q.mockResolvedValueOnce([{
        id: 'fm-1', holder_id: 'u-holder', holder_name: 'Root A', status: 'active', held_until: null,
        spend_limit_credits: 5000, spent_credits: 0, holder_suspended_at: new Date(),
      }]);
      const res = await svc.resolvePayer('u-member');
      expect(res).toMatchObject({payerId: 'u-holder', holderSuspended: true});
    });

    it('F2: a suspended root among two is offered, FLAGGED, never silently skipped', async () => {
      mockDb.q.mockResolvedValueOnce([
        {id: 'fm-1', holder_id: 'u-a', holder_name: 'Root A', status: 'active', held_until: null,
         spend_limit_credits: 500, spent_credits: 100, holder_suspended_at: new Date()},
        {id: 'fm-2', holder_id: 'u-b', holder_name: 'Root B', status: 'active', held_until: null,
         spend_limit_credits: null, spent_credits: 0, holder_suspended_at: null},
      ]);
      await svc.resolvePayer('u-member').then(
        () => { throw new Error('should have thrown'); },
        (e: BadRequestException) => {
          const body = e.getResponse() as {options: Array<{holderId: string; rootSuspended: boolean}>};
          expect(body.options.map(o => o.rootSuspended)).toEqual([true, false]);
        },
      );
    });

    it('B-843: choosing YOURSELF is self-payment and never reads the family tables', async () => {
      const res = await svc.resolvePayer('u-member', 'u-member');
      expect(res).toEqual({
        payerId: 'u-member', familyRowId: null, spendLimit: null, spent: 0,
        holderSuspended: false, holderId: null, holderName: null,
      });
      // A held membership must not be able to refuse a purchase the member is
      // paying for out of their OWN wallet.
      expect(mockDb.q).not.toHaveBeenCalled();
      expect(mockDb.qOne).not.toHaveBeenCalled();
    });

    // Spec §21 — a suspended ROOT account stops every member draw on it, even
    // though the member's own quota is untouched. Surfaced as a flag here and
    // turned into ROOT_ACCOUNT_SUSPENDED by the charge sites, so the member is
    // told the real reason instead of a limit message (§9's principle).
    it('flags a SUSPENDED holder', async () => {
      mockDb.q.mockResolvedValueOnce([famRow({spend_limit_credits: 5000, spent_credits: 0, holder_suspended_at: new Date()})]);
      const res = await svc.resolvePayer('u-member');
      expect(res).toMatchObject({payerId: 'u-holder', holderSuspended: true, spendLimit: 5000});
    });

    it('reads the holder suspension in the SAME query as the membership', async () => {
      // Two separate reads could straddle a suspension and miss it.
      mockDb.q.mockResolvedValueOnce([]);
      await svc.resolvePayer('u-member');
      const sql = String(mockDb.q.mock.calls[0][0]);
      // Both tokens, asserted independently — the projection precedes the JOIN
      // in SQL, so an ordered regex would pin the wrong thing (and would have
      // passed only by accident if it matched at all).
      expect(sql).toMatch(/h\.suspended_at AS holder_suspended_at/);
      expect(sql).toMatch(/JOIN public\.users h ON h\.id = fm\.holder_id/);
      // F2 — the hold and the status are PROJECTED, not filtered: eligibility is
      // decided in JS so the same rows can also build the refusal's options.
      const flat = sql.replace(/\s+/g, ' ');
      expect(flat).toContain('fm.status, fm.held_until');
      expect(flat).not.toContain('fm.held_until <= NOW()');
      // ...and the hold RULE itself is unchanged — a held member pays from their
      // own wallet, which the F2 cases above exercise behaviourally.
    });
  });

  describe('myMemberships (B-843 — the member may have several roots)', () => {
    const row = (over: Record<string, unknown> = {}) => ({
      id: 'fm-1', holder_id: 'u-holder', holder_name: 'Root A', held_until: null,
      spend_limit_credits: 1000, spent_credits: 250, holder_suspended_at: null,
      root_credits: 5000, ...over,
    });

    it('returns EVERY active root, oldest first, each carrying its own row id (A14)', async () => {
      mockDb.q
        .mockResolvedValueOnce([row(), row({id: 'fm-2', holder_id: 'u-root-b', holder_name: 'Root B', spend_limit_credits: null})])
        .mockResolvedValueOnce([]); // no open credit requests
      const out = await svc.myMemberships('u-member');
      expect(out.map(m => m.id)).toEqual(['fm-1', 'fm-2']);
      expect(out[0]).toMatchObject({
        holderId: 'u-holder', holderName: 'Root A', spendLimit: 1000, spent: 250,
        remaining: 750, rootSuspended: false, pendingRequest: null,
      });
      // Deterministic order — `useProPlanGate` and the quota cards both key on
      // "the first one", so an unordered read would reshuffle on every refetch.
      const sql = String(mockDb.q.mock.calls[0][0]).replace(/\s+/g, ' ');
      expect(sql).toContain('ORDER BY fm.accepted_at ASC NULLS LAST, fm.id ASC');
    });

    it('attaches each root\'s OPEN credit request to its own membership (§42)', async () => {
      mockDb.q
        .mockResolvedValueOnce([row(), row({id: 'fm-2', holder_id: 'u-root-b'})])
        .mockResolvedValueOnce([{id: 'req-9', family_row_id: 'fm-2', requested_credits: 300, created_at: new Date('2026-09-01T00:00:00Z')}]);
      const out = await svc.myMemberships('u-member');
      expect(out[0].pendingRequest).toBeNull();
      expect(out[1].pendingRequest).toEqual({
        id: 'req-9', requestedCredits: 300, createdAt: '2026-09-01T00:00:00.000Z',
      });
    });

    it('a SUSPENDED root spends nothing no matter what the quota says (§21)', async () => {
      mockDb.q
        .mockResolvedValueOnce([row({holder_suspended_at: new Date(), root_credits: 9999})])
        .mockResolvedValueOnce([]);
      const [m] = await svc.myMemberships('u-member');
      expect(m.rootSuspended).toBe(true);
      expect(m.effectiveSpendable).toBe(0);
    });

    it('returns [] for a non-member and never reads the requests table', async () => {
      mockDb.q.mockResolvedValueOnce([]);
      await expect(svc.myMemberships('u-stranger')).resolves.toEqual([]);
      expect(mockDb.q).toHaveBeenCalledTimes(1);
    });

    it('myMembership() (old clients) is the FIRST of that list, never an arbitrary row', async () => {
      mockDb.q
        .mockResolvedValueOnce([row({id: 'fm-oldest'}), row({id: 'fm-2', holder_id: 'u-root-b'})])
        .mockResolvedValueOnce([]);
      const one = await svc.myMembership('u-member');
      expect(one?.id).toBe('fm-oldest');
    });

    it('myMembership() is null for a non-member', async () => {
      mockDb.q.mockResolvedValueOnce([]);
      await expect(svc.myMembership('u-stranger')).resolves.toBeNull();
    });
  });

  describe('payerOptions (B-843 — what a money refusal offers)', () => {
    it('lists every active root, FLAGS a held one, and never returns the root balance (LM-B7)', async () => {
      const future = new Date(Date.now() + 86_400_000);
      mockDb.q.mockResolvedValueOnce([
        {holder_id: 'u-a', holder_name: 'Root A', held_until: null, spend_limit_credits: 900, spent_credits: 400, holder_suspended_at: null, root_credits: 10_000},
        {holder_id: 'u-b', holder_name: null, held_until: future, spend_limit_credits: null, spent_credits: 0, holder_suspended_at: null, root_credits: 10_000},
      ]);
      const out = await svc.payerOptions('u-member');
      expect(out).toEqual([
        {holderId: 'u-a', holderName: 'Root A', spendLimit: 900, spent: 400, remaining: 500, held: false, rootSuspended: false, effectiveSpendable: 500},
        {holderId: 'u-b', holderName: 'Plan holder', spendLimit: null, spent: 0, remaining: null, held: true, rootSuspended: false, effectiveSpendable: 10_000},
      ]);
      // A member is not entitled to read a root's finances through a booking.
      //
      // B-854 (A12) — `effectiveSpendable` is a DERIVED min, the same figure
      // `FamilyMembershipDto` has always published. The raw balance still never
      // leaves: no `bravo_credits`, no `balance` key. The read now DOES join
      // `wallet_balances` (it has to, to compute the min), so that half of the
      // old assertion is replaced by the output-shape check above — which is
      // the one that actually protects the member.
      const raw = JSON.stringify(out);
      expect(raw).not.toContain('bravo_credits');
      expect(raw).not.toContain('balance');
      expect(raw).not.toContain('root_credits');
      expect(Object.keys(out[0]).sort()).toEqual([
        'effectiveSpendable', 'held', 'holderId', 'holderName',
        'remaining', 'rootSuspended', 'spendLimit', 'spent',
      ]);
    });

    it('an EXPIRED hold is not "held"', async () => {
      mockDb.q.mockResolvedValueOnce([{
        holder_id: 'u-a', holder_name: 'Root A', held_until: new Date(Date.now() - 86_400_000),
        spend_limit_credits: null, spent_credits: 0, holder_suspended_at: null,
      }]);
      expect((await svc.payerOptions('u-member'))[0].held).toBe(false);
    });
  });

  describe('reportLocation (member last fix)', () => {
    const fix = {lat: 25.2048, lng: 55.2708, accuracyM: 12};

    it('upserts the fix with a server-side geocode label for an eligible member', async () => {
      mockDb.qOne.mockResolvedValueOnce({id: 'fm-1'}); // eligibility hit
      const res = await svc.reportLocation('u-member', fix);
      expect(res).toEqual({ok: true, reported: true});
      expect(mockGeocode.reverse).toHaveBeenCalledWith(25.2048, 55.2708);
      expect(mockDb.q).toHaveBeenCalledWith(
        expect.stringMatching(/INSERT INTO public\.family_member_locations[\s\S]*ON CONFLICT \(user_id\) DO UPDATE/),
        ['u-member', 25.2048, 55.2708, 12, 'Benoni'],
      );
    });

    it('gates eligibility on ACTIVE + not-held + the permissive location scope in SQL', async () => {
      mockDb.qOne.mockResolvedValueOnce({id: 'fm-1'});
      await svc.reportLocation('u-member', fix);
      const sql = (mockDb.qOne.mock.calls[0][0] as string).replace(/\s+/g, ' ');
      expect(sql).toContain(`fm.status = 'active'`);
      expect(sql).toContain('fm.held_until IS NULL OR fm.held_until <= NOW()');
      // Only the broad default shares; both narrower user choices
      // ('during_mission', 'never') exclude continuous family sharing.
      expect(sql).toContain(`u.location_scope = 'while_on_duty'`);
    });

    it('is a silent no-op for a non-member / held / opted-out caller — nothing stored', async () => {
      mockDb.qOne.mockResolvedValueOnce(null);
      const res = await svc.reportLocation('u-stranger', fix);
      expect(res).toEqual({ok: true, reported: false});
      expect(mockDb.q).not.toHaveBeenCalled();
      expect(mockGeocode.reverse).not.toHaveBeenCalled();
    });

    it.each([
      [{lat: 91, lng: 10}],
      [{lat: 10, lng: 181}],
      [{lat: 0, lng: 0}],          // null island — a failed-fix sentinel, never real
      [{lat: NaN, lng: 10}],
    ])('rejects invalid coordinates %j before touching the db', async bad => {
      await expect(svc.reportLocation('u-member', bad as never)).rejects.toThrow(/invalid_coordinates/);
      expect(mockDb.qOne).not.toHaveBeenCalled();
    });

    it('stores a null accuracy when the client sends none', async () => {
      mockDb.qOne.mockResolvedValueOnce({id: 'fm-1'});
      await svc.reportLocation('u-member', {lat: 1, lng: 2});
      expect(mockDb.q).toHaveBeenCalledWith(expect.any(String), ['u-member', 1, 2, null, 'Benoni']);
    });

    it('stores a null accuracy on the WIRE shape too (controller coalesces to null — Number(null) is 0)', async () => {
      mockDb.qOne.mockResolvedValueOnce({id: 'fm-1'});
      await svc.reportLocation('u-member', {lat: 1, lng: 2, accuracyM: null});
      expect(mockDb.q).toHaveBeenCalledWith(expect.any(String), ['u-member', 1, 2, null, 'Benoni']);
    });
  });

  describe('listMembers (owner view)', () => {
    const dbRow = (over: Record<string, unknown> = {}) => ({
      id: 'fm-1', member_id: 'u-m', invite_phone: null, status: 'active',
      held_until: null, spend_limit_credits: 1000, spent_credits: 0,
      invited_at: new Date('2026-08-01T00:00:00Z'), accepted_at: new Date('2026-08-02T00:00:00Z'),
      display_name: 'Ranger Danger', email: 'leak@example.com', phone_e164: '+971500000001',
      avatar_url: null, loc_lat: null, loc_lng: null, loc_label: null,
      loc_accuracy_m: null, loc_recorded_at: null, ...over,
    });
    const countsOk = () => {
      mockDb.qOne.mockResolvedValueOnce({n: 1}).mockResolvedValueOnce({active: 1, pending: 0, held: 0});
    };

    // PRIVACY — a holder invited by PHONE and has never seen a member's email.
    // Only the console roster needs it, so it is opt-in per call.
    it('B-835: the holder path never returns a member email even when the row has one', async () => {
      mockDb.q.mockResolvedValueOnce([dbRow()]);
      countsOk();
      const out = await svc.listMembers('u-holder');
      expect(out.members[0].email).toBeNull();
      // The phone stays — the holder chose it to invite with.
      expect(out.members[0].phone).toBe('+971500000001');
      // ...and the column is not even projected on this path.
      const sql = (mockDb.q.mock.calls[0][0] as string).replace(/\s+/g, ' ');
      expect(sql).not.toContain('u.email');
      expect(sql).toContain('NULL::text AS email');
    });

    it('B-836: the console path opts IN with includeEmail and gets it', async () => {
      mockDb.q.mockResolvedValueOnce([dbRow({email: 'ops@example.com'})]);
      countsOk();
      const out = await svc.listMembers('u-holder', {includeEmail: true});
      expect(out.members[0].email).toBe('ops@example.com');
      expect(mockDb.q.mock.calls[0][0] as string).toContain('u.email');
    });

    it('exposes lastLocation only through the active+non-held SQL gate and maps it', async () => {
      mockDb.q.mockResolvedValueOnce([{
        id: 'fm-1', member_id: 'u-m', invite_phone: null, status: 'active',
        held_until: null, spend_limit_credits: 1000,
        spent_credits: 0, invited_at: new Date('2026-08-01T00:00:00Z'),
        accepted_at: new Date('2026-08-02T00:00:00Z'), display_name: 'Ranger Danger',
        email: 'r@x.io', phone_e164: '+971500000001',
        avatar_url: null, loc_lat: 25.1, loc_lng: 55.2, loc_label: 'Benoni',
        loc_accuracy_m: 15, loc_recorded_at: new Date('2026-08-04T10:00:00Z'),
      }, {
        id: 'fm-2', member_id: 'u-p', invite_phone: null, status: 'pending',
        held_until: null, spend_limit_credits: null,
        spent_credits: 0, invited_at: new Date('2026-08-03T00:00:00Z'),
        accepted_at: null, display_name: 'Leon', avatar_url: null,
        email: null, phone_e164: null,
        loc_lat: null, loc_lng: null, loc_label: null, loc_accuracy_m: null, loc_recorded_at: null,
      }]);
      const out = await svc.listMembers('u-holder');
      expect(out.members[0].lastLocation).toEqual({
        lat: 25.1, lng: 55.2, label: 'Benoni', accuracyM: 15,
        recordedAt: '2026-08-04T10:00:00.000Z',
      });
      expect(out.members[1].lastLocation).toBeNull();
      // B-833 — the relationship badge is gone from the wire.
      expect(out.members[0]).not.toHaveProperty('relationship');
      const sql = (mockDb.q.mock.calls[0][0] as string).replace(/\s+/g, ' ');
      // The join itself must refuse pending/held rows — not just the mapper.
      expect(sql).toContain(`AND fm.status = 'active' AND (fm.held_until IS NULL OR fm.held_until <= NOW())`);
      expect(sql).not.toContain('fm.relationship');
    });

    // B-835 — the list is paged + searchable now (a root may hold thousands).
    it('B-835: q wildcards are ESCAPEd, and LIMIT/OFFSET + total + counts are emitted', async () => {
      mockDb.q.mockResolvedValueOnce([]);
      mockDb.qOne
        .mockResolvedValueOnce({n: 7})                            // total under {q,status}
        .mockResolvedValueOnce({active: 5, pending: 2, held: 1}); // UNFILTERED per-status
      const out = await svc.listMembers('u-holder', {q: ' 50%_x ', limit: 500, offset: -3});
      expect(out.total).toBe(7);
      expect(out.counts).toEqual({active: 5, pending: 2, held: 1});

      const [sqlRaw, params] = mockDb.q.mock.calls[0] as [string, unknown[]];
      const sql = sqlRaw.replace(/\s+/g, ' ');
      // B-636 lesson: a typed % / _ / \ is data, never a wildcard.
      expect(sql).toMatch(/ILIKE \$\d+ ESCAPE '\\'/);
      expect(sql).toContain('u.display_name ILIKE');
      expect(sql).toContain('u.phone_e164 ILIKE');
      expect(sql).toContain('fm.invite_phone ILIKE');
      expect(sql).toMatch(/LIMIT \$\d+ OFFSET \$\d+/);
      expect(sql).toContain('ORDER BY fm.invited_at DESC, fm.id DESC');
      expect(params).toContain('%50\\%\\_x%');
      // limit clamped to 200, a negative offset floored to 0.
      expect(params.slice(-2)).toEqual([200, 0]);
    });

    it('B-835: defaults are status=all (pending+active), limit 100, offset 0', async () => {
      mockDb.q.mockResolvedValueOnce([]);
      mockDb.qOne.mockResolvedValueOnce({n: 0}).mockResolvedValueOnce({active: 0, pending: 0, held: 0});
      await svc.listMembers('u-holder');
      const [sqlRaw, params] = mockDb.q.mock.calls[0] as [string, unknown[]];
      expect(sqlRaw.replace(/\s+/g, ' ')).toContain(`fm.status IN ('pending','active')`);
      expect(params.slice(-2)).toEqual([100, 0]);
      expect(params).toContain(null); // no q → the filter is a NULL passthrough
    });

    it(`B-835: status='held' narrows to ACTIVE rows still inside their hold window`, async () => {
      mockDb.q.mockResolvedValueOnce([]);
      mockDb.qOne.mockResolvedValueOnce({n: 1}).mockResolvedValueOnce({active: 3, pending: 0, held: 1});
      await svc.listMembers('u-holder', {status: 'held'});
      const sql = (mockDb.q.mock.calls[0][0] as string).replace(/\s+/g, ' ');
      expect(sql).toContain(`fm.status = 'active' AND fm.held_until > NOW()`);
    });

    it(`B-835: status='active' still RETURNS held rows (the screen renders the HOLD pill)`, async () => {
      mockDb.q.mockResolvedValueOnce([]);
      mockDb.qOne.mockResolvedValueOnce({n: 3}).mockResolvedValueOnce({active: 3, pending: 0, held: 1});
      await svc.listMembers('u-holder', {status: 'active'});
      const sql = (mockDb.q.mock.calls[0][0] as string).replace(/\s+/g, ' ');
      expect(sql).toContain(`fm.status = 'active'`);
      expect(sql).not.toContain('held_until > NOW()');
    });

    it('B-835: counts are UNFILTERED and held is the subset of active still on hold', async () => {
      mockDb.q.mockResolvedValueOnce([]);
      mockDb.qOne.mockResolvedValueOnce({n: 1}).mockResolvedValueOnce({active: 9, pending: 4, held: 2});
      const out = await svc.listMembers('u-holder', {q: 'ali'});
      expect(out.counts).toEqual({active: 9, pending: 4, held: 2});
      const countsCall = mockDb.qOne.mock.calls[1] as [string, unknown[]];
      const sql = countsCall[0].replace(/\s+/g, ' ');
      expect(sql).toContain(`COUNT(*) FILTER (WHERE status = 'active')`);
      expect(sql).toContain(`COUNT(*) FILTER (WHERE status = 'pending')`);
      expect(sql).toContain(`COUNT(*) FILTER (WHERE status = 'active' AND held_until > NOW())`);
      // The header must not move when the operator types in the search box.
      expect(countsCall[1]).toEqual(['u-holder']);
    });
  });

  describe('memberSpend (owner itemised view)', () => {
    it('404s for a foreign member row', async () => {
      mockDb.qOne.mockResolvedValueOnce(null);
      await expect(svc.memberSpend('u-holder', 'fm-x')).rejects.toThrow(NotFoundException);
    });

    it('returns empty lists for a pending (unbound) invite', async () => {
      mockDb.qOne.mockResolvedValueOnce({member_id: null, spend_limit_credits: null, spent_credits: 0, display_name: null, invite_phone: '+971' });
      const out = await svc.memberSpend('u-holder', 'fm-p');
      expect(out.byFeature).toEqual([]);
      expect(out.transactions).toEqual([]);
      expect(mockDb.q).not.toHaveBeenCalled();
    });

    it('itemises the holder-wallet ledger by actor with feature grouping', async () => {
      mockDb.qOne.mockResolvedValueOnce({member_id: 'u-m', spend_limit_credits: 1000, spent_credits: 344, display_name: 'Ranger Danger', invite_phone: null});
      mockDb.q
        .mockResolvedValueOnce([{ // transactions
          id: 't1', type: 'payment', amount_credits: -344, description: 'Escrow hold b1',
          booking_id: 'b1', feature: 'booking', created_at: new Date('2026-08-04T09:00:00Z'),
        }, {
          id: 't2', type: 'refund', amount_credits: 100, description: 'Refund · booking b0 cancelled',
          booking_id: 'b0', feature: 'booking', created_at: new Date('2026-08-03T09:00:00Z'),
        }])
        .mockResolvedValueOnce([{feature: 'booking', spent: 344, refunded: 100, n: 2}, {feature: null, spent: 5, refunded: 0, n: 1}]);
      const out = await svc.memberSpend('u-holder', 'fm-1');
      expect(out.member).toEqual({id: 'fm-1', name: 'Ranger Danger', spent: 344, spendLimit: 1000});
      expect(out.transactions[0]).toEqual({
        id: 't1', type: 'payment', feature: 'booking', description: 'Escrow hold b1',
        amount: -344, bookingId: 'b1', at: '2026-08-04T09:00:00.000Z',
        // B-854 (A6) — WHO spent it and through whom. Null here: this fixture is
        // a direct charge, not a chained one.
        actorUserId: null, actorName: null, viaUserId: null,
      });
      expect(out.byFeature).toEqual([
        {feature: 'booking', spent: 344, refunded: 100, count: 2},
        {feature: 'other', spent: 5, refunded: 0, count: 1},
      ]);
      // B-854 (A6) — scoped on the ROW ID, not the actor. The actor arm survives
      // ONLY as the pre-metadata legacy fallback, gated on the key being absent:
      // a chained charge carries `actor_user_id = C`, and C is not a member of
      // this holder at all, so the old predicate saw nothing while the row's
      // `spent_credits` climbed.
      const txSql = (mockDb.q.mock.calls[0][0] as string).replace(/\s+/g, ' ');
      expect(txSql).toContain(`wt.metadata->>'family_row_id' = $2`);
      expect(txSql).toContain(`wt.metadata->>'via_family_row_id' = $2`);
      expect(txSql).toContain(`wt.actor_user_id = $3 AND NOT (wt.metadata ? 'family_row_id')`);
      expect(mockDb.q.mock.calls[0][1]).toEqual(['u-holder', 'fm-1', 'u-m', 50]);
    });
  });

  describe('usage (holder rollup)', () => {
    it('keys recent rows on the actor stamp — never the description LIKE-match', async () => {
      mockDb.qOne.mockResolvedValueOnce({total: 300, n: 1});
      mockDb.q
        .mockResolvedValueOnce([{id: 'fm-1', member_id: 'u-m', invite_phone: null, spent_credits: 300, spend_limit_credits: 1000, display_name: 'Ranger'}])
        .mockResolvedValueOnce([{amount_credits: -300, created_at: new Date('2026-08-04T00:00:00Z'), booking_id: 'b1', display_name: 'Ranger'}]);
      const out = await svc.usage('u-holder');
      expect(out.recent).toEqual([{
        name: 'Ranger', credits: 300, at: '2026-08-04T00:00:00.000Z', bookingId: 'b1',
        // B-854 (A6) — the line item names the spender and the route it took.
        actorUserId: null, viaUserId: null,
      }]);
      const sql = (mockDb.q.mock.calls[1][0] as string).replace(/\s+/g, ' ');
      expect(sql).toContain('wt.actor_user_id IS NOT NULL');
      expect(sql).not.toContain('LIKE');
    });

    // B-835 (plan D5 + A17) — the bar chart takes the top 50, but the TOTAL is a
    // SQL SUM over every active member, so a member outside the top 50 is still
    // counted and the shares still visibly add up via `othersSpent`.
    it('B-835: totalSpent + memberCount come from SQL; the rollup is the top 50 and othersSpent covers the tail', async () => {
      mockDb.qOne.mockResolvedValueOnce({total: 1000, n: 120});
      mockDb.q
        .mockResolvedValueOnce([{id: 'fm-1', member_id: 'u-m', invite_phone: null, spent_credits: 300, spend_limit_credits: 1000, display_name: 'Ranger'}])
        .mockResolvedValueOnce([]);
      const out = await svc.usage('u-holder');
      expect(out.totalSpent).toBe(1000);
      expect(out.memberCount).toBe(120);
      expect(out.othersSpent).toBe(700);
      expect(out.members).toHaveLength(1);
      expect(out.members[0].sharePct).toBe(30);

      const totalsSql = (mockDb.qOne.mock.calls[0][0] as string).replace(/\s+/g, ' ');
      expect(totalsSql).toContain('SUM(fm.spent_credits)');
      expect(totalsSql).toContain('COUNT(*)');
      const rollupSql = (mockDb.q.mock.calls[0][0] as string).replace(/\s+/g, ' ');
      expect(rollupSql).toContain('ORDER BY fm.spent_credits DESC LIMIT 50');
    });

    it(`B-835: an unnamed ledger actor falls back to 'Member', not 'Family member'`, async () => {
      mockDb.qOne.mockResolvedValueOnce({total: 0, n: 0});
      mockDb.q
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{amount_credits: -10, created_at: new Date('2026-08-04T00:00:00Z'), booking_id: null, display_name: null}]);
      const out = await svc.usage('u-holder');
      expect(out.recent[0].name).toBe('Member');
    });
  });

  describe('revoke', () => {
    it('also purges the removed member\'s stored location (privacy hygiene)', async () => {
      mockDb.q.mockResolvedValueOnce([{id: 'fm-1'}]); // the revoke UPDATE matched
      await svc.revoke('u-holder', 'fm-1');
      expect(mockDb.q).toHaveBeenCalledWith(
        expect.stringMatching(/DELETE FROM public\.family_member_locations/),
        ['fm-1', 'u-holder'],
      );
    });

    // B-843 (A4) — the location row is keyed by USER, so it is SHARED with every
    // other root the member belongs to. One root revoking must not blank the map
    // for roots that are still entitled to it.
    it('B-843: the location DELETE is gated on NO other active membership remaining', async () => {
      mockDb.q.mockResolvedValueOnce([{id: 'fm-1'}]);
      await svc.revoke('u-holder', 'fm-1');
      const del = mockDb.q.mock.calls
        .find(c => /DELETE FROM public\.family_member_locations/.test(String(c[0]))) as [string, unknown[]];
      const sql = del[0].replace(/\s+/g, ' ');
      expect(sql).toContain('AND NOT EXISTS (SELECT 1 FROM public.family_members fm2');
      expect(sql).toContain('fm2.member_id = family_member_locations.user_id');
      expect(sql).toContain(`fm2.status = 'active'`);
      // Excluding the row being revoked is load-bearing: it is still 'active' in
      // the same statement's snapshot on some plans, so without `id <> $1` the
      // delete would never fire at all.
      expect(sql).toContain('fm2.id <> $1');
    });

    // B-724 — the bare UPDATE always answered {ok:true}; with the client
    // toasting optimistically, a failed remove was invisible.
    it('B-724: 404s when the row does not exist for this holder (was a silent ok)', async () => {
      mockDb.q.mockResolvedValueOnce([]);      // UPDATE matched nothing
      mockDb.qOne.mockResolvedValueOnce(null); // and no such row for this holder
      await expect(svc.revoke('u-holder', 'fm-x')).rejects.toThrow(NotFoundException);
    });

    it('B-724: re-revoking an already-revoked member stays idempotent-ok', async () => {
      mockDb.q.mockResolvedValueOnce([]);
      mockDb.qOne.mockResolvedValueOnce({status: 'revoked'});
      await expect(svc.revoke('u-holder', 'fm-1')).resolves.toEqual({ok: true});
    });
  });

  // B-843 (A15) — dead code that would 23505 under the new partial unique.
  describe('deleted surface', () => {
    const strip = (s: string) => s.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

    it('linkPendingInvitesByPhone is GONE (it had no caller and would collide under the new index)', () => {
      // A blind `SET member_id = $1 WHERE invite_phone = $2` across every legacy
      // pending row can bind the same member under two holders in one statement.
      expect((svc as unknown as Record<string, unknown>).linkPendingInvitesByPhone).toBeUndefined();
      // Comments stripped first: the replacement comment NAMES the method, which
      // is exactly how a scan like this passes vacuously (CLAUDE.md).
      const src = strip(readFileSync(join(__dirname, 'family.service.ts'), 'utf8'));
      expect(src).not.toContain('linkPendingInvitesByPhone');
    });

    it('notifyUsageThresholdForMember is GONE — the row-keyed hook replaced it (A9)', () => {
      expect((svc as unknown as Record<string, unknown>).notifyUsageThresholdForMember).toBeUndefined();
      const src = strip(readFileSync(join(__dirname, 'family.service.ts'), 'utf8'));
      expect(src).not.toContain('notifyUsageThresholdForMember');
      // ...and the row-keyed one is still there.
      expect(src).toContain('async notifyUsageThreshold(');
    });
  });
});
