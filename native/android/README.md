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

## Keeping the two copies in sync — READ THIS

There is currently **no automatic copy step**. `plugins/withBravoAndroidPackages.js`
_registers_ the packages in the regenerated `MainApplication.kt`; it does not
create the module sources. So today:

- Edit native Android code in `android/…`, then copy the changed file here
  before committing, **or** edit here and copy into `android/…`.
- After any `expo prebuild --clean`, restore these files into
  `android/app/src/main/java/com/bravosecure/app/` before building.

The durable fix is a config plugin that copies `native/android/**` into the
generated tree at prebuild, exactly as the iOS plugins do for `native/ios/`.
That is not wired yet — it needs a real prebuild to validate, which is why
this README exists instead of a silent half-fix.

Two suites already scan the generated paths and will stay red in CI until
that copy step lands, because CI checks out a tree with no `android/` and
runs no prebuild:

- `src/modules/messenger/__tests__/frameCryptorParity.test.ts` (5 tests)
- `src/modules/messenger/__tests__/receiveHoldWiring.test.ts` (1 test)
