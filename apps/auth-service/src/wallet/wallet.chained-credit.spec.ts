import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {WalletService} from './wallet.service';
import type {DatabaseService} from '../database/database.service';
import type {ConfigService} from '@nestjs/config';
import type {StripeClient} from './stripe.client';

/**
 * B-854 (A7) — refunds on a CHAINED booking.
 *
 * A chained charge consumed TWO allowances (the spender's limit under the
 * intermediary, and the intermediary's limit under the root whose wallet paid),
 * so a refund owes BOTH back. It must also refuse to give back more than the
 * booking ever consumed: a partial cancel followed by an upheld dispute clawback
 * would otherwise hand the member free headroom on someone else's plan.
 */
const ESCROW = '00000000-0000-0000-0000-0000000000e5';
const cfg = () => ({
  get: (k: string) => (k === 'platformAccounts.escrowId' ? ESCROW
    : k === 'platformAccounts.platformFeeId' ? '00000000-0000-0000-0000-0000000000fe' : undefined),
}) as unknown as ConfigService;
const stripe = () => ({}) as unknown as StripeClient;
const db = () => ({q: jest.fn(), qOne: jest.fn()}) as unknown as DatabaseService;

/**
 * A transaction double for `refundEscrowHold` on a chained booking.
 * `charge` is what the charge-row metadata lookup answers; `sums` is the
 * charged/refunded aggregate the cap is computed from.
 */
function chainTx(opts: {
  charge?: {row_id: string | null; via_row_id: string | null; via_user_id?: string | null} | null;
  sums?: {charged: string; refunded: string} | null;
  gross?: number;
  /** P3 — a SELF-paid booking: the spender IS the wallet, so no family row exists. */
  selfPaid?: boolean;
} = {}) {
  const q = jest.fn().mockResolvedValue([]);
  const qOne = jest.fn().mockImplementation((sql: string) => {
    const s = String(sql);
    if (/FROM escrow_holds\s+WHERE booking_id = \$1 FOR UPDATE/.test(s)) {
      return Promise.resolve({
        client_id: 'C', gross_credits: opts.gross ?? 800, currency: 'AED', status: 'HELD',
      });
    }
    if (/SELECT client_id, payer_user_id FROM lite_bookings/.test(s)) {
      return Promise.resolve(opts.selfPaid
        ? {client_id: 'C', payer_user_id: 'C'}
        : {client_id: 'C', payer_user_id: 'A'});
    }
    if (/metadata->>'family_row_id' AS row_id/.test(s)) {
      return Promise.resolve(opts.charge === undefined
        ? {row_id: 'fr-ab', via_row_id: 'fr-bc', via_user_id: 'B'} : opts.charge);
    }
    if (/AS charged/.test(s)) {
      return Promise.resolve(opts.sums === undefined
        ? {charged: String(opts.gross ?? 800), refunded: String(opts.gross ?? 800)} : opts.sums);
    }
    if (/payer_via_user_id IS NOT NULL/.test(s)) {return Promise.resolve({n: 1});}
    if (/'refund', 'succeeded'/.test(s)) {return Promise.resolve({id: 'rf-1'});}
    return Promise.resolve(null);
  });
  return {q, qOne};
}

function reversal(tx: {q: jest.Mock}): unknown[] | undefined {
  const call = tx.q.mock.calls.find(c => /GREATEST\(0, spent_credits - \$2\)/.test(String(c[0])));
  return call?.[1] as unknown[] | undefined;
}

describe('B-854 (A7) — a chained refund reverses BOTH allowances', () => {
  it('restores the funding row AND the member row in one statement', async () => {
    const tx = chainTx();
    await new WalletService(db(), cfg(), stripe()).refundEscrowHold(tx as never, 'b1', 'agency no-show');
    const params = reversal(tx)!;
    expect((params[0] as string[]).slice().sort()).toEqual(['fr-ab', 'fr-bc']);
    expect(params[1]).toBe(800);
  });

  it('the refund LEDGER row carries both keys, read off the CHARGE row', async () => {
    const tx = chainTx();
    await new WalletService(db(), cfg(), stripe()).refundEscrowHold(tx as never, 'b1', 'agency no-show');
    const insert = tx.qOne.mock.calls.find(c => /'refund', 'succeeded'/.test(String(c[0])));
    const meta = JSON.parse((insert![1] as unknown[])[5] as string) as Record<string, unknown>;
    expect(meta).toMatchObject({
      family_row_id: 'fr-ab', via_family_row_id: 'fr-bc', via_user_id: 'B',
    });
  });

  it('caps the CUMULATIVE reversal at the recorded charge', async () => {
    // 800 charged, 600 already given back before this 300 → only 200 is owed.
    // Without the cap the member gains 100 BC of free headroom on the root's
    // plan (the partial-cancel + clawback shape from the edge-case round).
    const tx = chainTx({gross: 300, sums: {charged: '800', refunded: '900'}});
    await new WalletService(db(), cfg(), stripe()).refundEscrowHold(tx as never, 'b1', 'dispute');
    expect(reversal(tx)![1]).toBe(200);
  });

  it('a fully-reversed booking reverses NOTHING more', async () => {
    const tx = chainTx({gross: 300, sums: {charged: '800', refunded: '1100'}});
    await new WalletService(db(), cfg(), stripe()).refundEscrowHold(tx as never, 'b1', 'dispute');
    expect(reversal(tx)).toBeUndefined();
  });

  it('an UNCHAINED charge still reverses exactly its one row', async () => {
    const tx = chainTx({charge: {row_id: 'fm-1', via_row_id: null}});
    await new WalletService(db(), cfg(), stripe()).refundEscrowHold(tx as never, 'b1', 'cancel');
    expect(reversal(tx)![0]).toEqual(['fm-1']);
  });

  it('a VIA booking with NO charge metadata warns with numbers only, and counts it', async () => {
    const metrics = {inc: jest.fn()};
    const tx = chainTx({charge: null});
    const svc = new WalletService(db(), cfg(), stripe(), metrics as never);
    const warn = jest.spyOn((svc as unknown as {log: {warn: jest.Mock}}).log, 'warn')
      .mockImplementation(() => undefined);
    await svc.refundEscrowHold(tx as never, 'b1', 'cancel');
    expect(metrics.inc).toHaveBeenCalledWith('family_chain_reversal_no_metadata_total');
    const msg = String(warn.mock.calls[0][0]);
    // Ids and numbers only — no names, no balances (the repo-wide log posture).
    expect(msg).toContain('b1');
    expect(msg).toMatch(/credits=800/);
    warn.mockRestore();
  });

  /**
   * `familyMetaForBooking` is the RECEIPT-decoration read; `reverseFamilySpend`
   * has its own, narrower one (two columns, no `via_user_id`). Only the first is
   * short-circuited here — the second deliberately runs BEFORE its
   * `memberId === holderId` guard so a degenerate chain cannot abort a reversal
   * that owes two allowances (the earlier P1 fix). The filter therefore keys on
   * the column only the decoration read projects, or it would also count the
   * reversal's and fail on correct code.
   */
  const decorationReads = (tx: {qOne: jest.Mock}): unknown[] =>
    tx.qOne.mock.calls.filter(c => /AS via_user_id/.test(String(c[0])));

  it('P3 — a SELF-paid refund never issues the receipt-decoration read', async () => {
    // The spender IS the wallet, so there is no family row on either rung and
    // nothing for that read to find. It is also the COMMON refund, so paying
    // for a round trip it cannot use is a per-cancellation cost for nothing.
    const tx = chainTx({selfPaid: true});
    await new WalletService(db(), cfg(), stripe()).refundEscrowHold(tx as never, 'b1', 'cancel');
    expect(decorationReads(tx)).toHaveLength(0);
  });

  it('P3 — a FAMILY refund still issues it (the short-circuit is not a blanket skip)', async () => {
    const tx = chainTx();
    await new WalletService(db(), cfg(), stripe()).refundEscrowHold(tx as never, 'b1', 'cancel');
    expect(decorationReads(tx).length).toBeGreaterThan(0);
  });

  it('a MISSING metric double never breaks the reversal (the counter is optional)', async () => {
    const tx = chainTx({charge: null});
    await expect(new WalletService(db(), cfg(), stripe())
      .refundEscrowHold(tx as never, 'b1', 'cancel')).resolves.toMatchObject({refunded: true});
  });
});

describe('B-854 (A7) — source invariants', () => {
  const strip = (s: string) => s.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const svc = (): string =>
    strip(readFileSync(join(__dirname, 'wallet.service.ts'), 'utf8')).replace(/\r?\n/g, '\n');

  it('the metadata path runs BEFORE the (member === holder) short-circuit', () => {
    const s = svc();
    const fnAt = s.indexOf('private async reverseFamilySpend(');
    expect(fnAt).toBeGreaterThan(-1);
    const body = s.slice(fnAt, fnAt + 3500);
    const meta = body.indexOf(`metadata->>'family_row_id' AS row_id`);
    const shortCircuit = body.indexOf('if (memberId === holderId) {return;}');
    expect(meta).toBeGreaterThan(-1);
    expect(shortCircuit).toBeGreaterThan(-1);
    // The guard belongs to the LEGACY (member, holder) arm — that pair is its
    // key. Leaving it on top aborts a reversal that owes two allowances.
    expect(meta).toBeLessThan(shortCircuit);
  });

  it('holdToEscrow writes the via keys only when it is given them', () => {
    const s = svc();
    expect(s).toMatch(/\.\.\.\(args\.viaFamilyRowId \? \{via_family_row_id: args\.viaFamilyRowId\} : \{\}\)/);
    expect(s).toMatch(/\.\.\.\(args\.viaUserId \? \{via_user_id: args\.viaUserId\} : \{\}\)/);
  });

  it('the booking-refund row keeps `kind` — the at-most-once index is partial on it', () => {
    const s = svc();
    expect(s).toContain(`kind: 'booking_refund'`);
    expect(s).toMatch(/ON CONFLICT \(user_id, booking_id\)[\s\S]{0,200}metadata->>'kind' = 'booking_refund'/);
  });
});
