-- 2026-09-04 — "Accepted is not Dispatched" (founder).
--
-- Today crew-assignment INSERTs the mission directly as DISPATCHED, so the
-- customer is told "Team dispatched" the moment the agency picks names off its
-- roster. The team may still be at base. This adds ONE state before DISPATCHED:
--
--   CREWED  — crew assigned by the agency, nobody has moved yet ("Not started")
--   DISPATCHED — the agency / lead explicitly pressed Dispatched: the team is
--                moving toward the client. Stamped in `dispatched_at`.
--
-- Everything downstream (PICKUP → LIVE → COMPLETED, SOS, ABORTED) is untouched.
-- `live_at` (stamped on PICKUP → LIVE, "client received") remains the ONE
-- authoritative start of the service window; it is never overwritten (every
-- writer uses COALESCE(live_at, NOW())).
--
-- SEPARATE migration from the trigger update (20260904120001): Postgres forbids
-- referencing a freshly ADD VALUE'd enum label in the same transaction, and the
-- runner applies each file with --single-transaction (same split as
-- 20260622000000 / 20260622000001 for AGENCY_NO_SHOW).
--
-- DEPLOY ORDER IS HARD: migration → server → APK. A new server INSERTs 'CREWED'
-- and reads `dispatched_at`; against an old schema both fail. An old server
-- against the new schema keeps working (it never writes CREWED).

ALTER TYPE mission_status ADD VALUE IF NOT EXISTS 'CREWED' BEFORE 'DISPATCHED';

ALTER TABLE public.missions
  ADD COLUMN IF NOT EXISTS dispatched_at timestamptz;

COMMENT ON COLUMN public.missions.dispatched_at IS
  'Server time the agency/lead pressed Dispatched (CREWED -> DISPATCHED). NULL on a CREWED mission and on legacy rows created before 2026-09-04 that were inserted straight at DISPATCHED.';

-- ─── Hourly-service duration is ops-configurable, never a compiled 4 ───────
--
-- The booking engine defaulted every hourly booking to 4 hours and the app had
-- no control to change it. These three keys make the default and the allowed
-- range live on the same ops board as every other booking number. Seeded to
-- EXACTLY the values the code already enforced (DTO 1..24, default 4) so this
-- migration changes no behaviour on its own; ops can raise the floor to 4 (or
-- anything else) from the console. Executive Protection keeps its own fixed
-- 3-hour-block rule and never reads these.
--
-- The key set is a column CHECK, so admitting new keys means replacing it —
-- dropped by lookup, never by assumed name (same as 20260831180000).
DO $$
DECLARE
  con_name text;
BEGIN
  SELECT conname INTO con_name
    FROM pg_constraint
   WHERE conrelid = 'public.service_pricing'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) LIKE '%eur_per_bc%';
  IF con_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.service_pricing DROP CONSTRAINT %I', con_name);
  END IF;
END $$;

ALTER TABLE public.service_pricing
  ADD CONSTRAINT service_pricing_key_check CHECK (key IN (
    'eur_per_bc',
    'transfer_base_rate_bc',
    'transfer_extra_unit_factor',
    'transfer_driver_only_factor',
    'peak_multiplier',
    'base_rate_aed',
    'exec_cpo_rate_bc',
    'exec_vehicle_rate_bc',
    'exec_driver_only_rate_bc',
    'addon_female_cpo_bc',
    'addon_recon_bc',
    'addon_medical_bc',
    'addon_comms_bc',
    'exec_min_lead_hours',
    'transfer_min_lead_hours',
    'close_min_lead_hours',
    'platform_fee_pct',
    'cancel_fee_pct',
    'hourly_default_hours',   -- NEW: hours, the pre-filled duration for hourly services
    'hourly_min_hours',       -- NEW: hours, smallest bookable duration
    'hourly_max_hours'        -- NEW: hours, largest bookable duration
  ));

INSERT INTO public.service_pricing (key, value, region_code) VALUES
  ('hourly_default_hours', 4,  'GLOBAL'),
  ('hourly_min_hours',     1,  'GLOBAL'),
  ('hourly_max_hours',     24, 'GLOBAL')
ON CONFLICT (key, region_code) DO NOTHING;
