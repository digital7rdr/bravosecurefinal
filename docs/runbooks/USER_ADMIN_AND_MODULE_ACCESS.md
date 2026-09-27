# User administration & Module Access (2026-09-27)

## Creating accounts — SMS invites, no admin passwords

**People → All Users → + ADD USER** (SUPER_ADMIN / ADMIN, rank 3). Types:

| Type | What is created |
|---|---|
| Individual client | `users` row, role `individual`, tier `lite` |
| Service-provider agency | Same scaffolding as Pro Management → Create organization (`agents` company ACTIVE + coverage profile) |
| CPO agent | Same as Pro Management → Create CPO under the chosen agency (born ACTIVE) |

Every account is born a **pending invite**: `password_hash` NULL, `invited_at`,
`invite_expires_at` = +14 days. An SMS tells the person to install the app and
**sign up with that phone number**. In the normal signup flow the OTP proves the
phone and `registerVerify` **claims** the pre-configured row (they set their own
password; role, tier and agency membership stay as provisioned). No app release
was needed for this.

- Until claimed, the account cannot log in (`login()` refuses a NULL password).
- The user's page shows **Invitation pending / expired** with **Resend SMS**
  (extends 14 days).
- If Twilio is not configured (App Configuration → Integrations) creation still
  succeeds; the console says the SMS was not sent — tell the person to sign up
  with that number.
- An email or phone already in use → refused (`user_already_exists`).
- Endpoints: `POST /ops/users`, `GET /ops/users/:id/invite`,
  `POST /ops/users/:id/invite/resend`. Audited (`user.create`, `user.invite.resend`).
- Pro Management's own create-org / create-CPO (admin types a temp password)
  are unchanged and still work.

**Suspend / Restore / Erase** stay on the user's page (Erase = rank 3). Agency
and agent pages link to it via **ACCOUNT RECORD →**.

## Module Access

**App Configuration → Module Access** (rank 3). Groups are derived from the same
facts `/auth/me` routes on: `cpo`, `agency` (owner or delegated manager),
`enterprise` (individual who owns or belongs to a workspace), else `individual`.
Corporate is not a separate role (folded into Enterprise, July 2026).

| Module | Groups | Off blocks (server, 403 `module_disabled`) |
|---|---|---|
| Secure Transfer | individual, enterprise | New bookings |
| Executive Protection | individual, enterprise | New executive-protection bookings |
| Secure Pro | individual, enterprise | New applications / renewals / accept / activate / missions, new protection sessions |
| GeoRisk (VBG) | individual, enterprise | Monitoring enrolment, SRA, threats, key points, new geofences |
| Linked Members | individual, enterprise | `/family` |
| Bravo Feed | all | `/news` |
| Departmental | enterprise, agency, cpo | `/department`, `/attendance`, `/attendance/roster`, `/incidents`, `/org/workspace` |
| Job Portal | agency | open-jobs list + claim |

**Safety rule (pinned by `module-access.binding.spec.ts`):** off blocks
*starting* new use only. Never gated: SOS, VBG panic / heartbeat / biometric
check-in / telemetry / tracking / status, and in-flight protection-session
endpoints (current, readiness, locations, end). Wallet is always on.

- Resolution: user override → group switch → **enabled**. Empty tables = the
  pre-feature behaviour. A module is never gated for a group it doesn't apply to.
- Per-user overrides: the **Access** card on a user's page (Group / ON / OFF).
- Propagation: per-user result cached 30 s in Redis under a key that embeds the
  matrix version; a matrix edit invalidates everyone at once, an override edit
  that one user. Fails **open** on DB/Redis errors (JWT auth still applies).
- `/auth/me` now returns `module_group` and `disabled_modules` for the app.
- Endpoints: `GET /ops/module-access`, `PUT /ops/module-access/groups/:group/:module`,
  `GET|PUT /ops/module-access/users/:userId[/:module]`. Audited.

## Deploy

Apply `supabase/migrations/20260927130000_user_invites_and_module_access.sql`
(adds 3 nullable `users` columns, a partial index, and two RLS deny-all tables).

## Not done yet

- **Mobile hiding**: the app must read `disabled_modules` and hide those tiles,
  and show a friendly message on 403 `module_disabled`. Needs an app build;
  older apps get the server block only.
- **Messenger** (separate messenger-service) is listed as "not controllable yet".
