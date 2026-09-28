# OTP / SMS delivery and crash reporting (2026-09-28)

Two changes made together:

1. **OTP codes: Twilio Verify or Twilio SMS, chosen in the console.** The
   Twilio SMS path used to text an *empty* code; it now works.
2. **Crash reporting: Firebase Crashlytics + Analytics → Sentry protocol**
   (hosted Sentry or self-hosted GlitchTip). Firebase stays only for the push
   channel, App Check and the iOS path — see "What still uses Firebase".

WhatsApp and Unifonic were built on 2026-09-27 and removed on 2026-09-28 at
the owner's request; they never reached GitHub.

**Production (bravosecure.cloud) does not use SMS at all:** it runs
`AUTH_SECOND_FACTOR=totp` — an authenticator app is the second factor for
login, registration and vault-PIN reset (see `deploy/production/README.md`).
The Twilio modes below apply only where `AUTH_SECOND_FACTOR=sms` (the
default), e.g. the old staging server. Without Twilio, VBG alert texts and
ops invite SMS are not sent (they log "not sent"); share invites another way.

Nothing changes on a deployment until someone changes a setting: with no OTP
mode chosen the servers behave exactly as before (Twilio Verify when its SID
is set, otherwise Twilio SMS).

---

## Part 1 — OTP codes and SMS

### Where it is configured

Ops console → **Config → Integrations → Twilio** (SUPER_ADMIN):
Account SID · Auth token (secret) · From number · Verify service SID ·
**OTP delivery** (Twilio Verify / Twilio SMS) · **Send a test SMS**.

Values can also come from the deployment env (`TWILIO_*`,
`TWILIO_OTP_MODE`); a console value wins. Changes reach every auth-service
replica within ~15 s.

### How codes work per mode

| OTP delivery | Who generates / checks the code |
|---|---|
| Twilio Verify | Twilio (original behaviour) |
| Twilio SMS | auth-service; Twilio only delivers |

In SMS mode the auth-service generates the code and stores only an **HMAC of
it** in Redis (key derived from `JWT_ACTION_SECRET`, bound to the phone
number) for the OTP TTL (`OTP_TTL_MINUTES`, default 10). A code is
single-use, a new send replaces the previous code, and 5 wrong checks burn it
— the same budget Twilio Verify applies. If Redis is down a code is **not**
sent (fail closed); the per-number send cap still fails open as before.

VBG panic / missed check-in / geofence texts and ops invite texts always use
Twilio SMS (From number).

### Rollback

Set **OTP delivery** back to Twilio Verify (or clear it). Codes already sent
in SMS mode keep verifying until they expire — `check()` looks for a
server-held code first and only then asks Twilio.

---

## Part 2 — Crash reporting and the Firebase reduction

### Crashlytics → Sentry protocol

- `@react-native-firebase/crashlytics` and `@react-native-firebase/analytics`
  are removed; `@sentry/react-native ~7.2.0` (the version Expo SDK 54 pins) is
  added. `src/modules/observability/crashlytics.ts` keeps its name and exports
  so every call site and test mock is unchanged; it now forwards to
  `sentry.ts`.
- Redaction is unchanged (`redact.ts`), and `sentry.ts` scrubs the final event
  again: no default PII, no screenshots / view hierarchy, console breadcrumbs
  dropped, query strings stripped from HTTP breadcrumbs, user = pseudonymous id
  only. Performance tracing is off unless
  `EXPO_PUBLIC_SENTRY_TRACES_SAMPLE_RATE` is set.
- Product analytics is removed, not replaced. `trackEvent()` had no callers
  and now only leaves a breadcrumb.
- **Turning it on:** set `EXPO_PUBLIC_SENTRY_DSN` at build time
  (`.env.production.local` for local builds, an EAS environment variable for
  cloud builds — same pattern as the Mapbox token in `MOBILE_BUILD_ENV.md`).
  No DSN → reporting is off and the SDK is never loaded.
- **Sentry or GlitchTip:** both accept the same DSN format. GlitchTip can run
  on your own server if crash data must stay in-house.
- **Readable stack traces** need source maps uploaded per release (sentry-cli
  with an auth token). Not wired yet — reports work without it, with minified
  JS frames.

### Local Android builds (the gitignored `android/` folder)

The hand-maintained `android/` project applied the Crashlytics Gradle plugin
and linked `firebase-crashlytics` / `firebase-analytics`. Those lines were
removed on 2026-09-27; the originals are in
`bravo-backups/android-gradle-2026-09-27/`. EAS builds regenerate native
projects from `app.json`, where the Crashlytics plugin entry was removed.

**Run `npm install` before the next build** so `node_modules` matches
`package.json` (Sentry in, Crashlytics / Analytics out).

### Test distribution

- `npm run apk:internal` builds the `preview-staging-device` profile on EAS
  (`distribution: internal`) and prints an install link/QR for testers.
- iOS testers: TestFlight via `eas submit` — uploads to App Store Connect, so
  only on the owner's instruction.
- The old `npm run release` / `apk:dist` Firebase App Distribution path still
  works and stays until the QA group has moved to EAS links.

### What still uses Firebase

| Piece | Status | Why |
|---|---|---|
| FCM (Android) | **kept** | The only reliable way to wake a killed Android app for messages and calls. |
| FCM for iOS data pushes | kept for now | Moving iOS chat wakes to direct APNs needs a new iOS build and on-device testing; it would not remove Firebase (Android still needs it). |
| App Check | kept for now | messenger-service **enforces** App Check in production. A replacement (Play Integrity + App Attest) must ship in an app build before Firebase App Check is switched off. |
| iOS VoIP pushes | already direct APNs | unchanged |
