#!/usr/bin/env bash
# Tests for scripts/toolchain-diff against fake system generations.
# Pure: no network, writes only to a temp dir.
# Run: bash tests/toolchain_diff_test.sh
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
hash=0123456789abcdfghijklmnpqrsvwxyz
fail=0

# system <name> <tool>=<store-name>...: a fake generation whose per-user
# profile links each tool into a fake store dir, like nix-darwin's.
system() {
  local sys="$tmp/$1" spec tool store
  shift
  mkdir -p "$sys/etc/profiles/per-user/u/bin"
  for spec in "$@"; do
    tool="${spec%%=*}" store="$tmp/store/$hash-${spec#*=}"
    mkdir -p "$store/bin" && touch "$store/bin/$tool"
    ln -s "$store/bin/$tool" "$sys/etc/profiles/per-user/u/bin/$tool"
  done
}

# check <name> <old> <new> <expected stderr>
check() {
  local got code=0
  got="$(bash "$repo/scripts/toolchain-diff" "$tmp/$2" "$tmp/$3" u 2>&1 >/dev/null)" || code=$?
  if [ "$code" = 0 ] && [ "$got" = "$4" ]; then
    echo "ok   $1"
  else
    echo "FAIL $1 (exit $code)"
    printf '  want: %s\n  got:  %s\n' "$4" "$got"
    fail=1
  fi
}

hint=$'  Repos that pin exact versions or rely on old behavior may break.\n  Run their checks, or pin the toolchain per repo (packageManager, engines, devShell).'
system before node=nodejs-slim-22.23.2 pnpm=pnpm-11.22.0
system after node=nodejs-slim-22.23.3 pnpm=pnpm-12.9.0
system same node=nodejs-slim-22.23.2 pnpm=pnpm-11.22.0
system nopnpm node=nodejs-slim-22.23.2

check "10 Oct bump warns, major flagged" before after \
  "warning: system node changed 22.23.2 -> 22.23.3
warning: system pnpm changed 11.22.0 -> 12.9.0 (major version change)
$hint"
check "no change prints one line" before same "toolchain unchanged: node 22.23.2 pnpm 11.22.0"
check "removed tool warns" before nopnpm "warning: system pnpm removed (was 11.22.0)
$hint"
check "added tool warns" nopnpm before "warning: system pnpm added (11.22.0)
$hint"
check "missing old system is silent" does-not-exist after ""
exit "$fail"
