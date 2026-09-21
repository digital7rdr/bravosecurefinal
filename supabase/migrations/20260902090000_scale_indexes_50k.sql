-- 2026-09-02 — index coverage for the 50k-user scale audit.
--
-- Source: full cross-reference of every db.q/qOne predicate in auth-service +
-- the PostgREST query shapes in messenger-service against the effective schema
-- (audit "DB index coverage", session 2026-09-02). Each index below names the
-- query it serves. All statements are IF NOT EXISTS so re-applying is a no-op.
--
-- NOTE: scripts/db-migrate.sh applies migrations with --single-transaction, so
-- these are plain CREATE INDEX (brief write locks). At today's staging data
-- sizes that is fine. If a table has grown large by the time this is applied,
-- run the statement by hand as CREATE INDEX CONCURRENTLY (outside a tx) and
-- then re-run the migration — IF NOT EXISTS makes it skip.

-- ─── P0: hot-path / sweep predicates with NO supporting index ───────────────

-- Agency tenancy predicate — every agency board/KPI/IDOR gate filters on it.
-- org-mission.service.ts:88,137,179,220,390,527 · org-cpo.service.ts:501,548,917-930
CREATE INDEX IF NOT EXISTS lite_bookings_provider_pickup_idx
  ON public.lite_bookings (assigned_provider_user_id, pickup_time DESC)
  WHERE assigned_provider_user_id IS NOT NULL;

-- Rating average recomputed on every client rating submit (booking.service.ts:1310).
CREATE INDEX IF NOT EXISTS lite_bookings_provider_rating_idx
  ON public.lite_bookings (assigned_provider_user_id, rating)
  WHERE assigned_provider_user_id IS NOT NULL AND rating IS NOT NULL;

-- Retention sweep fires ~1 insert in 200 (notifications.service.ts:155-159);
-- existing indexes all lead with user_id and cannot serve a bare created_at range.
CREATE INDEX IF NOT EXISTS notifications_created_at_idx
  ON public.notifications (created_at);

-- 90-day archive sweep (messenger backup.service.ts sweepSealedArchive) —
-- every ts_ms index is prefixed by recipient_user_id.
CREATE INDEX IF NOT EXISTS sealed_envelope_archive_ts_ms_idx
  ON public.sealed_envelope_archive (ts_ms);

-- Location retention sweep (protection.service.ts:883).
CREATE INDEX IF NOT EXISTS psl_received_at_idx
  ON public.protection_session_locations (received_at);

-- Ops-room teardown runs on every booking completion/abort/no-show
-- (booking.service.ts:1470, agent.service.ts:1859, arrival-noshow.service.ts:185).
CREATE INDEX IF NOT EXISTS missions_comms_channel_idx
  ON public.missions (comms_channel_id) WHERE comms_channel_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS dispatch_room_intents_conversation_idx
  ON public.dispatch_room_intents (conversation_id);

-- Contact-sync legacy-format fallback (users.service.ts:145) — makes the
-- double-regexp predicate sargable instead of a 50k-row seq scan per sync.
CREATE INDEX IF NOT EXISTS users_phone_digits_legacy_idx
  ON public.users (regexp_replace(regexp_replace(phone_e164, '[^0-9]', '', 'g'), '^0+', ''))
  WHERE phone_e164 !~ '^\+';

-- ─── P1: pagination / sweeps / webhook lookups ──────────────────────────────

-- Client booking list + active-booking gate on every create (booking.service.ts:303,1156).
CREATE INDEX IF NOT EXISTS lite_bookings_client_created_idx
  ON public.lite_bookings (client_id, created_at DESC);

-- 60s dispatch sweeps (crew-sla, dispatch-slo, relist-timeout, scheduled-dispatch,
-- payment-pending-expiry) — same partial-index shape as lite_bookings_arrival_due.
CREATE INDEX IF NOT EXISTS lite_bookings_crew_due_idx
  ON public.lite_bookings (crew_deadline_at)
  WHERE status = 'CONFIRMED' AND dispatch_mode = 'auto' AND crew_deadline_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS lite_bookings_dispatching_started_idx
  ON public.lite_bookings (dispatch_started_at)
  WHERE status = 'DISPATCHING';
CREATE INDEX IF NOT EXISTS lite_bookings_ops_approved_pending_idx
  ON public.lite_bookings (updated_at)
  WHERE dispatch_mode = 'auto' AND status = 'OPS_APPROVED' AND dispatch_started_at IS NULL;
CREATE INDEX IF NOT EXISTS lite_bookings_payment_pending_idx
  ON public.lite_bookings (updated_at)
  WHERE status = 'PAYMENT_PENDING';

-- mission-drift-janitor refund reconcile (10 min) — CANCELLED accumulates forever.
CREATE INDEX IF NOT EXISTS lite_bookings_cancelled_paid_idx
  ON public.lite_bookings (dispatch_settled_at NULLS LAST)
  WHERE status = 'CANCELLED' AND payment_captured = TRUE;

-- Stripe webhook → user resolution on every subscription event
-- (subscription.service.ts userIdForSubscription).
CREATE INDEX IF NOT EXISTS users_stripe_subscription_idx
  ON public.users (stripe_subscription_id)
  WHERE stripe_subscription_id IS NOT NULL;

-- Paid-tier renew/lapse sweeps (renewFromCredits, sweepLapsedPro).
CREATE INDEX IF NOT EXISTS users_paid_tier_expiry_idx
  ON public.users (pro_active_until)
  WHERE subscription_tier IN ('pro', 'enterprise') AND pro_active_until IS NOT NULL;

-- CPO mission history (agent.service.ts:1197, org-cpo.service.ts:548) — the
-- only agent_id-leading index is partial WHERE status <> 'off', which excludes
-- exactly the historical rows. Also an unindexed ON DELETE RESTRICT FK.
CREATE INDEX IF NOT EXISTS mission_crew_agent_idx
  ON public.mission_crew (agent_id);

-- CPO "my applications" + job-feed join (agent.service.ts:755,1095); unindexed FK.
CREATE INDEX IF NOT EXISTS job_applications_agent_idx
  ON public.job_applications (agent_id, applied_at DESC);

-- One topup ledger row per PaymentIntent — DB-level guarantee behind the
-- webhook/confirm settle race (payment audit P1-6). No dupes can exist today:
-- topUp mints exactly one row per intent and both settle paths update in place.
CREATE UNIQUE INDEX IF NOT EXISTS ux_wallet_tx_topup_intent
  ON public.wallet_transactions (stripe_intent_id)
  WHERE type = 'topup' AND stripe_intent_id IS NOT NULL;

-- ─── P2: analytics windows / reconciliation / cascade FKs ───────────────────

CREATE INDEX IF NOT EXISTS lite_bookings_created_at_idx
  ON public.lite_bookings (created_at);
CREATE INDEX IF NOT EXISTS missions_created_at_idx
  ON public.missions (created_at);
CREATE INDEX IF NOT EXISTS wallet_tx_created_at_idx
  ON public.wallet_transactions (created_at) WHERE status = 'succeeded';
CREATE INDEX IF NOT EXISTS sos_events_triggered_idx
  ON public.sos_events (triggered_at DESC);

-- PII redaction sweep (dispatch-privacy-purge.service.ts:81). Predicate omits
-- the status enums deliberately — enum literals in index predicates are brittle
-- (same convention as 20260809140000).
CREATE INDEX IF NOT EXISTS dispatch_offers_redact_idx
  ON public.dispatch_offers (responded_at)
  WHERE reject_reason IS NOT NULL;

-- Escrow daily reconciliation (escrow-reconciliation.service.ts:108-137).
CREATE INDEX IF NOT EXISTS escrow_holds_status_settled_idx
  ON public.escrow_holds (status, settled_at);

-- Unindexed ON DELETE CASCADE FKs — user erasure seq-scans these today.
CREATE INDEX IF NOT EXISTS conversation_members_user_idx
  ON public.conversation_members (user_id);
CREATE INDEX IF NOT EXISTS channel_membership_intents_member_idx
  ON public.channel_membership_intents (member_user_id);
CREATE INDEX IF NOT EXISTS conversation_membership_intents_member_idx
  ON public.conversation_membership_intents (member_user_id);
CREATE INDEX IF NOT EXISTS dispatch_room_intents_member_idx
  ON public.dispatch_room_intents (member_user_id);
CREATE INDEX IF NOT EXISTS enterprise_join_requests_applicant_idx
  ON public.enterprise_join_requests (applicant_user_id);
CREATE INDEX IF NOT EXISTS dept_channels_created_by_idx
  ON public.department_channels (created_by);
CREATE INDEX IF NOT EXISTS family_credit_requests_row_idx
  ON public.family_credit_requests (family_row_id);

-- Protection history + org assignment boards (protection.service.ts:539,817,938).
CREATE INDEX IF NOT EXISTS protection_sessions_customer_created_idx
  ON public.protection_sessions (customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS pro_cpo_assignments_org_idx
  ON public.pro_cpo_assignments (org_user_id, status, starts_on DESC);

-- Incident org queue reads ORDER BY created_at DESC; existing composite has no time key.
CREATE INDEX IF NOT EXISTS incident_org_created_idx
  ON public.incident_reports (org_user_id, created_at DESC);

-- Backup conversation keyset tie-break (backup.service.ts getConversations).
CREATE INDEX IF NOT EXISTS conversation_backups_owner_ts_id_idx
  ON public.conversation_backups (owner_user_id, last_message_at DESC NULLS LAST, conversation_id ASC);

-- Ops user directory search uses leading-wildcard ILIKE on three columns —
-- only pg_trgm GIN can serve that shape.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS users_display_name_trgm
  ON public.users USING GIN (display_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS users_email_trgm
  ON public.users USING GIN ((email::text) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS users_phone_trgm
  ON public.users USING GIN (phone_e164 gin_trgm_ops);

-- ─── Drops: duplicates and a documented leftover ────────────────────────────

-- Exact duplicate of vbg_monitoring_active_beat_idx (same columns, re-created
-- under a new name by 20260705124648).
DROP INDEX IF EXISTS public.idx_vbg_monitoring_active_beat;

-- 20260705110000_lite_mission_compat_bridge.sql:14 says "POST-DEPLOY STEP
-- (required): DROP INDEX" — never done. Beyond redundancy (missions_booking_active_uq
-- is the real constraint), the full UNIQUE blocks the re-dispatch path that
-- org-mission LM-B1 assumes works (a 2nd mission after an ABORTED one).
DROP INDEX IF EXISTS public.missions_booking_id_bridge;

-- Strict prefix of messages_backup_owner_ts_id_idx (DESC is served by a
-- backward scan); no query filters msg_created_at alone.
DROP INDEX IF EXISTS public.messages_backup_owner_since_idx;

-- Strict prefix of lite_bookings_client_created_idx added above.
DROP INDEX IF EXISTS public.lite_bookings_client_idx;

-- Indexes flagged as LIKELY droppable but requiring a pg_stat_user_indexes
-- check on staging first (do not drop blind):
--   notifications_user_created_idx   (covered by the partial _active_ variant
--                                     iff no reader wants dismissed rows)
--   lite_bookings_status_idx         (superseded by the partials above)
--   users_not_deleted_idx            (PK-covered)
--   mission_telemetry_last_recorded_idx (no known reader)
--   agents_dispatch_pool             (rebuild as (status, on_duty) WHERE type='company')
