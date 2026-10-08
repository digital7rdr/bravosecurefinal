# Checked-in Android native sources

**These files are the source of truth. `android/` holds a generated copy.**

## Why this directory exists

Every `.kt` file here is hand-written Bravo code — custom React Native
modules, foreground services and the battery/ringtone/frame-cryptor
bridges. Until 2026-09-21 they existed **only** inside the generated
`android/app/src/main/java/com/bravosecure/app/` tree.

`android/` is gitignored (Expo regenerates it), so none of this was in
version control. `npx expo prebuild --clean` deletes `android/` outright,
which means one routine command would have destroyed roughly 82 KB of
hand-written native code with no copy anywhere.

The `.gitignore` rule was also unanchored — a bare `android/` matches at
_any_ depth, so it silently swallowed `native/android/` as well. It is now
`/android/`, matching only the generated tree at the repo root.

This mirrors what `native/ios/` has always done for the Swift/ObjC side
(see the B-111-B note in `.gitignore`).

## What is here

| File group                                                                                                          | What it is                                                                                    |
| ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `BravoMessageSyncModule.kt`, `MessageSyncForegroundService.kt`, `MessageSyncJobService.kt`, `ReactInstanceProbe.kt` | B-776/B-777/B-778 background-delivery lane (11 s → 0.5 s per background receive)              |
| `BravoFrameCryptorModule.kt` / `Package.kt`                                                                         | B-111-B SFrame call encryption, Android half of the parity contract                           |
| `CallForegroundService.kt`, `BravoCallForegroundModule.kt`                                                          | Call foreground service                                                                       |
| `BravoBatteryOptimizationModule.kt`                                                                                 | OEM battery / auto-start prompts (Xiaomi lane)                                                |
| `BravoRingtoneModule.kt`, `BravoCallVolumeModule.kt`, `BravoNetworkCountryModule.kt`                                | Ringtone, in-call volume, SIM country                                                         |
| `MainActivity.kt`, `MainApplication.kt`                                                                             | Template-derived; kept as a reference snapshot, since the plugin patches the regenerated copy |
| `AndroidManifest.reference.xml`                                                                                     | Snapshot of the manifest the services are declared in                                         |

## Keeping the two copies in sync — `scripts/android-sync-native.sh`

Since 2026-10-08 the copy step exists, and the nine hand-maintained
**non-Kotlin** files live here too, under `overlay/` at their `android/`-relative
paths (`build.gradle`, `gradle.properties`, `app/build.gradle` — signing config +
`versionCode`/`versionName` —, `app/proguard-rules.pro`, `app/google-services.json`,
`app/src/main/AndroidManifest.xml` — the foreground-service declarations and the
`ops.bravosecure.cloud` app link —, `res/values/colors.xml`, `res/values/styles.xml`,
`res/drawable/ic_stat_bravo.xml`). Before this, none of them was in git and a fresh
clone could not build the shipped app.

```bash
bash scripts/android-sync-native.sh            # native/android → android/   (after any prebuild)
bash scripts/android-sync-native.sh --check    # exit 1 when android/ drifted (run before committing)
bash scripts/android-sync-native.sh --reverse  # android/ → native/android  (after editing in android/)
```

Rules:

- Edit here **or** in `android/`, then run `--reverse` / `sync` so both match, and
  commit `native/android/`. `--check` is the guard.
- After `npx expo prebuild --platform android` (with or without `--clean`), run the
  sync before building: prebuild regenerates `app/build.gradle` and the manifest
  from Expo's templates and would otherwise drop the signing block and the
  services. `docs/runbooks/ANDROID_RELEASE.md` is the full build procedure.
- A new native file goes in here first; `android/` is still gitignored.

`AndroidManifest.reference.xml` is kept as a readable snapshot; `overlay/app/src/
main/AndroidManifest.xml` is the copy that is actually applied.

Two suites scan the generated paths and stay red in CI until CI runs a prebuild +
sync (CI checks out a tree with no `android/`):

- `src/modules/messenger/__tests__/frameCryptorParity.test.ts` (5 tests)
- `src/modules/messenger/__tests__/receiveHoldWiring.test.ts` (1 test)
