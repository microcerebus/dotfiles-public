#!/usr/bin/env bash
# Claude Code status line - Catppuccin Mocha, dim/subtle, single line.
#
# Canonical copy: dotfiles/files/.claude/statusline.sh. Home Manager symlinks
# it to ~/.claude/statusline.sh (see nix/user.nix) - edit the dotfiles copy,
# not the symlink target, so changes survive `rebuild`.
#
# Shows: model | context usage vs the model's real window (tokens + %) |
# session cost (API-equivalent estimate, informational on subscription) |
# 5h quota | cwd | git branch
set -euo pipefail

input="$(cat)"

# Catppuccin Mocha palette (truecolor; dim/subtle picks only).
DIM='108;112;134'     # overlay0 - separators
BLUE='137;180;250'    # model
GREEN='166;227;161'   # context: healthy
YELLOW='249;226;175'  # context: warm / cost
RED='243;139;168'     # context: hot
MAUVE='203;166;247'   # directory
PEACH='250;179;135'   # git branch

seg() { printf '\033[38;2;%sm%s\033[0m' "$1" "$2"; }
dim() { printf '\033[38;2;%sm%s\033[0m' "$DIM" "$1"; }

model="$(jq -r '.model.display_name // .model.id // "Claude"' <<<"$input")"
cwd_full="$(jq -r '.workspace.current_dir // .cwd // empty' <<<"$input")"
cwd="$(basename "${cwd_full:-$PWD}")"
# Context usage against the model's real window. Prefer the window size the
# harness reports; fall back to the model id ([1m] variants -> 1M, else 200k).
used_tokens="$(jq -r '
  .context_window // empty
  | .total_input_tokens
    // ((.current_usage.input_tokens // 0)
      + (.current_usage.cache_creation_input_tokens // 0)
      + (.current_usage.cache_read_input_tokens // 0))
' <<<"$input")"
window="$(jq -r '.context_window.context_window_size // empty' <<<"$input")"
if [ -z "$window" ]; then
  model_id="$(jq -r '.model.id // ""' <<<"$input")"
  case "$model_id" in
    # Native 1M context: Fable, Opus 4.7+, Sonnet 5.x (code.claude.com model-config).
    *"[1m]"*|*fable*|*opus-5*|*opus-4-[789]*|*sonnet-5*) window=1000000 ;;
    *) window=200000 ;;
  esac
fi
cost="$(jq -r '.cost.total_cost_usd // empty' <<<"$input")"

# 12345 -> "12k", 1000000 -> "1M"
fmt_tokens() {
  if [ "$1" -ge 1000000 ]; then
    printf '%dM' $(( ($1 + 500000) / 1000000 ))
  elif [ "$1" -ge 1000 ]; then
    printf '%dk' $(( ($1 + 500) / 1000 ))
  else
    printf '%d' "$1"
  fi
}

out="$(seg "$BLUE" "$model")"

if [ -n "$used_tokens" ]; then
  tokens_int="$(printf '%.0f' "$used_tokens")"
  pct_int=$(( tokens_int * 100 / window ))
  # Colour by absolute fill, not percent: with auto-compact off this is the
  # only warning, and quality degrades well before a 1M window is full
  # (Anthropic's session-management guidance: compact or hand off by
  # ~300-400k). Yellow = plan a handoff, red = do it now. Small windows keep
  # the 50%/80% marks.
  warn=$(( window / 2 )); [ "$warn" -gt 200000 ] && warn=200000
  crit=$(( window * 4 / 5 )); [ "$crit" -gt 350000 ] && crit=350000
  if [ "$tokens_int" -ge "$crit" ]; then
    color="$RED"
  elif [ "$tokens_int" -ge "$warn" ]; then
    color="$YELLOW"
  else
    color="$GREEN"
  fi
  out="$out$(dim ' │ ')$(seg "$color" "ctx $(fmt_tokens "$tokens_int")/$(fmt_tokens "$window") ${pct_int}%")"
fi

if [ -n "$cost" ]; then
  cost_fmt="$(printf '$%.2f' "$cost")"
  out="$out$(dim ' │ ')$(seg "$YELLOW" "$cost_fmt")"
fi

# Plan quota (5-hour rolling window), color-graded like context.
quota="$(jq -r '.rate_limits.five_hour.used_percentage // empty' <<<"$input")"
if [ -n "$quota" ]; then
  q_int="$(printf '%.0f' "$quota")"
  if [ "$q_int" -ge 80 ]; then
    qcolor="$RED"
  elif [ "$q_int" -ge 50 ]; then
    qcolor="$YELLOW"
  else
    qcolor="$GREEN"
  fi
  out="$out$(dim ' │ ')$(seg "$qcolor" "5h ${q_int}%")"
fi

out="$out$(dim ' │ ')$(seg "$MAUVE" "$cwd")"

if [ -n "$cwd_full" ] && branch="$(git -C "$cwd_full" --no-optional-locks branch --show-current 2>/dev/null)" && [ -n "$branch" ]; then
  out="$out$(dim ' │ ')$(seg "$PEACH" " $branch")"
fi

printf '%s\n' "$out"
