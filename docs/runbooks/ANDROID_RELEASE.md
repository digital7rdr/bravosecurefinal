# Android release — production APK for ops.bravosecure.cloud (2026-10-08)

Builds `com.bravosecure.app` **1.0.322 (versionCode 380)** on a Mac against the
Hostinger VPS (`auth.` / `relay.` / `api.bravosecure.cloud`). Companion to
`docs/handover/01a_LOCAL_APK_BUILD_GUIDE.md` (the general build reference) and
`deploy/production/README.md` §6 (server side).

## What changed for this release

| Area          | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sign-in       | One field accepts **email or phone (+country code)**; phone is sent as `phoneE164`, the same way the web app signs in.                                                                                                                                                                                                                                                                                                                                                                                                                |
| Sign-up       | Sign-up proves the phone with **one code**, then creates the account and **enrols the authenticator** on the same screens as first login. `REGISTER_PHONE_PROOF` in `.env.auth` picks the delivery: `stub` (**testing, current**: the code comes back in the API response and the app pre-fills it — "Test mode" is shown on the screen; nothing is sent) or `sms` (**go-live**: Twilio Verify; credentials in the ops console → Config → Integrations → Twilio: Account SID, Auth Token, Verify Service SID). Login never sends SMS. |
| Second factor | **Phone app: none** (`MOBILE_SECOND_FACTOR=none`, owner decision 2026-10-10) — password only at sign-in (`/auth/login` issues the session when the app sends `deviceId`+`platform`), phone code only at sign-up; optional **Biometric Lock** in Profile. The ops console / web app keep the authenticator (`AUTH_SECOND_FACTOR=totp`). With `MOBILE_SECOND_FACTOR=totp` the app's authenticator screens (enrol, 6-digit code, backup code) are used instead — they remain in the build.                                               |
| Errors        | `/auth/verify` failures are explained (`expired`, `attempts left`, `locked`, …) instead of "Request failed with status code 400".                                                                                                                                                                                                                                                                                                                                                                                                     |
| Endpoints     | `.env.production` → bravosecure.cloud. App-link host `ops.bravosecure.cloud`. Staging URLs survive only in the explicit `*:staging` scripts.                                                                                                                                                                                                                                                                                                                                                                                          |
| Build files   | The 9 hand-maintained Gradle/manifest/resource files and the 20 Kotlin modules are now **in git** under `native/android/` with `scripts/android-sync-native.sh` (they used to exist only on one machine).                                                                                                                                                                                                                                                                                                                             |
| Preflight     | `scripts/check-release-env.mjs` refuses a production build that would point at staging, lack the Mapbox token, the production Supabase anon key or the production sender-cert key.                                                                                                                                                                                                                                                                                                                                                    |

## 1. One-time machine setup (Mac)

```bash
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"   # JDK 17 or 21
export ANDROID_HOME="$HOME/Library/Android/sdk"
export PATH="$PATH:$ANDROID_HOME/platform-tools:$JAVA_HOME/bin"
"$JAVA_HOME/bin/java" -version && node -v        # 17.x/21.x, Node ≥ 20
export MAPBOX_DOWNLOADS_TOKEN="sk.…"             # Mapbox SDK download token (secret) — shell only, never a file in git
export RNMAPBOX_MAPS_DOWNLOAD_TOKEN="$MAPBOX_DOWNLOADS_TOKEN"   # what android/build.gradle reads (the sync restores the tracked gradle.properties, which must not hold it)
```

## 2. Values that only exist on the VPS → `.env.production.local`

`.env.production.local` is gitignored and already holds `EXPO_PUBLIC_MAPBOX_TOKEN`.
Add two lines — both printed by `deploy/production/make-env.sh` on the server
(or read `ANON_KEY` from `/opt/supabase/.env` and
`NEXT_PUBLIC_SENDER_CERT_PUBLIC_KEY_B64` from the ops-console env; the mobile key
is the **same** public key):

```
EXPO_PUBLIC_SUPABASE_ANON_KEY=eyJ…
EXPO_PUBLIC_SENDER_CERT_PUBLIC_KEY_B64=…=      # 44-char base64
```

Without the sender-cert key the bundle pins the _dev_ key and every messenger
sender certificate fails to verify against production. The preflight stops the
build when either is missing:

```bash
node scripts/check-release-env.mjs
```

## 3. Signing (optional for direct install, required for Play)

Without `BRAVO_UPLOAD_*` the APK is **debug-signed** — installable on any phone
and fine for QA / sideload, not accepted by Google Play and re-signable by anyone.
For a store-grade build export these before building (never in a tracked file):

```bash
export BRAVO_UPLOAD_STORE_FILE="$HOME/keys/bravo-upload.keystore"
export BRAVO_UPLOAD_STORE_PASSWORD='…' BRAVO_UPLOAD_KEY_ALIAS='bravo' BRAVO_UPLOAD_KEY_PASSWORD='…'
```

(`android/app/build.gradle` reads them via `findProperty` / `System.getenv`;
a `~/.gradle/gradle.properties` entry works too.)

## 4. Build

```bash
cd "~/Projects/Bravo Secure Final/Bravo_Secure-main"
npm ci                                              # if node_modules is stale
npx expo prebuild --platform android                # regenerates the gradle wrapper + template files (NO --clean)
bash scripts/android-sync-native.sh                 # puts the signing block, services, icons, Kotlin modules back
bash scripts/android-sync-native.sh --check         # must print "android/ matches native/android (29 files)."
npm run apk:release:mac                             # preflight + ./gradlew assembleRelease  (~10–20 min first time)
```

Output: `android/app/build/outputs/apk/release/app-release.apk`.
For a Play App Bundle instead: `npm run aab:release:mac` →
`android/app/build/outputs/bundle/release/app-release.aab`.

If `prebuild` asks to install CocoaPods or touches `ios/`, answer no — it is
Android-only here. If it complains that `android/` exists, that is expected; do
**not** pass `--clean` (it deletes the hand-written files; the sync script would
restore them, but you would also lose any local experiments).

## 5. Verify the APK before handing it out

```bash
APK=android/app/build/outputs/apk/release/app-release.apk
unzip -p "$APK" assets/index.android.bundle | grep -c 'auth.bravosecure.cloud'      # ≥ 1
unzip -p "$APK" assets/index.android.bundle | grep -c '94-136-184-52'               # 0
"$ANDROID_HOME/build-tools/"*/aapt dump badging "$APK" | grep -E "package:|versionCode"   # 1.0.322 / 380
adb install -r "$APK"
```

On the phone (needs the VPS deployment live and an account issued from the ops
console with a first sign-in password):

0. Sign up as a new client: phone → SMS code arrives (Twilio) → "Set up your
   authenticator" → code → signed in; the ops console shows the user with
   kyc `approved` (phone proven).
1. Sign in with **phone (+971…) or email** + password.
2. First time: "Set up your authenticator" → _Open in authenticator app_ (or copy
   the key into Google/Microsoft Authenticator) → save the backup codes → enter
   the 6-digit code → **Verify & Sign In**.
3. Sign out, sign in again → "Authenticator code" step only.
4. _Use a backup code_ → one of the saved codes signs in once.
5. Wrong code → "That code didn't work… 2 attempts left."; after the limit →
   "Too many attempts. Go back and sign in again."
6. Messenger: send a message to another production account (sender-cert key).
7. Map screen shows tiles (Mapbox token).

## 6. Not covered / known

- **No build was run from the Cowork VM** (no Android SDK there). TypeScript
  (46 pre-existing errors, baseline unchanged), ESLint on the touched files, and
  Jest (`store`, `screens/auth`, `services`, `navigation`: 70 suites / 832 tests,
  plus the two new suites) all pass.
- Profile-photo upload, wallet top-up and Sentry remain inert on the VPS
  (`deploy/production/README.md` §7).
- QR-code device linking for the web app is a later app release.
- `eas.json` `production` profile lacks `EXPO_PUBLIC_SUPABASE_ANON_KEY` and
  `EXPO_PUBLIC_SENDER_CERT_PUBLIC_KEY_B64`; add them as EAS env vars before any
  cloud build (`eas env:create --environment production …`).
- iOS: untouched by this change except that the shared JS gains the TOTP flow;
  `ios.buildNumber` not bumped.
