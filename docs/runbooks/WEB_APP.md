# Bravo Web App (2026-10-03)

Messenger and online booking in the browser at **https://web.bravosecure.cloud**,
for everyone with a Bravo Secure account.

| Who | What they get |
|---|---|
| Client account (`account_kind='individual'`, not an agency manager) | Chats, Book (Lite + Executive), My bookings, Secure Pro, Account |
| Officer, agency, agency manager | Chats and Account only |

The server stays the gate for every booking call; the pages only hide what an
account cannot use.

## Sign-in

Same phone number, password and authenticator code as the app
(`AUTH_SECOND_FACTOR=totp`). An account that has not enrolled an authenticator
is shown the enrolment QR on first sign-in. An officer invite that still needs
its first password is told to finish that in the app.

Linking the browser by scanning a QR code with the phone (like WhatsApp Web)
comes later, with an app release that can scan it.

## Messenger

The same end-to-end encrypted Messenger as the app and the consoles: Signal
sessions, Sealed Sender, the same relay. The browser is its own device with its
own keys, kept in this browser's vault behind the messenger passphrase, so:

- it receives messages sent after it was set up; older history stays on the phone;
- people are found by their exact phone number only (`POST /users/lookup`,
  throttled 20 per 10 minutes, matches only, blocked users never shown);
- text only for now (attachments, calls and voice notes stay in the app);
- signing out deletes the vault from the browser.

## Booking and payment

- **Lite (secure transfer):** pick-up and drop-off on the map or by address,
  start time, duration (the server's own duration rule), passengers, officers,
  vehicles, add-ons.
- **Executive protection:** location, start, 3–24 hour blocks, task, add-ons,
  optional secure-transfer leg.
- **Secure Pro:** request a plan, read the proposal, accept, activate with
  credits, ask for protection dates, message the Bravo Secure team.
- **Payment:** Bravo credits already in the wallet only. There is no card
  top-up on the web (Stripe is off); clients top up in the app.
- With auto dispatch on, a booking goes to `POST /dispatch/request` (provider
  search starts at once; credits are held when a provider accepts; location and
  terms consent required). Otherwise `POST /bookings` files it for HQ approval
  and the client pays from My bookings once approved
  (`/bookings/:id/pay-with-credits`, key `paywc-<id>`).
- Every create carries one Idempotency-Key per submitted form, reused on retry.
- First booking needs the ID document (Account page; JPEG/PNG up to 4 MB).

## How it is built

- **Same ops-console container.** The middleware serves `src/app/web/*` when
  the host is `web.*`, under clean paths (`/bookings`). The internal `/web/*`
  paths return 404 on every host, and the ops legacy redirects skip this host.
- **Own session.** Requests from a `WEB_APP_ORIGINS` origin use the
  `bravo_web_token` / `bravo_web_csrf` / `bravo_web_refresh` cookies.
- **CSRF.** A web cookie session must send `X-CSRF-Token` (the `bravo_web_csrf`
  value) on every non-GET request; `JwtAuthGuard` refuses it otherwise. This
  matters because the web app uses the mobile routes (bookings, wallet,
  Secure Pro), which were built for Bearer callers and carry no CsrfGuard. The
  app (Bearer) and the two consoles are unchanged.
- Session refresh ahead of expiry; sign-out after 30 minutes idle.

## Deploying

1. DNS: `A web.bravosecure.cloud → 31.97.126.211`.
2. `/opt/bravo/deploy/production/.env.auth`:
   ```
   CORS_ALLOWED_ORIGINS=https://ops.bravosecure.cloud,https://provider.bravosecure.cloud,https://web.bravosecure.cloud
   WEB_APP_ORIGINS=https://web.bravosecure.cloud
   ```
3. `/opt/bravo/deploy/production/.env.messenger`:
   ```
   CORS_ORIGINS=https://ops.bravosecure.cloud,https://provider.bravosecure.cloud,https://web.bravosecure.cloud
   ```
4. Caddy: add the `web.bravosecure.cloud` block from
   `deploy/production/Caddyfile`, then `caddy validate` and `systemctl reload caddy`.
5. No database migration.
6. Rebuild auth-service, messenger-service and ops-console with `deploy.sh`.
7. If the Mapbox token is URL-restricted, add `https://web.bravosecure.cloud`
   (the map and the address search use it).

Without steps 2–3 the page loads but sign-in and chats fail CORS; the consoles
and the app are unaffected.
