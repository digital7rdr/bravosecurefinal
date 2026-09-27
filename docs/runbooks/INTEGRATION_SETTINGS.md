# Integration settings — third-party keys from the ops console (2026-09-27)

Stripe, Twilio (including the OTP delivery mode — see
`OTP_SMS_AND_CRASH_REPORTING.md`), the Mapbox **server** token and the biometric
Google key can be set at runtime from **Ops console → App Configuration →
Integrations**, instead of only through the deployment environment. Settings
with a fixed set of values (the OTP delivery mode) render as a select and the
server rejects anything else.

## How it works

| Piece | Where |
|---|---|
| Table | `platform_settings` — migration `20260927120000_platform_settings.sql`. RLS on, **no policies** (deny-all to anon/authenticated); only the backend's service-role connection reads/writes it. |
| Encryption | Secrets are AES-256-GCM encrypted (`v1:<iv>:<tag>:<ct>`) with `SETTINGS_ENCRYPTION_KEY`. Non-secrets (price IDs, numbers, SIDs) are stored plain. |
| Resolver | `apps/auth-service/src/settings/settings.service.ts` — `getSync(key)`: **console value → deployment env → unset**. Warm in-memory snapshot, refreshed every 15 s and immediately after a write; cross-replica invalidation via the Redis `cfgver:integrations` counter. |
| Catalog | `settings-catalog.ts` — the single list of editable keys. The console renders from it, so adding an entry there surfaces it in the UI. |
| API | `GET /ops/settings`, `PUT /ops/settings/:key {value}`, `DELETE /ops/settings/:key`, `POST /ops/settings/sms/test {to}` (one test SMS through Twilio, audited as `integration.sms.test` with the number masked). `@RequireRoles('SUPER_ADMIN')` (rank 3 — legacy `ADMIN` is the same rank), CSRF + per-user throttle like every `/ops` route. |
| Audit | Every set/clear writes `integration.setting.set` / `.clear` to the ops audit log with the key and category — **never the value**. |
| UI | `/config/integrations` — visible only to rank-3 admins. Secrets are write-only: shown masked (`••••1234`), never pre-filled, dropped from browser state after save. "Revert to env" deletes the console value. |

An **empty table behaves exactly like before**: every key falls back to the same
env variable the code read previously. If the table does not exist yet (migration
not applied), the service logs one warning per 15 s and keeps using env.

## Consumers switched to the resolver

- `wallet/stripe.client.ts` — every `stripe.*` read (secret key, webhook secret(s), price IDs, API base/version, live-mode check)
- `common/services/sms.service.ts`, `common/services/otp.service.ts` — `twilio.*`
- `ops/mapbox-directions.service.ts`, `vbg/geocode.service.ts`, `vbg/vbg.service.ts` — `mapbox.serverToken` (env fallback: `MAPBOX_ACCESS_TOKEN` → `NEXT_PUBLIC_MAPBOX_TOKEN` → `EXPO_PUBLIC_MAPBOX_TOKEN`, as before)

## Deploy checklist

1. Generate the key once per environment and put it in the auth-service env
   (never in git): `openssl rand -base64 32` → `SETTINGS_ENCRYPTION_KEY=…`
2. Apply the migration: `supabase db push` (or run the SQL file).
3. Restart auth-service. The Integrations tab shows **SECRETS LOCKED** until a
   valid key is present; non-secret values can still be saved.

## The encryption key

- It must be **backed up with the database** and kept identical across replicas.
- If it is lost or changed, saved secrets become undecryptable: the service logs
  `decrypt failed … using env fallback` and uses env for those keys. Re-enter the
  secrets in the console after setting the new key.
- Rotation (manual, for now): set the new key, restart, re-enter each secret.

## Not managed here (yet)

| Setting | Why | Where it stays |
|---|---|---|
| Mobile map tile token, Stripe publishable key, Supabase URL/anon key | Baked into the app at build time | `.env.production.local` / EAS env (`docs/runbooks/MOBILE_BUILD_ENV.md`) |
| TURN secret / URLs | Read by **messenger-service**, which does not have the resolver yet | messenger env |
| Firebase service-account JSON, APNs VoIP `.p8` key | Files, not strings | secret files on the server |
| JWT secrets, `DATABASE_URL`, `SETTINGS_ENCRYPTION_KEY` itself | Bootstrap secrets — needed before the DB can be read | env |
