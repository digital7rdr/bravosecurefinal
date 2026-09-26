-- platform_settings — runtime third-party integration config, edited from the
-- ops console "Integrations" tab (2026-09-27).
--
-- WHY: Stripe / Twilio / Mapbox / biometric keys used to come ONLY from
-- process.env, so changing one meant a redeploy, and the values lived in build
-- files (which is exactly what GitHub push protection rejected). This table lets
-- a SUPER_ADMIN set them at runtime; the services read here first and fall back
-- to env, so an empty table behaves exactly like today.
--
-- SECURITY MODEL:
--   * Secrets (is_secret = true) are stored in value_enc as an AES-256-GCM
--     envelope ("v1:<iv>:<tag>:<ct>") encrypted by the auth-service with
--     SETTINGS_ENCRYPTION_KEY (which stays in env — the one bootstrap secret).
--     The database never holds a secret in clear.
--   * Non-secrets (price IDs, api base, from-number) live in value_plain.
--   * RLS is ON with NO policies, so anon/authenticated clients get nothing.
--     Only the backend, using the service-role connection, reads or writes.

create table if not exists public.platform_settings (
  key         text primary key,
  category    text        not null,
  value_plain text,
  value_enc   text,
  is_secret   boolean     not null default false,
  updated_by  uuid,
  updated_at  timestamptz not null default now(),

  -- A row exists only when it carries a value, and the value lives in exactly
  -- the column its secrecy dictates. Clearing a setting deletes the row (→ the
  -- service falls back to env), so there is no "both null" state to model.
  constraint platform_settings_value_placement check (
    (is_secret     and value_enc is not null and value_plain is null) or
    (not is_secret and value_plain is not null and value_enc   is null)
  )
);

alter table public.platform_settings enable row level security;
-- Intentionally no policies: RLS-on with none = deny-all for anon/authenticated.
-- The service-role key the backend uses bypasses RLS.

comment on table public.platform_settings is
  'Runtime third-party integration config (Integrations tab). Secrets AES-256-GCM in value_enc via SETTINGS_ENCRYPTION_KEY; non-secrets in value_plain. Read at request time with env fallback. RLS deny-all; backend service-role only. Added 2026-09-27.';
