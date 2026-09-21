#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────
# db-migrate.sh — apply supabase/migrations/*.sql, and record what ran.
#
# WHY THIS EXISTS
#
# On 2026-09-01, deploying the regions batch, `exec_min_lead_hours` turned out
# to have NEVER been applied to staging. The runbook said it was deployed. The
# SQA register said it was deployed. Executive Protection's ops-configurable
# lead time had been running on its compiled fallback for a day, and any ops
# edit would have hit a CHECK constraint that did not know the key.
#
# Nobody was careless — there was simply no way to ask the question. Migrations
# are applied by hand with psql, and Supabase's own
# `supabase_migrations.schema_migrations` is written by Studio/CLI with its own
# timestamps, so it does not correspond to the files in this repo.
#
#   scripts/db-migrate.sh --check     # what is pending? (read-only, exit 1 if any)
#   scripts/db-migrate.sh --apply     # apply pending, in filename order
#   scripts/db-migrate.sh --baseline 20260830190000
#                                     # record every file <= that version as
#                                     # already applied, WITHOUT running it
#
# --apply REPLAYS FILES IN NAME ORDER. That is correct for a database that is
# behind, and WRONG for one that is already ahead by hand. Proven the first
# time this script was run: replaying 20260831180000 after 20260901130000
# re-installed the OLDER service_pricing key CHECK, which the two lead-time
# rows added by the newer migration then violated —
#   ERROR: check constraint "service_pricing_key_check" ... violated by some row
# The apply aborted and recorded nothing, which is the designed behaviour.
#
# If a migration is ALREADY applied by hand, record it with --baseline; do not
# let --apply re-run it. Only a migration that has genuinely never run belongs
# in the apply path.
#
# Environment:
#   BOX_HOST/BOX_USER/SSH_KEY   as scripts/deploy-staging.sh
#   PG_CONTAINER                default bravo-staging-pg
#
# The DATABASE_URL is read from the box's own docker-compose.staging.yml —
# never hard-coded here. The B-709 deploy nearly landed in the wrong database
# because the box runs a local `postgres` container that auth-service does NOT
# use; reading the compose is what caught it, so it is the only way this
# script resolves a target.
# ─────────────────────────────────────────────────────────────────────────
set -euo pipefail

BOX_HOST="${BOX_HOST:-94.136.184.52}"
BOX_USER="${BOX_USER:-admin}"
BOX_DIR="${BOX_DIR:-/home/admin/bravo}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/bravo-staging.pem}"
COMPOSE="${COMPOSE:-docker-compose.staging.yml}"
PG_CONTAINER="${PG_CONTAINER:-bravo-staging-pg}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIG_DIR="$REPO_ROOT/supabase/migrations"

SSH_OPTS=(-i "$SSH_KEY" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20 -o BatchMode=yes)
REMOTE="$BOX_USER@$BOX_HOST"

log()  { printf '\033[1;36m>> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m!! %s\033[0m\n' "$*"; }
fail() { printf '\033[1;31m!! %s\033[0m\n' "$*" >&2; exit 1; }

command -v ssh >/dev/null || fail "ssh not on PATH"
[[ -d "$MIG_DIR" ]] || fail "no migrations directory at $MIG_DIR"

MODE=""
BASELINE=""
case "${1:-}" in
  --check)    MODE=check ;;
  --apply)    MODE=apply ;;
  --baseline) MODE=baseline; BASELINE="${2:-}"; [[ -n "$BASELINE" ]] || fail "--baseline needs a version prefix" ;;
  *) fail "usage: $0 --check | --apply | --baseline <version>" ;;
esac

# One SSH round trip per psql call is slow but honest: every statement is
# visible in the transcript, which is what makes a migration run auditable
# after the fact.
psql_q() {
  ssh "${SSH_OPTS[@]}" "$REMOTE" \
    "cd '$BOX_DIR' && DBURL=\$(grep -m1 'DATABASE_URL' '$COMPOSE' | sed -E 's/.*\"(postgres[^\"]+)\".*/\1/') \
     && docker exec -i '$PG_CONTAINER' psql \"\$DBURL\" -v ON_ERROR_STOP=1 -tAc \"$1\""
}

# ── Is the ledger there yet? ──────────────────────────────────────────────
LEDGER_EXISTS=$(psql_q "SELECT to_regclass('public.applied_migrations') IS NOT NULL;" | tr -d '[:space:]')
if [[ "$LEDGER_EXISTS" != "t" ]]; then
  warn "public.applied_migrations does not exist yet."
  warn "Apply 20260901140000_migration_ledger_and_grant_hygiene.sql first, then"
  warn "seed it:  $0 --baseline 20260830190000"
  [[ "$MODE" == "check" ]] && exit 1
  fail "cannot proceed without the ledger"
fi

mapfile -t ALL_FILES < <(cd "$MIG_DIR" && ls -1 *.sql | sort)
[[ ${#ALL_FILES[@]} -gt 0 ]] || fail "no .sql files in $MIG_DIR"

APPLIED_RAW=$(psql_q "SELECT filename FROM public.applied_migrations;")
declare -A APPLIED=()
while IFS= read -r f; do
  f="$(echo "$f" | tr -d '\r')"
  [[ -n "$f" ]] && APPLIED["$f"]=1
done <<< "$APPLIED_RAW"

PENDING=()
for f in "${ALL_FILES[@]}"; do
  [[ -z "${APPLIED[$f]:-}" ]] && PENDING+=("$f")
done

# ── baseline ──────────────────────────────────────────────────────────────
if [[ "$MODE" == "baseline" ]]; then
  n=0
  for f in "${ALL_FILES[@]}"; do
    ver="${f%%_*}"
    [[ "$ver" > "$BASELINE" ]] && continue
    [[ -n "${APPLIED[$f]:-}" ]] && continue
    sum=$(sha256sum "$MIG_DIR/$f" | cut -d' ' -f1)
    psql_q "INSERT INTO public.applied_migrations (filename, checksum, source) \
            VALUES ('$f', '$sum', 'baseline') ON CONFLICT (filename) DO NOTHING;" >/dev/null
    n=$((n+1))
  done
  log "recorded $n file(s) at or below $BASELINE as 'baseline' (asserted, NOT run)"
  warn "a baseline row is an assertion, not a receipt — anything ABOVE $BASELINE"
  warn "is still unproven and will show as pending"
  exit 0
fi

# ── check ─────────────────────────────────────────────────────────────────
if [[ ${#PENDING[@]} -eq 0 ]]; then
  log "up to date — ${#ALL_FILES[@]} migration(s), none pending"
else
  warn "${#PENDING[@]} PENDING migration(s):"
  for f in "${PENDING[@]}"; do printf '     %s\n' "$f"; done
fi

# Grant drift — the other half of what went wrong on 2026-09-01. A new table
# inheriting anon/authenticated privileges is invisible until someone looks.
DRIFT=$(psql_q "SELECT count(DISTINCT g.table_name) FROM information_schema.role_table_grants g \
  WHERE g.table_schema='public' AND g.grantee IN ('anon','authenticated') \
    AND NOT EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname='public' \
      AND p.tablename=g.table_name AND (p.roles::text LIKE '%anon%' \
      OR p.roles::text LIKE '%authenticated%' OR p.roles::text='{public}'));" | tr -d '[:space:]')
if [[ "${DRIFT:-0}" != "0" ]]; then
  warn "GRANT DRIFT: $DRIFT table(s) grant anon/authenticated with no policy admitting them"
else
  log "grants clean — no policy-less table exposes anon/authenticated"
fi

if [[ "$MODE" == "check" ]]; then
  { [[ ${#PENDING[@]} -eq 0 ]] && [[ "${DRIFT:-0}" == "0" ]]; } || exit 1
  exit 0
fi

# ── apply ─────────────────────────────────────────────────────────────────
[[ ${#PENDING[@]} -eq 0 ]] && { log "nothing to apply"; exit 0; }

for f in "${PENDING[@]}"; do
  log "applying $f"
  sum=$(sha256sum "$MIG_DIR/$f" | cut -d' ' -f1)
  scp "${SSH_OPTS[@]}" "$MIG_DIR/$f" "$REMOTE:/tmp/$f" >/dev/null \
    || fail "could not copy $f to the box"
  # --single-transaction + ON_ERROR_STOP: a migration either lands whole or not
  # at all, so a half-applied file can never be recorded as applied.
  ssh "${SSH_OPTS[@]}" "$REMOTE" \
    "cd '$BOX_DIR' && DBURL=\$(grep -m1 'DATABASE_URL' '$COMPOSE' | sed -E 's/.*\"(postgres[^\"]+)\".*/\1/') \
     && docker exec -i '$PG_CONTAINER' psql \"\$DBURL\" -v ON_ERROR_STOP=1 --single-transaction -f /dev/stdin < /tmp/$f" \
    || fail "$f FAILED — nothing recorded; fix it and re-run"
  psql_q "INSERT INTO public.applied_migrations (filename, checksum, source) \
          VALUES ('$f', '$sum', 'applied') ON CONFLICT (filename) DO NOTHING;" >/dev/null
  log "  recorded $f"
done

log "applied ${#PENDING[@]} migration(s) ✓"

# ── post-apply assertions ────────────────────────────────────────────────
#
# A migration that "succeeded" is not the same as a migration that did what it
# said. 20260903120000 builds a UNIQUE index inside a DO block that, on finding
# pre-existing duplicates, RAISEs a WARNING and RETURNs — the run then exits 0,
# the ledger records the file as applied, and the COMMENT ON TABLE in the same
# file asserts a guard that is not there. A psql WARNING scrolls past in a deploy
# transcript; nobody reads it, and the next person reads the comment instead.
#
# So the objects a migration PROMISES are re-asserted here, by name, after the
# fact. Each entry is `<file-prefix>|<regclass>|<what it guards>`: checked only
# once its migration is recorded as applied, so this stays correct on a database
# that is legitimately behind. Add a row whenever a migration's whole point is
# one object.
ASSERT_OBJECTS=(
  "20260903120000|public.lite_bookings_one_active_per_client_uq|E2E-23 one-active-booking guard (build skipped => duplicate active bookings exist; see the migration's WARNING for the cleanup query)"
)

missing=0
for entry in "${ASSERT_OBJECTS[@]}"; do
  IFS='|' read -r prefix obj why <<< "$entry"
  # Only assert objects whose migration has actually run.
  ran=""
  for f in "${ALL_FILES[@]}"; do
    [[ "$f" == "$prefix"* ]] && { [[ -n "${APPLIED[$f]:-}" ]] && ran=1; break; }
  done
  # A file applied in THIS run is not in the APPLIED map read at start-up.
  for f in "${PENDING[@]}"; do [[ "$f" == "$prefix"* ]] && ran=1; done
  [[ -z "$ran" ]] && continue

  present=$(psql_q "SELECT to_regclass('$obj') IS NOT NULL;" | tr -d '[:space:]')
  if [[ "$present" != "t" ]]; then
    warn "POST-APPLY ASSERTION FAILED: $obj is MISSING"
    warn "  $why"
    missing=$((missing+1))
  else
    log "asserted $obj ✓"
  fi
done

[[ "$missing" -eq 0 ]] || fail "$missing promised object(s) missing after apply — the guard is NOT in place"
