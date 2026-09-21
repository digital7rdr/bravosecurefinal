-- 2026-09-14 — B-877: a Secure Transfer is billed as a fixed BLOCK of hours.
--
-- Founder, on the SERVICE DURATION card of a 10-minute transfer: "What is this
-- for? ... This card is not relative." Decision relayed 2026-09-14 13:16:
-- "Confirm we can set the 4 hours per region" - "Yes".
--
-- Read as: a Secure Transfer is billed as a fixed block of hours that OPS set
-- PER REGION (default 4, the number every shipped app already sends). The
-- client no longer chooses hours for a transfer; the app has no duration
-- control for it from 1.0.316. Hourly services (Close Protection and anything
-- else per-hour) keep the ops-configurable stepper range untouched, and
-- Executive Protection keeps its own fixed 3-hour grid.
--
-- Per-region by construction: this is one more key on the same overlay as every
-- other booking number (compiled default -> 'GLOBAL' row -> the region's row,
-- 20260901130000), so ops set a region's block without re-entering anything
-- else and a region that never diverges follows the global 4.
--
-- The key set is a column CHECK, so admitting a new key means REPLACING it -
-- dropped by LOOKUP, never by assumed name (same as 20260831180000 /
-- 20260901130000 / 20260904120000). The list below is the full current set plus
-- the new key; dropping one from it would make its existing rows unwritable.
--
-- DEPLOY ORDER IS HARD: migration -> server -> APK. The new server reads
-- transfer_block_hours, and the ops PATCH writes it - against an old schema
-- the write fails the CHECK. An old server against the new schema keeps working
-- (it ignores the key it does not know).

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
    'hourly_default_hours',
    'hourly_min_hours',
    'hourly_max_hours',
    'transfer_block_hours'    -- NEW: hours, the block a Secure Transfer is billed as
  ));

-- Seeded to 4 - EXACTLY the duration every shipped app's stepper defaults to
-- and the value the engine already stored for a transfer that did not choose,
-- so this migration changes no price on its own. The column CHECK is
-- (0 < value < 100000); the ops BOUNDS carry the business range (1..24 whole
-- hours, re-checked at the point of use by resolveTransferBlockHours).
INSERT INTO public.service_pricing (key, value, region_code) VALUES
  ('transfer_block_hours', 4, 'GLOBAL')
ON CONFLICT (key, region_code) DO NOTHING;
