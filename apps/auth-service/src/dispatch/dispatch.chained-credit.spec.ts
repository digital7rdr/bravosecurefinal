import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {BadRequestException} from '@nestjs/common';
import {DispatchService} from './dispatch.service';
import {BookingStateMachine} from '../booking/state-machine.service';
import type {DatabaseService} from '../database/database.service';
import type {OpsAuditService} from '../ops/ops-audit.service';
import type {BookingPushBridge} from '../ops/booking-push-bridge.service';
import type {WalletService} from '../wallet/wallet.service';
import type {FamilyService} from '../family/family.service';

/**
 * B-854 — the ESCROW charge for a chained booking (`settleWonOffer`).
 *
 * The booking is stamped `payer_user_id = A` (the wallet), `payer_via_user_id =
 * B` (the intermediary), `client_id = C` (the spender). The charge must:
 * re-resolve BOTH membership rows under one ordered lock, refuse fail-closed if
 * any rung died, debit A, bump BOTH `spent_credits`, and carry both row ids into
 * the ledger metadata so a refund can reverse both.
 */
const fsm = new BookingStateMachine();
const audit = {record: jest.fn()};
const push = {
  providerAccepted: jest.fn(), paymentFailed: jest.fn(), familyChargeBlocked: jest.fn(),
  dispatchOffer: jest.fn(), noProvider: jest.fn(), bookingReDispatching: jest.fn(),
};
const wallet = {holdToEscrow: jest.fn(), refundEscrowHold: jest.fn()};
const family = {notifyUsageThreshold: jest.fn()};
const db = {q: jest.fn(), qOne: jest.fn(), withTransaction: jest.fn()};

function service(): DispatchService {
  return new DispatchService(
    db as unknown as DatabaseService, fsm,
    audit as unknown as OpsAuditService,
    push as unknown as BookingPushBridge,
    wallet as unknown as WalletService,
    undefined, undefined, undefined,
    family as unknown as FamilyService,
  );
}

const CLAIM_BOOKING = {
  status: 'DISPATCHING', client_id: 'C', region_code: 'AE', cpo_count: 1,
  requirements: {} as Record<string, unknown>, armed_required: false,
  dispatch_mode: 'auto' as string | null,
};
const AGENT_OK = {type: 'company', status: 'ACTIVE', cooldown_until: null};

/** The (B,C) row — the spender's own membership. */
const MEMBER_ROW = {
  id: 'fr-bc', holder_id: 'B', member_id: 'C', status: 'active', held_until: null,
  spend_limit_credits: null as number | null, spent_credits: 0, funds_sub_members: false,
  holder_suspended_at: null as Date | null, holder_deleted_at: null as Date | null,
};
/** The (A,B) row — the intermediary's membership under the root that pays. */
const FUNDING_ROW = {
  id: 'fr-ab', holder_id: 'A', member_id: 'B', status: 'active', held_until: null,
  spend_limit_credits: null as number | null, spent_credits: 0, funds_sub_members: true,
  holder_suspended_at: null as Date | null, holder_deleted_at: null as Date | null,
};

interface Wire {
  settleBooking?: Record<string, unknown> | null;
  chainRows?: Array<Record<string, unknown>>;
  ids?: {member_row_id: string | null; funding_row_id: string | null} | null;
}

function wire(w: Wire = {}): void {
  db.qOne.mockImplementation((sql: string) => {
    const s = String(sql);
    if (/SELECT status, region_code, cpo_count/.test(s)) {
      return Promise.resolve(null);
    }
    if (/FROM lite_bookings WHERE id = \$1 FOR UPDATE/.test(s) && /cpo_count/.test(s)) {
      return Promise.resolve(CLAIM_BOOKING);
    }
    if (/FROM public\.agents WHERE user_id = \$1/.test(s)) {return Promise.resolve(AGENT_OK);}
    if (/is_eligible_for_dispatch/.test(s)) {return Promise.resolve({ok: true});}
    if (/has_free_cpo_capacity/.test(s)) {return Promise.resolve({ok: true});}
    if (/SELECT 1 AS x FROM dispatch_offers/.test(s)) {return Promise.resolve(null);}
    if (/INSERT INTO dispatch_offers/.test(s)) {return Promise.resolve({id: 'o-1'});}
    if (/SELECT status, client_id, payer_user_id, payer_via_user_id, total_eur/.test(s)) {
      return Promise.resolve(w.settleBooking === undefined
        ? {status: 'DISPATCHING', client_id: 'C', payer_user_id: 'A', payer_via_user_id: 'B', total_eur: '100'}
        : w.settleBooking);
    }
    if (/SELECT booking_id FROM escrow_holds/.test(s)) {return Promise.resolve(null);}
    if (/AS member_row_id/.test(s)) {
      return Promise.resolve(w.ids === undefined
        ? {member_row_id: 'fr-bc', funding_row_id: 'fr-ab'} : w.ids);
    }
    // The charge-failure handler's booking read.
    if (/SELECT client_id, payer_user_id, payer_via_user_id FROM lite_bookings WHERE id = \$1$/m.test(s)
        || /SELECT client_id, payer_user_id, payer_via_user_id FROM lite_bookings/.test(s)) {
      return Promise.resolve({client_id: 'C', payer_user_id: 'A', payer_via_user_id: 'B'});
    }
    if (/SELECT status FROM lite_bookings WHERE id = \$1 FOR UPDATE/.test(s)) {
      return Promise.resolve({status: 'DISPATCHING'});
    }
    return Promise.resolve(null);
  });
  db.q.mockImplementation((sql: string) => {
    const s = String(sql);
    if (/FROM public\.family_members fr/.test(s) && /FOR UPDATE OF fr/.test(s)) {
      return Promise.resolve(w.chainRows ?? [MEMBER_ROW, FUNDING_ROW]);
    }
    if (/UPDATE dispatch_offers SET status = 'ACCEPTED'/.test(s)) {return Promise.resolve([]);}
    if (/UPDATE lite_bookings\s+SET status = 'CONFIRMED'/.test(s)) {
      return Promise.resolve([{id: 'b1'}]);
    }
    return Promise.resolve([{id: 'b1'}]);
  });
}

function bumps(): Array<[string, number]> {
  return db.q.mock.calls
    .filter(c => /UPDATE public\.family_members SET spent_credits = spent_credits \+ \$2/.test(String(c[0])))
    .map(c => {
      const p = c[1] as [string, number];
      return [p[0], p[1]] as [string, number];
    });
}

describe('B-854 — the chained escrow charge', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    audit.record.mockResolvedValue(undefined);
    push.providerAccepted.mockResolvedValue(undefined);
    push.familyChargeBlocked.mockResolvedValue(undefined);
    push.paymentFailed.mockResolvedValue(undefined);
    wallet.holdToEscrow.mockResolvedValue({currency: 'AED'});
    family.notifyUsageThreshold.mockResolvedValue(undefined);
    db.withTransaction.mockImplementation((fn: (tx: unknown) => unknown) => fn({q: db.q, qOne: db.qOne}));
  });

  it('debits the ROOT wallet and carries BOTH row ids into the ledger metadata', async () => {
    wire();
    await service().claimOpenBooking('b1', 'agency-A');
    expect(wallet.holdToEscrow).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      // The money leaves A's wallet…
      clientId: 'A',
      // …the LEDGER's own cap key is the funding row (that is what the money on
      // THIS wallet was taken against)…
      familyRowId: 'fr-ab',
      // …the spender's own row rides as the via key, with the intermediary.
      viaFamilyRowId: 'fr-bc',
      viaUserId: 'B',
      // The actor stays the spender, so the root's sheet reads "C via B".
      actorUserId: 'C',
    }));
  });

  it('bumps BOTH allowances, each keyed on the id it locked', async () => {
    wire();
    await service().claimOpenBooking('b1', 'agency-A');
    const b = bumps();
    expect(b).toHaveLength(2);
    expect(b.map(x => x[0]).sort()).toEqual(['fr-ab', 'fr-bc']);
    expect(b.every(x => x[1] === 100)).toBe(true);
  });

  it('warns BOTH holders after the commit — they are different people', async () => {
    wire();
    await service().claimOpenBooking('b1', 'agency-A');
    expect(family.notifyUsageThreshold).toHaveBeenCalledWith('fr-bc');
    expect(family.notifyUsageThreshold).toHaveBeenCalledWith('fr-ab');
  });

  it.each([
    ['the switch was turned off', [{...MEMBER_ROW}, {...FUNDING_ROW, funds_sub_members: false}]],
    ['the intermediary was revoked', [{...MEMBER_ROW}, {...FUNDING_ROW, status: 'revoked'}]],
    ['the intermediary is on hold', [{...MEMBER_ROW}, {...FUNDING_ROW, held_until: new Date(Date.now() + 86_400_000)}]],
    ['the ROOT is suspended', [{...MEMBER_ROW}, {...FUNDING_ROW, holder_suspended_at: new Date()}]],
    ['the intermediary is suspended', [{...MEMBER_ROW, holder_suspended_at: new Date()}, {...FUNDING_ROW}]],
    ['the intermediary was erased', [{...MEMBER_ROW, holder_deleted_at: new Date()}, {...FUNDING_ROW}]],
    ['the spender was revoked', [{...MEMBER_ROW, status: 'revoked'}, {...FUNDING_ROW}]],
    ['the spender is over their own cap', [{...MEMBER_ROW, spend_limit_credits: 50, spent_credits: 0}, {...FUNDING_ROW}]],
    ['the intermediary is over theirs', [{...MEMBER_ROW}, {...FUNDING_ROW, spend_limit_credits: 50, spent_credits: 0}]],
  ])('fails CLOSED when %s — no debit, no bump', async (_name, rows) => {
    wire({chainRows: rows});
    await expect(service().claimOpenBooking('b1', 'agency-A')).rejects.toBeInstanceOf(BadRequestException);
    expect(wallet.holdToEscrow).not.toHaveBeenCalled();
    expect(bumps()).toHaveLength(0);
  });

  it('a missing row id is fail-closed too (never a charge against one rung)', async () => {
    wire({ids: {member_row_id: 'fr-bc', funding_row_id: null}});
    await expect(service().claimOpenBooking('b1', 'agency-A')).rejects.toBeInstanceOf(BadRequestException);
    expect(wallet.holdToEscrow).not.toHaveBeenCalled();
  });

  it('A2 — a chain whose WALLET is the spender is refused, never a self-charge', async () => {
    wire({settleBooking: {
      status: 'DISPATCHING', client_id: 'C', payer_user_id: 'C', payer_via_user_id: 'B', total_eur: '100',
    }});
    await expect(service().claimOpenBooking('b1', 'agency-A')).rejects.toBeInstanceOf(BadRequestException);
    expect(wallet.holdToEscrow).not.toHaveBeenCalled();
  });

  it('a NON-chained family booking still takes the B-384 path, untouched', async () => {
    wire({settleBooking: {
      status: 'DISPATCHING', client_id: 'C', payer_user_id: 'B', payer_via_user_id: null, total_eur: '100',
    }});
    // The B-384 statement is `fm`-aliased and answered by qOne; route it.
    const prevQOne = db.qOne.getMockImplementation()!;
    db.qOne.mockImplementation((sql: string) => {
      if (/FROM public\.family_members fm/.test(String(sql))) {
        return Promise.resolve({
          id: 'fm-plain', held_until: null, spend_limit_credits: null,
          spent_credits: 0, holder_suspended_at: null,
        });
      }
      return prevQOne(sql);
    });
    await service().claimOpenBooking('b1', 'agency-A');
    expect(wallet.holdToEscrow).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      clientId: 'B', familyRowId: 'fm-plain', viaFamilyRowId: null, viaUserId: null,
    }));
    expect(bumps()).toEqual([['fm-plain', 100]]);
  });
});

describe('B-854 (A8/A10) — the charge-failure fan-out names the right root', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    audit.record.mockResolvedValue(undefined);
    push.familyChargeBlocked.mockResolvedValue(undefined);
    push.paymentFailed.mockResolvedValue(undefined);
    wallet.holdToEscrow.mockResolvedValue({currency: 'AED'});
    family.notifyUsageThreshold.mockResolvedValue(undefined);
    db.withTransaction.mockImplementation((fn: (tx: unknown) => unknown) => fn({q: db.q, qOne: db.qOne}));
  });

  it('the SPENDER is told about the INTERMEDIARY, never the wallet above it', async () => {
    wire({chainRows: [{...MEMBER_ROW}, {...FUNDING_ROW, status: 'revoked'}]});
    await expect(service().claimOpenBooking('b1', 'agency-A')).rejects.toBeInstanceOf(BadRequestException);
    await new Promise(r => setImmediate(r));
    // LM-B7 — the id handed to the member is B's.
    expect(push.familyChargeBlocked).toHaveBeenCalledWith('C', 'b1', 'B');
    // Both upstream parties hear it: the allowance owner and the money owner.
    expect(push.familyChargeBlocked).toHaveBeenCalledWith('B', 'b1', 'B');
    expect(push.familyChargeBlocked).toHaveBeenCalledWith('A', 'b1', 'B');
  });

  it('the payment_failed audit row says WHY and whether a chain was involved', async () => {
    wire({chainRows: [{...MEMBER_ROW}, {...FUNDING_ROW, status: 'revoked'}]});
    await expect(service().claimOpenBooking('b1', 'agency-A')).rejects.toBeInstanceOf(BadRequestException);
    await new Promise(r => setImmediate(r));
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      action: 'dispatch.payment_failed',
      metadata: expect.objectContaining({reason: 'family_blocked', chained: true}),
    }));
  });
});

describe('B-854 (A1/A2) — the source invariants the doubles cannot prove', () => {
  const strip = (s: string) => s.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const svc = (): string =>
    strip(readFileSync(join(__dirname, 'dispatch.service.ts'), 'utf8')).replace(/\r?\n/g, '\n');

  it('A1 — the B-384 outer guard EXCLUDES a chained booking', () => {
    // Without `!b.payer_via_user_id` the B-384 block re-resolves `(client,
    // wallet)` — a pair with no membership row — and every chained booking
    // throws charge_failed_family before the chained branch can run.
    expect(svc()).toMatch(
      /if \(b\.payer_user_id && b\.payer_user_id !== b\.client_id && !b\.payer_via_user_id\)/,
    );
  });

  it('A1 — the chained branch sits AFTER the B-384 block and never uses the `fm` literals', () => {
    const s = svc();
    const b384 = s.indexOf('fm.spend_limit_credits, fm.spent_credits');
    const chained = s.indexOf('} else if (b.payer_via_user_id) {');
    expect(b384).toBeGreaterThan(-1);
    expect(chained).toBeGreaterThan(b384);
    // The pins anchor on the FIRST occurrence of each literal; the chained
    // branch must not introduce either one earlier in the file.
    expect(s.indexOf('FROM public.family_members fm')).toBeLessThan(chained);
    expect(s.slice(chained)).not.toContain('fm.spend_limit_credits, fm.spent_credits');
    expect(s.slice(chained)).not.toContain('FROM public.family_members fm\n');
  });

  it('A2 — both cap rows are locked in ONE statement, ordered by id, `OF fr`', () => {
    const s = svc();
    // Anchored on the LOCK, not on the first `fr` in the file: the id-discovery
    // read above it is `mr`/`fu`-aliased, and a naive first-occurrence anchor
    // would land there and pass vacuously (CLAUDE.md's source-scan rule).
    const at = s.indexOf('SELECT fr.id, fr.holder_id, fr.member_id');
    expect(at).toBeGreaterThan(-1);
    const stmt = s.slice(at, at + 700);
    expect(stmt).toMatch(/WHERE fr\.id = ANY\(\$1::uuid\[\]\)/);
    // ORDER BY id is the TOTAL order. "Upstream before member" is only a local
    // one and deadlocks on two mutual funders (§7 round 1a P0).
    expect(stmt).toMatch(/ORDER BY fr\.id/);
    // `OF fr` so the joined users row is not locked — same reason as `OF fm`.
    expect(stmt).toMatch(/FOR UPDATE OF fr/);
    expect(stmt).not.toMatch(/FOR UPDATE`/);
  });

  it('MON-4 — the chained family lock still precedes the wallet debit', () => {
    const s = svc();
    const lock = s.indexOf('FOR UPDATE OF fr');
    const hold = s.indexOf('this.wallet.holdToEscrow');
    expect(lock).toBeGreaterThan(-1);
    expect(hold).toBeGreaterThan(-1);
    expect(lock).toBeLessThan(hold);
  });
});
