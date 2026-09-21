-- Referral / discount campaigns (founder, 2026-09-05): ops mints a referral
-- code per REGION or UNIVERSAL; a client applies it on a booking and gets a
-- discount; ops sees usage, what was sold and what was paid, per code.
--
-- This is a DIFFERENT thing from provider_referral_codes (Issue 28), which is
-- ATTRIBUTION ONLY and pinned never to change pricing. A campaign changes the
-- price, so it gets its own table, its own columns on the booking and its own
-- ledger. The one shared rule: a campaign never touches availability,
-- licensing, dispatch ranking or operator approval — it moves the client's
-- total and nothing else.
--
-- Money model: stored booking totals are EUR (charged at round(total_eur /
-- eur_per_bc)), so the discount is stored in EUR too and total_eur is written
-- ALREADY DISCOUNTED. Every charge path (pay-with-credits, offer accept, the
-- B-795 committed-sum check) reads total_eur, so none of them needs to know a
-- discount exists. referral_discount_eur keeps the gross recoverable for
-- reporting (gross = total_eur + referral_discount_eur).

CREATE TABLE IF NOT EXISTS public.referral_campaigns (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Stored upper-case; the API upper-cases before lookup (same rule as the
  -- partner codes, so one client-side box can carry either kind).
  code            TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  scope           TEXT NOT NULL CHECK (scope IN ('universal', 'region')),
  region_code     TEXT,
  discount_type   TEXT NOT NULL CHECK (discount_type IN ('percent', 'fixed_bc')),
  discount_value  NUMERIC(10,2) NOT NULL CHECK (discount_value > 0),
  -- Ceiling for a percent discount, in BC. NULL = uncapped.
  max_discount_bc INTEGER CHECK (max_discount_bc IS NULL OR max_discount_bc > 0),
  -- NULL = every service; otherwise the booking's service must be listed.
  services        TEXT[],
  -- NULL = unlimited redemptions overall.
  max_redemptions INTEGER CHECK (max_redemptions IS NULL OR max_redemptions > 0),
  -- How many bookings ONE client may discount with this code.
  per_user_limit  INTEGER NOT NULL DEFAULT 1 CHECK (per_user_limit > 0),
  starts_at       TIMESTAMPTZ,
  expires_at      TIMESTAMPTZ,
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  notes           TEXT,
  created_by      UUID REFERENCES public.users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT referral_campaigns_region_scope CHECK (
    (scope = 'universal' AND region_code IS NULL)
    OR (scope = 'region' AND region_code IS NOT NULL)
  ),
  CONSTRAINT referral_campaigns_percent_range CHECK (
    discount_type <> 'percent' OR discount_value <= 100
  ),
  CONSTRAINT referral_campaigns_window CHECK (
    starts_at IS NULL OR expires_at IS NULL OR starts_at < expires_at
  )
);

CREATE INDEX IF NOT EXISTS referral_campaigns_active_idx
  ON public.referral_campaigns(code) WHERE active = TRUE;
CREATE INDEX IF NOT EXISTS referral_campaigns_region_idx
  ON public.referral_campaigns(region_code) WHERE region_code IS NOT NULL;

-- One row per discounted booking: the ledger ops reads for usage, who used it,
-- what was sold (gross), what was given away (discount) and what was charged
-- (net). booking_id is UNIQUE so a booking can never be discounted twice.
CREATE TABLE IF NOT EXISTS public.referral_redemptions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id   UUID NOT NULL REFERENCES public.referral_campaigns(id) ON DELETE CASCADE,
  booking_id    UUID NOT NULL UNIQUE REFERENCES public.lite_bookings(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  region_code   TEXT,
  service       TEXT,
  gross_eur     NUMERIC(12,2) NOT NULL CHECK (gross_eur >= 0),
  discount_eur  NUMERIC(12,2) NOT NULL CHECK (discount_eur >= 0),
  net_eur       NUMERIC(12,2) NOT NULL CHECK (net_eur >= 0),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS referral_redemptions_campaign_idx
  ON public.referral_redemptions(campaign_id, created_at DESC);
CREATE INDEX IF NOT EXISTS referral_redemptions_campaign_user_idx
  ON public.referral_redemptions(campaign_id, user_id);

-- The booking keeps the code AS SUBMITTED plus the discount it actually got,
-- so reporting survives the campaign being renamed or deactivated later.
ALTER TABLE public.lite_bookings
  ADD COLUMN IF NOT EXISTS referral_campaign_id   UUID REFERENCES public.referral_campaigns(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS referral_campaign_code TEXT,
  ADD COLUMN IF NOT EXISTS referral_discount_eur  NUMERIC(12,2) NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS lite_bookings_referral_campaign_idx
  ON public.lite_bookings(referral_campaign_id)
  WHERE referral_campaign_id IS NOT NULL;

-- Deny-by-default RLS, same as every table added since the 2026-08-05 catch-up:
-- the auth-service connects with a role that bypasses RLS; anon/authenticated
-- roles get nothing.
ALTER TABLE public.referral_campaigns   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.referral_campaigns   FORCE  ROW LEVEL SECURITY;
ALTER TABLE public.referral_redemptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.referral_redemptions FORCE  ROW LEVEL SECURITY;

COMMENT ON TABLE public.referral_campaigns IS
  'Ops-minted referral / discount codes, universal or per region. Changes the client total ONLY; never dispatch, availability, licensing or approval.';
COMMENT ON TABLE public.referral_redemptions IS
  'One row per discounted booking: gross / discount / net in EUR. The usage + revenue ledger the ops console reads.';
COMMENT ON COLUMN public.lite_bookings.referral_discount_eur IS
  'Discount already subtracted from total_eur. Gross = total_eur + referral_discount_eur.';
