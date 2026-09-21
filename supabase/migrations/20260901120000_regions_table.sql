-- 2026-09-01 — REGIONS become ops-managed data instead of a compiled constant.
--
-- Client: "we need to be able to add regions as we get service providers."
-- Today `REGIONS` is a TypeScript array in apps/auth-service/src/common/regions.ts,
-- so onboarding a provider in a new country is a code change plus a deploy.
--
-- Same shape as `service_pricing`, deliberately: a table seeded with EXACTLY the
-- compiled values, read fail-open behind a short cache, with the compiled array
-- kept in code as the fallback. An unreachable or empty table therefore behaves
-- exactly like today's build — never an empty region list, which would make
-- every booking `unsupported_region` and take the product down.
--
-- ── The bounding box, and why it is here in the FIRST regions migration ──────
--
-- 20260831180000_exec_min_lead_hours.sql refused to scope lead time by region
-- and wrote down why: "region is client-supplied on the create DTO and only
-- checked against SUPPORTED_REGIONS, so scoping lead time by it would let a
-- client shrink their own lead by sending a different region code. Region
-- scoping becomes possible once region is server-derived."
--
-- Per-region PRICING has the identical hole — a client would name the cheapest
-- region and pay its rate — so it needs the same precondition. `create_booking`
-- already carries `pickup.latitude/longitude`, so the region a booking is PRICED
-- in can be derived from the coordinates instead of taken on trust. These four
-- columns are that derivation, kept here so the pricing migration does not have
-- to alter this table again.
--
-- NULLABLE on purpose: a region with no box simply never resolves from
-- coordinates, and a booking that resolves to no region prices at the GLOBAL
-- rate. That is the fail-safe direction — an un-boxed region can never make a
-- booking cheaper, it can only decline to make it different.
--
-- Boxes are rough country extents, which is all the pricing resolver needs
-- (regions do not overlap in this product). Ops can refine them per region.

CREATE TABLE IF NOT EXISTS public.regions (
  code             text PRIMARY KEY CHECK (code ~ '^[A-Z]{2,8}$'),
  name             text NOT NULL CHECK (length(btrim(name)) > 0),
  currency         text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  -- DST-naive by design, matching the compiled RegionDef: an hour of drift twice
  -- a year in GB beats evaluating the peak-pricing window in raw UTC everywhere.
  utc_offset_hours numeric(4,2) NOT NULL DEFAULT 0 CHECK (utc_offset_hours BETWEEN -12 AND 14),
  -- B-93 — PRODUCT launch flag, not a supply signal. A launched region with no
  -- providers still takes bookings (ops handles them); deriving this from pool
  -- counts is what stuck ZA on "COMING SOON".
  launched         boolean NOT NULL DEFAULT false,
  min_lat          numeric(8,5) CHECK (min_lat BETWEEN -90 AND 90),
  max_lat          numeric(8,5) CHECK (max_lat BETWEEN -90 AND 90),
  min_lng          numeric(8,5) CHECK (min_lng BETWEEN -180 AND 180),
  max_lng          numeric(8,5) CHECK (max_lng BETWEEN -180 AND 180),
  -- Either a whole box or no box. A half-populated box is the state that would
  -- silently mis-resolve a booking's pricing region.
  CONSTRAINT regions_bbox_all_or_nothing CHECK (
    (min_lat IS NULL AND max_lat IS NULL AND min_lng IS NULL AND max_lng IS NULL)
    OR (min_lat IS NOT NULL AND max_lat IS NOT NULL AND min_lng IS NOT NULL AND max_lng IS NOT NULL)
  ),
  CONSTRAINT regions_bbox_ordered CHECK (
    (min_lat IS NULL) OR (min_lat < max_lat AND min_lng < max_lng)
  ),
  created_at       timestamptz NOT NULL DEFAULT NOW(),
  updated_at       timestamptz NOT NULL DEFAULT NOW(),
  updated_by       uuid REFERENCES public.users(id)
);

-- Deny-by-default, matching every other ops-config table: reached only through
-- the service role via auth-service, never from an anon/authenticated client.
ALTER TABLE public.regions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.regions FORCE ROW LEVEL SECURITY;

-- Supabase's default schema privileges hand anon/authenticated full DML on any
-- new public table. RLS is FORCED with no policies, so that is already
-- deny-by-default and not exploitable — but the standing rule for ops-config
-- tables is zero anon/authenticated grants (it is what the B-709 deploy
-- verified), and defence in depth should not rest on one setting nobody
-- re-checks. Caught on the staging apply, 2026-09-01, and revoked there too.
REVOKE ALL ON public.regions FROM anon, authenticated;

-- Seeded to EXACTLY the compiled REGIONS array, so running this migration
-- changes no behaviour on its own.
INSERT INTO public.regions (code, name, currency, utc_offset_hours, launched,
                            min_lat, max_lat, min_lng, max_lng) VALUES
  ('AE', 'UAE — Dubai, Abu Dhabi, Sharjah',        'AED', 4, true,   22.50000,  26.50000,  51.00000,  56.50000),
  ('SA', 'Saudi Arabia — Riyadh, Jeddah',          'SAR', 3, false,  16.00000,  32.20000,  34.50000,  55.70000),
  ('BD', 'Bangladesh — Dhaka Division',            'BDT', 6, true,   20.50000,  26.70000,  88.00000,  92.70000),
  ('GB', 'United Kingdom — London',                'GBP', 0, false,  49.80000,  61.00000,  -8.70000,   1.80000),
  ('ZA', 'South Africa — Johannesburg, Cape Town', 'ZAR', 2, true,  -35.00000, -22.10000,  16.40000,  33.00000)
ON CONFLICT (code) DO NOTHING;

-- The pricing resolver scans by coordinate; five rows never needs an index, but
-- this table is expected to grow as providers are onboarded.
CREATE INDEX IF NOT EXISTS regions_bbox_idx
  ON public.regions (min_lat, max_lat, min_lng, max_lng)
  WHERE min_lat IS NOT NULL;
