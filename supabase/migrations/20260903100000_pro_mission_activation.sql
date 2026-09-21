-- Secure Pro — reserved dates actually activate (audit E2E-01/07/08/35, 2026-09-03).
--
-- Until now nothing in the backend was triggered by a reserved date: the only
-- writers of pro_plan_missions were the request/decision paths, so a SCHEDULED
-- date unlocked a UI tile and stopped there. This migration adds the columns a
-- 60 s fenced sweeper needs to (a) claim a mission-day at-most-once, (b) close
-- the day, (c) escalate a date nobody was assigned to, and (d) run the
-- protection sweeps off the ops poll.
--
-- Statement by statement:
--   1. pro_plan_missions.activated_at / activated_for_date — the at-most-once
--      claim. TWO columns, not one: mission_dates is an ARRAY, so a single
--      activated_at would claim a multi-date reservation once and never fire on
--      its remaining dates. The pair claims per (mission, Gulf calendar day).
--   2. pro_plan_missions.escalated_at — at-most-once claim for the "reserved
--      date with no assigned team" ops alert, so the sweeper cannot re-alert
--      every 60 s for the same row.
--   3. status CHECK gains CANCELLED — E2E-07 needs a terminal value for a
--      client- or ops-cancelled reservation (DECLINED already means "ops said
--      no to the request", which is a different thing).
--   4/5. Partial indexes for the sweeper's two open-status scans. Both are tiny
--      (open reservations only) so a plain CREATE INDEX is fine here.
--   6. protection_sessions.escalated_at — at-most-once claim for the "session
--      created but never reached ACTIVE" ops alert.
--   7. psl_received_at_idx — the retention DELETE leads on received_at and had
--      no index that could serve it (psl_session_idx is (session_id,
--      received_at)). Same name/shape as the copy in the not-yet-applied
--      20260902090000_scale_indexes_50k.sql, so whichever lands first wins.
--
-- PRODUCTION NOTE: statements 4, 5 and 7 take a SHARE lock on their table for
-- the duration of the build. pro_plan_missions is small (one row per
-- reservation) so it can be built inline, but protection_session_locations is
-- the high-volume telemetry table — apply statement 7 as
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS psl_received_at_idx
--     ON public.protection_session_locations (received_at);
-- outside a transaction block in production.

-- 1. Per-day activation claim.
ALTER TABLE public.pro_plan_missions
  ADD COLUMN IF NOT EXISTS activated_at       timestamptz;
ALTER TABLE public.pro_plan_missions
  ADD COLUMN IF NOT EXISTS activated_for_date date;

COMMENT ON COLUMN public.pro_plan_missions.activated_for_date IS
  'Gulf calendar day this reservation was last activated for — with activated_at, the at-most-once claim per (mission, day).';

-- 2. Ops-escalation claim ("no team assigned and the date is nearly here").
ALTER TABLE public.pro_plan_missions
  ADD COLUMN IF NOT EXISTS escalated_at timestamptz;

-- 3. CANCELLED joins the status vocabulary. Drop-then-add is idempotent; the
--    constraint was created inline in 20260803210000 so it carries Postgres'
--    default name.
ALTER TABLE public.pro_plan_missions
  DROP CONSTRAINT IF EXISTS pro_plan_missions_status_check;
ALTER TABLE public.pro_plan_missions
  ADD CONSTRAINT pro_plan_missions_status_check
  CHECK (status IN ('REQUESTED','SCHEDULED','DECLINED','COMPLETED','CANCELLED'));

-- 4. The activation + end-of-day passes scan open SCHEDULED reservations.
CREATE INDEX IF NOT EXISTS pro_plan_missions_open_scheduled_idx
  ON public.pro_plan_missions (created_at)
  WHERE status = 'SCHEDULED';

-- 5. The escalation pass (and the ops queue) scan open REQUESTED reservations.
CREATE INDEX IF NOT EXISTS pro_plan_missions_open_requested_idx
  ON public.pro_plan_missions (created_at)
  WHERE status = 'REQUESTED';

-- 6. Session-level escalation claim.
ALTER TABLE public.protection_sessions
  ADD COLUMN IF NOT EXISTS escalated_at timestamptz;

COMMENT ON COLUMN public.protection_sessions.escalated_at IS
  'Set once when the ops alert for "still REQUESTED past the activation escalation window" was raised — the at-most-once claim.';

-- 7. Retention DELETE support (see PRODUCTION NOTE above).
CREATE INDEX IF NOT EXISTS psl_received_at_idx
  ON public.protection_session_locations (received_at);
