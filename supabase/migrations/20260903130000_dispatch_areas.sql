-- B-788a — Dispatch v2: assigned providers per operational AREA, no radius.
--
-- Founder, 2026-09-03: "Bravo's operating model is not based on onboarding
-- multiple service providers within every small geographic area. We intend to
-- appoint a primary service provider for each province or operational region,
-- with a secondary provider available as backup. The decision on whether a
-- pickup location is too far away should be made by the service provider
-- receiving the request, not automatically by Bravo based on distance."
--
-- AREAS SIT UNDER REGIONS, NOT BESIDE THEM. `regions` stays country-level
-- because pricing, currency and licence/insurance eligibility are per country
-- (is_eligible_for_dispatch is region-scoped). An area is a ROUTING partition
-- inside a region; an area may equal its whole region (the default area).
--
-- Deny-by-default RLS + zero anon/authenticated grants, matching every other
-- ops-config table (the B-709 standing rule). Reached only through auth-service.
--
-- Ships DARK: `regions.routing_mode` defaults to 'nearest', which is the
-- byte-identical Uber-style ranker that runs today. Ops draws areas and assigns
-- providers, then flips a region to 'assigned'.

-- ─── Routing mode per region (the per-region switch) ─────────────────────────
ALTER TABLE public.regions
  ADD COLUMN IF NOT EXISTS routing_mode text NOT NULL DEFAULT 'nearest'
  CHECK (routing_mode IN ('nearest', 'assigned'));

-- ─── Operational areas ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.operational_areas (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  region_code text NOT NULL REFERENCES public.regions(code) ON DELETE CASCADE,
  -- Human/ops key, e.g. ZA-WC. Unique product-wide so ops never has two "WC".
  -- The region part matches regions.code (2..8 letters — 'AE-DXB' style regions
  -- exist in the DTO), or the default-area seed below would abort the migration.
  code        text NOT NULL UNIQUE CHECK (code ~ '^[A-Z]{2,8}(-[A-Z0-9]{1,8})?$'),
  name        text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  -- The region's catch-all: box NULL, matches any point in the region that no
  -- drawn area claims. Exactly one per region, created with the region.
  is_default  boolean NOT NULL DEFAULT false,
  active      boolean NOT NULL DEFAULT true,
  min_lat     numeric(8,5) CHECK (min_lat BETWEEN -90 AND 90),
  max_lat     numeric(8,5) CHECK (max_lat BETWEEN -90 AND 90),
  min_lng     numeric(9,5) CHECK (min_lng BETWEEN -180 AND 180),
  max_lng     numeric(9,5) CHECK (max_lng BETWEEN -180 AND 180),
  created_at  timestamptz NOT NULL DEFAULT NOW(),
  updated_at  timestamptz NOT NULL DEFAULT NOW(),
  updated_by  uuid REFERENCES public.users(id),
  CONSTRAINT operational_areas_bbox_all_or_nothing CHECK (
    (min_lat IS NULL AND max_lat IS NULL AND min_lng IS NULL AND max_lng IS NULL)
    OR (min_lat IS NOT NULL AND max_lat IS NOT NULL AND min_lng IS NOT NULL AND max_lng IS NOT NULL)
  ),
  CONSTRAINT operational_areas_bbox_ordered CHECK (
    (min_lat IS NULL) OR (min_lat < max_lat AND min_lng < max_lng)
  ),
  -- A drawn (non-default) area must have a box; the default must not.
  CONSTRAINT operational_areas_default_shape CHECK (
    (is_default AND min_lat IS NULL) OR (NOT is_default AND min_lat IS NOT NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS operational_areas_one_default_per_region
  ON public.operational_areas (region_code) WHERE is_default;
CREATE INDEX IF NOT EXISTS operational_areas_region_active_idx
  ON public.operational_areas (region_code, active);

ALTER TABLE public.operational_areas ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.operational_areas FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.operational_areas FROM anon, authenticated;

-- ─── Provider priority per area ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.area_provider_assignments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  area_id          uuid NOT NULL REFERENCES public.operational_areas(id) ON DELETE CASCADE,
  -- A company agent (agents.type = 'company'); agents is keyed by user_id.
  provider_user_id uuid NOT NULL REFERENCES public.agents(user_id) ON DELETE CASCADE,
  -- 1 = primary, 2 = secondary, … Offers cascade in this order.
  priority         smallint NOT NULL CHECK (priority BETWEEN 1 AND 5),
  active           boolean NOT NULL DEFAULT true,
  assigned_by      uuid REFERENCES public.users(id),
  assigned_at      timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE (area_id, provider_user_id)
);
-- One provider per rung while active (two "primaries" is a data error).
CREATE UNIQUE INDEX IF NOT EXISTS area_provider_assignments_one_per_rung
  ON public.area_provider_assignments (area_id, priority) WHERE active;
CREATE INDEX IF NOT EXISTS area_provider_assignments_area_idx
  ON public.area_provider_assignments (area_id, priority) WHERE active;

ALTER TABLE public.area_provider_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.area_provider_assignments FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.area_provider_assignments FROM anon, authenticated;

-- ─── Stamps ──────────────────────────────────────────────────────────────────
-- The area a booking resolved to at create time (NULL for rows that predate
-- this migration, or when no area matched — the router resolves those lazily).
ALTER TABLE public.lite_bookings
  ADD COLUMN IF NOT EXISTS area_id uuid REFERENCES public.operational_areas(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS lite_bookings_area_idx
  ON public.lite_bookings (area_id) WHERE area_id IS NOT NULL;

-- Why this offer was made: 'nearest' (today's ranker), 'assigned:1' (primary),
-- 'assigned:2' (secondary), … or 'regional_fallback'. The dispatch inspector
-- and the agency card both read it.
ALTER TABLE public.dispatch_offers
  ADD COLUMN IF NOT EXISTS source text;

-- ─── Seed ────────────────────────────────────────────────────────────────────
-- One default (catch-all) area per existing region, so every region routes
-- under 'assigned' even before ops draws provinces.
INSERT INTO public.operational_areas (region_code, code, name, is_default)
SELECT code, code, name || ' (all)', true FROM public.regions
ON CONFLICT (code) DO NOTHING;

-- South Africa's launch provinces (founder Q6 default). Boxes are APPROXIMATE
-- and overlap at borders (first match wins, ordered by created_at); ops must
-- verify them in the console before flipping ZA to 'assigned'. Drawn ACTIVE so
-- ops can assign providers immediately — they route on fallback until then.
INSERT INTO public.operational_areas (region_code, code, name, is_default, min_lat, max_lat, min_lng, max_lng) VALUES
  ('ZA', 'ZA-WC',  'Western Cape',    false, -34.90000, -30.40000, 17.40000, 24.60000),
  ('ZA', 'ZA-GP',  'Gauteng',         false, -26.95000, -25.05000, 27.00000, 29.20000),
  ('ZA', 'ZA-KZN', 'KwaZulu-Natal',   false, -31.20000, -26.80000, 28.80000, 33.00000)
ON CONFLICT (code) DO NOTHING;
