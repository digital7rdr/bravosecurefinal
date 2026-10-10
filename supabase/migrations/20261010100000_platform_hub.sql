-- Bravo Secure home (bravosecure.cloud) — 2026-10-10.
--
-- 1. Verified contact details. Registration on the home site proves both the
--    phone (SMS code) and the email (emailed code); these columns record when.
--    Existing accounts keep NULL (not proven yet); nothing reads them as a gate
--    except the email fallback for the sign-in code.
-- 2. platform_apps: the tiles on the home screen. A Super Admin sets, per app,
--    its address, whether it is active, and which kinds of account may open it
--    (ops console → Internal → Apps). The server decides access from this
--    table on every launch; the tiles only mirror it.
--
-- Additive only: new nullable columns and a new table. Safe to re-run.

BEGIN;

ALTER TABLE public.users ADD COLUMN IF NOT EXISTS email_verified_at timestamptz;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS phone_verified_at timestamptz;

CREATE TABLE IF NOT EXISTS public.platform_apps (
  key               text PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_]{1,39}$'),
  name              text NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  tagline           text NOT NULL DEFAULT '' CHECK (length(tagline) <= 80),
  icon              text NOT NULL CHECK (icon IN ('shield','chat','team','globe','chart','calendar','vault','video')),
  sort              integer NOT NULL DEFAULT 0,
  active            boolean NOT NULL DEFAULT false,
  -- Where the tile opens. NULL while an app has no address yet (it then shows
  -- as inactive whatever `active` says).
  url               text CHECK (url IS NULL OR url ~ '^https?://[^\s]+$'),
  -- Optional: where agency owners and managers go instead (Secure Services →
  -- the provider console). NULL = everyone uses `url`.
  agency_url        text CHECK (agency_url IS NULL OR agency_url ~ '^https?://[^\s]+$'),
  -- Kinds of account that may open the app: client, officer, agency, ops.
  allowed_audiences text[] NOT NULL DEFAULT '{}'
    CHECK (allowed_audiences <@ ARRAY['client','officer','agency','ops']::text[]),
  -- Only people with a confirmed authenticator may open it (Control Console).
  requires_totp     boolean NOT NULL DEFAULT false,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  updated_by        uuid REFERENCES public.users(id) ON DELETE SET NULL
);

-- Deny-by-default like every other table: only the auth-service (service role)
-- reads or writes it.
ALTER TABLE public.platform_apps ENABLE ROW LEVEL SECURITY;

INSERT INTO public.platform_apps (key, name, tagline, icon, sort, active, url, agency_url, allowed_audiences, requires_totp) VALUES
  ('secure_services', 'Secure Services',      'Book & Manage Protection',      'shield',   10, true,
     'https://web.bravosecure.cloud/book', 'https://provider.bravosecure.cloud', ARRAY['client','agency'], false),
  ('messenger',       'Messenger',            'Secure Communications',         'chat',     20, true,
     'https://web.bravosecure.cloud/', NULL, ARRAY['client','officer','agency','ops'], false),
  ('enterprise',      'Enterprise Workspace', 'Teams & Channels',              'team',     30, false, NULL, NULL, ARRAY['client'], false),
  ('georisk',         'GeoRisk',              'Risk Intelligence & Analysis',  'globe',    40, false, NULL, NULL, ARRAY['client','agency','ops'], false),
  ('control',         'Control Console',      'Monitor • Coordinate • Respond','chart',    50, true,
     'https://ops.bravosecure.cloud/', NULL, ARRAY['ops'], true),
  ('calendar',        'Calendar',             'Plan & Schedule',               'calendar', 60, false, NULL, NULL, ARRAY['client','officer','agency','ops'], false),
  ('vault',           'Vault',                'Secure File Storage',           'vault',    70, false, NULL, NULL, ARRAY['client','officer','agency','ops'], false),
  ('meet',            'Meet',                 'Secure Meetings',               'video',    80, false, NULL, NULL, ARRAY['client','officer','agency','ops'], false)
ON CONFLICT (key) DO NOTHING;

COMMIT;
