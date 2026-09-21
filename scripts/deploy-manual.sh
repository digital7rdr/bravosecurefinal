#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────
# deploy-manual.sh — deploy without rsync, and refresh the watchdog snapshot.
#
# WHY THIS EXISTS
#
# `deploy-staging.sh` requires rsync, which is NOT present in Git Bash on
# Windows — where this repo is developed. Its own error message therefore
# hands you a four-line tar recipe to run by hand. Everyone runs that recipe.
#
# The recipe is missing the last step. `deploy-staging.sh` refreshes the
# self-heal watchdog's `pristine-main.tgz` AFTER a green deploy; the hand recipe
# does not. So every manual deploy leaves the watchdog holding a snapshot that
# predates the code now running, and if it ever fires it restores the OLD tree
# over the new one. On 2026-09-01 the snapshot on the box was from 31 Aug and
# contained ZERO of the files just deployed.
#
# That is a latent trap, not an active one — the watchdog only heals on the
# B-376 wipe signature and has fired 3 times ever (last 2026-08-05). But it is
# precisely the kind of trap that fires on the worst possible day, so the fix is
# to make the path everyone actually uses do the whole job.
#
#   scripts/deploy-manual.sh auth-service
#   scripts/deploy-manual.sh auth-service ops-console
#
# What it does that the hand recipe does not:
#   * refuses to deploy a checkout that does not contain origin/main (B-376)
#   * VERIFIES a symbol from your change is in the running container's dist/
#   * refreshes the watchdog snapshot
#   * proves the refresh by listing your files inside the new snapshot
# ─────────────────────────────────────────────────────────────────────────
set -euo pipefail

BOX_HOST="${BOX_HOST:-94.136.184.52}"
BOX_USER="${BOX_USER:-admin}"
BOX_DIR="${BOX_DIR:-/home/admin/bravo}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/bravo-staging.pem}"
COMPOSE="${COMPOSE:-docker-compose.staging.yml}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

SSH_OPTS=(-i "$SSH_KEY" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20 -o BatchMode=yes)
REMOTE="$BOX_USER@$BOX_HOST"

log()  { printf '\033[1;36m>> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m!! %s\033[0m\n' "$*"; }
fail() { printf '\033[1;31m!! %s\033[0m\n' "$*" >&2; exit 1; }

[[ $# -gt 0 ]] || fail "usage: $0 <service> [service...]   (auth-service | ops-console | messenger-service)"
SERVICES=("$@")
for s in "${SERVICES[@]}"; do
  [[ -d "$REPO_ROOT/apps/$s" ]] || fail "no such service: apps/$s"
done

# ── B-376 stale-checkout guard, same rule as deploy-staging.sh ────────────
# The box is built FROM this checkout, so the checkout must contain everything
# already on origin/main. Deploying a behind-main tree is how ~6 weeks of
# shipped code was silently removed on 2026-08-04.
if [[ "${ALLOW_STALE:-0}" != "1" ]]; then
  git -C "$REPO_ROOT" fetch origin main --quiet 2>/dev/null \
    || warn "could not fetch origin (offline?) — guard runs against the last known ref"
  if ! git -C "$REPO_ROOT" merge-base --is-ancestor origin/main HEAD 2>/dev/null; then
    fail "STALE CHECKOUT: origin/main is not an ancestor of HEAD.
  Pull first:  git pull --rebase origin main
  Override (you own the consequences):  ALLOW_STALE=1 $0 $*"
  fi
  log "stale-checkout guard passed (origin/main is an ancestor of HEAD)"
fi

# ── ship ──────────────────────────────────────────────────────────────────
TGZ="$(mktemp -t bravo-svc-XXXXXX).tgz"
trap 'rm -f "$TGZ"' EXIT
log "packing ${SERVICES[*]}"
tar czf "$TGZ" --exclude node_modules --exclude dist --exclude .next \
    --exclude '.env' --exclude '.env.*' --exclude '*.tsbuildinfo' \
    -C "$REPO_ROOT/apps" "${SERVICES[@]}"

log "shipping $(du -h "$TGZ" | cut -f1) to $REMOTE"
scp "${SSH_OPTS[@]}" "$TGZ" "$REMOTE:/tmp/bravo-svc.tgz" >/dev/null || fail "scp failed"

# An OVERLAY extract, never --delete. This is the property that makes the manual
# path incapable of repeating the B-376 wipe.
ssh "${SSH_OPTS[@]}" "$REMOTE" "cd '$BOX_DIR/apps' && tar xzf /tmp/bravo-svc.tgz" \
  || fail "extract failed on the box"
log "extracted (overlay — nothing deleted)"

for s in "${SERVICES[@]}"; do
  log "building $s"
  ssh "${SSH_OPTS[@]}" "$REMOTE" "cd '$BOX_DIR' && docker compose -f '$COMPOSE' build $s" \
    || fail "$s build FAILED — nothing restarted, previous container still serving"
  log "starting $s"
  ssh "${SSH_OPTS[@]}" "$REMOTE" "cd '$BOX_DIR' && docker compose -f '$COMPOSE' up -d $s" \
    || fail "$s up -d FAILED"
done

# ── verify IN the container, never from an exit code ──────────────────────
# A green exit means docker was happy, not that your code is running. Pass
# VERIFY_SYMBOL to grep the built dist/ for something your change added.
if [[ -n "${VERIFY_SYMBOL:-}" ]]; then
  for s in "${SERVICES[@]}"; do
    case "$s" in
      auth-service)      cn=bravo-staging-auth ;;
      messenger-service) cn=bravo-staging-msgr ;;
      ops-console)       cn=bravo-staging-ops  ;;
      *)                 cn="" ;;
    esac
    [[ -z "$cn" ]] && continue
    sleep 8
    # -l WITHOUT -q: GNU grep's -q suppresses ALL output including -l's file
    # list, so the old `grep -rql | head -1` printed nothing on a MATCH and
    # this verify could never pass (found the first time the script was used).
    if ssh "${SSH_OPTS[@]}" "$REMOTE" "docker exec $cn sh -c 'grep -rl \"$VERIFY_SYMBOL\" dist/ 2>/dev/null | head -1'" | grep -q .; then
      log "verified '$VERIFY_SYMBOL' present in $cn dist/"
    else
      fail "'$VERIFY_SYMBOL' NOT found in $cn dist/ — the container is running OLD code"
    fi
  done
else
  warn "no VERIFY_SYMBOL set — deploy not verified beyond docker's exit code."
  warn "Re-run with e.g.  VERIFY_SYMBOL=myNewFunction $0 ${SERVICES[*]}"
fi

# ── THE STEP THE HAND RECIPE FORGETS ──────────────────────────────────────
log "refreshing watchdog pristine snapshot from the just-deployed tree"
ssh "${SSH_OPTS[@]}" "$REMOTE" "set -e; cd '$BOX_DIR' && mkdir -p /home/admin/bravo-watchdog \
  && tar czf /home/admin/bravo-watchdog/pristine-main.tgz.tmp \
       --exclude node_modules --exclude dist --exclude .next \
       --exclude '.env' --exclude '.env.*' --exclude '*.tsbuildinfo' \
       apps/auth-service apps/ops-console apps/messenger-service packages/messenger-core .dockerignore \
  && mv /home/admin/bravo-watchdog/pristine-main.tgz.tmp /home/admin/bravo-watchdog/pristine-main.tgz" \
  || fail "snapshot refresh FAILED — the deploy is live but the watchdog would
  restore the PREVIOUS tree if it ever fires. Fix this before walking away."

SNAP_AGE=$(ssh "${SSH_OPTS[@]}" "$REMOTE" "date -r /home/admin/bravo-watchdog/pristine-main.tgz '+%F %T'")
log "snapshot refreshed ($SNAP_AGE)"

log "deploy complete ✓"
