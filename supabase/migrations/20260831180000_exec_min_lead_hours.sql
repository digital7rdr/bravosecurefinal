-- 2026-08-31 — Executive Protection minimum booking LEAD TIME, ops-configurable.
--
-- Client change: EP is now ALWAYS scheduled. The client picks when protection
-- starts, and the earliest selectable start is `booking time + lead time`.
-- Phase 1 default is 3 hours, but 3 must not be the permanent hardcoded rule.
--
-- Why this table and not a new one: `service_pricing` already carries every
-- ops-editable number for the booking engine, with the whole chain we need —
-- SUPERVISOR/ADMIN-guarded PATCH, per-key bounds, from→to audit rows, a 60 s
-- cache and a FAIL-OPEN read that falls back to the compiled default. A parallel
-- config table would have to re-earn all of that.
--
-- SCOPE IS GLOBAL, deliberately (founder decision 2026-08-31 after the
-- investigation): this table has no region or provider dimension, and neither
-- scope is safely resolvable at booking time anyway —
--   * provider is bound only when an agency ACCEPTS an offer, which happens
--     after the booking exists, so a provider-specific lead time cannot be
--     resolved while the client is picking a start time;
--   * region is client-supplied on the create DTO and only checked against
--     SUPPORTED_REGIONS, so scoping lead time by it would let a client shrink
--     their own lead by sending a different region code.
-- Region scoping becomes possible once region is server-derived. Until then a
-- single global key is the honest model.
--
-- NOT a price. It shares the table for the machinery, not the semantics — the
-- pricing formula does not read it and lead time never affects a quote.

-- The key set is a column CHECK, so admitting a new key means replacing it.
-- Dropped by lookup rather than by assumed name: the original constraint was
-- created inline, and its generated name is not guaranteed across environments.
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
    'exec_min_lead_hours'   -- NEW: hours, not currency
  ));

-- Seeded to the value the code already compiles in, so running this migration
-- changes no behaviour on its own. The existing `value > 0 AND value < 100000`
-- CHECK on the column already rejects a negative or zero lead time; the
-- business ceiling lives in the controller's BOUNDS.
INSERT INTO public.service_pricing (key, value) VALUES ('exec_min_lead_hours', 3)
ON CONFLICT (key) DO NOTHING;
