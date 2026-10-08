#!/usr/bin/env bash
# android-sync-native.sh — put the hand-written Android sources back into the
# generated android/ tree (2026-10-08).
#
# WHY: android/ is gitignored and `expo prebuild` regenerates it from Expo's
# templates. Eleven of its files are hand-maintained (signing config +
# versionCode in app/build.gradle, the foreground-service declarations in the
# manifest, Mapbox download token wiring in build.gradle, notification icon,
# colours, Firebase config) and twenty Kotlin modules are hand-written. None
# of that survives a prebuild, and none of it was in git until this commit —
# a fresh clone could not produce the shipped app.
#
# `native/android/` is the source of truth:
#   native/android/com/bravosecure/app/*.kt   → android/app/src/main/java/com/bravosecure/app/
#   native/android/overlay/**                 → android/**   (same relative paths)
#
# Usage (from the repo root, after `npx expo prebuild --platform android`):
#   bash scripts/android-sync-native.sh            # copy native → android
#   bash scripts/android-sync-native.sh --check    # exit 1 if they differ (CI / pre-commit)
#   bash scripts/android-sync-native.sh --reverse  # copy android → native after editing in android/
set -euo pipefail
cd "$(dirname "$0")/.."
SRC=native/android
DST=android
MODE="${1:-sync}"

pairs() {
  local f
  for f in "$SRC"/com/bravosecure/app/*.kt; do
    printf '%s\t%s\n' "$f" "$DST/app/src/main/java/com/bravosecure/app/$(basename "$f")"
  done
  (cd "$SRC/overlay" && find . -type f) | sed 's|^\./||' | while read -r rel; do
    printf '%s\t%s\n' "$SRC/overlay/$rel" "$DST/$rel"
  done
}

status=0; n=0
while IFS=$'\t' read -r src dst; do
  n=$((n+1))
  case "$MODE" in
    --check)
      if [ ! -f "$dst" ]; then echo "MISSING  $dst"; status=1
      elif ! cmp -s "$src" "$dst"; then echo "DIFFERS  $dst"; status=1; fi ;;
    --reverse)
      if [ -f "$dst" ] && ! cmp -s "$dst" "$src"; then cp "$dst" "$src"; echo "native ← $dst"; fi ;;
    sync|*)
      mkdir -p "$(dirname "$dst")"
      if [ ! -f "$dst" ] || ! cmp -s "$src" "$dst"; then cp "$src" "$dst"; echo "android ← $src"; fi ;;
  esac
done < <(pairs)

case "$MODE" in
  --check) [ $status -eq 0 ] && echo "android/ matches native/android ($n files)." || { echo "Run: bash scripts/android-sync-native.sh"; exit 1; } ;;
  --reverse) echo "native/android updated from android/ ($n files checked). Commit native/android." ;;
  *) echo "android/ synced from native/android ($n files)." ;;
esac
