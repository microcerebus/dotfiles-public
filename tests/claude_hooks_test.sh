#!/usr/bin/env bash
# Tests for the Claude Code hooks and the managed-settings merge in
# files/.claude/. Pure: no network, writes only to a temp dir.
# Run: bash tests/claude_hooks_test.sh
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
hooks="$repo/files/.claude/hooks"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
fail=0
check() { # check <name> <expected-exit> <hook> <json>
  local name="$1" want="$2" hook="$3" json="$4" got=0
  printf '%s' "$json" | python3 -I "$hooks/$hook" >"$tmp/out" 2>"$tmp/err" || got=$?
  if [ "$got" = "$want" ]; then echo "ok   $name"; else echo "FAIL $name: exit $got, want $want"; cat "$tmp/err"; fail=1; fi
}
bash_cmd() { python3 -I -c 'import json,sys; print(json.dumps({"tool_input": {"command": sys.argv[1]}}))' "$1"; }
em=$'—'

# Containers and VMs: blocked at command position, allowed with approval or as plain text.
check "blocks docker run"            2 bash_guard.py "$(bash_cmd 'docker run --rm ubuntu true')"
check "blocks orbctl after &&"       2 bash_guard.py "$(bash_cmd 'cd x && orbctl create ubuntu jt-ci-repro')"
check "blocks orb in subshell"       2 bash_guard.py "$(bash_cmd 'echo $(orb list)')"
check "blocks open -a OrbStack"      2 bash_guard.py "$(bash_cmd 'open -a OrbStack')"
check "blocks sudo podman"           2 bash_guard.py "$(bash_cmd 'sudo podman ps')"
check "blocks env-prefixed docker"   2 bash_guard.py "$(bash_cmd 'FOO=1 docker ps')"
check "blocks docker on a later line" 2 bash_guard.py "$(bash_cmd $'cd x\ndocker compose up -d')"
check "blocks bare orb"              2 bash_guard.py "$(bash_cmd 'orb')"
check "allows docker --version"      0 bash_guard.py "$(bash_cmd 'docker --version')"
check "allows docker commit scope"   0 bash_guard.py "$(bash_cmd 'git commit -m "fix(docker): pin base image"')"
check "allows lima commit scope"     0 bash_guard.py "$(bash_cmd "git commit -m 'chore(lima): bump'")"
check "allows grep alternation"      0 bash_guard.py "$(bash_cmd "grep -E 'podman|docker' README.md")"
check "allows rg group"              0 bash_guard.py "$(bash_cmd "rg -n '(orb|lima)' nix/")"
check "allows jq pipe text"          0 bash_guard.py "$(bash_cmd "jq '.x | orb' f")"
check "allows quoted ampersand"      0 bash_guard.py "$(bash_cmd 'echo "a & docker"')"
check "allows heredoc body"          0 bash_guard.py "$(bash_cmd $'git commit -F - <<EOF\nfeat: x\n\nDocker images are pinned now\norb list\nEOF')"
check "allows grep for docker"       0 bash_guard.py "$(bash_cmd 'grep -rn docker README.md')"
check "allows git log"               0 bash_guard.py "$(bash_cmd 'git log --oneline -3')"
# Em dashes in commit messages.
check "blocks em dash commit"        2 bash_guard.py "$(bash_cmd "git commit -m 'feat: a ${em} b'")"
check "allows plain commit"          0 bash_guard.py "$(bash_cmd "git commit -m 'feat: a - b'")"
check "allows em dash outside git"   0 bash_guard.py "$(bash_cmd "printf '${em}'")"
mkdir -p "$tmp/home/.claude" && echo $(( $(date +%s) + 3600 )) >"$tmp/home/.claude/containers-approved-until"
if bash_cmd 'docker ps' | HOME="$tmp/home" python3 -I "$hooks/bash_guard.py" 2>/dev/null; then echo "ok   approval file allows containers"; else echo "FAIL approval file"; fail=1; fi
echo $(( $(date +%s) - 60 )) >"$tmp/home/.claude/containers-approved-until"
if ! bash_cmd 'docker ps' | HOME="$tmp/home" python3 -I "$hooks/bash_guard.py" 2>/dev/null; then echo "ok   expired approval blocks again"; else echo "FAIL expired approval"; fail=1; fi
check "tolerates bad json"           0 bash_guard.py "not json"
check "tolerates unbalanced quotes"  0 bash_guard.py "$(bash_cmd "echo 'oops")"

# Prose writes with em dashes are flagged; code and clean prose pass.
check "flags em dash in markdown"    2 write_guard.py "{\"tool_input\":{\"file_path\":\"/x/a.md\",\"content\":\"a ${em} b\"}}"
check "flags em dash in edit"        2 write_guard.py "{\"tool_input\":{\"file_path\":\"/x/a.html\",\"new_string\":\"a ${em} b\"}}"
check "flags em dash in multiedit"   2 write_guard.py "{\"tool_input\":{\"file_path\":\"/x/a.md\",\"edits\":[{\"new_string\":\"${em}\"}]}}"
check "ignores code files"           0 write_guard.py "{\"tool_input\":{\"file_path\":\"/x/a.py\",\"content\":\"'${em}'\"}}"
check "passes clean prose"           0 write_guard.py "{\"tool_input\":{\"file_path\":\"/x/a.md\",\"content\":\"a - b\"}}"

# Turn context: always the SGT time; context size read from the transcript's last usage record.
printf '%s\n' '{"type":"user","message":{"content":"hi"}}' \
  '{"type":"assistant","message":{"usage":{"input_tokens":5,"cache_creation_input_tokens":1000,"cache_read_input_tokens":349000}}}' >"$tmp/t.jsonl"
check "turn context with transcript" 0 turn_context.py "{\"transcript_path\":\"$tmp/t.jsonl\"}"
if grep -q 'SGT' "$tmp/out" && grep -q '350k tokens. Past 300k' "$tmp/out"; then echo "ok   turn context text"; else echo "FAIL turn context text: $(cat "$tmp/out")"; fail=1; fi
check "turn context without transcript" 0 turn_context.py '{}'
grep -q 'Current time' "$tmp/out" || { echo "FAIL no time without transcript"; fail=1; }

# Managed settings merge: adds owned keys, keeps everything else, idempotent.
cat >"$tmp/settings.json" <<'JSON'
{"theme":"dark","autoCompactEnabled":true,"hooks":{"SessionStart":[{"matcher":"","hooks":[{"type":"command","command":"gh-axi"}]}],"UserPromptSubmit":[{"hooks":[{"type":"command","command":"other-tool"}]}],"PostToolUse":[{"hooks":[{"type":"command","command":"python3 -I ~/.claude/hooks/retired.py"}]}]}}
JSON
bash "$repo/files/.claude/merge-settings.sh" jq "$tmp/settings.json" "$repo/files/.claude/settings.managed.json"
got="$(jq -c '[.theme, .autoCompactEnabled, .cleanupPeriodDays, (.hooks.SessionStart|length), [.hooks.UserPromptSubmit[].hooks[0].command], (.hooks.PreToolUse[0].matcher), ([.hooks.PostToolUse[].hooks[0].command]|any(test("retired")))]' "$tmp/settings.json")"
want='["dark",false,365,1,["other-tool","python3 -I ~/.claude/hooks/turn_context.py"],"Bash",false]'
if [ "$got" = "$want" ]; then echo "ok   merge keeps others' hooks, replaces ours, drops retired ones"; else echo "FAIL merge: $got, want $want"; fail=1; fi
cp "$tmp/settings.json" "$tmp/once.json"; rm -f "$tmp/settings.json.before-merge"
bash "$repo/files/.claude/merge-settings.sh" jq "$tmp/settings.json" "$repo/files/.claude/settings.managed.json"
if cmp -s "$tmp/once.json" "$tmp/settings.json" && [ ! -e "$tmp/settings.json.before-merge" ]; then echo "ok   merge is idempotent"; else echo "FAIL merge not idempotent"; fail=1; fi

bash "$repo/files/.claude/merge-settings.sh" jq "$tmp/fresh/.claude/settings.json" "$repo/files/.claude/settings.managed.json"
if [ "$(jq .cleanupPeriodDays "$tmp/fresh/.claude/settings.json")" = 365 ]; then echo "ok   merge creates settings on a fresh machine"; else echo "FAIL merge on a fresh machine"; fail=1; fi
printf '{not json' >"$tmp/bad.json"
if bash "$repo/files/.claude/merge-settings.sh" jq "$tmp/bad.json" "$repo/files/.claude/settings.managed.json" 2>/dev/null \
  && [ "$(cat "$tmp/bad.json")" = '{not json' ]; then echo "ok   merge leaves invalid settings alone and exits 0"; else echo "FAIL merge on invalid settings"; fail=1; fi

exit "$fail"
