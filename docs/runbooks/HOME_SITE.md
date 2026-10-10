# Bravo Secure home site and single sign-on (2026-10-10)

**https://bravosecure.cloud** is the front door: sign-in, registration, and a
launcher with one tile per app. Signing in there once opens every app the
person is allowed to use.

| Tile                                                 | Opens                                                                                          | Who (default)                    |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------- |
| Secure Services                                      | clients → web.bravosecure.cloud/book · agency owners and managers → provider.bravosecure.cloud | clients, agencies                |
| Messenger                                            | web.bravosecure.cloud                                                                          | everyone                         |
| Control Console                                      | ops.bravosecure.cloud                                                                          | HQ staff, authenticator required |
| Enterprise Workspace, GeoRisk, Calendar, Vault, Meet | —                                                                                              | inactive (faded)                 |

A Super Admin changes all of this in the ops console under **Internal → Apps**
(active or not, address, agency address, who may open it, authenticator
required). The server checks those settings every time a tile is opened.

Kinds of account (decided by the server): **client** (personal account),
**officer** (an agency's CPO), **agency** (agency owner or delegated manager),
**ops** (an active ops console admin). One person can be several.

## Sign-in (AUTH_SECOND_FACTOR=adaptive)

Phone number + password, then:

- an account with an authenticator app → its 6-digit code;
- HQ staff, and any sign-in started on the ops console → must set one up;
- everyone else → a code by **SMS** (Twilio), or by **email** to a verified
  address when SMS is not configured.

If no code can be sent the sign-in stops with a clear message; it never
falls back to password only. `totp` (authenticator for everyone) still works
as before.

## Registration

Name, mobile number, email, password (10+ characters), terms. A code is
**texted** to the phone and another **emailed**; both must be entered (each is
accepted as soon as it is right). Only then is the account created, with both
marked verified, and the person is signed in. The authenticator app is offered
next and is optional (it is required for Control Console). An ops-created
invite for the same phone number is claimed instead of creating a duplicate.

Registration stays closed (the page says so) until **both** Twilio and email
are configured. Exception for testing: with `REGISTER_PHONE_PROOF=stub` (the
owner's 2026-10-09 setting until Twilio is connected) the phone code is not
texted but filled in on the page with a "Testing mode" notice — the phone is
then NOT verified. Email is always really sent. Set `REGISTER_PHONE_PROOF=sms`
before go-live.

App registration (the Android app) is unchanged: in `adaptive` mode it follows
the same flow as `totp` mode (phone proof, account, authenticator enrolment).

## Single sign-on: how an app is opened

1. The home site calls `POST /hub/launch {app}`. The server checks the app is
   active, the person may open it, and (Control Console) that their
   authenticator is on. It mints a one-time code (60 seconds, only its sha256
   is stored) bound to the person, the app and the app's exact address.
2. The browser goes to `https://<app>/sso#code=…`. The code is in the URL
   fragment, so it never reaches a server log. The app's `/sso` page removes it
   from the address bar and calls `POST /auth/sso/exchange` from its own
   origin. The code is consumed in one Redis command (it works once), the
   origin must match, access is checked again, and a **new session for that
   app** is issued with that app's own cookies.

Each app keeps its own session (`bravo_ops_*`, `bravo_pv_*`, `bravo_web_*`,
`bravo_hub_*`), so a home-site cookie is never an ops session. Signing out of
the home site does not sign out of apps already opened.

## Setting up email and SMS (ops console → Configuration → Integrations)

- **Email (SMTP):** server, port (465 SSL/TLS or 587 STARTTLS), security,
  username, password, From address. Use **Send a test email**.
- **Twilio:** Account SID, auth token, and a Verify service SID (or a From
  number for SMS mode). Use **Send a test SMS**.

Values saved there override the environment within about 15 seconds; secrets
are encrypted and never shown again.

## Deploying

1. DNS: `A bravosecure.cloud → 31.97.126.211` and
   `A www.bravosecure.cloud → 31.97.126.211`. Anything currently served at
   the bare domain is replaced by the home site.
2. `/opt/bravo/deploy/production/.env.auth`:
   ```
   CORS_ALLOWED_ORIGINS=…existing…,https://bravosecure.cloud
   HUB_ORIGINS=https://bravosecure.cloud
   ```
3. Caddy: add the `bravosecure.cloud` and `www.bravosecure.cloud` blocks from
   `deploy/production/Caddyfile`, then `caddy validate` and reload.
4. Migration `20261010100000_platform_hub.sql` with `migrate.sh`
   (adds `users.email_verified_at` / `phone_verified_at` and the
   `platform_apps` table with the eight tiles). Additive only.
5. Rebuild auth-service and ops-console with `deploy.sh`.
6. In the ops console, set Twilio and Email under Integrations and send a test
   of each. Registration stays closed until both work (or until email works,
   while `REGISTER_PHONE_PROOF=stub`).
7. Only then switch `.env.auth` to `AUTH_SECOND_FACTOR=adaptive` and restart
   the auth-service. Before the switch (`totp`), everyone must use an
   authenticator; after it, the authenticator is optional for non-staff. Do
   not switch first: accounts without an authenticator could not receive a
   code and could not sign in.

The home site has no map, so the Mapbox token needs no change.
