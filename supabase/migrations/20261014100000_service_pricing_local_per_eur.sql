-- 2026-10-14 — Bravo Credits explainer: what 1 BC is worth in each region's
-- currency.
--
-- Tester report: "No reference to Bravo Credits in setup. Bravo must explain
-- the function and exchange rate per country, BC = 1 euro." The app now shows
-- a one-time "How Bravo Credits work" step (and the same page from Wallet) with
-- 1 BC = eur_per_bc EUR and its value in AED / SAR / BDT / GBP / ZAR.
--
-- `local_per_eur` is DISPLAY ONLY: local currency units per €1, set PER REGION
-- on the ops pricing board (same overlay as every other key). It is never read
-- by a quote, a charge, a top-up or a settlement: cards are always charged in
-- euro, so these numbers only tell the client roughly what their bank will
-- show. Seeded with indicative mid-market rates of 2026-10-14 (ECB reference
-- rates for GBP/ZAR, AED and SAR through their USD pegs, BDT mid-market);
-- ops keep them current.
--
-- The key set is a column CHECK, so admitting a new key means REPLACING it -
-- dropped by LOOKUP, never by assumed name (as 20260914130000). The list below
-- is the full current set plus the new key.
--
-- DEPLOY ORDER: migration -> auth-service -> console -> APK. An old server
-- against this schema ignores the key; the new server against the old schema
-- answers the compiled defaults (the read is fail-open) and only the ops PATCH
-- of this key would fail the CHECK.

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
    'transfer_block_hours',
    'local_per_eur'           -- NEW: display only, local currency per EUR
  ));

-- Per-region seeds (no GLOBAL row: a global "local currency" has no meaning;
-- a region without a row shows the server's compiled default for its currency).
INSERT INTO public.service_pricing (key, value, region_code) VALUES
  ('local_per_eur', 4.1114,  'AE'),
  ('local_per_eur', 4.1981,  'SA'),
  ('local_per_eur', 137.2000,'BD'),
  ('local_per_eur', 0.8439,  'GB'),
  ('local_per_eur', 18.4382, 'ZA')
ON CONFLICT (key, region_code) DO NOTHING;
