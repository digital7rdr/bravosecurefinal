# Mobile build env — where the Mapbox token lives (2026-09-27)

## What changed

GitHub push protection rejected the first push to
`digital7rdr/bravosecurefinal` because the Mapbox token
(`EXPO_PUBLIC_MAPBOX_TOKEN`, the client-public `pk.` token) was written inline
in five tracked files: `.env.production`, `eas.json` (three build profiles),
`package.json` (`apk:staging`, `apk:dist`) and `scripts/build-user-apk.ps1`.

It is a *public* token by Mapbox's design (it ships inside every APK/IPA),
but GitHub's scanner classifies it as a secret and blocks every push that
contains it. The project rule is "no environment secrets in git", so rather
than allow-listing it on GitHub the token was:

1. removed from all five files (this commit), and
2. **purged from git history** with `git filter-repo --replace-text`, which
   rewrote every commit — all SHAs before this note changed. The remote was
   empty at the time, so nothing downstream needed re-cloning.

## Where the token lives now

| Build path | Source of `EXPO_PUBLIC_MAPBOX_TOKEN` |
|---|---|
| `npm run apk:staging` / `apk:dist` / `apk:user` (local Gradle) | `.env.production.local` at the repo root — gitignored (`.env.*.local`). `@expo/env` loads it during `expo export:embed` with **higher** precedence than the tracked `.env.production`. |
| `eas build` (cloud) | An EAS environment variable, created once per environment (below). Gitignored files are not uploaded to EAS. |
| Local dev (`npm run android`, `.env`) | Unchanged — `.env` / `.env.local` as before. |

Every local release script now runs `node scripts/check-mapbox-token.mjs`
first and **fails** when the token is absent, because a build without it does
not error — `src/modules/maps/mapToken.ts` only logs once at bundle time and
every map surface renders the "misconfigured build" state (B-89 MG-04).

### `.env.production.local` (one line, never committed)

```
EXPO_PUBLIC_MAPBOX_TOKEN=pk.…
```

Copy the value from the Mapbox dashboard (Account → Tokens). Keep it
URL-/bundle-restricted there; rotate it there if it is ever leaked.

### EAS cloud builds (run once per environment, needs `eas login`)

```
eas env:create --scope project --environment production --visibility sensitive \
  --name EXPO_PUBLIC_MAPBOX_TOKEN --value "pk.…"
eas env:create --scope project --environment preview --visibility sensitive \
  --name EXPO_PUBLIC_MAPBOX_TOKEN --value "pk.…"
```

`production` covers the `production` profile; `preview` covers
`preview-staging`, `preview-local` and `preview-staging-device`
(`distribution: internal` profiles default to the preview environment).
Add `development` too if the dev-client profile ever needs maps.
`eas env:pull --environment production` writes it into `.env.local` for a
machine that has no `.env.production.local` yet.

### Not affected

- `MAPBOX_DOWNLOADS_TOKEN` (the `sk.` SDK-download token) was already
  env-only — see `app.config.js`.
- `EXPO_PUBLIC_SUPABASE_ANON_KEY` stays in the tracked files: it is the
  Supabase *anon* key, public by design and enforced by RLS.
- `GoogleService-Info.plist` stays tracked: Firebase's iOS config key is
  a project identifier, not a secret (security is Firebase rules + App Check).
