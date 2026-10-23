#!/usr/bin/env bash
# setup/mac.sh — the ONE bootstrap script. Fresh-machine, single-pass, idempotent.
#
# Contract (AGENTS.md):
#   * Humans run this. Agents NEVER run it for real — they validate it through
#     tests/mac_setup_test.sh, which masks PATH with stub executables.
#   * Safe to re-run: every step checks before acting.
#   * Everything after this script is `rebuild`, which switches through
#     `sudo dotfiles-autoupdate rebuild` under the auto-update's switch lock.
#
# What it does, in order:
#   1. Verify Xcode Command Line Tools (git). Prompt to install if missing.
#   2. Install Nix via the Determinate Systems installer (flakes enabled).
#   3. Install Homebrew (GUI apps are declared in nix/host.nix; nix-darwin
#      drives brew, but brew itself must exist).
#   4. First `darwin-rebuild switch --flake .` (via `nix run nix-darwin`).
#
# Undo story:
#   * Nix:      /nix/nix-installer uninstall
#   * Homebrew: official uninstall script
#   * nix-darwin: `rollback` (or `rollback <n>`), under the same switch lock

set -euo pipefail

log()  { printf '\033[1;34m[setup]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[setup] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

[ "$(uname -s)" = "Darwin" ] || die "This script is for macOS."

if grep -q "CHANGE_ME" flake.nix; then
  die "flake.nix still contains CHANGE_ME placeholders. Complete PLAN Phase 0 first."
fi

# ── 1. Xcode Command Line Tools ─────────────────────────────────────────────
if xcode-select -p >/dev/null 2>&1; then
  log "Xcode Command Line Tools: present."
else
  log "Xcode Command Line Tools missing; triggering installer..."
  xcode-select --install || true
  die "Finish the CLT installation dialog, then re-run this script."
fi

# ── 2. Nix (Determinate Systems installer: flakes on, clean uninstall) ─────
if command -v nix >/dev/null 2>&1; then
  log "Nix: present ($(nix --version))."
else
  log "Installing Nix (Determinate Systems installer)..."
  curl --proto '=https' --tlsv1.2 -sSf -L https://install.determinate.systems/nix \
    | sh -s -- install --no-confirm
  # Load nix into this shell session
  if [ -e /nix/var/nix/profiles/default/etc/profile.d/nix-daemon.sh ]; then
    # shellcheck disable=SC1091
    . /nix/var/nix/profiles/default/etc/profile.d/nix-daemon.sh
  fi
  command -v nix >/dev/null 2>&1 || die "Nix installed but not on PATH; open a new terminal and re-run."
fi

# ── 3. Homebrew ─────────────────────────────────────────────────────────────
if command -v brew >/dev/null 2>&1 || [ -x /opt/homebrew/bin/brew ]; then
  log "Homebrew: present."
  [ -x /opt/homebrew/bin/brew ] && eval "$(/opt/homebrew/bin/brew shellenv)" || true
else
  log "Installing Homebrew..."
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  eval "$(/opt/homebrew/bin/brew shellenv)"
fi

# ── 4. First nix-darwin activation ──────────────────────────────────────────
HOSTNAME_FLAKE="$(sed -n 's/^ *hostname *= *"\(.*\)";.*/\1/p' flake.nix | head -n1)"
[ -n "$HOSTNAME_FLAKE" ] || die "Could not read hostname from flake.nix."

# A re-run on a configured Mac would race the hourly auto-update like any
# other switch, so it takes the updater's switch lock, as `rebuild` does
# (scripts/dotfiles-autoupdate). The first activation needs none: the
# updater does not exist until that activation finishes.
SWITCH_LOCK="${DOTFILES_SWITCH_LOCK:-/var/db/dotfiles-autoupdate/switch.lock}"
if command -v darwin-rebuild >/dev/null 2>&1 && [ -d "$(dirname "$SWITCH_LOCK")" ]; then
  log "nix-darwin: present; switching to current flake once no auto-update switch is in progress (waits up to 30 min)..."
  code=0
  sudo lockf -k -t 1800 "$SWITCH_LOCK" darwin-rebuild switch --flake ".#${HOSTNAME_FLAKE}" || code=$?
  [ "$code" != 75 ] || die "an auto-update switch still holds $SWITCH_LOCK after 30 min; nothing was switched. See /var/log/dotfiles-autoupdate.log and \`dotfiles-autoupdate status\`."
  [ "$code" = 0 ] || exit "$code"
elif command -v darwin-rebuild >/dev/null 2>&1; then
  log "nix-darwin: present; switching to current flake..."
  sudo darwin-rebuild switch --flake ".#${HOSTNAME_FLAKE}"
else
  log "First nix-darwin activation (this may take a while)..."
  sudo nix run nix-darwin/master#darwin-rebuild -- switch --flake ".#${HOSTNAME_FLAKE}"
fi

log "Done. Open a NEW Ghostty window and use \`rebuild\` from now on."
log "Next: install Claude Code (self-updating): curl -fsSL https://claude.ai/install.sh | bash"
