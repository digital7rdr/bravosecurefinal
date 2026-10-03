#!/usr/bin/env bash
#
# migrate.sh — apply NEW database migrations on the production server.
#     bash /opt/bravo/deploy/production/migrate.sh            # list pending, ask, apply
#     bash /opt/bravo/deploy/production/migrate.sh --check    # list pending only
#
# Same bookkeeping as setup-supabase.sh (public._bravo_migrations), but it
# touches nothing else: no secrets, no .env, no containers. Each pending file
# runs once, in name order, with ON_ERROR_STOP; the first failure stops the
# run and records nothing for that file. Already-applied files are skipped.
set -euo pipefail
say() { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }
ok()  { printf '  \033[32m✓\033[0m %s\n' "$*"; }
die() { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PSQL=(docker exec -i supabase-db psql -v ON_ERROR_STOP=1 -q -U postgres -d postgres)
docker inspect -f '{{.State.Running}}' supabase-db 2>/dev/null | grep -q true || die "supabase-db is not running"
"${PSQL[@]}" -tAc "SELECT to_regclass('public._bravo_migrations') IS NOT NULL" | grep -q t \
  || die "public._bravo_migrations missing — this database was not set up by setup-supabase.sh"

pending=()
for f in "$REPO"/supabase/migrations/*.sql; do
  name="$(basename "$f")"
  "${PSQL[@]}" -tAc "SELECT 1 FROM public._bravo_migrations WHERE filename='$name'" | grep -q 1 || pending+=("$f")
done

say "Pending migrations: ${#pending[@]}"
for f in "${pending[@]}"; do printf '  · %s\n' "$(basename "$f")"; done
[[ ${#pending[@]} -eq 0 ]] && { ok "database is up to date"; exit 0; }
[[ "${1:-}" == "--check" ]] && exit 0

read -r -p "Apply these now? Type APPLY: " ans
[[ "$ans" == "APPLY" ]] || die "nothing applied"

for f in "${pending[@]}"; do
  name="$(basename "$f")"
  printf '  → %s\n' "$name"
  "${PSQL[@]}" < "$f" || die "migration FAILED: $name — it was not recorded; nothing after it ran"
  "${PSQL[@]}" -c "INSERT INTO public._bravo_migrations(filename) VALUES ('$name')"
  ok "$name"
done
ok "${#pending[@]} applied"
