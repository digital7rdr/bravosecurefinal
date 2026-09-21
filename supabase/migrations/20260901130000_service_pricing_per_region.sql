-- 2026-09-01 — service pricing gains a REGION dimension.
--
-- Client: "the pricing needs to be changed for each product of secure services
-- and must be adjustable per region."
--
-- ── Shape: an OVERLAY, not a replacement ────────────────────────────────────
--
-- `region_code` defaults to 'GLOBAL' and every existing row keeps that value, so
-- this migration changes no price anywhere. Resolution is three layers, most
-- specific last:
--
--     compiled DEFAULT_SERVICE_PRICING  ->  region 'GLOBAL' rows  ->  region rows
--
-- A region therefore only overrides the keys ops actually sets for it. Nobody has
-- to re-enter thirteen numbers to make one region's CPO rate different, and a
-- later change to a global rate still flows into every region that has not
-- deliberately diverged on that key.
--
-- 'GLOBAL' is a sentinel, not a region: `regions.code` is CHECKed as
-- ^[A-Z]{2,8}$, which 'GLOBAL' satisfies, so it is reserved here explicitly and
-- refused as a real region code by the ops controller. There is deliberately NO
-- foreign key to public.regions — a price row must survive a region being closed,
-- exactly as bookings in that region do.
--
-- ── Why the primary key has to change ───────────────────────────────────────
--
-- `key` was the PK. Per-region rows need (key, region_code). The old constraint
-- is dropped by LOOKUP rather than by assumed name: it was created inline as part
-- of `key text PRIMARY KEY`, and its generated name is not guaranteed identical
-- across environments (the same reason 20260831180000 looked up the key CHECK).

ALTER TABLE public.service_pricing
  ADD COLUMN IF NOT EXISTS region_code text NOT NULL DEFAULT 'GLOBAL';

ALTER TABLE public.service_pricing
  DROP CONSTRAINT IF EXISTS service_pricing_region_code_check;
ALTER TABLE public.service_pricing
  ADD CONSTRAINT service_pricing_region_code_check
  CHECK (region_code = 'GLOBAL' OR region_code ~ '^[A-Z]{2,8}$');

DO $$
DECLARE
  pk_name text;
BEGIN
  SELECT conname INTO pk_name
    FROM pg_constraint
   WHERE conrelid = 'public.service_pricing'::regclass
     AND contype = 'p';
  IF pk_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.service_pricing DROP CONSTRAINT %I', pk_name);
  END IF;
END $$;

ALTER TABLE public.service_pricing
  ADD CONSTRAINT service_pricing_pkey PRIMARY KEY (key, region_code);

-- The resolver reads one region plus GLOBAL in a single query.
CREATE INDEX IF NOT EXISTS service_pricing_region_idx
  ON public.service_pricing (region_code);

-- ── Per-service minimum lead times ──────────────────────────────────────────
--
-- Client: "the lead times need to be adjustable — all controlled by ops console."
--
-- `exec_min_lead_hours` already exists for Executive Protection. The other two
-- bookable services get their own keys, seeded to the values the code already
-- behaves as: a Secure Transfer has never had a minimum lead (it is the
-- book-now service), and Close Protection follows the EP rule at 3 hours.
--
-- Now that a booking's region is SERVER-DERIVED from its pickup coordinates
-- (20260901120000, `regionFromPoint`), scoping these per region is finally safe —
-- the objection recorded in 20260831180000 was that a client could shrink their
-- own lead by naming a different region, and a client cannot name a bounding box.
-- Seeded GLOBAL; a region row overrides only where ops sets one.
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
    'transfer_min_lead_hours',   -- NEW: hours
    'close_min_lead_hours'       -- NEW: hours
  ));

-- The column CHECK is `value > 0`, so "no lead time" cannot be stored as 0.
-- 0.25 h (15 min) is the smallest honest floor for a book-now service and is
-- what the dispatch rail can actually honour; the controller BOUNDS carry the
-- business range.
INSERT INTO public.service_pricing (key, value, region_code) VALUES
  ('transfer_min_lead_hours', 0.25, 'GLOBAL'),
  ('close_min_lead_hours',    3,    'GLOBAL')
ON CONFLICT (key, region_code) DO NOTHING;
