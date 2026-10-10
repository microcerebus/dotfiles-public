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
check "allows em dash grep before a commit" 0 bash_guard.py "$(bash_cmd "grep -rn '${em}' docs && git commit -m 'docs: drop dashes'")"
check "allows em dash in other heredoc" 0 bash_guard.py "$(bash_cmd $'cat <<EOF >notes.md\na '"${em}"$' b\nEOF\ngit commit -m "docs: notes"')"
check "blocks em dash in -am"         2 bash_guard.py "$(bash_cmd "git commit -am 'fix: a ${em} b'")"
check "blocks em dash in --message="  2 bash_guard.py "$(bash_cmd "git -C repo commit --message='fix: a ${em} b'")"
check "blocks em dash in -F heredoc"  2 bash_guard.py "$(bash_cmd $'git commit -F - <<EOF\nfeat: a '"${em}"$' b\nEOF')"
check "blocks em dash in cat heredoc" 2 bash_guard.py "$(bash_cmd $'git commit -m "$(cat <<\'EOF\'\nfeat: a '"${em}"$' b\nEOF\n)"')"
printf 'feat: a %s b\n' "$em" >"$tmp/msg.txt"
check "blocks em dash in -F file"     2 bash_guard.py "$(bash_cmd "git commit -F $tmp/msg.txt")"
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

# Handoff notes must not leave work "hosted" in a thread that is about to end.
# The real line from orchestrator 4's resume note, 10 Oct 14:19; the native worker died at 14:22.
c6='Coordinator 6 is renamed and still hosts #36s resolution review and hosted acceptance.'
check "flags still-hosts in resume note" 2 write_guard.py "{\"tool_input\":{\"file_path\":\"/h/orchestrator/orchestrator-resume-2026-10-10-o4.md\",\"content\":\"$c6\"}}"
check "flags still-running-in in .resume" 2 write_guard.py "{\"tool_input\":{\"file_path\":\"/w/.resume/n.md\",\"new_string\":\"acceptance still running in-thread\"}}"
check "flags still-hosts in orchestrator log" 2 write_guard.py "{\"tool_input\":{\"file_path\":\"$HOME/orchestrator/overnight.md\",\"content\":\"c6 still hosts the review\"}}"
check "passes still-hosts in other docs" 0 write_guard.py "{\"tool_input\":{\"file_path\":\"/x/docs/a.md\",\"content\":\"the box still hosts the site\"}}"
check "blocks still-hosts heredoc into .resume" 2 bash_guard.py "$(bash_cmd $'cat >> .resume/trail.md <<\'EOF\'\n- '"$c6"$'\nEOF')"
check "blocks still-running-in echo into resume" 2 bash_guard.py "$(bash_cmd "echo '- review still running in coordinator 6' >> ~/orchestrator/orchestrator-resume-x.md")"
check "allows grep for still hosts"  0 bash_guard.py "$(bash_cmd "grep -rn 'still hosts' .resume/ ~/orchestrator")"

# HTML must not let tables split ordinary words. The body rule is the 11 Oct design review page's
# ("Surfa ce"); the :where list is the July Lavish pages' pattern.
write_json() { python3 -I -c 'import json,sys; print(json.dumps({"tool_input": {"file_path": sys.argv[1], "content": sys.argv[2]}}))' "$1" "$2"; }
check "flags anywhere on body"       2 write_guard.py "$(write_json /x/review.html '<style>*{box-sizing:border-box}body{margin:0;font:15px/1.55 sans-serif;overflow-wrap:anywhere}</style>')"
check "flags anywhere on th,td"      2 write_guard.py "$(write_json /x/a.html '<style>th,td{text-align:left;overflow-wrap:anywhere}</style>')"
check "flags a :where list with td"  2 write_guard.py "$(write_json /x/a.htm $'<style>\n:where(p, h1, li, td, th) {\n  overflow-wrap: anywhere;\n}\n</style>')"
check "flags break-all inline on td" 2 write_guard.py "$(write_json /x/a.html '<td style="color:red; word-break: break-all">x</td>')"
check "allows anywhere on code"      0 write_guard.py "$(write_json /x/a.html '<style>code{overflow-wrap:anywhere}</style>')"
check "allows break-word on body"    0 write_guard.py "$(write_json /x/a.html '<style>body{overflow-wrap:break-word}</style>')"
check "ignores CSS quoted in markdown" 0 write_guard.py "$(write_json /x/a.md 'never write body{overflow-wrap:anywhere}')"
check "allows still-hosts heredoc elsewhere" 0 bash_guard.py "$(bash_cmd $'cat > docs/a.md <<EOF\nthe box still hosts the site\nEOF')"

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
