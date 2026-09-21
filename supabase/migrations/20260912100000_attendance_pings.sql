-- B-859 — "ping each user … if an admin or higher pings a person they should
-- see their location while on shift. Other than shift, if pinged, don't share
-- location" (founder, 2026-09-11).
--
-- ONE row per location request. The gate is NOT this table: a ping may only be
-- raised while the worker holds an OPEN cpo_shift_sessions row for THAT shift,
-- and the server re-checks the same predicate when the answer arrives — a
-- worker who clocked out between the two is recorded 'refused' with reason
-- 'off_shift' and NO coordinates are stored. There is deliberately no
-- always-on tracking lane here: a fix exists only because a named manager
-- asked for it, inside a shift, and the device chose to answer.
--
-- `status` is swept LAZILY (no cron, exactly like family_funding_requests):
-- a row can sit at 'pending' past its 10-minute life, so every reader derives
-- the reported status from requested_at. The write side sweeps stale pendings
-- before it inserts, so the partial unique index below cannot wedge a worker
-- out of ever being pinged again.

CREATE TABLE IF NOT EXISTS public.cpo_shift_pings (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shift_id      UUID NOT NULL REFERENCES public.cpo_shifts(id) ON DELETE CASCADE,
  -- The worker being asked. CASCADE with the account: a deleted user leaves no
  -- orphaned location request behind.
  cpo_user_id   UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  -- The manager who asked. Kept for the worker-visible trace (GET
  -- /attendance/pings/mine) and for the per-manager rate floor.
  --
  -- NULLABLE, ON DELETE SET NULL — the audit-safe shape. CASCADE would DELETE
  -- the worker's record of having been asked when the manager's account goes,
  -- which is precisely backwards: the trace exists for the person who was
  -- asked, not for the person who asked. The projection then answers
  -- requested_by_name: null and the client renders its "a manager" fallback.
  requested_by  UUID REFERENCES public.users(id) ON DELETE SET NULL,
  requested_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'answered', 'refused', 'expired')),
  answered_at   TIMESTAMPTZ,
  -- Written ONLY on an 'answered' row. A refusal (off shift, no permission, no
  -- fix, declined) stores nothing.
  lat           DOUBLE PRECISION,
  lng           DOUBLE PRECISION,
  accuracy_m    DOUBLE PRECISION,
  refuse_reason TEXT,

  -- The founder's rule made a SCHEMA invariant: "other than shift, if pinged,
  -- don't share location". Coordinates may exist ONLY on an answered row, so a
  -- future writer cannot leave a fix behind on a refusal or an expiry — not by
  -- a forgotten NULL in an UPDATE, not by a backfill, not by a console edit.
  -- The service refuses out-of-shift answers before this ever fires; this is
  -- the floor under that, not a substitute for it.
  CONSTRAINT cpo_shift_pings_fix_only_when_answered
    CHECK (status = 'answered' OR (lat IS NULL AND lng IS NULL AND accuracy_m IS NULL))
);

-- One outstanding ask per (shift, worker): a re-tap storm cannot queue N cards
-- on the worker's device, and the manager's UI has exactly one row to poll.
CREATE UNIQUE INDEX IF NOT EXISTS cpo_shift_pings_one_pending
  ON public.cpo_shift_pings(shift_id, cpo_user_id)
  WHERE status = 'pending';

-- The shift-detail LATERAL ("latest ping for this shift + worker") and the
-- per-(shift, worker) daily cap both read this order.
CREATE INDEX IF NOT EXISTS cpo_shift_pings_shift_cpo_idx
  ON public.cpo_shift_pings(shift_id, cpo_user_id, requested_at DESC);

-- The worker's own trace (GET /attendance/pings/mine), newest first.
CREATE INDEX IF NOT EXISTS cpo_shift_pings_cpo_idx
  ON public.cpo_shift_pings(cpo_user_id, requested_at DESC);

-- Deny-by-default, exactly like attendance_checkin_photos and every other
-- Dept Chat v2 table: no policy is defined, so PostgREST/anon reaches nothing.
-- The service role (auth-service) is the only reader/writer, behind the org
-- manager guard for the request side and the worker's own JWT for the answer.
ALTER TABLE public.cpo_shift_pings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cpo_shift_pings FORCE  ROW LEVEL SECURITY;

COMMENT ON TABLE public.cpo_shift_pings IS
  'Manager-raised "where are you" location request for a worker on an OPEN session of a specific shift. Answered with one fix or refused; never a tracking stream. Status expires lazily after 10 minutes.';
COMMENT ON COLUMN public.cpo_shift_pings.refuse_reason IS
  'off_shift (server verdict at answer time) | no_permission | no_fix | declined (the device''s own answer).';
