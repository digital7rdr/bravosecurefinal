# bravosecure.cloud — upgrade + data cutover plan (prepared 2026-09-28)

Status: **PLAN — nothing below has been run.** Every step that changes the
server waits for the owner's explicit confirmation.

## What is on the box today (read-only discovery, 2026-09-28)

| Piece | State |
|---|---|
| App | `/opt/bravo` = `digital7rdr/bravosecure-main` @ `9ea4a5b` (12 Sep): auth, messenger, ops-console, redis, minio, coturn via `deploy/production/docker-compose.prod.yml` |
| Database | self-hosted Supabase `/opt/supabase` (Postgres 17.6). 26 MB, 115 public tables, 159 migrations in `_bravo_migrations`. **2 test users, 1 admin, no bookings, messages or files.** |
| Edge | Caddy, Let's Encrypt certs for auth / relay / ops / media / api / turn `.bravosecure.cloud`; DNS already points here |
| coturn | restart-looping since install (`--no-loopback-peers` unsupported in 4.6; cert never copied) |
| Access | root + password over SSH, no keys |
| Other | nothing else hosted (no other sites, panels or databases) |

Real data lives in the **hosted Supabase project `qkkfkicgoncxslbwhyhz`**,
used by the current app builds through the old staging API (sslip.io).

## What gets removed / replaced / kept

| Item | Action |
|---|---|
| `/opt/bravo` checkout (bravosecure-main @ 9ea4a5b) | **replaced** by bravosecurefinal @ the reviewed commit; old commit kept as tag `pre-20260928` |
| Images `bravo/{auth-service,messenger-service,ops-console}:prod` | **rebuilt**; current ones retagged `:pre-20260928` for rollback |
| coturn container | **recreated** with the fixed flags |
| VPS database contents (2 test users, 1 admin) | **replaced** by the hosted data at cutover (Phase 3) — backed up first |
| `/opt/supabase` stack, its `.env`, JWT keys | kept |
| Caddy config + certificates | kept |
| `deploy/production/.env*`, `secrets/` (Firebase SA, coturn certs) | kept; `.env.auth` gains `SETTINGS_ENCRYPTION_KEY` and `PUBLIC_BASE_URL` (added only if absent) |
| MinIO / Redis volumes | kept |
| ufw rules, monarx agent, OS | kept |

## Phase 0 — prerequisites (owner)

1. `npm install`, then `git push` of the merge commit from the Mac. Record the
   commit hash as `REV` (goes into every command below).
2. Hosted row counts (`hosted-supabase-counts.sql`) — the reference for
   verifying the copy.
3. Decide timing (see "Open decisions").

## Phase 1 — backups (read-only for the app; writes only under /root/backups)

```bash
ssh root@31.97.126.211
B=/root/backups/2026-09-28 && mkdir -p $B && chmod 700 $B
docker exec supabase-db pg_dumpall -U postgres --clean > $B/vps-pg_dumpall.sql
tar -C /opt/bravo/deploy/production -czf $B/bravo-env-and-secrets.tgz .env .env.auth .env.messenger secrets
tar -C /opt -czf $B/supabase-config.tgz supabase/.env supabase/docker-compose.yml supabase/volumes/api supabase/volumes/db/*.sql
tar -C /etc -czf $B/caddy.tgz caddy
docker run --rm -v bravo_minio-data:/d -v $B:/b alpine tar -C /d -czf /b/minio-data.tgz .
for s in auth-service messenger-service ops-console; do docker tag bravo/$s:prod bravo/$s:pre-20260928; done
git -C /opt/bravo tag pre-20260928 9ea4a5b
ls -la $B
```

Copy off the box (backup destination outside the cleanup scope — the Mac):

```bash
# on the Mac
scp -r root@31.97.126.211:/root/backups/2026-09-28 "bravo-backups/vps-2026-09-28/server-backup"
```

## Phase 2 — deploy the merged code (app containers restart ~1–2 min)

```bash
# Mac: send the reviewed revision (no GitHub credentials needed on the box)
git bundle create /tmp/bravo.bundle main && scp /tmp/bravo.bundle root@31.97.126.211:/root/

# box
cd /opt/bravo
git fetch /root/bravo.bundle main:refs/remotes/final/main
git checkout -B main $REV
cd deploy/production
SKIP_PULL=1 bash deploy.sh                    # builds + rolls auth, messenger, ops; health-checks
bash setup-supabase.sh                        # applies the 30 newer migrations to the current DB
./sync-turn-certs.sh && docker compose -f docker-compose.prod.yml up -d coturn
( crontab -l 2>/dev/null; echo '17 4 * * * /opt/bravo/deploy/production/sync-turn-certs.sh' ) | crontab -
```

Verify: `docker compose -f docker-compose.prod.yml ps` all healthy (coturn
running, not restarting); `https://auth.bravosecure.cloud/health` 200; ops
login page loads; `docker logs bravo-coturn` shows the TLS listener on 5349.

## Phase 3 — data cutover (maintenance window)

Order matters: the hosted project keeps receiving writes from the current
app until the apps switch, so the **final** copy must be taken while the old
staging API is stopped — otherwise the VPS copy is older than production.

1. **Dry run first, in isolation** (no downtime): a throwaway
   `supabase/postgres:17.6.1.136` container on its own Docker network, no
   published ports. `pg_dump` the hosted project into it (the connection
   string is typed at a hidden prompt on the box — never stored in a file,
   script, log or Git), then compare row counts with the hosted counts, check
   foreign keys, and run the two new migrations against it. Destroy it.
2. Freeze writes on the old path: stop the old staging API
   (`94.136.184.52`) or put it in maintenance.
3. Final `pg_dump` of hosted `public` + `storage` schemas.
4. Stop `bravo-auth`, `bravo-msgr`, `bravo-ops`.
5. Restore into `supabase-db`: replace the `public` schema with the hosted
   one; record every migration the hosted DB already has in
   `_bravo_migrations`; `setup-supabase.sh` applies the rest.
6. Clear `auth_totp_secrets` / `auth_totp_backup_codes`: seeds sealed with the
   old server's `TOTP_ENCRYPTION_KEY` cannot be opened here — every user
   enrols an authenticator on first sign-in.
7. Files: copy the `avatars` and `kyc` buckets object-by-object through the
   Storage API (keeps object rows consistent), and the auth-service
   `uploads/` directory from the old staging server if it holds KYC files.
8. Start the app containers; verify (below).
9. Point the apps at production: new mobile build (see "Mobile").

Everyone signs in again after cutover (new JWT secrets), and users enrol
an authenticator app at that first sign-in.

## Phase 4 — security clean-up

- Rotate the Postgres superuser password and the Redis password (both
  appeared in a discovery output on 2026-09-28): update `/opt/supabase/.env`
  + Supabase roles, `.env.auth` / `.env.messenger` / `.env`, restart.
- SSH: add the owner's public key, confirm key login works in a second
  session, then set `PasswordAuthentication no`.

## Verification (after Phases 2 and 3)

- health: auth 200, relay `/envelopes` 401 unauthenticated, ops redirects to
  `/login`, api `/rest/v1/` 401 without a key, media `/minio/health/live` 200
- first admin sign-in enrols TOTP (QR + backup codes) and reaches the dashboard
- row counts per table = hosted counts; FK check clean; spot-check a user,
  booking, mission, notification
- an avatar and a KYC document open from the console
- TURN: calls between two phones on different mobile networks
- push: FCM wake on Android (Firebase service account unchanged)

## Rollback

- Code: `git -C /opt/bravo checkout -B main pre-20260928`; retag
  `bravo/*:pre-20260928` → `:prod`; `docker compose -f docker-compose.prod.yml up -d`.
- Database: `docker exec -i supabase-db psql -U postgres < $B/vps-pg_dumpall.sql`.
- Env/secrets: restore `bravo-env-and-secrets.tgz`.
- The hosted Supabase project is never written to, so the cutover can be
  repeated from it at any time.

## Mobile (separate from the VPS deploy)

The server runs `AUTH_SECOND_FACTOR=totp`. The app does not yet handle the
TOTP login response (`secondFactor`, `challengeId`, enrolment payload), so a
production app build needs that screen **and** the production endpoints
(`eas.json` → `production` / `production-apk`, or `npm run apk:prod:mac`
with `config/production.env` from `scripts/pull-prod-client-env.sh`). No
store upload without the owner's instruction.

## Open decisions

1. Data timing: dry run now + final copy when the new app build ships
   (recommended), or copy now and accept that later hosted writes are not on
   the VPS.
2. Files outside hosted Supabase: does the old staging server
   (`94.136.184.52`) hold KYC uploads or encrypted attachments (R2/MinIO)
   that must come across?
3. Maintenance window for Phase 3.
4. Phase 4 password rotation and SSH key-only login: yes / later.
