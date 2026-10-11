#!/usr/bin/env bash
# git's credential for github.com comes only from gh (nix/user.nix), so a gh
# login reaches every HTTPS fetch, including dotfiles-sync's, and no stale
# keychain copy outlives a rotation (11 Oct 2026). Runs the real git against
# the git config Home Manager generates, with stub gh and keychain helpers.
# No network; writes only to a temp dir.
# Run: bash tests/git_credential_test.sh
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
fail=0

ok() { echo "ok   $1"; }
bad() { echo "FAIL $1"; shift; printf '  %s\n' "$@"; fail=1; }

generated=$(nix build --no-link --print-out-paths \
  "$repo#darwinConfigurations.myhost.config.home-manager.users.myuser.xdg.configFile.\"git/config\".source")

# Stubs: gh answers from its login; the keychain helper (git's system default
# on this Mac) answers with the copy a rotation would leave behind.
cat >"$tmp/gh" <<'EOF'
#!/usr/bin/env bash
[ "$1 $2 $3" = "auth git-credential get" ] && printf 'username=gh-user\npassword=from-gh\n'
exit 0
EOF
cat >"$tmp/keychain" <<'EOF'
#!/usr/bin/env bash
[ "$1" = get ] && printf 'username=old\npassword=stale-copy\n'
exit 0
EOF
chmod +x "$tmp/gh" "$tmp/keychain"
printf '[credential]\n\thelper = %s/keychain\n' "$tmp" >"$tmp/system"
sed -E "s#!/nix/store/[^ ]*/bin/gh #!$tmp/gh #" "$generated" >"$tmp/global"

fill() { # fill <host>: the password git would send to that host
  printf 'protocol=https\nhost=%s\n\n' "$1" \
    | env -i HOME="$tmp" PATH=/usr/bin:/bin GIT_TERMINAL_PROMPT=0 \
      GIT_CONFIG_SYSTEM="$tmp/system" GIT_CONFIG_GLOBAL="$tmp/global" \
      "$(command -v git)" credential fill 2>/dev/null | sed -n 's/^password=//p'
}

if grep -q '/bin/gh auth git-credential' "$generated"; then ok "the generated config calls gh by its store path, which launchd agents can run"
else bad "the generated config calls gh by its store path, which launchd agents can run" "got: $(grep -i -A3 credential "$generated" || echo '<no credential section>')"; fi
got=$(fill github.com)
if [ "$got" = from-gh ]; then ok "github.com gets gh's credential, never the keychain copy"
else bad "github.com gets gh's credential, never the keychain copy" "got: ${got:-<none>}"; fi
got=$(fill gitlab.com)
if [ "$got" = stale-copy ]; then ok "other hosts keep the system keychain helper"
else bad "other hosts keep the system keychain helper" "got: ${got:-<none>}"; fi

exit "$fail"
