import {BadRequestException, Injectable, Logger, Optional} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {DatabaseService, type Tx} from '../database/database.service';
import {DispatchMetricsService} from '../observability/dispatch-metrics.service';
import {StripeClient, type StripeEvent} from './stripe.client';

type TxType   = 'topup' | 'payment' | 'refund' | 'payout' | 'expire' | 'escrow_hold' | 'escrow_refund' | 'escrow_release';
type TxStatus = 'pending' | 'succeeded' | 'failed' | 'refunded';

/**
 * Bravo Credits expiry policy. Every minted batch of credits gets a
 * 12-month TTL; the sweep cron expires the batch on the dot and writes
 * an `expire`-typed audit row so users can see why their balance fell.
 *
 * `applyCreditDelta` (positive paths) writes a row into
 * `wallet_credit_batches`; `debitBatchesFifo` walks those rows oldest-
 * expiry-first so about-to-expire credits get used before fresh ones.
 */
const CREDIT_TTL_MONTHS = 12;

interface WalletBalanceRow {
  user_id: string;
  bravo_credits: number;
  currency: string;
  stripe_customer_id: string | null;
  updated_at: Date;
}

interface WalletTxRow {
  id: string;
  user_id: string;
  type: TxType;
  status: TxStatus;
  amount_credits: number;
  amount_fiat_cents: number;
  fiat_currency: string;
  description: string | null;
  booking_id: string | null;
  stripe_intent_id: string | null;
  stripe_client_secret: string | null;
  metadata: Record<string, unknown>;
  created_at: Date;
  settled_at: Date | null;
  /** B-854 (A14) — WHO spent it. On a family row this is the member, not the
   *  wallet owner; `SELECT *` already returns it, it was simply never mapped. */
  actor_user_id?: string | null;
}

export interface WalletBalance {
  bravo_credits: number;
  currency: string;
  stripe_customer_id: string | null;
}

export interface WalletTransaction {
  id: string;
  user_id: string;
  type: TxType;
  status: TxStatus;
  amount: number;             // same semantics the mobile store expects
  currency: string;
  description: string;
  booking_id?: string;
  created_at: string;
  /**
   * B-854 (A14) — a family charge lands on the ROOT's wallet, so without these
   * the root's own statement reads a member's (or, once chained, a sub-member's)
   * spend as their own. `via_user_id` is the intermediary on a chained charge,
   * null on every other row.
   */
  actor_user_id?: string | null;
  via_user_id?: string | null;
}

export interface TopUpResult {
  transaction_id: string;
  credits_awarded: number;
  /** Present when Stripe is enabled. */
  client_secret?: string;
  intent_id?: string;
  customer_id?: string;
  /** Present when Stripe is disabled — the client auto-settles locally. */
  fallback?: true;
  balance: WalletBalance;
}

export interface SavedCard {
  id: string;
  brand: string;
  last4: string;
  exp_month: number;
  exp_year: number;
  is_default: boolean;
}

@Injectable()
export class WalletService {
  private readonly log = new Logger(WalletService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly cfg: ConfigService,
    private readonly stripe: StripeClient,
    // B-854 (A7) — optional so every existing construction site (and every
    // spec double) is unchanged. It counts ONE thing: a chained booking whose
    // charge row carried no metadata, i.e. an allowance that may be stuck.
    @Optional() private readonly metrics?: DispatchMetricsService,
  ) {}

  async getBalance(userId: string, tx?: Tx): Promise<WalletBalance> {
    const q = tx ?? this.db;
    const row = await q.qOne<WalletBalanceRow>(
      `SELECT * FROM wallet_balances WHERE user_id = $1`,
      [userId],
    ) ?? await this.ensureBalanceRow(userId);
    return {
      bravo_credits: row.bravo_credits,
      currency: row.currency,
      stripe_customer_id: row.stripe_customer_id,
    };
  }

  /**
   * A user's credit batches for the wallet UI (audit F-06 — the mobile
   * Balance tab renders these with per-batch expiry). Returns active +
   * recently-expired batches, newest first, in the shape the mobile
   * `CreditBatch` type expects. `amount` is the REMAINING credits in the
   * batch (total minus consumed) — that's the number expiry will reclaim.
   */
  async listBatches(userId: string): Promise<Array<{
    id: string;
    label: string;
    booking_id?: string;
    amount: number;
    aed_equivalent: number;
    issued_at: string;
    expires_at: string;
    source: 'booking' | 'topup';
  }>> {
    const rows = await this.db.q<{
      id: string; amount_credits: number; consumed_credits: number;
      issued_at: Date; expires_at: Date; src_type: TxType | null; booking_id: string | null;
    }>(
      `SELECT b.id, b.amount_credits, b.consumed_credits, b.issued_at, b.expires_at,
              t.type AS src_type, t.booking_id
         FROM wallet_credit_batches b
         LEFT JOIN wallet_transactions t ON t.id = b.source_tx_id
        WHERE b.user_id = $1
          AND b.consumed_credits < b.amount_credits
          AND (b.expired_at IS NULL OR b.expired_at > NOW() - INTERVAL '30 days')
        ORDER BY b.expires_at ASC, b.issued_at ASC
        LIMIT 100`,
      [userId],
    );
    return rows.map(r => {
      const remaining = r.amount_credits - r.consumed_credits;
      const issued = new Date(r.issued_at);
      return {
        id: r.id,
        label: issued.toLocaleDateString('en-GB', {month: 'short', year: 'numeric'}),
        booking_id: r.booking_id ?? undefined,
        amount: remaining,
        aed_equivalent: remaining, // 1 BC = 1 currency unit (Phase-1 peg)
        issued_at: issued.toISOString(),
        expires_at: new Date(r.expires_at).toISOString(),
        source: (r.src_type === 'payout' || r.src_type === 'refund') && r.booking_id ? 'booking' : 'topup',
      };
    });
  }

  async listTransactions(userId: string, limit = 50, offset = 0): Promise<WalletTransaction[]> {
    const rows = await this.db.q<WalletTxRow>(
      `SELECT * FROM wallet_transactions
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT $2 OFFSET $3`,
      [userId, limit, offset],
    );
    return rows.map(this.toClientTx);
  }

  // ── Promo codes ───────────────────────────────────────────────────────────

  /**
   * Redeem a promo code → credit BC once per user. The (promo_id, user_id)
   * primary key on promo_redemptions makes the double-redeem guard atomic
   * (a racing second insert conflicts), so a user can't double-credit a code.
   */
  async redeemPromo(userId: string, rawCode: string): Promise<{credits_awarded: number; balance: WalletBalance}> {
    const code = rawCode.trim().toUpperCase();
    if (!code) {throw new BadRequestException('code_required');}

    // One transaction end-to-end (audit F-15): the FOR UPDATE lock makes the
    // max_redemptions check-then-increment atomic (no oversell), and a crash
    // can no longer leave a redemption row without its ledger row / credit.
    return await this.db.withTransaction(async (t: Tx) => {
      const promo = await t.qOne<{
        id: string; credits: number; max_redemptions: number | null;
        redeemed_count: number; expires_at: string | null;
      }>(
        `SELECT id, credits, max_redemptions, redeemed_count, expires_at
           FROM promo_codes WHERE upper(code) = $1 AND active = true
           FOR UPDATE`,
        [code],
      );
      if (!promo) {throw new BadRequestException('invalid_code');}
      if (promo.expires_at && new Date(promo.expires_at) < new Date()) {throw new BadRequestException('code_expired');}
      if (promo.max_redemptions !== null && promo.redeemed_count >= promo.max_redemptions) {
        throw new BadRequestException('code_exhausted');
      }

      // Atomic per-user guard: the PK rejects a second redemption by this user.
      try {
        await t.q(
          `INSERT INTO promo_redemptions (promo_id, user_id, credits) VALUES ($1, $2, $3)`,
          [promo.id, userId, promo.credits],
        );
      } catch {
        throw new BadRequestException('already_redeemed');
      }
      await t.q(`UPDATE promo_codes SET redeemed_count = redeemed_count + 1 WHERE id = $1`, [promo.id]);

      const tx = await this.insertTx({
        userId,
        type: 'topup',
        status: 'succeeded',
        amountCredits: promo.credits,
        amountFiatCents: 0,
        fiatCurrency: 'aed',
        description: `Promo code ${code}`,
        metadata: {kind: 'promo', code},
        settledAt: new Date(),
      }, t);
      await this.creditDeltaTx(t, userId, promo.credits, tx.id);
      return {credits_awarded: promo.credits, balance: await this.getBalance(userId, t)};
    });
  }

  /**
   * Ops-initiated manual credit adjustment (audit F-14). Positive `credits`
   * grants BC (ledger `topup` + expiry batch); negative debits (ledger
   * `payment`, insufficient-guarded, FIFO batch consumption). The ledger
   * row's metadata carries the acting admin + mandatory reason — that IS
   * the audit trail. Locked + transactional like every other money path.
   */
  async adjustCredits(
    adminId: string,
    userId: string,
    credits: number,
    reason: string,
  ): Promise<{balance: WalletBalance; transaction_id: string}> {
    const delta = Math.trunc(credits);
    if (!delta) throw new BadRequestException('credits_must_be_nonzero');
    if (!reason?.trim()) throw new BadRequestException('reason_required');
    await this.ensureBalanceRow(userId);
    return await this.db.withTransaction(async (t: Tx) => {
      const row = await t.qOne<WalletBalanceRow>(
        `SELECT * FROM wallet_balances WHERE user_id = $1 FOR UPDATE`,
        [userId],
      );
      if (!row) throw new BadRequestException('wallet_not_found');
      if (delta < 0 && row.bravo_credits < -delta) {
        throw new BadRequestException('insufficient_credits');
      }
      const tx = await this.insertTx({
        userId,
        type: delta > 0 ? 'topup' : 'payment',
        status: 'succeeded',
        amountCredits: delta,
        amountFiatCents: 0,
        fiatCurrency: row.currency,
        description: `Ops adjustment · ${reason.trim()}`,
        metadata: {kind: 'ops_adjustment', admin_id: adminId, reason: reason.trim()},
        settledAt: new Date(),
      }, t);
      await this.creditDeltaTx(t, userId, delta, delta > 0 ? tx.id : undefined);
      this.log.log(`ops wallet adjustment user=${userId} by=${adminId} (${delta > 0 ? '+' : ''}${delta} BC)`);
      return {balance: await this.getBalance(userId, t), transaction_id: tx.id};
    });
  }

  // ── Saved cards (Payment Methods) ─────────────────────────────────────────

  private async getOrCreateCustomer(userId: string): Promise<string> {
    const row = await this.ensureBalanceRow(userId);
    const customerId = await this.stripe.ensureCustomer(userId, row.stripe_customer_id);
    if (customerId !== row.stripe_customer_id) {
      await this.db.q(
        `UPDATE wallet_balances SET stripe_customer_id = $1 WHERE user_id = $2`,
        [customerId, userId],
      );
    }
    return customerId;
  }

  /** Client confirms this SetupIntent via PaymentSheet to save a card. */
  async createCardSetupIntent(userId: string): Promise<{client_secret: string}> {
    const customerId = await this.getOrCreateCustomer(userId);
    const si = await this.stripe.createSetupIntent(customerId);
    return {client_secret: si.client_secret};
  }

  async listCards(userId: string): Promise<{cards: SavedCard[]}> {
    const customerId = await this.getOrCreateCustomer(userId);
    const [cards, defaultId] = await Promise.all([
      this.stripe.listCards(customerId),
      this.stripe.getDefaultCardId(customerId),
    ]);
    return {
      cards: cards.map(pm => ({
        id: pm.id,
        brand: pm.card.brand,
        last4: pm.card.last4,
        exp_month: pm.card.exp_month,
        exp_year: pm.card.exp_year,
        is_default: pm.id === defaultId,
      })),
    };
  }

  async removeCard(userId: string, paymentMethodId: string): Promise<{removed: true}> {
    const customerId = await this.getOrCreateCustomer(userId);
    // Only let the user detach a card that belongs to THEIR customer.
    const owned = await this.stripe.listCards(customerId);
    if (!owned.some(pm => pm.id === paymentMethodId)) {
      throw new BadRequestException('card_not_found');
    }
    await this.stripe.detachCard(paymentMethodId);
    return {removed: true};
  }

  async setDefaultCard(userId: string, paymentMethodId: string): Promise<{default_id: string}> {
    const customerId = await this.getOrCreateCustomer(userId);
    const owned = await this.stripe.listCards(customerId);
    if (!owned.some(pm => pm.id === paymentMethodId)) {
      throw new BadRequestException('card_not_found');
    }
    await this.stripe.setDefaultCard(customerId, paymentMethodId);
    return {default_id: paymentMethodId};
  }

  /**
   * Mint a PaymentIntent + write a PENDING ledger row. When Stripe is
   * disabled (no secret key), we still mint the ledger row and settle it
   * immediately — that lets local dev exercise the full flow end-to-end.
   */
  async topUp(userId: string, input: {amount: number; currency: string; creditsHint?: number}): Promise<TopUpResult> {
    if (input.amount <= 0) throw new BadRequestException('amount must be > 0');

    /**
     * Founder 2026-09-01 — THE SETTLEMENT CURRENCY IS THE SERVER'S, NEVER THE CLIENT'S.
     *
     * `computeCreditsForFiat` awards `round(amount)` credits whatever currency the card
     * is charged in (the 1-fiat-unit = 1-BC peg, CREDITS_BC_AUDIT F-01). That made the
     * currency field look economically inert, and it was passed straight to Stripe from
     * whichever screen happened to call: `aed` from the wallet, `usd` from the booking
     * paywall and the Pro paywall. It is not inert. Every service price in this product
     * is quoted in EUR and converted at `eur_per_bc` (default 1.0), so 500 BC is 500 EUR
     * of service — and the wallet path was selling it for 500 AED, about a quarter of that.
     *
     * So the currency is decided HERE. `input.currency` is accepted and ignored: an old
     * build still sending `aed` must not be able to buy credits at a discount, and 400ing
     * it instead would leave those users unable to top up at all. Stripe's PaymentSheet
     * shows the real currency and amount before the customer confirms, so nothing on
     * screen can disagree with what is charged.
     */
    const currency = this.settlementCurrency();
    // Why: credits and cents must be the SAME money. Math.round on a 2-decimal
    // amount minted credits the card never paid for (1.50 → charged 150¢,
    // credited 2 BC — a repeatable 33% discount). floor() the credits and
    // charge exactly their value; a fractional remainder is simply not charged.
    const credits = this.computeCreditsForFiat(input.amount, currency);
    const cents = credits * 100;
    const balanceRow = await this.ensureBalanceRow(userId);

    // ── Stripe disabled → local-only topup. Still writes a real ledger row.
    if (!this.stripe.enabled) {
      // Why: without this gate a prod deploy that loses STRIPE_SECRET_KEY
      // becomes a free money printer (audit F-15). Dev/staging keep the
      // fallback; production requires the explicit env escape hatch.
      const isProd = this.cfg.get<string>('nodeEnv') === 'production';
      if (isProd && process.env['ALLOW_NO_STRIPE_TOPUP'] !== '1') {
        throw new BadRequestException('stripe_disabled');
      }
      return await this.db.withTransaction(async t => {
        const tx = await this.insertTx({
          userId,
          type: 'topup',
          status: 'succeeded',
          amountCredits: credits,
          amountFiatCents: cents,
          fiatCurrency: currency,
          description: `Top-up ${credits} BC (fallback / no stripe)`,
          metadata: {fallback: true},
          settledAt: new Date(),
        }, t);
        await this.creditDeltaTx(t, userId, credits, tx.id);
        return {
          transaction_id: tx.id,
          credits_awarded: credits,
          fallback: true as const,
          balance: await this.getBalance(userId, t),
        };
      });
    }

    // ── Stripe enabled → real PaymentIntent, ledger stays PENDING until webhook.
    const customerId = await this.stripe.ensureCustomer(userId, balanceRow.stripe_customer_id);
    if (customerId !== balanceRow.stripe_customer_id) {
      await this.db.q(
        `UPDATE wallet_balances SET stripe_customer_id = $1 WHERE user_id = $2`,
        [customerId, userId],
      );
    }

    const intent = await this.stripe.createPaymentIntent({
      amountCents: cents,
      currency,
      customerId,
      description: `Bravo Credits top-up · ${credits} BC`,
      metadata: {user_id: userId, credits: String(credits), kind: 'wallet_topup'},
    });

    const tx = await this.insertTx({
      userId,
      type: 'topup',
      status: 'pending',
      amountCredits: credits,
      amountFiatCents: cents,
      fiatCurrency: currency,
      description: `Top-up ${credits} BC`,
      metadata: {kind: 'wallet_topup'},
      stripeIntentId: intent.id,
      stripeClientSecret: intent.client_secret,
    });

    return {
      transaction_id: tx.id,
      credits_awarded: credits,
      client_secret: intent.client_secret,
      intent_id: intent.id,
      customer_id: customerId,
      balance: {
        bravo_credits: balanceRow.bravo_credits,
        currency: balanceRow.currency,
        stripe_customer_id: customerId,
      },
    };
  }

  /**
   * Credit BC to a CPO at mission completion (payout from the booking
   * escrow). Pure ledger motion — no Stripe roundtrip. The booking flow
   * computes the per-agent split and calls this once per assigned CPO.
   *
   * Idempotent per (user_id, booking_id) — relies on a partial unique
   * index on `wallet_transactions (user_id, booking_id) WHERE type =
   * 'payout'` (see migration). A retry returns the existing balance
   * unchanged rather than double-crediting. Without the index, only the
   * caller's `withTransaction` + WHERE-status guard in
   * `OpsService.completeBooking` prevents double-credit; if a future
   * code path (refund flow, maintenance script) calls this method
   * outside that guard the agent would be paid twice.
   */
  async creditForBooking(userId: string, bookingId: string, credits: number, description: string): Promise<WalletBalance> {
    if (credits <= 0) throw new BadRequestException('credits must be > 0');
    const row = await this.ensureBalanceRow(userId);
    return await this.db.withTransaction(async tx => {
      // ON CONFLICT DO NOTHING relies on the partial unique index.
      // Inserted row count tells us whether this is a fresh credit or a
      // duplicate retry — only fresh credits bump the balance.
      const inserted = await tx.q<{id: string}>(
        `INSERT INTO wallet_transactions (
           user_id, type, status, amount_credits, amount_fiat_cents, fiat_currency,
           description, booking_id, metadata, settled_at
         ) VALUES ($1, 'payout', 'succeeded', $2, 0, $3, $4, $5, '{}'::jsonb, NOW())
         ON CONFLICT (user_id, booking_id) WHERE type = 'payout' AND booking_id IS NOT NULL DO NOTHING
         RETURNING id`,
        [userId, credits, row.currency, description, bookingId],
      );
      if (inserted.length === 0) {
        // Duplicate — return the current balance without crediting.
        return this.getBalance(userId, tx);
      }
      await tx.q(
        `UPDATE wallet_balances SET bravo_credits = bravo_credits + $1 WHERE user_id = $2`,
        [credits, userId],
      );
      // Mint a 12-month-expiry batch so this payout is subject to the
      // same expiry policy as topups. Source-tx links back to the row
      // we just inserted for traceability.
      await tx.q(
        `INSERT INTO wallet_credit_batches
           (user_id, source_tx_id, amount_credits, expires_at)
         VALUES ($1, $2, $3, NOW() + INTERVAL '${CREDIT_TTL_MONTHS} months')`,
        [userId, inserted[0]?.id ?? null, credits],
      );
      // Why: read on tx — a pool read can't see this transaction's credit yet.
      return this.getBalance(userId, tx);
    });
  }

  /**
   * Refund BC to a client when a PAID booking is cancelled or aborted
   * (audit C2). Reverses the original `type='payment'` debit for the
   * booking by minting a `type='refund'` credit of the same magnitude.
   *
   * Idempotent per (user_id, booking_id) via the partial unique index
   * `ux_wallet_tx_booking_refund` (scoped to metadata.kind='booking_refund'
   * so it doesn't collide with unrelated refund rows). A second
   * cancel/abort — or a cancel racing an abort — returns the current
   * balance unchanged rather than double-refunding.
   *
   * The refund amount is derived SERVER-SIDE from the original payment
   * ledger row, never from the caller, so a tampered request can't inflate
   * the refund. Returns `{refunded: false}` when there is no captured
   * payment to reverse (free booking, never paid, or already refunded).
   */
  async refundForBooking(
    userId: string,
    bookingId: string,
    description: string,
  ): Promise<{refunded: boolean; credits: number; balance: WalletBalance}> {
    const row = await this.ensureBalanceRow(userId);
    return await this.db.withTransaction(async tx => {
      // Sum the client's captured payment debits for this booking. The
      // payWithCredits path writes a single negative `payment` row; we sum
      // defensively in case of split captures. Lock nothing extra — the
      // refund insert's ON CONFLICT is what guarantees at-most-once.
      const paid = await tx.qOne<{debited: string | null}>(
        `SELECT COALESCE(SUM(-amount_credits), 0) AS debited
           FROM wallet_transactions
          WHERE user_id = $1 AND booking_id = $2
            AND type = 'payment' AND status = 'succeeded'
            AND amount_credits < 0`,
        [userId, bookingId],
      );
      const credits = Math.round(Number(paid?.debited ?? 0));
      if (credits <= 0) {
        // Nothing was captured for this booking — nothing to refund.
        return {refunded: false, credits: 0, balance: await this.getBalance(userId, tx)};
      }
      // Ledger actor = the booking's client (the member on a family booking);
      // `userId` is the payer wallet being made whole.
      const b = await tx.qOne<{client_id: string}>(
        `SELECT client_id FROM lite_bookings WHERE id = $1`,
        [bookingId],
      );
      const actorId = b?.client_id ?? userId;
      // B-854 (A7) — the family keys ride the refund row too. `kind` is kept
      // EXACTLY as it was: the at-most-once index is partial on
      // `metadata->>'kind' = 'booking_refund'`, so changing or dropping it would
      // silently disarm the double-refund guard.
      const refundMeta = JSON.stringify({
        kind: 'booking_refund',
        ...(await this.familyMetaForBooking(tx, bookingId, userId, actorId)),
      });
      const inserted = await tx.q<{id: string}>(
        `INSERT INTO wallet_transactions (
           user_id, type, status, amount_credits, amount_fiat_cents, fiat_currency,
           description, booking_id, metadata, settled_at, actor_user_id, feature
         ) VALUES ($1, 'refund', 'succeeded', $2, 0, $3, $4, $5,
                   $7::jsonb, NOW(), $6, 'booking')
         ON CONFLICT (user_id, booking_id) WHERE type = 'refund' AND booking_id IS NOT NULL AND metadata->>'kind' = 'booking_refund' DO NOTHING
         RETURNING id`,
        [userId, credits, row.currency, description, bookingId, actorId, refundMeta],
      );
      if (inserted.length === 0) {
        // Already refunded (retry or cancel/abort race) — no double credit.
        return {refunded: false, credits: 0, balance: await this.getBalance(userId, tx)};
      }
      await tx.q(
        `UPDATE wallet_balances SET bravo_credits = bravo_credits + $1 WHERE user_id = $2`,
        [credits, userId],
      );
      await this.reverseFamilySpend(tx, actorId, userId, credits, bookingId);
      // Mint a fresh expiry batch for the refunded credits, same as a
      // payout/topup, so they're subject to the normal 12-month TTL.
      await tx.q(
        `INSERT INTO wallet_credit_batches
           (user_id, source_tx_id, amount_credits, expires_at)
         VALUES ($1, $2, $3, NOW() + INTERVAL '${CREDIT_TTL_MONTHS} months')`,
        [userId, inserted[0]?.id ?? null, credits],
      );
      this.log.log(`wallet refund booking=${bookingId} user=${userId} (+${credits} BC)`);
      return {refunded: true, credits, balance: await this.getBalance(userId, tx)};
    });
  }

  /**
   * Auto-dispatch escrow HOLD (Step 9 / §39.1) — "charged ≠ paid". On agency
   * accept, move the booking's credits from the CLIENT into the platform ESCROW
   * account in a PAIRED ledger; the agency is NOT credited here. Runs on the
   * CALLER's transaction (tx) so it is all-or-nothing with the offer flip — on
   * insufficient_credits it throws and the whole accept unwinds (offer stays
   * OFFERED, no hold). Returns the client's wallet currency for the escrow_holds row.
   *
   * Mirrors the locked-debit core of debitForFeature/payWithCredits. The escrow
   * account is a platform holding account, so its credit gets NO expiry batch
   * (held funds must not be reclaimed by the credit-expiry sweep).
   *
   * LM-B7 — the CALLER passes the resolved payer as `clientId` (BookingService.create
   * resolves the family holder at request time and stamps lite_bookings.payer_user_id;
   * DispatchService.accept debits it). This function stays payer-agnostic.
   */
  async holdToEscrow(
    tx: Tx,
    args: {
      clientId: string; bookingId: string; offerId: string; credits: number;
      actorUserId?: string; familyRowId?: string | null;
      /**
       * B-854 — the CHAIN. `familyRowId` stays "the cap the money on THIS
       * wallet was taken against" (the funding row once chained); these two say
       * which of the intermediary's members actually spent it, and through whom.
       * Both optional, so every existing caller is unchanged.
       */
      viaFamilyRowId?: string | null; viaUserId?: string | null;
    },
  ): Promise<{currency: string}> {
    const {clientId, bookingId, offerId, credits} = args;
    if (credits <= 0) throw new BadRequestException('credits must be > 0');
    const escrowId = this.cfg.get<string>('platformAccounts.escrowId');
    if (!escrowId) throw new Error('escrow_account_unconfigured');
    const desc = `Escrow hold ${bookingId}`;
    // Who the booking is FOR (family member on an owner-paid booking) — the
    // payer stays `clientId`; the actor is what the per-member spend view keys on.
    const actorId = args.actorUserId ?? clientId;

    // 1) Debit the client — lock the balance, gate on funds, ledger + balance.
    const client = await tx.qOne<WalletBalanceRow>(
      `SELECT * FROM wallet_balances WHERE user_id = $1 FOR UPDATE`,
      [clientId],
    );
    if (!client || client.bravo_credits < credits) {
      throw new BadRequestException('insufficient_credits');
    }
    // Stamp the FX rate used (the client's currency) so a later refund/release
    // reversal carries the same rate on its receipt — money moves in credits, so
    // this is the audit proof that the reversal is rate-exact, not a recompute input.
    // family_row_id pins cap bookkeeping to the charge-time membership row.
    // B-854 — the via keys ride the SAME metadata blob, so a refund reads the
    // whole chain off the charge row it is reversing rather than re-deriving it
    // from a booking that may since have been re-stamped.
    const meta = JSON.stringify({
      offer_id: offerId,
      ...(args.familyRowId ? {family_row_id: args.familyRowId} : {}),
      ...(args.viaFamilyRowId ? {via_family_row_id: args.viaFamilyRowId} : {}),
      ...(args.viaUserId ? {via_user_id: args.viaUserId} : {}),
      ...this.fxStamp(client.currency),
    });
    await tx.q(
      `INSERT INTO wallet_transactions (
         user_id, type, status, amount_credits, amount_fiat_cents, fiat_currency,
         description, booking_id, metadata, settled_at, actor_user_id, feature
       ) VALUES ($1, 'payment', 'succeeded', $2, 0, $3, $4, $5, $6::jsonb, NOW(), $7, 'booking')`,
      [clientId, -credits, client.currency, desc, bookingId, meta, actorId],
    );
    await tx.q(
      `UPDATE wallet_balances SET bravo_credits = bravo_credits - $1 WHERE user_id = $2`,
      [credits, clientId],
    );
    await this.debitBatchesFifoTx(tx, clientId, credits);

    // 2) Credit the platform escrow account (no expiry batch — held funds don't sweep).
    // Why: the escrow row deliberately stamps the CLIENT's currency (not the escrow
    // account's own) — the held funds belong to that client's job, so release/refund
    // stay symmetric. Credits are the unit; currency is only a label.
    await tx.q(
      `INSERT INTO wallet_transactions (
         user_id, type, status, amount_credits, amount_fiat_cents, fiat_currency,
         description, booking_id, metadata, settled_at, actor_user_id, feature
       ) VALUES ($1, 'escrow_hold', 'succeeded', $2, 0, $3, $4, $5, $6::jsonb, NOW(), $7, 'booking')`,
      [escrowId, credits, client.currency, desc, bookingId, meta, actorId],
    );
    await tx.q(
      `UPDATE wallet_balances SET bravo_credits = bravo_credits + $1 WHERE user_id = $2`,
      [credits, escrowId],
    );
    this.log.log(`escrow hold booking=${bookingId} client=${clientId} (${credits} BC -> escrow)`);
    return {currency: client.currency};
  }

  /**
   * Family-correct settle targeting. escrow_holds.client_id is the booking's
   * CLIENT (the member on a family booking) but the hold DEBITED the resolved
   * payer (lite_bookings.payer_user_id — the family holder). Every client-side
   * credit (refund / split / clawback) must therefore go back to the PAYER's
   * wallet, with the member kept as the ledger actor. Falls back to the hold's
   * client for pre-payer-stamp bookings (payer == client there anyway).
   */
  private async bookingSettleTarget(
    tx: Tx,
    bookingId: string,
    fallback: string,
  ): Promise<{creditTo: string; actorId: string}> {
    const b = await tx.qOne<{client_id: string; payer_user_id: string | null}>(
      `SELECT client_id, payer_user_id FROM lite_bookings WHERE id = $1`,
      [bookingId],
    );
    return {creditTo: b?.payer_user_id ?? fallback, actorId: b?.client_id ?? fallback};
  }

  /**
   * B-854 (A7) — the family keys a refund/reversal row must carry, read off the
   * CHARGE row it is reversing.
   *
   * Refund rows used to carry only `{kind}` + the fx stamp, so a receipt could
   * not be tied back to the allowance it restored and the ops finance list read
   * a member's refund as the root's own. Reading them from the charge (rather
   * than from the booking, or from whatever membership is live now) is the same
   * rule the reversal itself follows: a revoke → re-invite between charge and
   * refund must not move the credit onto a fresh row.
   *
   * Never throws — a decoration may not fail a refund.
   */
  private async familyMetaForBooking(
    tx: Tx, bookingId: string, walletUserId: string, actorId?: string,
  ): Promise<Record<string, string>> {
    // P3 — a booking whose spender IS the wallet is self-paid: it has no family
    // row on either rung, so there is nothing for this read to find. Skipped
    // rather than run-and-discard, because this is the COMMON refund and it
    // would otherwise pay for a round trip it cannot use.
    if (actorId !== undefined && actorId === walletUserId) {return {};}
    const charge = await tx.qOne<{row_id: string | null; via_row_id: string | null; via_user_id: string | null}>(
      `SELECT metadata->>'family_row_id' AS row_id,
              metadata->>'via_family_row_id' AS via_row_id,
              metadata->>'via_user_id' AS via_user_id
         FROM wallet_transactions
        WHERE booking_id = $1 AND user_id = $2 AND type = 'payment'
          AND amount_credits < 0 AND metadata ? 'family_row_id'
        ORDER BY created_at ASC LIMIT 1`,
      [bookingId, walletUserId],
    ).catch(() => null);
    if (!charge?.row_id) {return {};}
    return {
      family_row_id: charge.row_id,
      ...(charge.via_row_id ? {via_family_row_id: charge.via_row_id} : {}),
      ...(charge.via_user_id ? {via_user_id: charge.via_user_id} : {}),
    };
  }

  /**
   * A family-charged booking coming back to the holder frees the member's cap:
   * reverse the `spent_credits` bump the charge made. Prefers the CHARGE-TIME
   * membership row (metadata.family_row_id on the original debit) so a
   * revoke → re-invite between charge and refund can't eat the fresh row's
   * legitimate spend; falls back to the current active pair for pre-stamp
   * rows. GREATEST guards underflow; a missing row is a no-op — the wallet
   * credit above is the source of truth, this is cap bookkeeping.
   */
  private async reverseFamilySpend(tx: Tx, memberId: string, holderId: string, credits: number, bookingId?: string): Promise<void> {
    if (credits <= 0) {return;}
    if (bookingId) {
      // B-854 (A7) — the METADATA path runs FIRST and is not gated on
      // `memberId !== holderId`. That guard belongs to the legacy
      // (member, holder) fallback below, where the pair IS the key; on a
      // chained charge the two can legitimately coincide in degenerate data,
      // and aborting there would leave BOTH allowances permanently consumed.
      const charge = await tx.qOne<{row_id: string | null; via_row_id: string | null}>(
        `SELECT metadata->>'family_row_id' AS row_id,
                metadata->>'via_family_row_id' AS via_row_id
           FROM wallet_transactions
          WHERE booking_id = $1 AND user_id = $2 AND type = 'payment'
            AND amount_credits < 0 AND metadata ? 'family_row_id'
          ORDER BY created_at ASC LIMIT 1`,
        [bookingId, holderId],
      );
      if (charge?.row_id) {
        // A7 — cap the CUMULATIVE reversal at what was actually charged. A
        // partial cancel followed by an upheld dispute clawback can otherwise
        // credit back more allowance than the booking ever consumed, handing
        // the member free headroom on someone else's plan. Every refund row for
        // this booking on this wallet is already inserted by the time we get
        // here, so "reversed before this one" is `refunded − credits`.
        const sums = await tx.qOne<{charged: string; refunded: string}>(
          `SELECT
             COALESCE(SUM(CASE WHEN type = 'payment' AND amount_credits < 0
                               THEN -amount_credits ELSE 0 END), 0)::text AS charged,
             COALESCE(SUM(CASE WHEN type = 'refund' AND amount_credits > 0
                               THEN amount_credits ELSE 0 END), 0)::text AS refunded
             FROM wallet_transactions
            WHERE booking_id = $1 AND user_id = $2`,
          [bookingId, holderId],
        ).catch(() => null);
        const charged = Number(sums?.charged ?? 0);
        const priorReversals = Math.max(0, Number(sums?.refunded ?? 0) - credits);
        // No usable sums (a double that does not model them) → behave as before
        // and reverse the full amount; the GREATEST(0, …) floor still holds.
        const allowed = sums ? Math.max(0, charged - priorReversals) : credits;
        const delta = Math.min(credits, allowed);
        if (delta <= 0) {return;}
        // BOTH allowances come back: the one the wallet's money was capped
        // against, and the spender's own limit under the intermediary.
        const rowIds = [charge.row_id, charge.via_row_id].filter((x): x is string => !!x);
        await tx.q(
          `UPDATE public.family_members
              SET spent_credits = GREATEST(0, spent_credits - $2),
                  ${WalletService.REARM_QUOTA_PCT_SQL('$2')}
            WHERE id = ANY($1::uuid[])`,
          [rowIds, delta],
        );
        return;
      }
      // A7 — a VIA booking always writes metadata, so reaching the legacy
      // fallback for one means the charge row is missing or malformed and the
      // (member, holder) pair cannot describe a three-party charge. Numbers and
      // ids only, and it is loud because silently under-reversing a chained
      // booking leaves an allowance consumed forever.
      //
      // Skipped when the wallet IS the spender: a self-paid booking has no
      // family row on either rung, so there is nothing a chain could explain,
      // and this is the common refund — it must not pay for a read it cannot use.
      const via = memberId === holderId ? null : await tx.qOne<{n: number}>(
        `SELECT COUNT(*)::int AS n FROM lite_bookings
          WHERE id = $1 AND payer_via_user_id IS NOT NULL`,
        [bookingId],
      ).catch(() => null);
      if (Number(via?.n ?? 0) > 0) {
        this.log.warn(`[family.chain] via booking ${bookingId} has no charge metadata; reversal fell back (credits=${credits})`);
        this.metrics?.inc('family_chain_reversal_no_metadata_total');
      }
    }
    if (memberId === holderId) {return;}
    await tx.q(
      `UPDATE public.family_members
          SET spent_credits = GREATEST(0, spent_credits - $3),
              ${WalletService.REARM_QUOTA_PCT_SQL('$3')}
        WHERE member_id = $1 AND holder_id = $2 AND status = 'active'`,
      [memberId, holderId, credits],
    );
  }

  /**
   * B-724 / spec §26 — a refund frees the member's cap, so the 80/90/100 owner
   * warning bands must RE-ARM at the new usage or they stay latched at the
   * high-water mark and go permanently silent after the first refund cycle
   * (FamilyQuotaService.rearmUsageThreshold had the tested logic but ZERO
   * production callers; folding it into the same UPDATE keeps it atomic with
   * the spent_credits reversal). LEAST = lowering-only, mirroring that method.
   * `deltaParam` is the same placeholder the statement uses for the reversal
   * amount; RHS column refs read the PRE-update row, so the CASE computes the
   * band of the NEW spent value.
   */
  private static REARM_QUOTA_PCT_SQL(deltaParam: string): string {
    const newSpent = `GREATEST(0, spent_credits - ${deltaParam})`;
    return `quota_notified_pct = LEAST(quota_notified_pct, CASE
              WHEN spend_limit_credits IS NULL OR spend_limit_credits <= 0 THEN quota_notified_pct
              WHEN ${newSpent} * 100 >= spend_limit_credits * 100 THEN 100
              WHEN ${newSpent} * 100 >= spend_limit_credits * 90  THEN 90
              WHEN ${newSpent} * 100 >= spend_limit_credits * 80  THEN 80
              ELSE 0 END)`;
  }

  /**
   * Auto-dispatch escrow REFUND (Step 9 / LB5) — full reversal of a HELD hold
   * back to the PAYER (e.g. agency no-show). PAIRED ledger: debit escrow, credit
   * the wallet that funded the hold (the family holder on a member booking —
   * never the member; see bookingSettleTarget). Flips escrow_holds HELD ->
   * REFUNDED with to_client = gross. Runs on the CALLER's tx so it is atomic
   * with the booking flip. Idempotent: a missing or non-HELD hold is a no-op
   * (returns refunded:false).
   */
  async refundEscrowHold(
    tx: Tx,
    bookingId: string,
    reason: string,
  ): Promise<{refunded: boolean; credits: number}> {
    const escrowId = this.cfg.get<string>('platformAccounts.escrowId');
    if (!escrowId) throw new Error('escrow_account_unconfigured');
    const hold = await tx.qOne<{client_id: string; gross_credits: number; currency: string; status: string}>(
      `SELECT client_id, gross_credits, currency, status FROM escrow_holds
        WHERE booking_id = $1 FOR UPDATE`,
      [bookingId],
    );
    if (!hold || hold.status !== 'HELD') {
      return {refunded: false, credits: 0}; // nothing held / already settled — idempotent
    }
    const credits = hold.gross_credits;
    const {creditTo, actorId} = await this.bookingSettleTarget(tx, bookingId, hold.client_id);
    // B-854 (A7) — the refund row names the allowance(s) it restores.
    const meta = JSON.stringify({
      kind: 'escrow_refund', booking_id: bookingId,
      ...(await this.familyMetaForBooking(tx, bookingId, creditTo, actorId)),
      ...this.fxStamp(hold.currency),
    });

    // 1) Debit the escrow account.
    await tx.q(
      `INSERT INTO wallet_transactions (
         user_id, type, status, amount_credits, amount_fiat_cents, fiat_currency,
         description, booking_id, metadata, settled_at, actor_user_id, feature
       ) VALUES ($1, 'escrow_refund', 'succeeded', $2, 0, $3, $4, $5, $6::jsonb, NOW(), $7, 'booking')`,
      [escrowId, -credits, hold.currency, reason, bookingId, meta, actorId],
    );
    await tx.q(
      `UPDATE wallet_balances SET bravo_credits = bravo_credits - $1 WHERE user_id = $2`,
      [credits, escrowId],
    );
    // 2) Credit the payer + mint a fresh expiry batch (refunded credits get the normal TTL).
    const refundRow = await tx.qOne<{id: string}>(
      `INSERT INTO wallet_transactions (
         user_id, type, status, amount_credits, amount_fiat_cents, fiat_currency,
         description, booking_id, metadata, settled_at, actor_user_id, feature
       ) VALUES ($1, 'refund', 'succeeded', $2, 0, $3, $4, $5, $6::jsonb, NOW(), $7, 'booking')
       RETURNING id`,
      [creditTo, credits, hold.currency, reason, bookingId, meta, actorId],
    );
    await tx.q(
      `UPDATE wallet_balances SET bravo_credits = bravo_credits + $1 WHERE user_id = $2`,
      [credits, creditTo],
    );
    await tx.q(
      `INSERT INTO wallet_credit_batches (user_id, source_tx_id, amount_credits, expires_at)
       VALUES ($1, $2, $3, NOW() + INTERVAL '${CREDIT_TTL_MONTHS} months')`,
      [creditTo, refundRow?.id ?? null, credits],
    );
    await this.reverseFamilySpend(tx, actorId, creditTo, credits, bookingId);
    // 3) Flip the hold terminal — reconciliation: gross == to_client + to_provider + fee.
    await tx.q(
      `UPDATE escrow_holds
          SET status = 'REFUNDED', settled_at = NOW(),
              to_client_credits = $2, to_provider_credits = 0, platform_fee_credits = 0
        WHERE booking_id = $1`,
      [bookingId, credits],
    );
    this.log.log(`escrow refund booking=${bookingId} payer=${creditTo} (+${credits} BC)`);
    return {refunded: true, credits};
  }

  /**
   * Auto-dispatch escrow RELEASE (Step 11 §42) — on verified completion after the
   * dispute window, pay the agency provider out of escrow and take the platform fee.
   * Tx-aware (atomic with the escrow_holds RELEASED flip). Idempotent: only a
   * PENDING_RELEASE hold releases; a second call sees a non-PENDING_RELEASE status
   * and no-ops. Conserved: to_provider + platform_fee == gross (to_client 0). The
   * provider/fee credits are idempotent on ux_wallet_tx_payout (user, booking), so a
   * stray double-run can't double-pay. The provider is the AGENCY
   * (escrow_holds.provider_user_id) — it settles its own CPOs internally.
   */
  async releaseEscrowHold(
    tx: Tx,
    bookingId: string,
    feePct: number,
  ): Promise<{released: boolean; toProvider: number; platformFee: number}> {
    const escrowId = this.cfg.get<string>('platformAccounts.escrowId');
    const feeId = this.cfg.get<string>('platformAccounts.platformFeeId');
    if (!escrowId || !feeId) throw new Error('platform_accounts_unconfigured');
    const hold = await tx.qOne<{provider_user_id: string | null; gross_credits: number; currency: string; status: string}>(
      `SELECT provider_user_id, gross_credits, currency, status FROM escrow_holds
        WHERE booking_id = $1 FOR UPDATE`,
      [bookingId],
    );
    if (!hold || hold.status !== 'PENDING_RELEASE' || !hold.provider_user_id) {
      return {released: false, toProvider: 0, platformFee: 0};
    }
    const gross = hold.gross_credits;
    const platformFee = Math.min(gross, Math.max(0, Math.round((gross * feePct) / 100)));
    const toProvider = gross - platformFee;
    const meta = JSON.stringify({kind: 'escrow_release', booking_id: bookingId, ...this.fxStamp(hold.currency)});

    // 1) Debit the escrow account by the full gross.
    await tx.q(
      `INSERT INTO wallet_transactions (
         user_id, type, status, amount_credits, amount_fiat_cents, fiat_currency,
         description, booking_id, metadata, settled_at
       ) VALUES ($1, 'escrow_release', 'succeeded', $2, 0, $3, $4, $5, $6::jsonb, NOW())`,
      [escrowId, -gross, hold.currency, `Escrow release ${bookingId}`, bookingId, meta],
    );
    await tx.q(`UPDATE wallet_balances SET bravo_credits = bravo_credits - $1 WHERE user_id = $2`, [gross, escrowId]);

    // 2) Credit the agency provider (idempotent payout) + mint an expiry batch.
    if (toProvider > 0) {
      const payRow = await tx.qOne<{id: string}>(
        `INSERT INTO wallet_transactions (
           user_id, type, status, amount_credits, amount_fiat_cents, fiat_currency,
           description, booking_id, metadata, settled_at
         ) VALUES ($1, 'payout', 'succeeded', $2, 0, $3, $4, $5, $6::jsonb, NOW())
         ON CONFLICT (user_id, booking_id) WHERE type = 'payout' AND booking_id IS NOT NULL DO NOTHING RETURNING id`,
        [hold.provider_user_id, toProvider, hold.currency, `Mission payout ${bookingId}`, bookingId, meta],
      );
      if (payRow) {
        await tx.q(`UPDATE wallet_balances SET bravo_credits = bravo_credits + $1 WHERE user_id = $2`, [toProvider, hold.provider_user_id]);
        await tx.q(
          `INSERT INTO wallet_credit_batches (user_id, source_tx_id, amount_credits, expires_at)
           VALUES ($1, $2, $3, NOW() + INTERVAL '${CREDIT_TTL_MONTHS} months')`,
          [hold.provider_user_id, payRow.id, toProvider],
        );
      }
    }

    // 3) Credit the platform fee account (idempotent).
    if (platformFee > 0) {
      const feeRow = await tx.qOne<{id: string}>(
        `INSERT INTO wallet_transactions (
           user_id, type, status, amount_credits, amount_fiat_cents, fiat_currency,
           description, booking_id, metadata, settled_at
         ) VALUES ($1, 'payout', 'succeeded', $2, 0, $3, $4, $5, $6::jsonb, NOW())
         ON CONFLICT (user_id, booking_id) WHERE type = 'payout' AND booking_id IS NOT NULL DO NOTHING RETURNING id`,
        [feeId, platformFee, hold.currency, `Platform fee ${bookingId}`, bookingId, meta],
      );
      if (feeRow) {
        await tx.q(`UPDATE wallet_balances SET bravo_credits = bravo_credits + $1 WHERE user_id = $2`, [platformFee, feeId]);
      }
    }

    // 4) Flip the hold terminal — conservation: gross == to_provider + platform_fee + to_client(0).
    await tx.q(
      `UPDATE escrow_holds
          SET status = 'RELEASED', basis = 'full_release', settled_at = NOW(),
              to_provider_credits = $2, platform_fee_credits = $3, to_client_credits = 0
        WHERE booking_id = $1 AND status = 'PENDING_RELEASE'`,
      [bookingId, toProvider, platformFee],
    );
    this.log.log(`escrow release booking=${bookingId} provider=${hold.provider_user_id} (+${toProvider} BC, fee ${platformFee})`);
    return {released: true, toProvider, platformFee};
  }

  /**
   * Auto-dispatch escrow SPLIT settle (Step 11 §39.3-4 / §41) — the general paired-
   * ledger primitive for a partial outcome: pay the provider `toProvider`, refund the
   * client `toClient`, and the remainder is the platform fee. Tx-aware. Conserved:
   * gross == toProvider + toClient + platformFee (platformFee derived, never negative).
   *
   * Powers the mid-LIVE abort pro-rata (HELD -> PARTIAL, basis='pro_rata'), the post-
   * grace cancel fee (HELD -> PARTIAL, basis='partial'), and the admin dispute resolve
   * (DISPUTED -> REFUNDED|PARTIAL|RELEASED). Gated on `fromStatuses` under FOR UPDATE so
   * a second call no-ops (idempotent); the provider payout is also idempotent on
   * ux_wallet_tx_payout. The provider is the AGENCY (escrow_holds.provider_user_id).
   */
  async settleEscrowSplit(
    tx: Tx,
    bookingId: string,
    opts: {
      toProvider: number;
      toClient: number;
      basis: string;
      fromStatuses: string[];
      finalStatus: string;
      reason?: string;
    },
  ): Promise<{settled: boolean; toProvider: number; toClient: number; platformFee: number}> {
    const escrowId = this.cfg.get<string>('platformAccounts.escrowId');
    const feeId = this.cfg.get<string>('platformAccounts.platformFeeId');
    if (!escrowId || !feeId) throw new Error('platform_accounts_unconfigured');
    const hold = await tx.qOne<{
      provider_user_id: string | null; client_id: string; gross_credits: number; currency: string; status: string;
    }>(
      `SELECT provider_user_id, client_id, gross_credits, currency, status FROM escrow_holds
        WHERE booking_id = $1 FOR UPDATE`,
      [bookingId],
    );
    if (!hold || !opts.fromStatuses.includes(hold.status)) {
      return {settled: false, toProvider: 0, toClient: 0, platformFee: 0}; // wrong state — idempotent no-op
    }
    const gross = hold.gross_credits;
    const toProvider = Math.min(gross, Math.max(0, Math.round(opts.toProvider)));
    const toClient = Math.min(gross - toProvider, Math.max(0, Math.round(opts.toClient)));
    const platformFee = gross - toProvider - toClient; // >= 0 by construction
    if (toProvider > 0 && !hold.provider_user_id) {
      throw new BadRequestException('escrow_split_no_provider');
    }
    const reason = opts.reason ?? `Escrow ${opts.basis} ${bookingId}`;
    const meta = JSON.stringify({kind: 'escrow_split', basis: opts.basis, booking_id: bookingId, ...this.fxStamp(hold.currency)});

    // 1) Debit the escrow account by the full gross (funds leaving escrow).
    await tx.q(
      `INSERT INTO wallet_transactions (
         user_id, type, status, amount_credits, amount_fiat_cents, fiat_currency,
         description, booking_id, metadata, settled_at
       ) VALUES ($1, 'escrow_release', 'succeeded', $2, 0, $3, $4, $5, $6::jsonb, NOW())`,
      [escrowId, -gross, hold.currency, reason, bookingId, meta],
    );
    await tx.q(`UPDATE wallet_balances SET bravo_credits = bravo_credits - $1 WHERE user_id = $2`, [gross, escrowId]);

    // 2) Pay the agency provider its worked/awarded share (idempotent) + expiry batch.
    if (toProvider > 0 && hold.provider_user_id) {
      const payRow = await tx.qOne<{id: string}>(
        `INSERT INTO wallet_transactions (
           user_id, type, status, amount_credits, amount_fiat_cents, fiat_currency,
           description, booking_id, metadata, settled_at
         ) VALUES ($1, 'payout', 'succeeded', $2, 0, $3, $4, $5, $6::jsonb, NOW())
         ON CONFLICT (user_id, booking_id) WHERE type = 'payout' AND booking_id IS NOT NULL DO NOTHING RETURNING id`,
        [hold.provider_user_id, toProvider, hold.currency, reason, bookingId, meta],
      );
      if (payRow) {
        await tx.q(`UPDATE wallet_balances SET bravo_credits = bravo_credits + $1 WHERE user_id = $2`, [toProvider, hold.provider_user_id]);
        await tx.q(
          `INSERT INTO wallet_credit_batches (user_id, source_tx_id, amount_credits, expires_at)
           VALUES ($1, $2, $3, NOW() + INTERVAL '${CREDIT_TTL_MONTHS} months')`,
          [hold.provider_user_id, payRow.id, toProvider],
        );
      }
    }

    // 3) Refund the payer its unworked/awarded share + expiry batch — the wallet that
    // funded the hold (family holder on a member booking), never escrow_holds.client_id
    // blindly. (Idempotency comes from the fromStatuses guard under FOR UPDATE — a
    // second call sees finalStatus.)
    if (toClient > 0) {
      const {creditTo, actorId} = await this.bookingSettleTarget(tx, bookingId, hold.client_id);
      // B-854 (A7) — the CLIENT-side leg names the allowance(s) it restores; the
      // escrow/provider/fee legs above deliberately keep the plain `meta` (they
      // never touch a family allowance).
      const clientMeta = JSON.stringify({
        kind: 'escrow_split', basis: opts.basis, booking_id: bookingId,
        ...(await this.familyMetaForBooking(tx, bookingId, creditTo, actorId)),
        ...this.fxStamp(hold.currency),
      });
      const refundRow = await tx.qOne<{id: string}>(
        `INSERT INTO wallet_transactions (
           user_id, type, status, amount_credits, amount_fiat_cents, fiat_currency,
           description, booking_id, metadata, settled_at, actor_user_id, feature
         ) VALUES ($1, 'refund', 'succeeded', $2, 0, $3, $4, $5, $6::jsonb, NOW(), $7, 'booking') RETURNING id`,
        [creditTo, toClient, hold.currency, reason, bookingId, clientMeta, actorId],
      );
      await tx.q(`UPDATE wallet_balances SET bravo_credits = bravo_credits + $1 WHERE user_id = $2`, [toClient, creditTo]);
      await tx.q(
        `INSERT INTO wallet_credit_batches (user_id, source_tx_id, amount_credits, expires_at)
         VALUES ($1, $2, $3, NOW() + INTERVAL '${CREDIT_TTL_MONTHS} months')`,
        [creditTo, refundRow?.id ?? null, toClient],
      );
      await this.reverseFamilySpend(tx, actorId, creditTo, toClient, bookingId);
    }

    // 4) Platform fee remainder (idempotent).
    if (platformFee > 0) {
      const feeRow = await tx.qOne<{id: string}>(
        `INSERT INTO wallet_transactions (
           user_id, type, status, amount_credits, amount_fiat_cents, fiat_currency,
           description, booking_id, metadata, settled_at
         ) VALUES ($1, 'payout', 'succeeded', $2, 0, $3, $4, $5, $6::jsonb, NOW())
         ON CONFLICT (user_id, booking_id) WHERE type = 'payout' AND booking_id IS NOT NULL DO NOTHING RETURNING id`,
        [feeId, platformFee, hold.currency, `Platform fee ${bookingId}`, bookingId, meta],
      );
      if (feeRow) {
        await tx.q(`UPDATE wallet_balances SET bravo_credits = bravo_credits + $1 WHERE user_id = $2`, [platformFee, feeId]);
      }
    }

    // 5) Flip the hold terminal — conservation: gross == to_provider + to_client + fee.
    // The status='ANY(fromStatuses)' guard mirrors releaseEscrowHold (redundant under the
    // FOR UPDATE lock taken above, but keeps the flip self-guarding).
    await tx.q(
      `UPDATE escrow_holds
          SET status = $2, basis = $3, settled_at = NOW(),
              to_provider_credits = $4, to_client_credits = $5, platform_fee_credits = $6
        WHERE booking_id = $1 AND status = ANY($7)`,
      [bookingId, opts.finalStatus, opts.basis, toProvider, toClient, platformFee, opts.fromStatuses],
    );
    this.log.log(`escrow split booking=${bookingId} basis=${opts.basis} (provider ${toProvider}, client ${toClient}, fee ${platformFee})`);
    return {settled: true, toProvider, toClient, platformFee};
  }

  /**
   * Auto-dispatch escrow CLAWBACK (Step 11 §41) — a dispute upheld AFTER the hold
   * already RELEASED to the agency. Reclaim `toClient + toPlatform` from the agency (=
   * everything it should not keep, i.e. gross − final to_provider) and route it: refund
   * the client `toClient`, credit the platform fee account `toPlatform`. If the agency is
   * short, the platform fee account fronts the shortfall (a negative-balance recovery to
   * withhold from future payouts). Conserved: agency(−pulled) == client(+toClient) +
   * platform(+toPlatform − shortfall). The escrow_holds split columns are re-stated to
   * the FINAL partition so they still sum to gross (reconciliation-clean). Tx-aware,
   * gated on status IN ('RELEASED','PARTIAL') AND basis<>'clawback' under FOR UPDATE →
   * idempotent: a second call sees basis='clawback' and no-ops.
   *
   * E2E-06 follow-up — PARTIAL is admitted because a lead-declared CLIENT NO-SHOW
   * settles the hold TERMINALLY to PARTIAL (agency keeps cancel_fee_pct, client refunded
   * the rest) and the client can dispute that fee. Every movement below is stated
   * RELATIVE to the hold's own recorded split (`to_client_credits` is added to,
   * `to_provider_credits` is subtracted from) rather than to gross, so a half-settled
   * hold re-states correctly. This is also why the dispute exit MUST come through here
   * and not `settleEscrowSplit`: that one debits the escrow account by the full gross,
   * which on an already-terminal hold double-spends escrow. The status is deliberately
   * NOT re-flipped — a PARTIAL hold stays PARTIAL, only `basis` becomes 'clawback'.
   */
  async clawbackReleasedHold(
    tx: Tx,
    bookingId: string,
    toClient: number,
    toPlatform: number,
    reason: string,
  ): Promise<{clawed: boolean; toClient: number; toPlatform: number; toProvider: number; shortfall: number}> {
    const feeId = this.cfg.get<string>('platformAccounts.platformFeeId');
    if (!feeId) throw new Error('platform_accounts_unconfigured');
    const hold = await tx.qOne<{
      provider_user_id: string | null; client_id: string; gross_credits: number; currency: string;
      status: string; basis: string | null;
      to_provider_credits: number | null; to_client_credits: number | null; platform_fee_credits: number | null;
    }>(
      `SELECT provider_user_id, client_id, gross_credits, currency, status, basis,
              to_provider_credits, to_client_credits, platform_fee_credits
         FROM escrow_holds WHERE booking_id = $1 FOR UPDATE`,
      [bookingId],
    );
    // Idempotent: only a paid-out, not-yet-clawed-back hold reclaims (basis flips to
    // 'clawback', so a second call short-circuits here). Statuses are ENUMERATED — a
    // HELD/PENDING_RELEASE/DISPUTED hold still owns its escrow and is settled through
    // settleEscrowSplit, never clawed. `!provider_user_id` keeps a hold that never paid
    // a provider out of this path entirely.
    if (
      !hold ||
      (hold.status !== 'RELEASED' && hold.status !== 'PARTIAL') ||
      hold.basis === 'clawback' ||
      !hold.provider_user_id
    ) {
      return {clawed: false, toClient: 0, toPlatform: 0, toProvider: 0, shortfall: 0};
    }
    const gross = hold.gross_credits;
    const wantClient = Math.min(gross, Math.max(0, Math.round(toClient)));
    const wantPlatform = Math.min(gross - wantClient, Math.max(0, Math.round(toPlatform)));
    const pull = wantClient + wantPlatform; // total reclaimed from the agency
    if (pull <= 0) return {clawed: false, toClient: 0, toPlatform: 0, toProvider: 0, shortfall: 0};
    const meta = JSON.stringify({kind: 'escrow_clawback', booking_id: bookingId, ...this.fxStamp(hold.currency)});

    // 1) Debit the agency for what it can cover; the platform fee account fronts the rest.
    const agency = await tx.qOne<WalletBalanceRow>(
      `SELECT * FROM wallet_balances WHERE user_id = $1 FOR UPDATE`,
      [hold.provider_user_id],
    );
    const fromAgency = Math.max(0, Math.min(pull, agency?.bravo_credits ?? 0));
    const shortfall = pull - fromAgency;
    if (fromAgency > 0) {
      await tx.q(
        `INSERT INTO wallet_transactions (
           user_id, type, status, amount_credits, amount_fiat_cents, fiat_currency,
           description, booking_id, metadata, settled_at
         ) VALUES ($1, 'payment', 'succeeded', $2, 0, $3, $4, $5, $6::jsonb, NOW())`,
        [hold.provider_user_id, -fromAgency, hold.currency, reason, bookingId, meta],
      );
      await tx.q(`UPDATE wallet_balances SET bravo_credits = bravo_credits - $1 WHERE user_id = $2`, [fromAgency, hold.provider_user_id]);
      await this.debitBatchesFifoTx(tx, hold.provider_user_id, fromAgency);
    }
    // 2) Refund the payer (+ expiry batch) — same family-correct targeting as
    // refundEscrowHold/settleEscrowSplit.
    if (wantClient > 0) {
      const {creditTo, actorId} = await this.bookingSettleTarget(tx, bookingId, hold.client_id);
      // B-854 (A7) — same as the split: only the CLIENT-side leg carries the
      // family keys, and the cap in `reverseFamilySpend` is what stops a
      // clawback on top of a partial cancel from over-restoring the allowance.
      const clientMeta = JSON.stringify({
        kind: 'escrow_clawback', booking_id: bookingId,
        ...(await this.familyMetaForBooking(tx, bookingId, creditTo, actorId)),
        ...this.fxStamp(hold.currency),
      });
      const refundRow = await tx.qOne<{id: string}>(
        `INSERT INTO wallet_transactions (
           user_id, type, status, amount_credits, amount_fiat_cents, fiat_currency,
           description, booking_id, metadata, settled_at, actor_user_id, feature
         ) VALUES ($1, 'refund', 'succeeded', $2, 0, $3, $4, $5, $6::jsonb, NOW(), $7, 'booking') RETURNING id`,
        [creditTo, wantClient, hold.currency, reason, bookingId, clientMeta, actorId],
      );
      await tx.q(`UPDATE wallet_balances SET bravo_credits = bravo_credits + $1 WHERE user_id = $2`, [wantClient, creditTo]);
      await tx.q(
        `INSERT INTO wallet_credit_batches (user_id, source_tx_id, amount_credits, expires_at)
         VALUES ($1, $2, $3, NOW() + INTERVAL '${CREDIT_TTL_MONTHS} months')`,
        [creditTo, refundRow?.id ?? null, wantClient],
      );
      await this.reverseFamilySpend(tx, actorId, creditTo, wantClient, bookingId);
    }
    // 3) Net the platform fee account: + the awarded platform share, − any shortfall it fronted.
    const platformDelta = wantPlatform - shortfall;
    if (platformDelta !== 0) {
      // MON-5 — when platformFeePct>0 the RELEASE already wrote a (feeId, booking)
      // 'payout' row, so a fresh insert here collides with ux_wallet_tx_payout and
      // rolls back the ENTIRE dispute-resolve (a liveness DoS on the recovery path).
      // Merge the clawback fee movement onto that row instead of inserting a second.
      await tx.q(
        `INSERT INTO wallet_transactions (
           user_id, type, status, amount_credits, amount_fiat_cents, fiat_currency,
           description, booking_id, metadata, settled_at
         ) VALUES ($1, 'payout', 'succeeded', $2, 0, $3, $4, $5, $6::jsonb, NOW())
         ON CONFLICT (user_id, booking_id) WHERE type = 'payout' AND booking_id IS NOT NULL
         DO UPDATE SET amount_credits = wallet_transactions.amount_credits + EXCLUDED.amount_credits,
                       settled_at = NOW()`,
        [feeId, platformDelta, hold.currency, `Clawback platform ${bookingId}`, bookingId, meta],
      );
      await tx.q(`UPDATE wallet_balances SET bravo_credits = bravo_credits + $1 WHERE user_id = $2`, [platformDelta, feeId]);
    }
    if (shortfall > 0) {
      this.log.warn(`clawback shortfall booking=${bookingId} agency=${hold.provider_user_id} short=${shortfall} BC — recover from future payouts`);
    }
    // 4) Re-state the FINAL split so the three columns still sum to gross (reconciliation-clean).
    const finalToClient = Math.min(gross, (hold.to_client_credits ?? 0) + wantClient);
    const finalToProvider = Math.max(0, (hold.to_provider_credits ?? gross) - pull);
    const finalPlatform = gross - finalToClient - finalToProvider;
    await tx.q(
      `UPDATE escrow_holds
          SET basis = 'clawback', settled_at = NOW(),
              to_client_credits = $2, to_provider_credits = $3, platform_fee_credits = $4
        WHERE booking_id = $1`,
      [bookingId, finalToClient, finalToProvider, finalPlatform],
    );
    this.log.log(`escrow clawback booking=${bookingId} client +${wantClient} platform +${wantPlatform} (agency -${fromAgency}, short ${shortfall})`);
    return {clawed: true, toClient: wantClient, toPlatform: wantPlatform, toProvider: finalToProvider, shortfall};
  }

  /**
   * Debit BC for a non-booking feature purchase (e.g. a Pro subscription
   * period). Mirrors `debitForBooking` but is not booking-bound — the
   * `description` + optional `metadata` carry the context. Runs inside the
   * caller's transaction when one is supplied so a downstream side-effect
   * (e.g. flipping `subscription_tier`) can roll back the debit on failure.
   *
   * Throws `insufficient_credits` (400) when the caller is short, which the
   * mobile paywall maps onto its card top-up fallback — same contract the
   * booking flow relies on.
   */
  async debitForFeature(
    userId: string,
    credits: number,
    description: string,
    metadata: Record<string, unknown> = {},
    tx?: Tx,
    stamp?: {actorUserId?: string; feature?: string},
  ): Promise<WalletBalance> {
    if (credits <= 0) throw new BadRequestException('credits must be > 0');
    const run = async (t: Tx): Promise<WalletBalance> => {
      const row = await t.qOne<WalletBalanceRow>(
        // Lock the balance row so a concurrent debit can't race the check.
        `SELECT * FROM wallet_balances WHERE user_id = $1 FOR UPDATE`,
        [userId],
      ) ?? await this.ensureBalanceRow(userId);
      if (row.bravo_credits < credits) {
        throw new BadRequestException('insufficient_credits');
      }
      const inserted = await t.qOne<{id: string}>(
        `INSERT INTO wallet_transactions (
           user_id, type, status, amount_credits, amount_fiat_cents, fiat_currency,
           description, metadata, settled_at, actor_user_id, feature
         ) VALUES ($1, 'payment', 'succeeded', $2, 0, $3, $4, $5::jsonb, NOW(), $6, $7)
         RETURNING id`,
        [userId, -credits, row.currency, description, JSON.stringify(metadata),
         stamp?.actorUserId ?? userId, stamp?.feature ?? null],
      );
      await t.q(
        `UPDATE wallet_balances SET bravo_credits = bravo_credits - $1 WHERE user_id = $2`,
        [credits, userId],
      );
      // Consume FIFO-by-expiry, same policy as every other debit path.
      await this.debitBatchesFifoTx(t, userId, credits);
      this.log.log(`wallet feature debit user=${userId} (-${credits} BC) tx=${inserted?.id ?? '?'}`);
      return {
        bravo_credits: row.bravo_credits - credits,
        currency: row.currency,
        stripe_customer_id: row.stripe_customer_id,
      };
    };
    // Ensure a balance row exists before opening the locking transaction.
    await this.ensureBalanceRow(userId);
    return tx ? run(tx) : this.db.withTransaction(run);
  }

  /**
   * Client-driven settlement: after PaymentSheet succeeds on the device, the
   * mobile app calls us with the intent id. We verify the intent is actually
   * `succeeded` against Stripe directly, then settle the pending ledger row
   * and credit BC. Idempotent — safe to call twice (returns the settled row
   * on the second call). This is a belt-and-braces path alongside the webhook.
   *
   * Ownership-checked: only the user who owns the pending tx can confirm it.
   */
  async confirmIntent(userId: string, intentId: string): Promise<{
    transaction_id: string;
    status: TxStatus;
    credits_awarded: number;
    balance: WalletBalance;
  }> {
    const tx = await this.db.qOne<WalletTxRow>(
      `SELECT * FROM wallet_transactions
        WHERE stripe_intent_id = $1 AND user_id = $2
        LIMIT 1`,
      [intentId, userId],
    );
    if (!tx) throw new BadRequestException('intent_not_found');
    // Audit Rev2 (live money bug) — only a genuinely-succeeded top-up awarded
    // credits. Reporting `credits_awarded: tx.amount_credits` for a 'failed'
    // row was the bug: a declined-then-retried PaymentIntent left the row
    // 'failed', and this early return then told the UI "N BC added" while
    // nothing was credited. A 'refunded' row was credited then clawed back, so
    // it awarded nothing from the caller's perspective either.
    if (tx.status === 'succeeded' || tx.status === 'refunded') {
      const balance = await this.getBalance(userId);
      return {
        transaction_id: tx.id,
        status: tx.status,
        credits_awarded: tx.status === 'succeeded' ? tx.amount_credits : 0,
        balance,
      };
    }
    // 'pending' OR 'failed' fall through — Stripe permits re-confirming a
    // failed PaymentIntent under the SAME intent id, so a prior decline is
    // recoverable: re-verify with Stripe below and settle if it now succeeded.

    // Independently ask Stripe whether the intent actually landed — trust
    // but verify, never take the client's word for "yes I paid".
    const intent = await this.stripe.getPaymentIntent(intentId);
    if (intent.status === 'succeeded') {
      // Payment audit P2-12 — the intent we minted and the intent Stripe holds
      // must still agree on amount + currency (a partially-captured or
      // dashboard-edited intent must not settle at full ledger value).
      const amountMismatch = typeof intent.amount === 'number' && intent.amount !== tx.amount_fiat_cents;
      const currencyMismatch = typeof intent.currency === 'string' && !!tx.fiat_currency
        && intent.currency.toLowerCase() !== String(tx.fiat_currency).toLowerCase();
      if (amountMismatch || currencyMismatch) {
        this.log.error(`confirmIntent refused: intent ${intentId} amount/currency ${intent.amount} ${intent.currency} != ledger ${tx.amount_fiat_cents} ${tx.fiat_currency}`);
        throw new BadRequestException('intent_mismatch');
      }
      await this.settlePendingTopup(tx.id, tx.user_id, tx.amount_credits, 'client-confirm');
      const balance = await this.getBalance(userId);
      return {
        transaction_id: tx.id,
        status: 'succeeded',
        credits_awarded: tx.amount_credits,
        balance,
      };
    }

    if (intent.status === 'canceled' || intent.status === 'payment_failed') {
      await this.db.q(
        `UPDATE wallet_transactions
            SET status = 'failed', settled_at = NOW(), stripe_client_secret = NULL
          WHERE id = $1`,
        [tx.id],
      );
      throw new BadRequestException(`intent_${intent.status}`);
    }

    // Intent still requires action on the Stripe side (e.g.
    // requires_confirmation, requires_action). Leave the ledger pending.
    throw new BadRequestException(`intent_${intent.status}`);
  }

  /**
   * Race-proof settle of a PENDING top-up row (audit F-03). The webhook and
   * the client-confirm path can both observe the row as pending; only the
   * one whose status-guarded UPDATE actually flips it credits the wallet.
   * The flip + balance bump + batch mint share one transaction (F-10).
   */
  private async settlePendingTopup(txId: string, userId: string, credits: number, via: string, eventId?: string): Promise<void> {
    await this.db.withTransaction(async (t: Tx) => {
      // Payment audit P1-6 — event-id replay claim, same-transaction (see
      // reverseToppedUpCredits). Webhook-only; client-confirm passes no id.
      if (eventId && !(await this.claimStripeEventTx(t, eventId))) return;
      // DC-14 — the Stripe client secret is one-shot bootstrap material; it
      // must not outlive the pending state it authorizes.
      // Audit Rev2 (live money bug) — settle a 'pending' OR previously-'failed'
      // row. Stripe lets a declined PaymentIntent be re-confirmed under the same
      // id; the succeeded event/confirm for that retry must be able to credit a
      // row a prior decline marked 'failed'. 'succeeded'/'refunded' are excluded
      // so a redelivery can never double-credit.
      const flipped = await t.q<{id: string; stripe_intent_id: string | null; metadata: Record<string, unknown> | null}>(
        `UPDATE wallet_transactions
            SET status = 'succeeded', settled_at = NOW(), stripe_client_secret = NULL
          WHERE id = $1 AND status IN ('pending', 'failed')
          RETURNING id, stripe_intent_id, metadata`,
        [txId],
      );
      if (flipped.length === 0) {
        // Already succeeded/refunded — the other settle path won, or this is a
        // duplicate. Nothing left to do.
        this.log.log(`wallet tx ${txId} already settled (${via} lost the race)`);
        return;
      }
      await this.creditDeltaTx(t, userId, credits, txId);
      this.log.log(`wallet tx ${txId} settled via ${via} (+${credits} BC for ${userId})`);
      // Payment audit P0-1 — a refund/dispute that arrived BEFORE this settle
      // left a reversal_pending marker (Stripe won't re-send it). Apply it in
      // the SAME transaction as the mint so the credits are clawed back
      // atomically with their creation.
      const rp = (flipped[0].metadata as {reversal_pending?: {reason?: string; fraction?: number | string}} | null)?.reversal_pending;
      if (rp && flipped[0].stripe_intent_id) {
        await this.reverseToppedUpCreditsTx(
          t,
          flipped[0].stripe_intent_id,
          `${rp.reason ?? 'refund'} (pre-settle)`,
          Number(rp.fraction ?? 1),
        );
      }
    });
  }

  /** Claim a Stripe event id for the wallet handler inside the caller's
   *  transaction. Returns false when the event was already processed. */
  private async claimStripeEventTx(t: Tx, eventId: string): Promise<boolean> {
    const claimed = await t.q<{event_id: string}>(
      `INSERT INTO public.stripe_processed_events (event_id, handler)
         VALUES ($1, 'wallet')
       ON CONFLICT DO NOTHING
       RETURNING event_id`,
      [eventId],
    );
    if (claimed.length === 0) {
      this.log.log(`duplicate stripe event ${eventId} (wallet) — ignoring`);
    }
    return claimed.length > 0;
  }

  /**
   * MON-1 — reverse the credits a settled top-up minted, once, when its card charge
   * is reversed. Locks the original top-up row FOR UPDATE so concurrent event
   * redeliveries serialise; a reversal already recorded for the intent is a no-op.
   * The compensating row is a negative `payment` (a debit out of the wallet) marked
   * kind='topup_reversal'; the balance is allowed to go NEGATIVE (an uncollected
   * receivable) rather than leaving unfunded credits spendable.
   */
  /**
   * MON-1 — claw back the credits a card charge minted when the fiat is refunded or
   * a dispute pulls the funds. `refundFraction` is the fraction of the ORIGINAL charge
   * now refunded (1 = full / dispute; <1 = partial). Because Stripe's `amount_refunded`
   * is CUMULATIVE, we compute a TARGET total-reversed = round(minted × fraction) and
   * reverse only the DELTA versus what we've already reversed for this intent — so a
   * series of partials each claw back their increment, a redelivered event is a no-op,
   * and a final full refund after partials reverses only the remaining credits (never
   * double). Clamped to [0, minted] so we can't reverse more than we minted (promo
   * top-ups where credits ≠ cents are handled by scaling the CREDITS, not the fiat).
   */
  private async reverseToppedUpCredits(intentId: string, reason: string, refundFraction = 1, eventId?: string): Promise<void> {
    await this.db.withTransaction(async (t: Tx) => {
      // Payment audit P1-6 — structural replay guard: claim the Stripe event id
      // in the same transaction as the side effect (mirrors the subscription
      // handler). A rollback releases the claim, so a genuine retry re-runs.
      if (eventId && !(await this.claimStripeEventTx(t, eventId))) return;
      await this.reverseToppedUpCreditsTx(t, intentId, reason, refundFraction);
    });
  }

  /** Tx-bound body of {@link reverseToppedUpCredits} — also called from
   *  settlePendingTopup to apply a reversal that arrived BEFORE the settle. */
  private async reverseToppedUpCreditsTx(t: Tx, intentId: string, reason: string, refundFraction = 1): Promise<void> {
    {
      const topup = await t.qOne<{id: string; user_id: string; amount_credits: number; currency: string}>(
        `SELECT id, user_id, amount_credits, currency FROM wallet_transactions
          WHERE stripe_intent_id = $1 AND type = 'topup' AND status = 'succeeded'
          ORDER BY settled_at DESC NULLS LAST LIMIT 1
          FOR UPDATE`,
        [intentId],
      );
      if (!topup) {
        // Payment audit P0-1 — Stripe does NOT guarantee delivery order, and a
        // refund/dispute can land while our topup row is still pending (e.g.
        // the succeeded event 500'd and is being retried). Dropping the
        // reversal here was permanent free money: the retried succeeded event
        // would mint credits the card already took back. Stamp a durable
        // marker on the un-settled row; settlePendingTopup applies it in the
        // same transaction as the mint. GREATEST keeps the largest cumulative
        // fraction across a series of partials.
        const stamped = await t.q<{id: string}>(
          `UPDATE wallet_transactions
              SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
                    'reversal_pending', jsonb_build_object(
                      'reason', $2::text,
                      'fraction', GREATEST(
                        COALESCE((metadata#>>'{reversal_pending,fraction}')::numeric, 0),
                        $3::numeric)))
            WHERE stripe_intent_id = $1 AND type = 'topup' AND status IN ('pending', 'failed')
            RETURNING id`,
          [intentId, reason, Math.min(1, Math.max(0, refundFraction))],
        );
        if (stamped.length > 0) {
          this.log.warn(`stripe reversal for un-settled intent ${intentId} (${reason}) — recorded reversal_pending, applied at settle`);
        } else {
          this.log.warn(`stripe reversal: no top-up row at all for intent ${intentId} (${reason})`);
        }
        return;
      }
      // Credits already clawed back for this intent (prior partials sum up).
      const prior = await t.qOne<{reversed: string | null}>(
        `SELECT COALESCE(SUM(-amount_credits), 0) AS reversed FROM wallet_transactions
          WHERE type = 'payment' AND stripe_intent_id = $1
            AND metadata->>'kind' = 'topup_reversal'`,
        [intentId],
      );
      const alreadyReversed = Math.round(Number(prior?.reversed ?? 0));
      const fraction = Math.min(1, Math.max(0, refundFraction));
      const target = Math.min(topup.amount_credits, Math.round(topup.amount_credits * fraction));
      const delta = target - alreadyReversed;
      if (delta <= 0) {
        this.log.log(`stripe reversal for intent ${intentId} already at/above target (${alreadyReversed}/${target}) — no-op`);
        return;
      }
      const meta = JSON.stringify({kind: 'topup_reversal', stripe_intent_id: intentId, reason, target, delta});
      await t.q(
        `INSERT INTO wallet_transactions (
           user_id, type, status, amount_credits, amount_fiat_cents, fiat_currency,
           description, stripe_intent_id, metadata, settled_at, feature
         ) VALUES ($1, 'payment', 'succeeded', $2, 0, $3, $4, $5, $6::jsonb, NOW(), 'topup')`,
        [topup.user_id, -delta, topup.currency, `Card charge reversed (${reason})`, intentId, meta],
      );
      await t.q(
        `UPDATE wallet_balances SET bravo_credits = bravo_credits - $1 WHERE user_id = $2`,
        [delta, topup.user_id],
      );
      // Payment audit P1-3 — a reversal must consume credit batches like every
      // other debit path, or the clawed-back credits stay "active" in the batch
      // table and the 12-month expiry sweep debits the SAME money a second time
      // (and reconcileBalances can't see it — the phantom expire row balances
      // the ledger). Target this top-up's own batch first, spill any remainder
      // to the normal FIFO walk.
      const absorbedRow = await t.qOne<{absorbed: number}>(
        `WITH b AS (
           SELECT id, amount_credits - consumed_credits AS free
             FROM wallet_credit_batches
            WHERE source_tx_id = $2 AND expired_at IS NULL
            FOR UPDATE
         )
         UPDATE wallet_credit_batches w
            SET consumed_credits = LEAST(w.amount_credits, w.consumed_credits + $1)
           FROM b
          WHERE w.id = b.id
          RETURNING GREATEST(0, LEAST($1::int, b.free))::int AS absorbed`,
        [delta, topup.id],
      );
      const spill = delta - Number(absorbedRow?.absorbed ?? 0);
      if (spill > 0) await this.debitBatchesFifoTx(t, topup.user_id, spill);
      this.log.warn(`stripe ${reason}: reversed ${delta} BC (target ${target}, was ${alreadyReversed}) for ${topup.user_id} (intent ${intentId}) — balance may be negative`);
    }
  }

  /** Webhook dispatcher — called with an already-verified Stripe event. */
  async handleStripeEvent(event: StripeEvent): Promise<void> {
    // MON-1 — a reversed card charge must claw back the credits it minted, or the
    // customer keeps the goods AND the money (top up → spend → chargeback). The
    // event object here is a charge/dispute carrying the original PaymentIntent id.
    // A dispute-funds-withdrawn pulls the whole charge (fraction 1). A charge.refunded
    // may be PARTIAL: amount_refunded is cumulative, so we pass the refunded FRACTION
    // and reverseToppedUpCredits claws back the proportional delta (idempotent across
    // a series of partials + the final full refund — see that method).
    if (event.type === 'charge.refunded' || event.type === 'charge.dispute.funds_withdrawn') {
      const obj = event.data.object as {
        payment_intent?: string | {id?: string};
        amount?: number; amount_refunded?: number;
      };
      const intentId = typeof obj.payment_intent === 'string' ? obj.payment_intent : obj.payment_intent?.id;
      if (!intentId) return;
      let fraction = 1;
      if (event.type === 'charge.refunded'
          && typeof obj.amount === 'number' && obj.amount > 0
          && typeof obj.amount_refunded === 'number') {
        fraction = obj.amount_refunded / obj.amount;
      }
      await this.reverseToppedUpCredits(intentId, event.type, fraction, event.id);
      return;
    }
    if (event.type !== 'payment_intent.succeeded' &&
        event.type !== 'payment_intent.payment_failed') {
      // Anything else (customer updates, other charge events…) is out of scope.
      return;
    }
    const intent = event.data.object as {
      id?: string;
      metadata?: Record<string, string>;
    };
    if (!intent.id) return;

    // Audit Rev2 (live money bug) — accept a 'failed' row too, not just
    // 'pending'. A retry of a declined PaymentIntent fires payment_intent
    // .succeeded for the SAME id; if we only matched 'pending' here the row a
    // prior decline marked 'failed' would never be found and the successful
    // retry would credit nothing while logging "unknown pending intent".
    const tx = await this.db.qOne<WalletTxRow>(
      `SELECT * FROM wallet_transactions
         WHERE stripe_intent_id = $1 AND status IN ('pending', 'failed')
         LIMIT 1`,
      [intent.id],
    );
    if (!tx) {
      this.log.warn(`Stripe event for unknown/settled intent ${intent.id}`);
      return;
    }

    if (event.type === 'payment_intent.succeeded') {
      await this.settlePendingTopup(tx.id, tx.user_id, tx.amount_credits, 'webhook', event.id);
    } else if (tx.status === 'pending') {
      // Mark failed (non-terminal — a later succeeded event/confirm can still
      // settle it). Don't re-stamp an already-'failed' row.
      await this.db.withTransaction(async (t: Tx) => {
        if (!(await this.claimStripeEventTx(t, event.id))) return;
        await t.q(
          `UPDATE wallet_transactions
              SET status = 'failed', settled_at = NOW(), stripe_client_secret = NULL
            WHERE id = $1 AND status = 'pending'`,
          [tx.id],
        );
        this.log.warn(`wallet tx ${tx.id} failed for ${tx.user_id}`);
      });
    }
  }

  // ─── helpers ──────────────────────────────────────────────────────────

  private async ensureBalanceRow(userId: string): Promise<WalletBalanceRow> {
    const existing = await this.db.qOne<WalletBalanceRow>(
      `SELECT * FROM wallet_balances WHERE user_id = $1`,
      [userId],
    );
    if (existing) return existing;
    const inserted = await this.db.qOne<WalletBalanceRow>(
      `INSERT INTO wallet_balances (user_id) VALUES ($1)
        ON CONFLICT (user_id) DO UPDATE SET updated_at = NOW()
        RETURNING *`,
      [userId],
    );
    if (!inserted) throw new BadRequestException('wallet_init_failed');
    return inserted;
  }

  private async applyCreditDelta(userId: string, delta: number, sourceTxId?: string): Promise<void> {
    // Why: balance bump + batch motion must land atomically (audit F-10) —
    // a crash between them left a succeeded ledger row with no balance.
    await this.db.withTransaction(async (tx: Tx) => {
      await this.creditDeltaTx(tx, userId, delta, sourceTxId);
    });
  }

  /** Tx-bound core of {@link applyCreditDelta}: balance bump + batch mint/consume. */
  private async creditDeltaTx(tx: Tx, userId: string, delta: number, sourceTxId?: string): Promise<void> {
    await tx.q(
      `UPDATE wallet_balances
          SET bravo_credits = bravo_credits + $1
        WHERE user_id = $2`,
      [delta, userId],
    );
    if (delta > 0) {
      // Grant path — mint a new batch with a 12-month TTL.
      await tx.q(
        `INSERT INTO wallet_credit_batches
           (user_id, source_tx_id, amount_credits, expires_at)
         VALUES ($1, $2, $3, NOW() + INTERVAL '${CREDIT_TTL_MONTHS} months')`,
        [userId, sourceTxId ?? null, delta],
      );
    } else if (delta < 0) {
      // Debit path — consume against existing batches FIFO-by-expiry so
      // the closest-to-expiry credits are used first.
      await this.debitBatchesFifoTx(tx, userId, -delta);
    }
  }

  /**
   * Walk a user's active credit batches oldest-expiry-first and bump
   * `consumed_credits` until `need` is covered, inside the caller's
   * transaction so the batch motion shares the same atomic unit as the
   * balance update + ledger insert (FOR UPDATE prevents double-spend).
   *
   * Caller has already debited `wallet_balances.bravo_credits` and
   * already gated on the balance being sufficient — this method only
   * reconciles the batch table with the balance row. If batches don't
   * fully cover `need` (data drift), we log and return silently rather
   * than throwing, because the balance is the source of truth for the
   * user-facing number.
   */
  private async debitBatchesFifoTx(tx: Tx, userId: string, need: number): Promise<void> {
    if (need <= 0) return;
    {
      let remaining = need;
      const batches = await tx.q<{id: string; amount_credits: number; consumed_credits: number}>(
        `SELECT id, amount_credits, consumed_credits
           FROM wallet_credit_batches
          WHERE user_id = $1
            AND expired_at IS NULL
            AND consumed_credits < amount_credits
          ORDER BY expires_at ASC, issued_at ASC
          FOR UPDATE`,
        [userId],
      );
      for (const b of batches) {
        if (remaining <= 0) break;
        const free = b.amount_credits - b.consumed_credits;
        const take = Math.min(remaining, free);
        await tx.q(
          `UPDATE wallet_credit_batches
              SET consumed_credits = consumed_credits + $1
            WHERE id = $2`,
          [take, b.id],
        );
        remaining -= take;
      }
      if (remaining > 0) {
        this.log.warn(`wallet debit drift: user=${userId} needed=${need} unallocated=${remaining}`);
      }
    }
  }

  /**
   * Sweep job — invoked by `walletExpirySweep` (see wallet-expiry.cron.ts).
   * Finds every batch whose `expires_at` has passed and that hasn't been
   * swept yet, reverses the unconsumed remainder out of the user's
   * balance, marks the batch as swept, and writes an `expire` ledger row
   * for the audit trail. Returns the number of batches expired.
   */
  async sweepExpiredCredits(now: Date = new Date()): Promise<{batches: number; creditsExpired: number}> {
    // Scale audit P0-1 / payment audit P2-10 — the old shape selected EVERY due
    // batch FOR UPDATE in one transaction (unbounded: the whole 12-month cohort
    // matures at once), issued 3 queries per row, and took its locks in the
    // OPPOSITE order to the spend paths (batches → balance vs balance → batches),
    // which is a textbook deadlock. Now: bounded pages of users, one SMALL
    // transaction per user, balance row locked FIRST, and set-based writes.
    const PAGE = 200;
    const MAX_PAGES = 20; // hard ceiling per tick; the hourly cron drains the rest
    let batches = 0;
    let creditsExpired = 0;
    for (let page = 0; page < MAX_PAGES; page++) {
      const dueUsers = await this.db.q<{user_id: string}>(
        `SELECT DISTINCT user_id
           FROM wallet_credit_batches
          WHERE expired_at IS NULL AND expires_at <= $1
          LIMIT ${PAGE}`,
        [now],
      );
      if (dueUsers.length === 0) break;
      for (const {user_id} of dueUsers) {
        try {
          const r = await this.sweepExpiredCreditsForUser(user_id, now);
          batches += r.batches;
          creditsExpired += r.creditsExpired;
        } catch (e) {
          // One bad wallet must not abort the whole sweep.
          this.log.warn(`wallet expiry sweep failed for user=${user_id}: ${e instanceof Error ? e.message : e}`);
        }
      }
      if (dueUsers.length < PAGE) break;
    }
    if (batches > 0) {
      this.log.log(`wallet expiry sweep: ${batches} batch(es), ${creditsExpired} BC reclaimed`);
    }
    return {batches, creditsExpired};
  }

  private async sweepExpiredCreditsForUser(userId: string, now: Date): Promise<{batches: number; creditsExpired: number}> {
    return await this.db.withTransaction(async (tx: Tx) => {
      // Lock order matches every spend path: balance row FIRST, then batches.
      const bal = await tx.qOne<{currency: string | null}>(
        `SELECT currency FROM wallet_balances WHERE user_id = $1 FOR UPDATE`,
        [userId],
      );
      const due = await tx.q<{id: string; amount_credits: number; consumed_credits: number}>(
        `SELECT id, amount_credits, consumed_credits
           FROM wallet_credit_batches
          WHERE user_id = $1 AND expired_at IS NULL AND expires_at <= $2
          ORDER BY expires_at ASC
          FOR UPDATE`,
        [userId, now],
      );
      if (due.length === 0) return {batches: 0, creditsExpired: 0};
      const remainders = due
        .map(b => ({id: b.id, remainder: b.amount_credits - b.consumed_credits}))
        .filter(b => b.remainder > 0);
      const total = remainders.reduce((s, b) => s + b.remainder, 0);
      if (total > 0) {
        await tx.q(
          `UPDATE wallet_balances SET bravo_credits = bravo_credits - $1 WHERE user_id = $2`,
          [total, userId],
        );
        await tx.q(
          `INSERT INTO wallet_transactions (
             user_id, type, status, amount_credits, amount_fiat_cents, fiat_currency,
             description, metadata, settled_at
           )
           SELECT $1, 'expire', 'succeeded', -r.remainder, 0, $2,
                  'Credits expired (' || r.remainder || ' BC, batch issued > 12mo ago)',
                  jsonb_build_object('batch_id', r.id, 'kind', 'credit_expiry'),
                  $3
             FROM unnest($4::uuid[], $5::int[]) AS r(id, remainder)`,
          [userId, bal?.currency ?? 'AED', now, remainders.map(b => b.id), remainders.map(b => b.remainder)],
        );
      }
      await tx.q(
        `UPDATE wallet_credit_batches SET expired_at = $1 WHERE id = ANY($2::uuid[])`,
        [now, due.map(b => b.id)],
      );
      return {batches: due.length, creditsExpired: total};
    });
  }

  /**
   * Nightly reconciliation probe (audit F-12) — reports every wallet whose
   * denormalised balance disagrees with the sum of its succeeded ledger
   * rows. Detection only, never auto-fixes: drift means a code path or a
   * script bypassed the service layer and a human should look at it.
   */
  async reconcileBalances(shard?: {index: number; of: number}): Promise<{checked: number; drifted: number}> {
    // Scale audit P0-2 — the full ledger GROUP BY (50k wallets × their whole
    // history) is too heavy to run hourly. The cron passes an hour-derived
    // shard so each tick checks 1/24th and every wallet is still probed daily.
    const shardWhere = shard ? `WHERE (hashtext(wb.user_id::text) & 2147483647) % $1 = $2` : '';
    const params = shard ? [shard.of, shard.index] : [];
    const rows = await this.db.q<{user_id: string; balance: number; ledger_sum: string}>(
      `SELECT wb.user_id, wb.bravo_credits AS balance,
              COALESCE(SUM(wt.amount_credits) FILTER (WHERE wt.status = 'succeeded'), 0) AS ledger_sum
         FROM wallet_balances wb
         LEFT JOIN wallet_transactions wt ON wt.user_id = wb.user_id
        ${shardWhere}
        GROUP BY wb.user_id, wb.bravo_credits
       HAVING wb.bravo_credits <> COALESCE(SUM(wt.amount_credits) FILTER (WHERE wt.status = 'succeeded'), 0)`,
      params,
    );
    for (const r of rows) {
      this.log.warn(
        `wallet drift: user=${r.user_id} balance=${r.balance} ledger=${r.ledger_sum} (Δ ${r.balance - Number(r.ledger_sum)})`,
      );
    }
    const checked = await this.db.qOne<{n: string}>(
      `SELECT COUNT(*) AS n FROM wallet_balances wb ${shardWhere}`,
      params,
    );
    return {checked: Number(checked?.n ?? 0), drifted: rows.length};
  }

  private async insertTx(input: {
    userId: string;
    type: TxType;
    status: TxStatus;
    amountCredits: number;
    amountFiatCents: number;
    fiatCurrency: string;
    description: string;
    bookingId?: string;
    stripeIntentId?: string;
    stripeClientSecret?: string;
    metadata?: Record<string, unknown>;
    settledAt?: Date;
  }, tx?: Tx): Promise<WalletTxRow> {
    const q = tx ?? this.db;
    const row = await q.qOne<WalletTxRow>(
      `INSERT INTO wallet_transactions (
         user_id, type, status, amount_credits, amount_fiat_cents, fiat_currency,
         description, booking_id, stripe_intent_id, stripe_client_secret, metadata, settled_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12)
       RETURNING *`,
      [
        input.userId,
        input.type,
        input.status,
        input.amountCredits,
        input.amountFiatCents,
        input.fiatCurrency,
        input.description,
        input.bookingId ?? null,
        input.stripeIntentId ?? null,
        input.stripeClientSecret ?? null,
        JSON.stringify(input.metadata ?? {}),
        input.settledAt ?? null,
      ],
    );
    if (!row) throw new BadRequestException('tx_insert_failed');
    return row;
  }

  // Code-default FX table (units of fiat per 1 USD) — RECEIPT METADATA ONLY since the
  // 1-fiat-unit = 1-BC peg (computeCreditsForFiat no longer converts). The SOURCE of
  // truth is config.fx (env-overridable); these literals are the fallback when config
  // is absent (e.g. a unit test that stubs ConfigService without an fx block).
  private static readonly FX_DEFAULTS: Record<string, number> = {
    usd: 1, aed: 3.67, eur: 1 / 1.08, sar: 3.75, gbp: 1 / 1.27, bdt: 110,
  };

  /**
   * FX units per 1 USD for `currency` — reads config.fx (finance-set, env-overridable),
   * falling back to FX_DEFAULTS. The single source for both the credit conversion and the
   * metadata rate stamp (so a refund/reversal shows the same rate it was held at; money
   * moves in fixed CREDITS, so the reversal is already credit-exact — this is the proof).
   */
  private fxUnitsPerUsd(currency: string): number {
    const c = currency.toLowerCase();
    const cfg = this.cfg.get<number>(`fx.${c}`);
    if (typeof cfg === 'number' && cfg > 0) return cfg;
    return WalletService.FX_DEFAULTS[c] ?? 1;
  }

  /**
   * The ONE currency Bravo Secure settles wallet top-ups in.
   *
   * EUR because that is the currency every service price is quoted in and the
   * currency `eur_per_bc` converts from — see `topUp`. Config-overridable
   * (`wallet.settlementCurrency`) so finance can move the whole product to
   * another currency without a code change, but never client-supplied.
   *
   * Guarded against a malformed override: an unknown code would reach Stripe
   * and fail every top-up, so anything outside the supported 2-decimal set
   * falls back to EUR rather than taking the product down.
   */
  private static readonly SETTLEMENT_FALLBACK = 'eur';
  private settlementCurrency(): string {
    const cfg = (this.cfg.get<string>('wallet.settlementCurrency') ?? '').trim().toLowerCase();
    return cfg && cfg in WalletService.FX_DEFAULTS ? cfg : WalletService.SETTLEMENT_FALLBACK;
  }

  private computeCreditsForFiat(amount: number, _currency: string): number {
    // Why: product rule (2026-07-05, CREDITS_BC_AUDIT F-01/F-02) — 1 unit of
    // fiat = 1 BC, regardless of charge currency. Hard-coded (not config/FX)
    // so an env override can't silently break the peg the UI promises. The FX
    // table below survives only as the metadata rate stamp on receipts.
    // floor, not round: never award a credit the fiat doesn't fully cover
    // (payment audit P1-5 — .50 amounts rounded UP into free credits).
    return Math.floor(amount);
  }

  /** The fx stamp written into a money row's metadata for the receipt/reconciliation. */
  private fxStamp(currency: string): {fx_currency: string; fx_rate: number} {
    return {fx_currency: currency.toLowerCase(), fx_rate: this.fxUnitsPerUsd(currency)};
  }

  private toClientTx = (r: WalletTxRow): WalletTransaction => ({
    id: r.id,
    user_id: r.user_id,
    type: r.type,
    status: r.status,
    amount: r.amount_credits,
    currency: 'BC',
    description: r.description ?? '',
    booking_id: r.booking_id ?? undefined,
    created_at: new Date(r.created_at).toISOString(),
    // A14 — read off the row the ledger already stores; the chain key comes
    // from the SAME metadata blob the charge and its refunds carry.
    actor_user_id: r.actor_user_id ?? null,
    via_user_id: typeof r.metadata?.via_user_id === 'string' ? r.metadata.via_user_id : null,
  });
}
