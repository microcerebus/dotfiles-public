#!/usr/bin/env bash
# Merge the settings this repo owns (settings.managed.json) into
# ~/.claude/settings.json. Claude Code, herdr and the axi tools all write to
# that file at runtime, so it cannot be a symlink.
# - Plain keys: deep merge, managed values win.
# - Hooks: entries whose command runs `python3 -I ~/.claude/hooks/...` or
#   `~/dotfiles/scripts/...` belong to this repo. They are removed and
#   re-added from the managed file, so a hook dropped here disappears on the
#   next switch. Every other entry, for any event, is kept in place, except
#   the axi tools' own SessionStart hooks (a command that is just gh-axi,
#   chrome-devtools-axi, lavish-axi or tasks-axi, by name or path; other
#   hooks in the same group stay): scripts/axi-session-start runs all four
#   instead and prints counts where they print whole lists.
#   `<tool> setup hooks` adds its hook back; the next switch removes it again.
# Idempotent. A failed merge warns and exits 0: aborting would skip the rest
# of Home Manager activation (see the brew bundle sharp edge in AGENTS.md).
# Usage: merge-settings.sh <jq> <settings.json> <settings.managed.json>
set -euo pipefail
jq="$1" settings="$2" managed="$3"
mkdir -p "$(dirname "$settings")"
[ -s "$settings" ] || printf '{}\n' >"$settings"
tmp="$(mktemp "${settings}.XXXXXX")"
trap 'rm -f "$tmp"' EXIT
filter='
  def owned: any(.hooks[]?; (.command // "") | startswith("python3 -I ~/.claude/hooks/") or startswith("~/dotfiles/scripts/"));
  def axi_hook: (.command // "") | test("^\\s*(node\\s+)?(\\S*/)?(gh|chrome-devtools|lavish|tasks)-axi(/\\S*)?\\s*$");
  .[0] as $s | .[1] as $m
  | ($s * ($m | del(.hooks)))
  | .hooks = (
      reduce (($m.hooks // {}) | to_entries[]) as $e
        (($s.hooks // {}) | map_values(map(select(owned | not)))
         | if .SessionStart then .SessionStart |= map(.hooks |= ((. // []) | map(select(axi_hook | not))) | select(.hooks | length > 0)) else . end;
         .[$e.key] = ((.[$e.key] // []) + $e.value))
      | with_entries(select(.value | length > 0)))
  | if .hooks == {} then del(.hooks) else . end'
if ! "$jq" -s "$filter" "$settings" "$managed" >"$tmp"; then
  echo "warning: $settings was not merged with $managed (invalid JSON?); fix it and rebuild" >&2
  exit 0
fi
if ! cmp -s "$tmp" "$settings"; then
  cp "$settings" "${settings}.before-merge"
  mv "$tmp" "$settings"
fi
