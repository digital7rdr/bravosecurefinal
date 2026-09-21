# CI/CD — Staging (Contabo) auto-deploy on push to `main`

**What it does:** every push to `main` that touches a backend/console service
rebuilds and restarts **only that service** on the Contabo staging box
(`94.136.184.52`), then verifies the container is healthy. Manual runs are
supported too.

This replaced the original `deploy-auth.yml` / `deploy-messenger.yml` /
`deploy-ops-console.yml` workflows, which targeted decommissioned infra
(AWS ECR + EC2, Vercel) and failed on every push.

---

## Moving parts

| File                                   | Role                                                                                                    |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `.github/workflows/deploy-staging.yml` | Trigger + changed-service detection + SSH deploy                                                        |
| `scripts/deploy-staging.sh`            | The actual deploy (rsync → `docker compose build` → `up -d` → health-check). Runnable by hand too.      |
| `docker-compose.staging.yml` (on box)  | Service definitions (`auth-service`, `messenger-service`, `ops-console`, `postgres`, `redis`, `coturn`) |

> **⚠️ `docker-compose.staging.yml` LIVES ON THE BOX, NOT IN THIS REPO.** Nothing
> in `git` can change it. The repo's own `docker-compose.yml` is local-dev only
> (its first line says so) and `infra/systemd/*.service` is the decommissioned
> EC2 path — edits to either are **inert for staging**. See
> [Box compose: required keys](#box-compose--required-keys-2026-09-03) below for
> the settings that must be added there by hand.

**Mechanism:** the runner checks out `main`, `rsync`s the changed service's
source into `~/bravo` on the box, then over SSH runs
`docker compose -f docker-compose.staging.yml build <svc> && up -d <svc>`.
The Docker build runs each service's own typecheck/build
(`next build` / `nest build`, `ignoreBuildErrors=false`), so **a broken commit
fails the build and the running container is left untouched — build gates deploy.**

---

## Box compose — required keys (2026-09-03)

**Status: OWED.** From `SECURE_SERVICES_E2E_AUDIT_2026-09-03.md` E2E-20 / E2E-21.
None of this can be delivered by a push: it has to be edited into
`~/bravo/docker-compose.staging.yml` on `94.136.184.52` and applied.

The two facts that make it urgent, together:

- **No container on the box has a memory or CPU limit.** One 4-vCPU / 8 GB host
  runs auth-service, messenger-service, ops-console, postgres, redis and coturn.
  An unbounded leak in any one of them is a host-wide OOM, and the kernel picks
  its victim by RSS — usually Redis, which takes every fenced sweep lock, the WS
  adapter and every live call with it.
- **`THROTTLE_ENFORCE` now defaults to `true` in code.** Global rate limiting was
  shadow-mode forever because that variable was set in no file anywhere; it is ON
  by default as of 2026-09-03. The escape hatch only exists if the key is
  _present_ on the box, so add it explicitly even at its default value.

### Per Node service — `auth-service` **and** `messenger-service`

```yaml
mem_limit: 1536m
memswap_limit: 1536m # EQUAL to mem_limit => swap disabled for this container
cpus: 1.5
environment:
  # V8 sizes its heap from HOST memory, not the cgroup: without a ceiling a
  # 1.5 GB container grows old space toward ~4 GB and is OOM-killed mid-GC
  # instead of throwing a recoverable heap error. ~2/3 of mem_limit.
  NODE_OPTIONS: '--max-old-space-size=1024'
  # 'false' for ONE deploy reverts to [throttle-shadow] log lines.
  THROTTLE_ENFORCE: 'true'
```

### `redis`

```yaml
mem_limit: 512m
memswap_limit: 512m
cpus: 0.5
# maxmemory BELOW the cgroup limit so Redis evicts on its own terms rather
# than being OOM-killed. Everything it stores here is a cache, a TTL'd sweep
# lock, a TTL'd idempotency slot or a pub/sub buffer — no durable money record.
command: redis-server --save '' --appendonly no --maxmemory 384mb --maxmemory-policy allkeys-lru
```

### `coturn`

```yaml
mem_limit: 512m
memswap_limit: 512m
cpus: 1.0
```

`network_mode: host` does **not** exempt a container from cgroup limits.

### Apply + verify

```bash
ssh admin@94.136.184.52
cd ~/bravo
docker compose -f docker-compose.staging.yml up -d
docker inspect -f '{{.Name}} mem={{.HostConfig.Memory}} cpu={{.HostConfig.NanoCpus}}' $(docker ps -q)
docker exec bravo-staging-auth printenv THROTTLE_ENFORCE NODE_OPTIONS
```

Every `mem=` / `cpu=` must be non-zero. A zero means the key did not land.

Budget: ~2 GB left for the host, the ops console and page cache; no service above
~1.5 GB, so one leak is a fast restartable kill instead of a host-wide OOM.

**Rollback lever:** if enforcement 429s real traffic, set `THROTTLE_ENFORCE: 'false'`
and `up -d` that service. The global bucket is a **DDoS backstop** (3000/min per
IP, and an IP is a whole office or CGNAT pool) — the real per-actor limits are the
per-user `@Throttle` decorators on routes binding `UserThrottlerGuard`. Do not
lower the global number to fix an abusive user; that punishes shared egress.

---

## One-time setup (required before the pipeline works)

Add the deploy SSH key as a repository secret:

1. Repo → **Settings → Secrets and variables → Actions → New repository secret**
2. Name: **`CONTABO_SSH_KEY`**
3. Value: the **private** key that authenticates `admin@94.136.184.52`
   — the full contents of `~/.ssh/bravo-staging.pem` (`-----BEGIN … END-----`).

Optional repository **variables** (only if the box moves): `BOX_HOST`,
`BOX_USER`, `BOX_DIR`.

> The public half of that key must be in
> `admin@94.136.184.52:~/.ssh/authorized_keys` (it already is — that's the key
> used for the current manual deploys).

---

## Triggers

- **Automatic:** push to `main` touching `apps/auth-service/**`,
  `apps/messenger-service/**`, `apps/ops-console/**`, `packages/messenger-core/**`,
  `docker-compose.staging.yml`, or the pipeline files. Only the affected
  service(s) redeploy (`packages/messenger-core` change → both messenger + ops).
- **Manual:** Actions → _Deploy to Contabo staging_ → _Run workflow_ → set
  **services** to `all` or a space-separated subset
  (`auth-service messenger-service ops-console`).

---

## Deploy by hand (same script the CI uses)

```sh
# from the repo root, with the pem key locally
SSH_KEY=~/.ssh/bravo-staging.pem scripts/deploy-staging.sh ops-console
SSH_KEY=~/.ssh/bravo-staging.pem scripts/deploy-staging.sh all
SSH_KEY=~/.ssh/bravo-staging.pem scripts/deploy-staging.sh auth-service ops-console
```

---

## Post-deploy smoke checks

```sh
curl -sf https://auth.94-136-184-52.sslip.io/auth/health          # {"ok":true,...}
curl -s -o /dev/null -w '%{http_code}\n' https://ops.94-136-184-52.sslip.io/   # 307 → /login when healthy
```

Container health on the box:

```sh
ssh -i ~/.ssh/bravo-staging.pem admin@94.136.184.52 \
  'docker ps --filter name=bravo-staging --format "{{.Names}}  {{.Status}}"'
```

---

## Rollback

The script backs nothing up itself; to roll back, deploy an earlier commit:

```sh
git checkout <good-sha> -- apps/<svc>          # or check out the whole tree
SSH_KEY=~/.ssh/bravo-staging.pem scripts/deploy-staging.sh <svc>
```

Or, on the box, the previous image layers are still present until pruned; a
manual `docker tag <old-image-id> bravo/<svc>:staging && docker compose -f
docker-compose.staging.yml up -d <svc>` restores the prior image.

---

## ⚠️ messenger-service precondition: `APP_CHECK_MODE` on the box (AUDIT #6)

Under `NODE_ENV=production` the push-token App Check gate
(`app-check.guard.ts`) **fails closed on every `/push/*` request** (both
register routes, both unregisters, AND `token-health` — the diagnostic
route is behind the same guard) when `APP_CHECK_MODE` is unset or
unrecognized — the service stays up; only those routes 401. The deploy
script verifies **in its preamble, before any rsync or build**, that the
box compose resolves `APP_CHECK_MODE` to a **recognized value**
(`warn-only|enforce|disabled`) **on the `messenger-service` block** — a
bare key, an empty/typo'd value, or the var on a different service all
block the deploy with the box left untouched (emergency override:
`ALLOW_APPCHECK_UNVERIFIED=1`, mirroring `ALLOW_STALE`). This gate covers
only this script: the rollback lane **above** and the box watchdog run
`up -d` directly and would boot the scoped fail-closed posture — logged at
boot and recurring 1/min at the rejection site
(`reason=app_check_mode_unset_prod`), so it survives log rotation.

One-time ops step (before the first messenger deploy after this lands):
SSH to the box and add to the `messenger-service` `environment:` block in
`docker-compose.staging.yml`:

```yaml
APP_CHECK_MODE: 'warn-only' # flip to 'enforce' once clients ship X-Firebase-AppCheck
```

`warn-only` is the current correct value — no shipped client sends the
header yet. Flip to `enforce` only when (1) clients ship the header and
(2) `/push/token-health` reports `fcmReady=true` — check it **while still
on `warn-only`** (once fail-closed, token-health itself 401s).

---

## ⚠️ Source-of-truth rule

The rsync uses `--delete`, so **`main` is authoritative**: any file living
under a service's dir on the box but not in `main` is removed on the next
deploy. **Commit server-side hotfixes to `main`** — don't hand-edit files
inside `~/bravo/apps/**` on the box and expect them to survive. (`.env*`,
`node_modules`, `.next`, `dist`, and `.git` are excluded from the sync, so
env/secret files on the box are never touched.)

---

## Not covered here

- **Supabase migrations** deploy via the separate `deploy-migrations.yml`
  (`supabase db push`), which needs `SUPABASE_ACCESS_TOKEN` /
  `SUPABASE_DB_PASSWORD` secrets.
- **Mobile** builds via EAS (`build-mobile.yml`), needs `EXPO_TOKEN`.
- **Prod** is out of scope — this pipeline is staging only.
