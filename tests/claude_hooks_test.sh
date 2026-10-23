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
# shellcheck disable=SC2016 # $(orb list) is the command text under test
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
# Bare darwin-rebuild switches: blocked at command position; the locked
# commands, read-only actions and text that mentions them pass.
check "blocks sudo darwin-rebuild switch"   2 bash_guard.py "$(bash_cmd 'sudo darwin-rebuild switch --flake ~/dotfiles')"
check "blocks switch after cd &&"           2 bash_guard.py "$(bash_cmd 'cd ~/dotfiles && sudo darwin-rebuild switch --flake .#myhost')"
check "blocks the old rebuild alias text"   2 bash_guard.py "$(bash_cmd 'sudo darwin-rebuild switch --flake /Users/x/dotfiles && brew upgrade')"
check "blocks darwin-rebuild --rollback"    2 bash_guard.py "$(bash_cmd 'sudo darwin-rebuild --rollback')"
check "blocks darwin-rebuild -G"            2 bash_guard.py "$(bash_cmd 'sudo darwin-rebuild -G 42')"
check "blocks --switch-generation="         2 bash_guard.py "$(bash_cmd 'sudo darwin-rebuild --switch-generation=42')"
check "blocks activate by full path"        2 bash_guard.py "$(bash_cmd 'sudo /run/current-system/sw/bin/darwin-rebuild activate')"
check "blocks flags before the action"      2 bash_guard.py "$(bash_cmd 'sudo darwin-rebuild --flake . switch')"
check "blocks nix run darwin-rebuild"       2 bash_guard.py "$(bash_cmd 'sudo nix run nix-darwin/master#darwin-rebuild -- switch --flake .#myhost')"
check "blocks env-prefixed switch"          2 bash_guard.py "$(bash_cmd 'SUDO_UID=501 darwin-rebuild switch --flake x')"
check "allows rebuild alias"                0 bash_guard.py "$(bash_cmd 'rebuild')"
check "allows dotfiles-autoupdate rebuild"  0 bash_guard.py "$(bash_cmd 'sudo dotfiles-autoupdate rebuild ~/dotfiles')"
check "allows dotfiles-autoupdate rollback" 0 bash_guard.py "$(bash_cmd 'sudo dotfiles-autoupdate rollback 41')"
check "allows darwin-rebuild build"         0 bash_guard.py "$(bash_cmd 'darwin-rebuild build --flake .#myhost')"
check "allows darwin-rebuild check"         0 bash_guard.py "$(bash_cmd 'darwin-rebuild check --flake .')"
check "allows --list-generations"           0 bash_guard.py "$(bash_cmd 'sudo darwin-rebuild --list-generations')"
check "allows nix run darwin-rebuild build" 0 bash_guard.py "$(bash_cmd 'nix run nix-darwin#darwin-rebuild -- build --flake .')"
check "allows nix run of another switch"    0 bash_guard.py "$(bash_cmd 'nix run .#deploy -- switch')"
check "allows grep for a switch"            0 bash_guard.py "$(bash_cmd "git grep -n 'sudo darwin-rebuild switch --flake' -- . | head")"
check "allows sed over the old alias"       0 bash_guard.py "$(bash_cmd "sed -i '' 's|sudo darwin-rebuild switch|sudo x rebuild|' nix/user.nix")"
check "allows a commit that names it"       0 bash_guard.py "$(bash_cmd "git commit -m 'fix(rebuild): stop calling darwin-rebuild switch directly'")"
check "allows a comment that names it"     0 bash_guard.py "$(bash_cmd $'ls # then: sudo darwin-rebuild --rollback; done\necho ok')"
check "blocks a switch after a comment line" 2 bash_guard.py "$(bash_cmd $'# switch now\nsudo darwin-rebuild switch --flake .')"
check "allows a heredoc that names it"      0 bash_guard.py "$(bash_cmd $'cat >notes.md <<EOF\nsudo darwin-rebuild --rollback\nEOF')"
check "allows a <<\\EOF heredoc that names it" 0 bash_guard.py "$(bash_cmd $'cat <<\\EOF\nsudo darwin-rebuild switch\nEOF')"
# Switches through wrappers, nix run of the nix-darwin flake, and sh -c strings.
check "blocks nix run of the nix-darwin flake" 2 bash_guard.py "$(bash_cmd 'sudo nix run nix-darwin -- switch --flake .')"
check "blocks nix run of a github nix-darwin"  2 bash_guard.py "$(bash_cmd 'nix run github:nix-darwin/nix-darwin/nix-darwin-25.05 -- switch')"
check "blocks nix flags before run"         2 bash_guard.py "$(bash_cmd "sudo nix --extra-experimental-features 'nix-command flakes' run nix-darwin/master#darwin-rebuild -- switch --flake .")"
check "blocks nix run args without --"      2 bash_guard.py "$(bash_cmd 'sudo nix run nix-darwin#darwin-rebuild switch')"
check "blocks a timeout wrapper"            2 bash_guard.py "$(bash_cmd 'timeout 900 sudo darwin-rebuild switch --flake .')"
check "blocks a timeout wrapper with flags" 2 bash_guard.py "$(bash_cmd 'timeout -s KILL 900 darwin-rebuild --rollback')"
check "blocks a caffeinate wrapper"         2 bash_guard.py "$(bash_cmd 'caffeinate -i sudo darwin-rebuild switch --flake .')"
check "blocks sudo -u root"                 2 bash_guard.py "$(bash_cmd 'sudo -u root darwin-rebuild switch --flake .')"
check "blocks bash -c"                      2 bash_guard.py "$(bash_cmd "bash -c 'sudo darwin-rebuild switch --flake .'")"
check "blocks zsh -lc after cd"             2 bash_guard.py "$(bash_cmd "cd ~/dotfiles && zsh -lc 'git pull && sudo darwin-rebuild switch --flake .'")"
check "blocks sh -c docker"                 2 bash_guard.py "$(bash_cmd "sh -c 'docker run --rm x'")"
check "allows bash -c of a build"           0 bash_guard.py "$(bash_cmd "bash -c 'darwin-rebuild build --flake .'")"
check "allows bash running a script"        0 bash_guard.py "$(bash_cmd 'bash tests/autoupdate_test.sh switch')"
check "allows nix run of nix-darwin build"  0 bash_guard.py "$(bash_cmd 'nix run nix-darwin -- build --flake .')"
check "allows nix run of another flake"     0 bash_guard.py "$(bash_cmd 'nix run nixpkgs#hello -- switch')"
check "allows command -v docker"            0 bash_guard.py "$(bash_cmd 'command -v docker && echo yes')"
# Comments: only an unquoted # at the start of a word opens one, and quotes inside it are text.
check "blocks docker after an apostrophe comment" 2 bash_guard.py "$(bash_cmd $'# don\'t start it yet\ndocker run hello')"
check "blocks docker after a quoted #"      2 bash_guard.py "$(bash_cmd "echo '#' ; docker run hello")"
check "blocks docker after a quoted shebang" 2 bash_guard.py "$(bash_cmd "printf '#!/bin/sh\\n' > x; docker run hello")"
check "blocks em dash after a quoted #"     2 bash_guard.py "$(bash_cmd "git commit -m '#42 fix ${em} thing'")"
check "blocks em dash after an apostrophe comment" 2 bash_guard.py "$(bash_cmd $'# it\'s fine\ngit commit -m \'a '"${em}"$' b\'')"
check "blocks docker after a trailing comment" 2 bash_guard.py "$(bash_cmd $'ls # note\ndocker run x')"
# shellcheck disable=SC2016 # ${#arr[@]} is the command text under test
check "blocks docker after \${#arr[@]}"     2 bash_guard.py "$(bash_cmd 'echo ${#arr[@]}; docker run x')"
check "blocks docker after x=a#b"           2 bash_guard.py "$(bash_cmd 'x=a#b; docker run x')"
check "allows a quoted commit body with quotes" 0 bash_guard.py "$(bash_cmd $'git commit -m "$(cat <<\'EOF\'\nfix: say "docker run" once\n\ndocker run x\nEOF\n)"')"
# The block names the aliases only: on the owner's PATH, dotfiles-autoupdate is the checkout's copy.
msg=$(bash_cmd 'sudo darwin-rebuild switch' | python3 -I "$hooks/bash_guard.py" 2>&1 >/dev/null || true)
# shellcheck disable=SC2016 # the backquotes are literal text
if [[ $msg == *'run `rebuild` (or `rollback`'* && $msg != *dotfiles-autoupdate* ]]; then echo "ok   the switch block names only the aliases"
else echo "FAIL the switch block names only the aliases: $msg"; fail=1; fi
# The nix run installable comes before --; what follows is the program's arguments.
check "allows nix-darwin after nix run --"    0 bash_guard.py "$(bash_cmd 'nix run nixpkgs#ripgrep -- -e nix-darwin -e switch docs')"
check "allows a nix-darwin path after --"     0 bash_guard.py "$(bash_cmd 'nix run nixpkgs#git -- -C ~/src/nix-darwin switch main')"
# A backslash-newline continues the command, as in the shell.
check "blocks a switch across a continuation" 2 bash_guard.py "$(bash_cmd $'sudo darwin-rebuild \\\n  switch --flake .')"
check "blocks an em dash across a continuation" 2 bash_guard.py "$(bash_cmd $'git commit \\\n  -m \'a '"${em}"$' b\'')"
check "allows a quoted backslash-newline"     0 bash_guard.py "$(bash_cmd $'echo \'darwin-rebuild \\\nswitch\'')"
# Reserved words before the command word.
check "blocks a switch after if"              2 bash_guard.py "$(bash_cmd 'if sudo darwin-rebuild switch --flake .; then echo ok; fi')"
check "blocks a switch in braces"             2 bash_guard.py "$(bash_cmd '{ sudo darwin-rebuild switch --flake .; }')"
check "blocks a switch after !"               2 bash_guard.py "$(bash_cmd '! sudo darwin-rebuild switch --flake .')"
check "blocks a switch after do"              2 bash_guard.py "$(bash_cmd 'for i in 1; do sudo darwin-rebuild switch --flake .; done')"
check "allows an if that greps for it"        0 bash_guard.py "$(bash_cmd 'if grep -q darwin-rebuild file; then echo ok; fi')"
check "allows echo docker in braces"          0 bash_guard.py "$(bash_cmd '{ echo docker; }')"
# Heredoc delimiters with - or . end their body.
check "allows an END-NOTES heredoc body"      0 bash_guard.py "$(bash_cmd $'cat > notes.md <<\'END-NOTES\'\ndocker run hello\nEND-NOTES')"
check "allows a MSG.txt heredoc body"         0 bash_guard.py "$(bash_cmd $'cat > notes.md <<\'MSG.txt\'\nsudo darwin-rebuild switch --flake .\nMSG.txt')"
check "blocks a switch after an END.x heredoc" 2 bash_guard.py "$(bash_cmd $'cat <<END.x\nfoo\nEND.x\nsudo darwin-rebuild switch')"
# shellcheck disable=SC2016 # $((1<<2)) is the command text under test
check "blocks a switch after an arithmetic shift" 2 bash_guard.py "$(bash_cmd $'echo $((1<<2))\nsudo darwin-rebuild switch --flake .')"
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
  '{"type":"assistant","message":{"usage":{"input_tokens":5,"cache_creation_input_tokens":1000,"cache_read_input_tokens":209000}}}' >"$tmp/t.jsonl"
check "turn context with transcript" 0 turn_context.py "{\"transcript_path\":\"$tmp/t.jsonl\"}"
if grep -q 'SGT' "$tmp/out" && grep -q '210k tokens. Past 200k' "$tmp/out"; then echo "ok   turn context text"; else echo "FAIL turn context text: $(cat "$tmp/out")"; fail=1; fi
check "turn context without transcript" 0 turn_context.py '{}'
grep -q 'Current time' "$tmp/out" || { echo "FAIL no time without transcript"; fail=1; }
# Past 250k the stop is firm: every prompt repeats it, and main-thread tool calls repeat
# it once per 5k tokens of growth. 266k is the peak of the 16 Oct job-tracker thread
# that made 116 tool calls past 250k. The hook keeps its last stop in the temp dir.
export TMPDIR="$tmp"
at() { printf '{"type":"assistant","message":{"usage":{"input_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":%s}}}\n' "$1" >"$tmp/s.jsonl"; }
tool() { check "$1" 0 turn_context.py "{\"hook_event_name\":\"PostToolUse\",${2:-}\"transcript_path\":\"$tmp/s.jsonl\"}"; }
stop='Past the 250k hard stop: start no new work and use the pause-safely skill now'
at 266000; tool "tool call past 250k"
if grep -q "266k tokens. $stop" "$tmp/out" && grep -q '"hookEventName": "PostToolUse"' "$tmp/out" && ! grep -q 'SGT' "$tmp/out"; then
  echo "ok   tool call past 250k gets the stop"; else echo "FAIL tool call past 250k: $(cat "$tmp/out")"; fail=1; fi
tool "next tool call at the same size"
[ ! -s "$tmp/out" ] || { echo "FAIL stop repeated with no growth: $(cat "$tmp/out")"; fail=1; }
at 270999; tool "tool call 1 token short of 5k growth"
[ ! -s "$tmp/out" ] || { echo "FAIL stop repeated under 5k growth: $(cat "$tmp/out")"; fail=1; }
at 271000; tool "tool call after 5k growth"
grep -q "271k tokens. $stop" "$tmp/out" || { echo "FAIL no stop after 5k growth: $(cat "$tmp/out")"; fail=1; }
at 280000; check "turn context past 250k" 0 turn_context.py "{\"hook_event_name\":\"UserPromptSubmit\",\"transcript_path\":\"$tmp/s.jsonl\"}"
grep -q "280k tokens. $stop" "$tmp/out" || { echo "FAIL prompt past 250k: $(cat "$tmp/out")"; fail=1; }
tool "tool call right after a prompt's stop"
[ ! -s "$tmp/out" ] || { echo "FAIL tool call repeated the prompt's stop: $(cat "$tmp/out")"; fail=1; }
at 266000; tool "tool call after /compact and a climb back"
grep -q "266k tokens. $stop" "$tmp/out" || { echo "FAIL no stop after a drop: $(cat "$tmp/out")"; fail=1; }
check "tool call under 250k" 0 turn_context.py "{\"hook_event_name\":\"PostToolUse\",\"transcript_path\":\"$tmp/t.jsonl\"}"
[ ! -s "$tmp/out" ] || { echo "FAIL tool call under 250k printed: $(cat "$tmp/out")"; fail=1; }
# Subagent calls carry agent_id (seen in a real PostToolUse payload, 16 Oct) and the
# main thread's transcript_path, so without the skip they would get the thread's stop.
at 300000; tool "subagent tool call past 250k" '"agent_id":"a1",'
[ ! -s "$tmp/out" ] || { echo "FAIL subagent got the stop: $(cat "$tmp/out")"; fail=1; }
check "tool call without transcript" 0 turn_context.py '{"hook_event_name":"PostToolUse"}'
[ ! -s "$tmp/out" ] || { echo "FAIL tool call without transcript printed: $(cat "$tmp/out")"; fail=1; }
check "pre-compact backstop" 0 pre_compact.py '{"trigger":"auto"}'
grep -q 'pause-safely' "$tmp/out" || { echo "FAIL pre-compact text: $(cat "$tmp/out")"; fail=1; }

# Managed settings merge: adds owned keys, keeps everything else, idempotent.
cat >"$tmp/settings.json" <<'JSON'
{"theme":"dark","autoCompactEnabled":false,"hooks":{"SessionStart":[{"matcher":"","hooks":[{"type":"command","command":"gh-axi"}]},{"matcher":"*","hooks":[{"type":"command","command":"bash herdr-agent-state.sh session"}]},{"hooks":[{"type":"command","command":"tasks-axi"},{"type":"command","command":"echo gh-axi >> audit.log"}]},{"matcher":"","hooks":[{"type":"command","command":"node /p/pnpm/global/v11/ed72/node_modules/tasks-axi/dist/bin/tasks-axi.js"}]},{"matcher":"","hooks":[{"type":"command","command":"node /p/pnpm/global/v11/31a7/node_modules/lavish-axi/dist/cli.mjs"}]},{"hooks":[{"type":"command","command":"lavish-axi"}]},{"hooks":[{"type":"command","command":"~/dotfiles/scripts/retired-script"}]}],"UserPromptSubmit":[{"hooks":[{"type":"command","command":"other-tool"}]}],"PostToolUse":[{"hooks":[{"type":"command","command":"python3 -I ~/.claude/hooks/retired.py"}]}]}}
JSON
bash "$repo/files/.claude/merge-settings.sh" jq "$tmp/settings.json" "$repo/files/.claude/settings.managed.json"
got="$(jq -c '[.theme, .autoCompactEnabled, .cleanupPeriodDays, [.hooks.SessionStart[].hooks[0].command], [.hooks.UserPromptSubmit[].hooks[0].command], (.hooks.PreToolUse[0].matcher), ([.hooks.PostToolUse[].hooks[0].command]|any(test("retired")))]' "$tmp/settings.json")"
want='["dark",true,365,["bash herdr-agent-state.sh session","echo gh-axi >> audit.log","~/dotfiles/scripts/dotfiles-autoupdate status --alarms","~/dotfiles/scripts/axi-session-start"],["other-tool","python3 -I ~/.claude/hooks/turn_context.py"],"Bash",false]'
if [ "$got" = "$want" ]; then echo "ok   merge keeps others' hooks, replaces ours and the axi tools' session hooks, drops retired ones"; else echo "FAIL merge: $got, want $want"; fail=1; fi
cp "$tmp/settings.json" "$tmp/once.json"; rm -f "$tmp/settings.json.before-merge"
bash "$repo/files/.claude/merge-settings.sh" jq "$tmp/settings.json" "$repo/files/.claude/settings.managed.json"
if cmp -s "$tmp/once.json" "$tmp/settings.json" && [ ! -e "$tmp/settings.json.before-merge" ]; then echo "ok   merge is idempotent"; else echo "FAIL merge not idempotent"; fail=1; fi

bash "$repo/files/.claude/merge-settings.sh" jq "$tmp/fresh/.claude/settings.json" "$repo/files/.claude/settings.managed.json"
if [ "$(jq .cleanupPeriodDays "$tmp/fresh/.claude/settings.json")" = 365 ]; then echo "ok   merge creates settings on a fresh machine"; else echo "FAIL merge on a fresh machine"; fail=1; fi
printf '{not json' >"$tmp/bad.json"
if bash "$repo/files/.claude/merge-settings.sh" jq "$tmp/bad.json" "$repo/files/.claude/settings.managed.json" 2>/dev/null \
  && [ "$(cat "$tmp/bad.json")" = '{not json' ]; then echo "ok   merge leaves invalid settings alone and exits 0"; else echo "FAIL merge on invalid settings"; fail=1; fi

exit "$fail"
