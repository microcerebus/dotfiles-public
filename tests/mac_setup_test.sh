#!/usr/bin/env bash
# tests/mac_setup_test.sh — validates setup/mac.sh WITHOUT touching the host.
#
# Pattern (after kunchenguid/dotfiles-mac-nix): run the real script with PATH
# masked so every mutating executable is a logging stub, inside a sandboxed
# HOME and a sandboxed copy of the repo. Nothing real is installed. Any write
# that escapes the sandbox fails the test. This is the ONLY way agents may
# exercise the bootstrap (AGENTS.md).
#
# This repo ships UNPERSONALIZED (identity values are CHANGE_ME), so the tests
# run in the opposite order from a personalized checkout: the placeholder guard
# is exercised against the tree as shipped, and the happy path runs against a
# sandbox copy that the test personalizes itself.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SANDBOX="$(mktemp -d)"
STUBS="$SANDBOX/stubs"
CALLS="$SANDBOX/calls.log"
FAKE_HOME="$SANDBOX/home"
WORK="$SANDBOX/repo"
FAKE_HOST="examplehost"

cleanup() { rm -rf "$SANDBOX"; }
trap cleanup EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "  ok: $*"; }

mkdir -p "$STUBS" "$FAKE_HOME" "$WORK"
cp -R "$REPO_DIR/." "$WORK/"
: > "$CALLS"

stub() { # stub <name> [body...]
  local name="$1"; shift
  {
    echo '#!/bin/bash'
    echo "echo \"$name \$*\" >> '$CALLS'"
    [ $# -gt 0 ] && printf '%s\n' "$@"
    echo 'exit 0'
  } > "$STUBS/$name"
  chmod +x "$STUBS/$name"
}

# Stub ONLY the mutating/host-specific executables. Read-only text tools
# (grep, sed, head, dirname) come from the real /usr/bin via PATH.
stub uname        'case "${1:-}" in -s) echo Darwin;; -m) echo arm64;; *) echo Darwin;; esac'
stub xcode-select '[ "${1:-}" = "-p" ] && echo /Library/Developer/CommandLineTools'
stub curl         'echo "# stubbed installer payload"'
stub sh
stub sudo
stub nix          '[ "${1:-}" = "--version" ] && echo "nix (stub) 2.99"'
stub brew         'echo "Homebrew (stub) 4.x"'
stub darwin-rebuild

TEST_PATH="$STUBS:/usr/bin:/bin"

# ── Test 1: the published tree carries placeholders, never real identity ────
# This is the anti-leak assertion. If a real username/hostname/email ever
# lands here, this test is what catches it.
grep -q 'username = "CHANGE_ME";' "$WORK/flake.nix" \
  || fail "flake.nix must ship with username = \"CHANGE_ME\""
grep -q 'hostname = "CHANGE_ME";' "$WORK/flake.nix" \
  || fail "flake.nix must ship with hostname = \"CHANGE_ME\""
grep -q 'user.name = "CHANGE_ME";' "$WORK/nix/user.nix" \
  || fail "nix/user.nix must ship with user.name = \"CHANGE_ME\""
grep -q 'user.email = "CHANGE_ME@example.com";' "$WORK/nix/user.nix" \
  || fail "nix/user.nix must ship with a placeholder git email"
pass "ships unpersonalized (CHANGE_ME placeholders intact)"

# ── Test 2: placeholder guard blocks the unpersonalized tree ────────────────
if HOME="$FAKE_HOME" PATH="$TEST_PATH" bash "$WORK/setup/mac.sh" \
     >"$SANDBOX/out1.log" 2>&1; then
  fail "script must refuse to run while flake.nix has CHANGE_ME placeholders"
fi
grep -q "CHANGE_ME" "$SANDBOX/out1.log" || fail "placeholder error message not shown"
pass "refuses to run with CHANGE_ME placeholders"

# ── Test 3: a personalized tree completes single-pass against stubs ─────────
sed -i.bak "s/username = \"CHANGE_ME\"/username = \"exampleuser\"/" "$WORK/flake.nix"
sed -i.bak "s/hostname = \"CHANGE_ME\"/hostname = \"$FAKE_HOST\"/" "$WORK/flake.nix"
rm -f "$WORK/flake.nix.bak"
grep -q "CHANGE_ME" "$WORK/flake.nix" && fail "personalization left a placeholder behind"

MARKER="$SANDBOX/.t0"; touch "$MARKER"; sleep 1
: > "$CALLS"
HOME="$FAKE_HOME" PATH="$TEST_PATH" bash "$WORK/setup/mac.sh" \
  >"$SANDBOX/out2.log" 2>&1 \
  || { cat "$SANDBOX/out2.log" >&2; fail "bootstrap failed against stubs"; }
pass "bootstrap completes single-pass against stubs"

# ── Test 4: expected mutations were attempted, via stubs only ────────────────
if ! grep -Eq "^sudo (nix run nix-darwin|darwin-rebuild switch)" "$CALLS"; then
  echo "--- calls ---"; cat "$CALLS"
  fail "no darwin-rebuild switch attempted"
fi
grep -q "$FAKE_HOST" "$CALLS" || fail "flake hostname not passed to darwin-rebuild"
pass "attempts darwin-rebuild switch --flake .#$FAKE_HOST"

# ── Test 5: sandbox containment — nothing outside SANDBOX was written ───────
LEAKS="$(find "$REPO_DIR" -type f -newer "$MARKER" 2>/dev/null || true)"
[ -z "$LEAKS" ] || { echo "$LEAKS"; fail "bootstrap wrote into the real repo"; }
pass "no writes escaped the sandbox"

echo "ALL TESTS PASSED"
