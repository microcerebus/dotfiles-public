#!/usr/bin/env bash
# Tests for the Claude Code hooks and the managed-settings merge in
# files/.claude/. Pure: no network, writes only to a temp dir.
# Run: bash tests/claude_hooks_test.sh
set -euo pipefail
# Confine the suite under scripts/test-sandbox (see tests/lib/confine.sh).
# shellcheck source=tests/lib/confine.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/confine.sh"
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
check "blocks docker after x+=1"      2 bash_guard.py "$(bash_cmd 'x+=1 docker run x')"
check "blocks docker after a[0]=1"    2 bash_guard.py "$(bash_cmd 'a[0]=1 docker run x')"
check "blocks env x+=1 docker"        2 bash_guard.py "$(bash_cmd 'env x+=1 docker run x')"
check "allows x+=1 echo docker"       0 bash_guard.py "$(bash_cmd 'x+=1 echo docker')"
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
check "allows a quoted -EOF heredoc body"          0 bash_guard.py "$(bash_cmd $'cat <<\'-EOF\' > n.md\ndocker run x\n-EOF')"
check "allows a quoted @@ heredoc body"            0 bash_guard.py "$(bash_cmd $'cat >n.md <<"@@"\nsudo darwin-rebuild switch --flake .\n@@')"
check "allows a <<\\1 heredoc body"               0 bash_guard.py "$(bash_cmd $'cat >n.md <<\\1\ndocker run x\n1')"
check "blocks a switch after a quoted -EOF heredoc" 2 bash_guard.py "$(bash_cmd $'cat <<\'-EOF\' > n.md\nfoo\n-EOF\ndocker run x')"
check "blocks after a heredoc whose delimiter starts with a space" 2 bash_guard.py "$(bash_cmd $'cat <<\' EOF\' >n.md\nhello\n EOF\ndocker run x')"
check "blocks after a heredoc whose delimiter ends with a space"   2 bash_guard.py "$(bash_cmd $'cat <<\'EOF \' >n.md\nhello\nEOF \ndocker run x')"
check "allows the body of a heredoc whose delimiter has a space"  0 bash_guard.py "$(bash_cmd $'cat <<\' EOF\' >n.md\ndocker run x\n EOF')"
# The shell removes quotes and backslashes from a delimiter word, so these end at EOF, EOFx or E"F.
check "blocks after a <<E\"OF\" heredoc"            2 bash_guard.py "$(bash_cmd $'cat <<E"OF" >n.md\nhello\nEOF\ndocker run x')"
check "blocks after a <<'E'OF heredoc"             2 bash_guard.py "$(bash_cmd $'cat <<\'E\'OF >n.md\nhello\nEOF\ndocker run x')"
check "blocks after a <<\"EOF\"x heredoc"           2 bash_guard.py "$(bash_cmd $'cat <<"EOF"x >n.md\nhello\nEOFx\ndocker run x')"
check "blocks after a <<EOF\"x\" heredoc"           2 bash_guard.py "$(bash_cmd $'cat <<EOF"x" >n.md\nhello\nEOFx\ndocker run x')"
check "blocks after a <<E\\OF heredoc"             2 bash_guard.py "$(bash_cmd $'cat <<E\\OF >n.md\nhello\nEOF\ndocker run x')"
check "blocks after a <<\\E\\OF heredoc"           2 bash_guard.py "$(bash_cmd $'cat <<\\E\\OF >n.md\nhello\nEOF\ndocker run x')"
check "blocks after a <<\"E\\\"F\" heredoc"          2 bash_guard.py "$(bash_cmd $'cat <<"E\\"F" >n.md\nhello\nE"F\ndocker run x')"
check "blocks after a delimiter split by backslash-newline" 2 bash_guard.py "$(bash_cmd $'cat <<EO\\\nF >n.md\nhello\nEOF\ndocker run x')"
check "allows the body of a <<E\"OF\" heredoc"      0 bash_guard.py "$(bash_cmd $'cat <<E"OF" >n.md\ndocker run x\nEOF')"
# Only a line equal to the delimiter ends a body; an indented one is body text whose
# apostrophe must not open a quote that hides the command after the real end.
check "blocks after a doc with an indented EOF line"  2 bash_guard.py "$(bash_cmd $'cat >README.md <<\'EOF\'\nExample:\n\n    cat <<EOF\n    hi\n    EOF\n\nIt\'s done.\nEOF\ndocker run x')"
check "blocks after a commit body with an indented MSG line" 2 bash_guard.py "$(bash_cmd $'git commit -F- <<\'MSG\'\nfix: x\n\n  MSG\nit\'s fine\nMSG\ndocker run x')"
check "blocks after a spaced delimiter with a bare EOF line" 2 bash_guard.py "$(bash_cmd $'cat <<\' EOF\' >n.md\nEOF\ndon\'t\n EOF\ndocker run x')"
check "allows a body with an indented delimiter line" 0 bash_guard.py "$(bash_cmd $'cat >n.md <<\'EOF\'\n    EOF\ndocker run x\nEOF')"
check "allows a body continued past an EOF line"   0 bash_guard.py "$(bash_cmd $'cat >n.md <<EOF\nx\\\nEOF\ndocker run x\nEOF')"
# bash ends a heredoc in $( ) at a line starting with the delimiter and holding a ),
# bash 3.2 at a ) its matcher closes the $( ) with, and both at a backtick that closes `...`.
check "blocks after a \$( ) heredoc ended by EOF)"   2 bash_guard.py "$(bash_cmd $'x=$(cat <<EOF\nhello\nEOF)\ndocker run x')"
check "blocks a command bash 3.2 runs after a ) in a \$( ) body" 2 bash_guard.py "$(bash_cmd $'x=$(cat <<EOF\nsmile :)\ndocker run x\nEOF\n)')"
check "blocks after a backtick heredoc ended by EOF\`" 2 bash_guard.py "$(bash_cmd $'x=`cat <<EOF\nhello\nEOF`\ndocker run x')"
check "allows a commit body with a ) line in \"\$( )\"" 0 bash_guard.py "$(bash_cmd $'git commit -m "$(cat <<\'EOF\'\nfix: x\n\n1) docker run is blocked\nEOF\n)"')"
check "blocks after a <<1 heredoc"                 2 bash_guard.py "$(bash_cmd $'cat >n.md <<1\nIt\'s\n1\ndocker run x')"
check "allows a <<1 heredoc body"                  0 bash_guard.py "$(bash_cmd $'cat >n.md <<1\ndocker run x\n1')"
# shellcheck disable=SC2016 # $[1<<n] is the command text under test
check "blocks after a \$[ ] shift"                 2 bash_guard.py "$(bash_cmd $'echo $[1<<n]\ndocker run x')"
# A delimiter word the guard cannot read ($"...", $'...', ${...}, $(...), a backtick) blocks the
# call, because the guard cannot tell where its body ends.
check "blocks an unread \$\"EOF\" delimiter"          2 bash_guard.py "$(bash_cmd $'cat >n.md <<$"EOF"\nIt\'s\nEOF\ndocker run x')"
check "blocks an unread \"\$(x)\" delimiter"          2 bash_guard.py "$(bash_cmd $'cat <<"$(x)"\nit\'s\n$(x)\ndocker run x\necho \'y\'')"
check "blocks an unread \${X} delimiter"             2 bash_guard.py "$(bash_cmd $'cat <<${X}\nhi\n${X}')"
# shellcheck disable=SC2016 # the arithmetic is the command text under test
check "blocks after a shift by a variable"         2 bash_guard.py "$(bash_cmd $'x=$((1<<n))\ndocker run y')"
check "blocks after a spaced (( )) shift"          2 bash_guard.py "$(bash_cmd $'(( x = 1 << n ))\nsudo darwin-rebuild switch --flake .')"
# shellcheck disable=SC2016 # the arithmetic is the command text under test
check "allows a heredoc after a closed shift"      0 bash_guard.py "$(bash_cmd $'echo $((1<<n)); cat <<EOF >n.md\ndocker run x\nEOF')"
check "allows a heredoc after a quoted (("        0 bash_guard.py "$(bash_cmd $'echo "(("; cat <<EOF >n.md\ndocker run x\nEOF')"
# Nested ( ) and [ ] inside (( )) and $[ ] do not close them early.
check "blocks after a shift past (2*(1)) in (( ))" 2 bash_guard.py "$(bash_cmd $'(( x = (2*(1)) << 3 ))\ndocker run x\n3')"
# shellcheck disable=SC2016 # $[ ] is the command text under test
check "blocks after a shift past a[1] in \$[ ]"     2 bash_guard.py "$(bash_cmd $'echo $[ a[1] << 3 ]\ndocker run x\n3')"
check "allows a heredoc after (( (2*(1)) ))"      0 bash_guard.py "$(bash_cmd $'(( x = (2*(1)) )); cat <<E >n.md\ndocker run x\nE')"
# shellcheck disable=SC2016 # $[ ] is the command text under test
check "allows a heredoc after \$[ a[1] ]"          0 bash_guard.py "$(bash_cmd $'echo $[ a[1] ]; cat <<E >n.md\ndocker run x\nE')"
check "allows a heredoc after (( (1)))"           0 bash_guard.py "$(bash_cmd $'(( (1))); cat <<E >n.md\ndocker run x\nE')"
# A lone ) after (( closes nothing, so the << is a shift and the body reads as code.
check "blocks after a lone ) in a (("              2 bash_guard.py "$(bash_cmd $'((cd x) && cat <<E >n.md\ndocker run x\nE\n)')"
# A << inside ${ }, quoted or not, or inside an a[ ] subscript opens no heredoc.
check "blocks after \${x#<<}"                     2 bash_guard.py "$(bash_cmd $'x=1; echo ${x#<<}\ndocker run x')"
check "blocks after \${line##*<<}"                2 bash_guard.py "$(bash_cmd $'line=\'cat <<EOF\'; d=${line##*<<}\ndocker run x')"
check "blocks after \${x//<</y}"                  2 bash_guard.py "$(bash_cmd $'x=1; echo ${x//<</y}\ndocker run x')"
check "blocks after \${x:-<<}"                    2 bash_guard.py "$(bash_cmd $'echo ${x:-<<}\ndocker run x')"
check "blocks after \"\${x#\"<<\"}\""              2 bash_guard.py "$(bash_cmd $'echo "${x#"<<"}"\ndocker run x')"
check "blocks after an a[1<<2]=3 subscript"        2 bash_guard.py "$(bash_cmd $'a[1<<2]=3\ndocker run x')"
check "allows a heredoc body inside \${x:-\$( )}"   0 bash_guard.py "$(bash_cmd $'echo ${x:-$(cat <<EOF\ndocker run x\nEOF\n)}')"
# A backslash-newline after << is skipped before the delimiter word, as in the shell.
check "blocks after a <<\\<newline> EOF heredoc"   2 bash_guard.py "$(bash_cmd $'cat <<\\\n  EOF\nbody\nEOF\ndocker run x')"
check "allows a <<\\<newline> EOF heredoc body"    0 bash_guard.py "$(bash_cmd $'cat <<\\\n  EOF\ndocker run x\nEOF')"
# bash 3.2 matches the ) of a $( ) before it reads heredocs, skipping quotes, escapes and
# comments, and its open quotes carry past the body end.
check "blocks a command bash 3.2 runs after a quoted ( in a body"  2 bash_guard.py "$(bash_cmd $'x=$(cat <<\'EOF\'\n\'(\' ); docker run x; echo \\(\nEOF\n)')"
check "blocks a command bash 3.2 runs after a commented ( in a body" 2 bash_guard.py "$(bash_cmd $'x=$(cat <<\'EOF\'\n# (\n); docker run x; echo \\(\nEOF\n)')"
check "blocks a command bash 3.2 runs after a quote left open in a body" 2 bash_guard.py "$(bash_cmd $'x=$(cat <<\'EOF\'\nit\'s\nEOF\nx\' )\ndocker run x\necho \'')"
check "allows a 1) line after an apostrophe in a \$( ) body" 0 bash_guard.py "$(bash_cmd $'msg=$(cat <<\'EOF\'\nIt\'s simple: 1) run tests\ndocker run x is blocked\nEOF\n)')"
# Commands inside "$( )" and "${ }" count, and quotes nested in them do not hide later ones.
# shellcheck disable=SC2016 # the $( ) is the command text under test
check "blocks docker in \"\$( )\""                 2 bash_guard.py "$(bash_cmd 'echo "a $(docker run x) b"')"
# shellcheck disable=SC2016 # the $( ) is the command text under test
check "blocks docker in \"\${x:-\$( )}\""           2 bash_guard.py "$(bash_cmd 'echo "${x:-$(docker run x)}"')"
check "blocks after nested quotes in \"\$( )\""     2 bash_guard.py "$(bash_cmd $'echo "$(echo \'a "b\')"; docker run x')"
check "allows nested quotes in \"\$( )\""          0 bash_guard.py "$(bash_cmd $'eval "$(sed -n \'/^echo "main/p\' f)"')"
# zsh reads ' and $' inside "${ }" as literal characters; bash reads them as quotes.
check "blocks after \"\${1:-don't know}\" in zsh"    2 bash_guard.py "$(bash_cmd $'msg="${1:-don\'t know}"\ndocker run x\necho \'ok\'')"
check "blocks after \"\${x/'/}\" in zsh"              2 bash_guard.py "$(bash_cmd $'echo "${x/\'/}"; docker run x; echo \'a\'')"
check "blocks after \"\${x:-\$'a}\" in zsh"           2 bash_guard.py "$(bash_cmd $'echo "${x:-$\'a}"; docker run x; echo \'b\'')"
# Only $( ) and backticks inside "${ }" are commands; the rest is text.
# shellcheck disable=SC2016 # the "${ }" is the command text under test
check "allows \"\${docker}\""                       0 bash_guard.py "$(bash_cmd 'echo "${docker}"')"
# bash reads name[ as a subscript only at the start of a command word; zsh never does.
check "blocks after s/a[ before a heredoc"          2 bash_guard.py "$(bash_cmd $'sed s/a[/b/ <<\'EOF\'\nit\'s\nEOF\ndocker run x\necho \'y\'')"
check "blocks after cat x[ before a heredoc"        2 bash_guard.py "$(bash_cmd $'cat x[ <<\'EOF\'\nit\'s\nEOF\ndocker run x\necho \'y\'')"
check "blocks after a[1<<EOF]=3 read as a heredoc by zsh" 2 bash_guard.py "$(bash_cmd $'a[1<<EOF]=3\nit\'s\nEOF]=3\ndocker run x\necho \'y\'')"
check "blocks a << after a[ it cannot place"        2 bash_guard.py "$(bash_cmd $'>f a[1<<EOF]=3\nhi\nEOF]=3')"
# bash skips time's -p and -- before an a[ ] assignment, and bash 5 reads one after coproc too.
check "blocks after time -p a[1<<EOF]=3"            2 bash_guard.py "$(bash_cmd $'time -p a[1<<EOF]=3\ndocker run x\nEOF]=3')"
check "blocks after time -p -- a[1<<EOF]=3"         2 bash_guard.py "$(bash_cmd $'time -p -- a[1<<EOF]=3\ndocker run x\nEOF]=3')"
check "blocks after coproc a[1<<EOF]=3"             2 bash_guard.py "$(bash_cmd $'coproc a[1<<EOF]=3\ndocker run x\nEOF]=3')"
check "blocks after coproc foo a[1<<EOF]=3"         2 bash_guard.py "$(bash_cmd $'coproc foo a[1<<EOF]=3\ndocker run x\nEOF]=3')"
check "allows time -p a[1<<2]=3"                    0 bash_guard.py "$(bash_cmd 'time -p a[1<<2]=3')"
check "allows time -p with a heredoc"               0 bash_guard.py "$(bash_cmd $'time -p cat <<\'EOF\'\nhi\nEOF')"
# bash 5.3 runs ${ cmd; } and ${| cmd; } as commands; the guard does not read them.
check "blocks a heredoc in bash 5.3 \${ cmd; }"     2 bash_guard.py "$(bash_cmd $'x=${ cat <<\'EOF\'\nit\'s\nEOF\n}\ndocker run x\necho \'y\'')"
# shellcheck disable=SC2016 # the ${ } is the command text under test
check "blocks bash 5.3 \${ docker run x; }"         2 bash_guard.py "$(bash_cmd 'echo ${ docker run x; }')"
# Process substitution reads like $( ); backticks are commands too, quoted or not.
check "blocks a command bash 3.2 runs after a ) in a <( ) body" 2 bash_guard.py "$(bash_cmd $'cat <(cat <<\'EOF\'\n) ; docker run x\nEOF\n)')"
check "blocks a command bash runs after EOF) in a <( ) body"    2 bash_guard.py "$(bash_cmd $'cat <(cat <<\'EOF\'\nEOF) ; docker run x\nEOF\n)')"
# shellcheck disable=SC2016 # the backticks are the command text under test
check "blocks docker in backticks"                  2 bash_guard.py "$(bash_cmd 'echo `docker run x`')"
# shellcheck disable=SC2016 # the backticks are the command text under test
check "blocks docker in quoted backticks"           2 bash_guard.py "$(bash_cmd 'echo "`docker run x`"')"
# The shell cuts out `...` before it reads a # comment inside, so the comment ends at the backtick.
# shellcheck disable=SC2016 # the backticks are the command text under test
check "blocks after a # comment in quoted backticks" 2 bash_guard.py "$(bash_cmd 'echo "`echo a # b`"; docker run x')"
# shellcheck disable=SC2016 # the backticks are the command text under test
check "blocks after two # comments in quoted backticks" 2 bash_guard.py "$(bash_cmd 'echo "`echo # a` and `echo # b`"; docker run x')"
# shellcheck disable=SC2016 # the backticks are the command text under test
check "blocks after a # comment in backticks"     2 bash_guard.py "$(bash_cmd 'echo `echo a # b`; docker run x')"
# shellcheck disable=SC2016 # the backticks are the command text under test
check "blocks after x=\`git log -1 # latest\`"   2 bash_guard.py "$(bash_cmd 'x=`git log -1 # latest`; docker run x')"
# shellcheck disable=SC2016 # the backticks are the command text under test
check "blocks an em dash after #12 in backticks"  2 bash_guard.py "$(bash_cmd 'git commit -q -m "fix: close `#12` a '"${em}"' b"')"
# shellcheck disable=SC2016 # the backticks are the command text under test
check "blocks a backslash in a # comment in backticks" 2 bash_guard.py "$(bash_cmd 'echo `echo # a \` b`; docker run x')"
# shellcheck disable=SC2016 # the backticks are the command text under test
check "allows a # comment in backticks"          0 bash_guard.py "$(bash_cmd 'echo `git log -1 --format=%h # latest`')"
# shellcheck disable=SC2016 # the backticks are the command text under test
check "allows #12 in backticks in a commit"      0 bash_guard.py "$(bash_cmd 'git commit -m "fix: close `#12` a - b"')"
# A heredoc opened inside $( ) is read before one opened earlier outside it.
check "blocks after an outer heredoc read after a \$( ) one" 2 bash_guard.py "$(bash_cmd $'cat <<A; x=$(cat <<B\nb\nB\n)\na\nA\ndocker run x')"
# A heredoc whose $( ) closes on its own line has no body in zsh and bash 3.2; bash 5 reads
# it before the outer one.
check "blocks a command zsh runs after a heredoc in a closed \$( )" 2 bash_guard.py "$(bash_cmd $'x=$(cat <<B)\ndocker run x\nB')"
check "blocks after a heredoc in a closed \$( ) read first by bash" 2 bash_guard.py "$(bash_cmd $'cat <<A; x=$(cat <<B)\nB\nA\ndocker run x\nB')"
# Inside backticks, and inside $( ) for bash 3.2, a backslash-newline joins body lines even
# after a quoted delimiter.
check "blocks after a joined EOF line in a backtick heredoc" 2 bash_guard.py "$(bash_cmd $'x=`cat <<\'EOF\'\nEO\\\nF\ndocker run x\nEOF\n`')"
check "blocks after a joined EOF line in a \$( ) heredoc"   2 bash_guard.py "$(bash_cmd $'x=$(cat <<\'EOF\'\nEO\\\nF\ndocker run x\nEOF\n)')"
# The ) after a case pattern closes no $( ) in zsh and bash; bash 3.2 closes it there.
# shellcheck disable=SC2016 # the $( ) is the command text under test
check "blocks case inside \"\$( )\""                 2 bash_guard.py "$(bash_cmd 'echo "$(case x in x) docker run x;; esac)"')"
# bash reads no heredoc body at a newline inside (( )), $(( )), $[ ] or a bash a[ ] subscript;
# zsh does.
check "blocks after a newline in (( )) with a heredoc pending" 2 bash_guard.py "$(bash_cmd $'cat <<EOF; ((1+\nEOF\n+2))\n\'\nEOF\ndocker run x\n\'')"
check "blocks after two newlines in (( ))"           2 bash_guard.py "$(bash_cmd $'cat <<EOF; ((1+\n2+\nEOF\n+3))\n\'\nEOF\ndocker run x\n\'')"
check "blocks after a newline in \$[ ]"               2 bash_guard.py "$(bash_cmd $'cat <<EOF; echo $[1+\nEOF\n+2]\n\'\nEOF\ndocker run x\n\'')"
check "blocks after a newline in a[ ]"               2 bash_guard.py "$(bash_cmd $'cat <<EOF; a[1+\nEOF\n+2]=3\n\'\nEOF\ndocker run x\n\'')"
check "blocks after a newline in coproc a[ ]"        2 bash_guard.py "$(bash_cmd $'cat <<EOF; coproc a[1+\nEOF\n+2]=3\n\'\nEOF\ndocker run x\n\'')"
check "blocks after a newline in (( )) inside \$( )"  2 bash_guard.py "$(bash_cmd $'x=$(cat <<EOF; ((1+\nEOF\n+2))\n\'\nEOF\ndocker run x\n\')')"
check "blocks after a heredoc and a quoted ((" 2 bash_guard.py "$(bash_cmd $'cat <<EOF; echo \'((\'\nit\'s\nEOF\ndocker run x\necho \'y\'')"
# shellcheck disable=SC2016 # the $( ) is the command text under test
check "blocks case after time -p in \"\$( )\""        2 bash_guard.py "$(bash_cmd 'echo "$(time -p case x in x) docker run x;; esac)"')"
# shellcheck disable=SC2016 # the $( ) is the command text under test
check "blocks case after time -p -- in \"\$( )\""     2 bash_guard.py "$(bash_cmd 'echo "$(time -p -- case x in x) docker run x;; esac)"')"
# shellcheck disable=SC2016 # the $( ) is the command text under test
blanks=$(python3 -I -c 'print("echo \"$(" + " " * 70 + "case x in x) docker run x;; esac)\"")')
check "blocks case after 70 blanks in \"\$( )\""      2 bash_guard.py "$(bash_cmd "$blanks")"
# shellcheck disable=SC2016 # the $( ) is the command text under test
braces=$(python3 -I -c 'print("echo \"$(" + "{ " * 40 + "case x in x) docker run x;; esac; " + "} " * 40 + ")\"")')
check "blocks case after 40 { in \"\$( )\""           2 bash_guard.py "$(bash_cmd "$braces")"
# A case the guard cannot place at command position inside "$( )", as after f(), function f,
# coproc NAME, zsh's repeat or another pattern's ),
# blocks the call; a \; before the word case leaves it an argument.
# shellcheck disable=SC2016 # the $( ) is the command text under test
check "blocks case in a f() { } body in \"\$( )\""   2 bash_guard.py "$(bash_cmd 'echo "$(f() { case x in x) docker run x;; esac; }; f)"')"
# shellcheck disable=SC2016 # the $( ) is the command text under test
check "blocks case as a f() body in \"\$( )\""       2 bash_guard.py "$(bash_cmd 'echo "$(f() case x in x) docker run x;; esac; f)"')"
# shellcheck disable=SC2016 # the $( ) is the command text under test
check "blocks case after function f in \"\$( )\""    2 bash_guard.py "$(bash_cmd 'echo "$(function f case x in x) docker run x;; esac; f)"')"
# shellcheck disable=SC2016 # the $( ) is the command text under test
check "blocks case after coproc NAME in \"\$( )\""   2 bash_guard.py "$(bash_cmd 'echo "$(coproc c case x in x) docker run x;; esac; wait)"')"
# shellcheck disable=SC2016 # the $( ) is the command text under test
check "blocks a nested case in \"\$( )\""            2 bash_guard.py "$(bash_cmd 'echo "$(case y in y) case x in x) :;; esac;; *) :;; esac; docker run x)"')"
# shellcheck disable=SC2016 # the $( ) is the command text under test
check "blocks case after zsh repeat in \"\$( )\""    2 bash_guard.py "$(bash_cmd 'echo "$(repeat 1 { case x in x) docker run x;; esac })"')"
# shellcheck disable=SC2016 # the $( ) is the command text under test
check "blocks zsh case x { after f() in \"\$( )\""   2 bash_guard.py "$(bash_cmd 'echo "$(f() case x { x) docker run x;; }; f)"')"
check "blocks case after f() in a body \$( )"       2 bash_guard.py "$(bash_cmd $'cat <<EOF\n$(f() case x in x) docker run x;; esac; f)\nEOF')"
check "blocks after echo \; case in \"\$( )\""       2 bash_guard.py "$(bash_cmd $'coproc a[1<<\'E\']=3\necho "$(echo \; case x) \'"; docker run x; echo \'"\'')"
# Outside "$( )" and backticks a case the guard cannot place is left as a word, so these pass.
check "allows echo case x in y"                    0 bash_guard.py "$(bash_cmd 'echo case x in y')"
# shellcheck disable=SC2016 # the $( ) is the command text under test
check "allows echo case x in y in an unquoted \$( )" 0 bash_guard.py "$(bash_cmd 'echo $(echo case x in y)')"
# shellcheck disable=SC2016 # the $( ) is the command text under test
check "allows echo in case of in \"\$( )\""          0 bash_guard.py "$(bash_cmd 'echo "$(echo in case of fire) docker run x"')"
# shellcheck disable=SC2016 # the $( ) is the command text under test
check "allows grep -c case in \"\$( )\""             0 bash_guard.py "$(bash_cmd 'n="$(grep -c case README.md)"; echo "$n docker run x"')"
# shellcheck disable=SC2016 # the $( ) is the command text under test
check "allows a case statement in \"\$( )\""         0 bash_guard.py "$(bash_cmd 'os="$(case "$(uname)" in Darwin) echo mac;; *) echo other;; esac)"')"
# bash 3.2's matcher reads ' and " inside a double-quoted ${ } as quotes.
check "blocks a command bash 3.2 runs after \"\${y:-'\"'}\" in a body" 2 bash_guard.py "$(bash_cmd $'x=$(cat <<\'EOF\'\n"${y:-\'"\'}" ) ; docker run x\nEOF\n)')"
# A lone trailing backslash is a literal; $'...' ends at its first unescaped quote.
# shellcheck disable=SC1003 # the trailing backslash is the command text under test
check "blocks docker before a trailing backslash"  2 bash_guard.py "$(bash_cmd 'docker run x \')"
check "blocks a bash -c script with a trailing backslash" 2 bash_guard.py "$(bash_cmd "bash -c 'docker run x \\'")"
check "blocks after \$'it\\'s'"                    2 bash_guard.py "$(bash_cmd $'echo $\'it\\\'s\'; docker run x; echo \'bye\'')"
# An unquoted heredoc body is read as if in double quotes: its $( ), ${ } and backticks run,
# and its quotes are literal. A quoted delimiter (<<'EOF', <<"EOF", <<\EOF, <<E"O"F) keeps it data.
check "blocks \$( ) in an unquoted heredoc body"        2 bash_guard.py "$(bash_cmd $'cat <<EOF\n$(docker run x)\nEOF')"
check "blocks backticks in an unquoted heredoc body"    2 bash_guard.py "$(bash_cmd $'cat <<EOF\n`docker run x`\nEOF')"
check "blocks \$( ) in a <<- heredoc body"              2 bash_guard.py "$(bash_cmd $'cat <<-EOF\n\t$(docker run x)\n\tEOF')"
check "blocks \$( ) between literal quotes in a body"   2 bash_guard.py "$(bash_cmd $'cat <<EOF\nit\'s \'$(docker run x)\'\nEOF')"
check "blocks \${y:-\$( )} in a heredoc body"            2 bash_guard.py "$(bash_cmd $'cat <<EOF\n${y:-$(docker run x)}\nEOF')"
check "blocks \$( ) in a body inside \$( )"              2 bash_guard.py "$(bash_cmd $'x=$(cat <<EOF\n$(docker run x)\nEOF\n)')"
check "blocks \$( ) in a body inside backticks"         2 bash_guard.py "$(bash_cmd $'x=`cat <<EOF\n$(docker run x)\nEOF\n`')"
# Inside backticks the shell drops the \ before $, ` and \ before it reads a heredoc there, so
# an unquoted body that holds one is Unreadable. A quoted body stays data.
check "blocks \\\$( ) in a body inside backticks"        2 bash_guard.py "$(bash_cmd $'x=`cat <<EOF\n\\$(docker run x)\nEOF\n`')"
check "blocks \\\` in a body inside backticks"            2 bash_guard.py "$(bash_cmd $'x=`cat <<EOF\n\\`docker run x\\`\nEOF\n`')"
check "blocks after a joined EO\\\\ line in a backtick heredoc" 2 bash_guard.py "$(bash_cmd $'x=`cat <<EOF\nEO\\\\\nF\ndocker run x\nEOF\n`')"
check "blocks \\\$( ) in a backtick heredoc inside a body" 2 bash_guard.py "$(bash_cmd $'cat <<EOF\n`cat <<B\n\\$(docker run x)\nB\n`\nEOF')"
check "allows \\\$( ) in a quoted body inside backticks" 0 bash_guard.py "$(bash_cmd $'x=`cat <<\'EOF\'\n\\$(docker run x)\nEOF\n`')"
check "allows a plain body inside backticks"            0 bash_guard.py "$(bash_cmd $'x=`cat <<EOF\nhello $USER, docker run x\nEOF\n`')"
check "blocks a multi-line \$( ) in a body"              2 bash_guard.py "$(bash_cmd $'cat <<EOF\n$(echo a\ndocker run x\n)\nEOF')"
check "blocks \$( ) in a heredoc nested in a body"      2 bash_guard.py "$(bash_cmd $'cat <<EOF\n$(cat <<B\n$(docker run x)\nB\n)\nEOF')"
check "blocks \$( ) in the second heredoc's body"       2 bash_guard.py "$(bash_cmd $'cat <<A <<B\na\nA\n$(docker run x)\nB')"
check "blocks a \$\\<newline>( ) in a body"              2 bash_guard.py "$(bash_cmd $'cat <<EOF\n$\\\n(docker run x)\nEOF')"
check "blocks a git commit -F - body's \$( )"            2 bash_guard.py "$(bash_cmd $'git commit -F - <<EOF\nfeat: x\n\n$(docker run x)\nEOF')"
# zsh reads ' inside a body's ${ } as a literal character, bash as a quote.
check "blocks a \$( ) zsh runs after \${x#'} in a body"  2 bash_guard.py "$(bash_cmd $'cat <<EOF\n${x#\'}\n$(docker run x)\nEOF')"
check "allows \$( ) in a <<'EOF' body"                  0 bash_guard.py "$(bash_cmd $'cat <<\'EOF\'\n$(docker run x)\n`docker run x`\nEOF')"
check "allows \$( ) in a <<\"EOF\" body"                 0 bash_guard.py "$(bash_cmd $'cat <<"EOF"\n$(docker run x)\nEOF')"
check "allows \$( ) in a <<\\EOF body"                  0 bash_guard.py "$(bash_cmd $'cat <<\\EOF\n$(docker run x)\nEOF')"
check "allows \$( ) in a <<E\"O\"F body"                 0 bash_guard.py "$(bash_cmd $'cat <<E"O"F\n$(docker run x)\nEOF')"
check "allows an escaped \\\$( ) in a body"              0 bash_guard.py "$(bash_cmd $'cat <<EOF\n\\$(docker run x)\nEOF')"
check "blocks \$( ) after a \" in a body"            2 bash_guard.py "$(bash_cmd $'cat <<EOF\n"$(docker run x)"\nEOF')"
check "allows an unquoted body with \$VAR and \`date\`"  0 bash_guard.py "$(bash_cmd $'cat >n.md <<EOF\nHi $USER, it\'s `date` "${HOME:-x}" $((1 << 2))\n- docker run x\nEOF')"
check "blocks docker after a body with a lone \""       2 bash_guard.py "$(bash_cmd $'cat <<EOF\n"\nEOF\ndocker run x')"
# Many unclosed quotes, or a long command that needs many passes: the guard gives up and blocks
# well inside the 5 s hook timeout. check_cpu measures the guard's CPU time, which a busy machine
# does not stretch the way it stretches wall time.
check_cpu() { # check_cpu <name> <expected-exit> <max-cpu-seconds> <stderr-text> <json>
  local name="$1" want="$2" max="$3" text="$4" json="$5" got cpu
  read -r got cpu < <(printf '%s' "$json" | python3 -I -c '
import resource, subprocess, sys
p = subprocess.run([sys.executable, "-I", sys.argv[1]], stdout=subprocess.DEVNULL, stderr=open(sys.argv[2], "w"))
r = resource.getrusage(resource.RUSAGE_CHILDREN)
print(p.returncode, round(r.ru_utime + r.ru_stime, 2))' "$hooks/bash_guard.py" "$tmp/err")
  if [ "$got" = "$want" ] && { [ -z "$text" ] || grep -qF "$text" "$tmp/err"; } && awk -v c="$cpu" -v m="$max" 'BEGIN { exit !(c <= m) }'; then
    echo "ok   $name"
  else
    echo "FAIL $name: exit $got after $cpu s of CPU, want $want within $max s saying '$text'"; cat "$tmp/err"; fail=1
  fi
}
# shellcheck disable=SC2016 # the $( is the command text under test
many=$(python3 -I -c 'print("echo " + "\"$( " * 3000 + "\ndocker run x")')
check_cpu "blocks 3000 unclosed \"\$( within 1 s of CPU" 2 1 'too many unclosed quotes' "$(bash_cmd "$many")"
# About 2.1 s of CPU on Python 3.9 and 1.1 s on 3.14: the work budget's whole allowance.
# shellcheck disable=SC2016 # the $( is the command text under test
big=$(python3 -I -c 'print("echo " + "\"$( " * 31 + "a " * 100000)')
check_cpu "blocks 31 unclosed \"\$( in 200 KB within 4 s of CPU" 2 4 'too long or too tangled' "$(bash_cmd "$big")"
# Joined body lines, long quoted words and long unquoted bodies are read in linear time.
joined=$(python3 -I -c 'print("cat <<EOF\n" + "x\\\n" * 250000 + "y\nEOF\ndocker run x")')
check_cpu "blocks docker after a 750 KB joined heredoc body within 2 s of CPU" 2 2 'starting containers' "$(bash_cmd "$joined")"
# Each word and simple command is charged too, so many short commands cannot outrun the budget.
short=$(python3 -I -c 'print("a;" * 200000)')
check_cpu "blocks 200,000 short commands within 3 s of CPU" 2 3 'too long or too tangled' "$(bash_cmd "$short")"
# The commit, handoff and heredoc checks read each $( ) text and each distinct body once.
# shellcheck disable=SC2016 # the $( ) is the command text under test
commits=$(python3 -I -c 'print("git commit -m \"$(a)\";" * 40000)')
check_cpu "blocks 40,000 commit messages with \$( ) within 3 s of CPU" 2 3 'too long or too tangled' "$(bash_cmd "$commits")"
# shellcheck disable=SC2016 # the $( ) is the command text under test
echoes=$(python3 -I -c 'print("echo \"$(a)\" > .resume/x\n" * 40000)')
check_cpu "blocks 40,000 echo lines into a resume note within 3 s of CPU" 2 3 'too long or too tangled' "$(bash_cmd "$echoes")"
bodies=$(python3 -I -c 'print("".join(f"cat <<E\n{i}\nE\n" for i in range(40000)))')
check_cpu "blocks 40,000 distinct heredoc bodies within 3 s of CPU" 2 3 'too long or too tangled' "$(bash_cmd "$bodies")"
# At 10,000 each, these take 10-26 s when the texts and bodies are read once per message or line,
# and 0.4-0.9 s on Python 3.9 to 3.14 when read once per reading; 4 s leaves room for a slow core.
# shellcheck disable=SC2016 # the $( ) is the command text under test
commits=$(python3 -I -c 'print("git commit -m \"$(a)\";" * 10000)')
check_cpu "allows 10,000 commit messages with \$( ) within 4 s of CPU" 0 4 '' "$(bash_cmd "$commits")"
# shellcheck disable=SC2016 # the $( ) is the command text under test
echoes=$(python3 -I -c 'print("echo \"$(a)\" > .resume/x\n" * 10000)')
check_cpu "allows 10,000 echo lines into a resume note within 4 s of CPU" 0 4 '' "$(bash_cmd "$echoes")"
bodies=$(python3 -I -c 'print("".join(f"cat <<E\n{i}\nE\n" for i in range(10000)))')
check_cpu "allows 10,000 distinct heredoc bodies within 4 s of CPU" 0 4 '' "$(bash_cmd "$bodies")"
# Each newline is charged for the heredocs still waiting for their bodies.
# shellcheck disable=SC2016 # the $( is the command text under test
waiting=$(python3 -I -c 'print("cat " + "<<E " * 400 + "$(" + "\n" * 40000 + ")")')
check_cpu "blocks 400 heredocs waiting over 40,000 newlines within 3 s of CPU" 2 3 'too long or too tangled' "$(bash_cmd "$waiting")"
# shellcheck disable=SC2016 # the $HOME is the command text under test
script=$(python3 -I -c 'print("cd /tmp && ls -la | grep x; echo \"$HOME\" > f\n" * 2000)')
check_cpu "allows a 2,000-line script of short commands within 1 s of CPU" 0 1 '' "$(bash_cmd "$script")"
pyc=$(python3 -I -c 'print("python3 -c \x27" + "x = {\"a\": [1, 2]}; print(x[\"a\"][0])\n" * 5000 + "\x27")')
check_cpu "allows a 200 KB python3 -c script within 1 s of CPU" 0 1 '' "$(bash_cmd "$pyc")"
# split_words() splits as shlex does with the guard's settings, in linear time: all short strings of
# a few characters, and random longer ones.
shlex_diff=$(python3 -I - "$hooks" <<'EOF'
import itertools, random, shlex, sys
sys.path.insert(0, sys.argv[1])
from bash_guard import split_words
def split(code, words):
    try:
        return list(words(code))
    except ValueError as e:
        return str(e)
def ref(code):
    lex = shlex.shlex(code, posix=True, punctuation_chars=';&|()\n')
    lex.whitespace, lex.whitespace_split, lex.commenters = ' \t\r', True, ''
    return lex
rnd = random.Random(7)
chars = list("ab \t\r\n;&|()'\"\\$`#=\x0b\x00\u00e9")
short = (''.join(t) for n in range(1, 5) for t in itertools.product("a \n;('\"\\", repeat=n))
longer = (''.join(rnd.choice(chars) for _ in range(rnd.randint(1, 60))) for _ in range(20000))
print(*[repr(c) for c in itertools.chain(short, longer) if split(c, ref) != split(c, split_words)][:3])
EOF
)
if [ -z "$shlex_diff" ]; then echo "ok   split_words() splits as shlex does"; else echo "FAIL split_words() differs from shlex on: $shlex_diff"; fail=1; fi
# shellcheck disable=SC2016 # the $( ) is the command text under test
notes=$(python3 -I -c 'print("cat >n.md <<EOF\n" + "- $(date) item, it\x27s \"quoted\" and `uname`\n" * 2000 + "EOF")')
check_cpu "allows a 2,000-line unquoted heredoc with \$( ) within 1 s of CPU" 0 1 '' "$(bash_cmd "$notes")"
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
# shellcheck disable=SC2016 # the $( ) is the command text under test
check "blocks em dash in -m \"\$(printf ...)\"" 2 bash_guard.py "$(bash_cmd "git commit -q -m \"\$(printf 'fix: a ${em} b')\"")"
# shellcheck disable=SC2016 # the ${ } is the command text under test
check "blocks em dash in -m \"\${MSG:-...}\""   2 bash_guard.py "$(bash_cmd "git commit -q -m \"\${MSG:-fix: a ${em} b}\"")"
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
# shellcheck disable=SC2016 # the $( ) is the command text under test
check "blocks still-hosted printf in \"\$( )\" into .resume" 2 bash_guard.py "$(bash_cmd 'echo "$(printf '"'worker still hosted in thread x'"')" > .resume/note.md')"
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
