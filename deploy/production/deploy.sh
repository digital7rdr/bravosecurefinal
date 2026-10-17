#!/usr/bin/env bash
#
# deploy.sh — pull the latest commit and roll the app containers, ON THE BOX.
#
#     cd /opt/bravo && bash deploy/production/deploy.sh            # everything
#     cd /opt/bravo && bash deploy/production/deploy.sh ops-console  # one service
#
# Infra containers (redis, minio, coturn) are left alone unless you name them —
# rolling Redis drops every live WebSocket, and rolling coturn drops every call.
# The env files are never touched: they are generated once by make-env.sh and
# re-running that would rotate JWT secrets out from under every signed-in device.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
COMPOSE="docker-compose.prod.yml"
APP_SERVICES=(auth-service messenger-service ops-console)

say()  { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
die()  { printf '  \033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

SERVICES=("${@:-${APP_SERVICES[@]}}")

say "Pre-flight"
for f in .env .env.auth .env.messenger; do [[ -f $f ]] || die "$f missing — run ./make-env.sh first"; done
grep -q 'PASTE_' .env .env.auth .env.messenger && die "unfilled PASTE_* placeholders remain in the env files" || ok "env files present, no placeholders"
case " ${SERVICES[*]} " in
  *" messenger-service "*) [[ -f secrets/firebase-service-account.json ]] || die "secrets/firebase-service-account.json missing (FCM push — only messenger-service mounts it)";;
esac
# totp = authenticator for everyone; adaptive (2026-10-10) = authenticator when
# set up (always for staff), otherwise a code by SMS (Twilio) or email (SMTP),
# both configured under Integrations in the ops console.
SECOND_FACTOR="$(grep -E '^AUTH_SECOND_FACTOR=' .env.auth | tail -1 | cut -d= -f2-)"
case "$SECOND_FACTOR" in
  totp|adaptive) ok "second factor: $SECOND_FACTOR";;
  *) die ".env.auth must set AUTH_SECOND_FACTOR=totp or adaptive — production refuses 'sms' unless Twilio is configured";;
esac

# 2026-09-28 — keys added after the first install. Appended ONLY when absent
# (never rotated): an existing box keeps every secret it already has.
ensure_env() {  # $1 file, $2 key, $3 value
  grep -qE "^$2=" "$1" || { printf '\n%s=%s\n' "$2" "$3" >> "$1"; ok "$1: added $2"; }
}
ensure_env .env.auth SETTINGS_ENCRYPTION_KEY "$(openssl rand -base64 32)"
ensure_env .env.auth PUBLIC_BASE_URL "https://auth.bravosecure.cloud"
# 2026-10-17 — group calls. Without these the SFU fails closed in production
# (no room is created, every join refused). Port range = the messenger-service
# ports published in docker-compose.prod.yml. The token secret is generated
# here, on the box, and never printed.
ensure_env .env.messenger SFU_ANNOUNCED_IP "31.97.126.211"
ensure_env .env.messenger SFU_LISTEN_IP "0.0.0.0"
ensure_env .env.messenger SFU_RTC_MIN_PORT "40000"
ensure_env .env.messenger SFU_RTC_MAX_PORT "40099"
ensure_env .env.messenger SFU_ROOM_TOKEN_SECRET "$(openssl rand -base64 36 | tr -d '\n/+=' | head -c 48)"

say "Update source"
before="$(git -C ../.. rev-parse --short HEAD)"
# SKIP_PULL=1 — the revision was placed by hand (e.g. fetched from a git
# bundle copied over SSH, when the box has no GitHub credentials). Deploy
# exactly what is checked out.
if [[ "${SKIP_PULL:-0}" == "1" ]]; then
  ok "pull skipped (SKIP_PULL=1) — deploying the checked-out revision"
else
  git -C ../.. pull --ff-only
fi
after="$(git -C ../.. rev-parse --short HEAD)"
ok "$before → $after"

case " ${SERVICES[*]} " in *" coturn "*) ./sync-turn-certs.sh || die "coturn cert not available";; esac

say "Build + roll: ${SERVICES[*]}"
docker compose -f "$COMPOSE" build "${SERVICES[@]}"
docker compose -f "$COMPOSE" up -d "${SERVICES[@]}"

say "Health (waiting up to 90s)"
for i in $(seq 1 18); do
  sleep 5
  unhealthy="$(docker compose -f "$COMPOSE" ps --format '{{.Name}} {{.Health}}' | grep -vE 'healthy|^$' | grep -E "$(IFS='|'; echo "${SERVICES[*]}")" || true)"
  [[ -z "$unhealthy" ]] && break
done
docker compose -f "$COMPOSE" ps
[[ -z "${unhealthy:-}" ]] || die "still unhealthy after 90s:
$unhealthy
  logs:  docker compose -f $COMPOSE logs --tail=100 <service>"

case " ${SERVICES[*]} " in
  *" messenger-service "*)
    # Read first, then grep: under pipefail `docker logs | grep -q` reports the
    # writer's SIGPIPE, which would hide exactly the line being looked for.
    msgr_log="$(docker logs --since 3m bravo-msgr 2>&1 || true)"
    if grep -qE 'sfu_announced_ip_unconfigured|SFU_ANNOUNCED_IP is' <<<"$msgr_log"; then
      die "messenger: SFU refused to start (SFU_ANNOUNCED_IP) — group calls would fail"
    fi
    ok "messenger: SFU announced IP set (group calls)";;
esac
curl -fsS https://auth.bravosecure.cloud/auth/health >/dev/null && ok "auth: /auth/health 200"
[[ "$(curl -s -o /dev/null -w '%{http_code}' https://relay.bravosecure.cloud/envelopes)" == "401" ]] && ok "relay: 401 unauthenticated (alive)"
[[ "$(curl -s -o /dev/null -w '%{http_code}' https://ops.bravosecure.cloud/)" =~ ^30[27]$ ]] && ok "ops: redirects to /login"
say "Deployed $after"
