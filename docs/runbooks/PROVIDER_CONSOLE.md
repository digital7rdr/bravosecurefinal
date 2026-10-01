# Service Provider Console (Phase 1, 2026-10-01)

Web console for security agencies at **https://provider.bravosecure.cloud**.
Phase 1 covers Lite and Executive work: offers, jobs, crew, live tracking,
officers, managers and earnings. Vehicles, Secure Pro assignments and payout
statements are Phase 2 and need new provider APIs.

## Who can sign in

An account sees the console if it is either:

| Person | How the server recognises them |
|---|---|
| Agency owner | an ACTIVE `company` agent (the agency account itself) |
| Delegated manager | an active `org_members` row with `member_role='manager'` in an ACTIVE agency |

Everyone else (clients, officers, Enterprise workspace owners) is told that
the account has no provider access and is signed out again.
`GET /org/console/context` returns the list; it grants nothing by itself.

## What a manager can open

The owner grants modules per manager (Managers page here, or Manager
Permissions in the app). **The server enforces the grant** on every `/org/*`
and `/dispatch/*` call (`OrgModuleGuard`, `@OrgModules(...)`), not only the
screens. The owner always has everything.

| Console area | Module(s) | Routes |
|---|---|---|
| Offers | Missions or Job portal | `/dispatch/offers/*`, claim, return |
| Jobs, crew, dispatch, live, complete | Missions | `/org/missions*`, `/org/bookings/:id/crew` |
| Payment on a job | Missions or Earnings | `/org/bookings/:id/escrow` |
| Officers, invitations | Officer roster | `/org/cpos*`, `/org/invites*` |
| Earnings | Earnings | `/org/earnings` |
| Managers | owner only | `/org/managers*` |

`GET /org/cpos` also admits Departmental, Org chart, Messenger and Compliance,
because those app screens read the roster.

## How it is built

- **Same ops-console container.** The middleware routes by host name:
  `provider.*` serves `src/app/provider/*` under clean paths (`/jobs`), and
  the `/provider/*` paths return 404 on both hosts. Legacy ops redirects skip
  the provider host (`next.config.ts`).
- **Own session.** The auth-service reads the request Origin: the provider
  origin uses `bravo_pv_token` / `bravo_pv_csrf` / `bravo_pv_refresh`, every
  other origin keeps `bravo_ops_*`. Signing in to one console never replaces
  the other console's session in the same browser.
- **CSRF** is now required for cookie sessions on `/org/*` and `/dispatch/*`
  (the mobile app uses Bearer tokens and is exempt).
- Sign-in is the same phone + password + authenticator flow as the ops
  console (`components/SignInFlow.tsx`).

## First password for a new agency (no SMS)

Accounts made under People → Add user are invites. With SMS off nobody gets
the text, so a Super Admin creates the first password in the ops console:
Add user → **Create sign-in password** on the "Account created" screen, or
later on the user's page under Access → Invitation pending. The server makes
the password and shows it once; the admin passes it on privately. It only
works on a never-claimed invite (an account in use is never touched) and
never on HQ admin accounts; every issue is audited
(`user.invite.password_issued`, without the password).

The password is temporary (`password_set_at` stays NULL). The provider console
shows a banner until the owner changes it (top bar → Password); officers are
made to change it by the app.

## Deploying

1. DNS: `A provider.bravosecure.cloud → 31.97.126.211`.
2. `/opt/bravo/deploy/production/.env.auth`:
   ```
   CORS_ALLOWED_ORIGINS=https://ops.bravosecure.cloud,https://provider.bravosecure.cloud
   PROVIDER_CONSOLE_ORIGINS=https://provider.bravosecure.cloud
   ```
3. Caddy: add the `provider.bravosecure.cloud` block from
   `deploy/production/Caddyfile`, then `caddy validate` and `systemctl reload caddy`.
4. Rebuild auth-service and ops-console with `deploy.sh`.
5. If the Mapbox token is URL-restricted, add the provider origin to it.

Without step 2 the console loads but every API call fails CORS; the ops
console is unaffected either way.

## Also fixed in this change

- Ops console sign-out never revoked the session: `DELETE /auth/session` was
  sent without the required `deviceId` and failed validation.
- Ops console on a phone showed an empty page: the main area was pinned to a
  grid column that does not exist in the one-column phone layout.
