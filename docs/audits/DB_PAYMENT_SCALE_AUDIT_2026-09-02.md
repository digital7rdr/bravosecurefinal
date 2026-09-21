# Database + Payment Gateway Scale Audit — 2026-09-02

Target: **50,000 users**. Four parallel audit lanes (auth-service N+1/batching,
messenger-service N+1/batching, index coverage, Stripe payment gateway edge
cases), then a same-session fix campaign. This doc is the findings register;
per-lane implementation state is in §5.

## 1. Payment gateway (Stripe) — findings & fixes

All fixed this session in `apps/auth-service/src/{wallet,subscription}` + pinned
by new tests in `wallet.service.spec.ts`, `stripe.client.spec.ts`,
`subscription.service.spec.ts` (112 tests green).

| #     | Severity     | Finding                                                                                                                                                                                                                                                       | Fix                                                                                                                                                                                                                                                                                                  |
| ----- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0-1  | P0 money     | A refund/dispute arriving BEFORE the top-up settles was dropped forever (`reverseToppedUpCredits` required `status='succeeded'`); Stripe's later retry of `payment_intent.succeeded` then minted credits for money already returned.                          | Reversal on an un-settled intent stamps a durable `metadata.reversal_pending` marker (GREATEST-merged fraction); `settlePendingTopup` applies it in the SAME transaction as the mint.                                                                                                                |
| P0-2  | P0 liveness  | `clawbackReleasedHold`'s `ON CONFLICT (user_id, booking_id) WHERE type='payout'` does not imply `ux_wallet_tx_payout`'s predicate → Postgres 42P10 → the entire dispute-resolve rolls back whenever the platform fee moves. Invisible to the mocked-tx tests. | Added `AND booking_id IS NOT NULL`; string-pinned in the clawback split test.                                                                                                                                                                                                                        |
| P1-3  | P1 money     | Chargeback reversal debited the balance but never consumed credit batches → the 12-month expiry sweep debited the same money AGAIN (and the phantom `expire` row blinded `reconcileBalances`).                                                                | Reversal consumes the top-up's own batch first (CTE update on `source_tx_id`), spills the remainder to the FIFO walk.                                                                                                                                                                                |
| P1-4  | P1 money     | All three Stripe-cancel sites swallowed a failed cancel then nulled `stripe_subscription_id` → a live sub billing the card forever with no row pointing at it. `reconcile_pending` was written but nothing consumed it.                                       | `cancelStripeSubSafe` classifies canceled/gone/failed; failed keeps the link + flags `reconcile_pending`; pre-replace failure now aborts the replace (no double-bill). New `reconcilePendingStripeSubs()` sweep (pro-lapse cron) retries cancels and cancels orphan subs found by customer+metadata. |
| P1-5  | P1 abuse     | `Math.round` on 2-decimal top-ups minted credits the card didn't pay for (1.50 → 150¢ charged, 2 BC credited — repeatable 33% discount).                                                                                                                      | `computeCreditsForFiat` floors; `cents = credits * 100` so charge and credit are the same money.                                                                                                                                                                                                     |
| P1-6  | P1 hardening | Wallet webhook had no event.id replay ledger (subscription endpoint has one); idempotency rested on two implicit, untested invariants.                                                                                                                        | Wallet handler claims `(event.id,'wallet')` in `stripe_processed_events` inside the side-effect transaction; plus `ux_wallet_tx_topup_intent` unique index (migration).                                                                                                                              |
| P2-7  | P2           | Webhook raw-body fallback silently HMAC'd a re-serialised body.                                                                                                                                                                                               | Both controllers now 500 loudly when `req.rawBody` is missing.                                                                                                                                                                                                                                       |
| P2-8  | P2           | `Object.fromEntries` kept only the LAST `v1` signature → every webhook 400s during an endpoint-secret roll; single secret only.                                                                                                                               | Multimap v1 parse; comma-separated `STRIPE_WEBHOOK_SECRET` list accepted.                                                                                                                                                                                                                            |
| P2-9  | P2           | `livemode` never checked; test-mode events (attacker-mintable) could hit prod wallets under a misconfigured key.                                                                                                                                              | `verifyWebhook` rejects a livemode/key-mode mismatch; boot warning in prod for non-live keys.                                                                                                                                                                                                        |
| P2-10 | P2           | Expiry sweep locked batches→balance while every spend path locks balance→batches (deadlock), unbounded single transaction over the whole due cohort.                                                                                                          | Rewritten: paged (200 users/page, 20 pages/tick), one small per-user tx, balance row locked FIRST, set-based writes (unnest).                                                                                                                                                                        |
| P2-11 | P2           | `creditForBooking`/`refundForBooking` returned a balance read on the POOL from inside an open transaction (pre-commit value, plus a second connection pinned).                                                                                                | All five sites read via the tx.                                                                                                                                                                                                                                                                      |
| P2-12 | P2           | Intent amount/currency never re-verified at settlement.                                                                                                                                                                                                       | `confirmIntent` refuses on amount/currency mismatch vs the ledger row.                                                                                                                                                                                                                               |
| P2-13 | P2 note      | Webhook endpoints are `@SkipThrottle` (correct — Stripe egress IPs) with the cheap pre-HMAC rejects already present. LB-level source-IP allowlist left as infra follow-up.                                                                                    | No code change.                                                                                                                                                                                                                                                                                      |

Also: `wallet-expiry.cron` and `pro-lapse.cron` now take a fenced Redis lock
(`common/redis-lock`), and `reconcileBalances` runs hour-sharded (1/24 of
wallets per tick — every wallet still probed daily) instead of a full
cross-product aggregate hourly.

Verified-OK list (evidence in the session audit): raw-body HMAC + timing-safe
compare, subscription event dedupe + retention, settle race guards, FOR UPDATE
debit paths, escrow conservation, payout/refund idempotency indexes, integer
money, server-side pricing everywhere, saved-card ownership, client-secret
lifetime, trust-proxy, DTO whitelisting.

## 2. Index coverage — migration `20260902090000_scale_indexes_50k.sql`

34 new indexes + pg_trgm for the ops user search; 4 safe drops (exact duplicate
`idx_vbg_monitoring_active_beat`, the documented-but-never-done
`missions_booking_id_bridge` drop, two strict-prefix redundancies). Highlights:

- `lite_bookings(assigned_provider_user_id, pickup_time DESC)` — the agency
  tenancy predicate had NO index at all.
- Bare-`created_at`/`ts_ms`/`received_at` indexes for the notifications,
  sealed_envelope_archive and protection_session_locations retention sweeps
  (all were full-table scans).
- Partial deadline indexes for the five 60-second dispatch sweeps (same shape
  as the existing `lite_bookings_arrival_due`).
- `users(stripe_subscription_id)` partial — webhook→user resolution was a
  50k-row seq scan per event.
- Expression index making the legacy-phone contact-sync fallback sargable.
- 7 unindexed FK cascades (user erasure seq-scanned them).
- Candidates needing `pg_stat_user_indexes` confirmation before dropping are
  listed commented-out at the bottom of the migration.

**Deploy step owed:** run `scripts/db-migrate.sh` against staging (large tables:
apply the CREATE INDEX statements by hand as CONCURRENTLY first — the header
explains).

## 3. auth-service N+1 / unbounded queries

Findings P0-1..P0-7, P1-1..P1-17, P2 table — see the session audit summary in
sqa.md B-716..B-721. Implementation state: §5.

## 4. messenger-service N+1 / unbounded work

Findings P0-1..P0-9, P1-1..P1-11, P2-1..P2-17 — the service is PostgREST +
Redis (no raw SQL); the heavy hitters were the per-envelope archive upsert on
the send path, the per-flush exact COUNT over up to 500k rows, cluster-wide
`fetchSockets()` and full-keyspace SCANs on 60s timers, the 400-query
`presence.subscribe` privacy N+1, and the unbounded 120s packet-replay buffer
holding full ciphertext frames. Implementation state: §5.

## 5. Implementation state

- **Payment lane (§1)**: DONE this session, tests green (see table).
- **Index migration (§2)**: WRITTEN this session; staging apply owed.
- **auth-service lane (§3)**: implemented this session by the auth fix lane —
  see the session report / git diff for the per-finding list.
- **messenger-service lane (§4)**: implemented this session by the messenger
  fix lane — see the session report / git diff for the per-finding list.
- Device/E2E verification of booking + messenger flows after these changes is
  owed before the next release build.
