# Table test for nix/activation-sudo-lint.nix: each crafted activate text
# must pass, or fail with the named rules. Returns the list of cases that did
# not; flake.nix turns a non-empty list into a `nix flake check` failure.
# Pure evaluation: nothing here runs a shell or a sudo.
# Case names starting B, F or m are the probes and mutant gaps of the
# round-3 review (B: must fail, F: must pass, m: a mutant the table missed);
# b, f and M1 name the round-4 review's probes and its must-fix; r5 names
# the round-5 check's should-fixes.
{ lib }:

let
  lint = import ../nix/activation-sudo-lint.nix { inherit lib; };
  prefix = "/opt/homebrew";
  brewPath = ''PATH="/opt/homebrew/bin:/nix/store/x-mas-7.0.0/bin:$PATH"'';
  bp = "PATH=/opt/homebrew/bin:$PATH";
  su = "sudo --user=myuser";
  sudoArgs = "--preserve-env=PATH --user=myuser --set-home env HOMEBREW_NO_AUTO_UPDATE=1 brew bundle --file='/nix/store/x-Brewfile'";

  # The function first, as nix/activation-sudo.nix puts it, then the line.
  after = line: "#!/usr/bin/env bash\n${lint.fnDef}\n${line}\n";

  # Rule ids, as lint.problems names them (a typo here fails the eval).
  r = lib.genAttrs [ "count" "order" "redefine" "bypass" "start" "notSudo" "user" "quote" "heredoc" "gone" ] lib.id;

  # nix-darwin's probe for an unmanaged Nix (activate lines 8-25 on
  # 26 Oct): a multi-line "$(...)" holding comments with backticks, a
  # nested $( ), quoted words and a `\` continuation.
  nixProbe = ''
    PATH="/nix/store/x-gnugrep/bin:/nix/store/x-coreutils/bin$(
      # If `nix.enable` is off, there might be an unmanaged Nix
      # `$PATH`. Search for it directly to avoid polluting the
      if nixEnvPath=$(
        PATH="$HOME/.nix-profile/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" command -v nix-env
      ); then
        printf ':'
        /nix/store/x-coreutils/bin/dirname -- "$(
          /nix/store/x-coreutils/bin/readlink \
            --canonicalize-missing \
            -- "$nixEnvPath"
        )"
      fi
    ):/usr/bin:/bin:/usr/sbin:/sbin"
  '';

  # Generated text with the mix of today's activate (992 lines on 26 Oct):
  # quotes, $( ), ${ }, comments. A scan whose depth grows with the text
  # overflows max-call-depth on 30 times this, or on today's size plus
  # one 3000-line plist.
  activateLike = lines: lib.concatStrings (lib.replicate (lines / 4) "x=\"$(echo 'a')\"\ny=\${z}\nfalse # c\ntrue\n");
  # Without the spine forcing in strict, `done` becomes a chain of `++`
  # thunks that costs no max-call-depth but crashes nix natively when forced
  # (measured 28 Oct: rc 139 from 60000 such lines; 50000 passed). Lines of
  # one word make the most steps for the least eval time. Nix 2.35.3: crash
  # between 50000 and 55000 lines (measured 29 Oct); re-measure after a Nix
  # upgrade, since a Nix that spends less stack per frame could pass 70000.
  oneWord = lines: lib.concatStrings (lib.replicate lines "t\n");
  plist = lines: "defaults write x y '<plist>\n" + lib.concatStrings (lib.replicate lines "  <key>k</key><integer>1</integer>\n") + "</plist>'";

  # { name; text; fails = [ rule ... ]; } with fails = [ ] for a pass.
  # homebrew = true checks the text as config.homebrew.enable would.
  cases = [
    # Upstream shapes and other text that must pass.
    { name = "upstream brew bundle line"; homebrew = true; text = after "  ${brewPath} sudo ${sudoArgs} --no-upgrade --zap --force-cleanup"; fails = [ ]; }
    { name = "cleanup = check, inside $(...)"; homebrew = true; text = after "  homebrewCleanupResult=$(${brewPath} sudo ${sudoArgs} --cleanup) || homebrewCleanupExitCode=$?"; fails = [ ]; }
    { name = "homebrew off, no PATH line (c1)"; homebrew = false; text = after "true"; fails = [ ]; }
    { name = "/usr/bin/sudo behind the prefix"; text = after "${brewPath} /usr/bin/sudo ${sudoArgs}"; fails = [ ]; }
    { name = "unquoted sbin prefix, sudo -u"; text = after "PATH=/opt/homebrew/sbin:$PATH sudo -u myuser true"; fails = [ ]; }
    { name = "single-quoted prefix"; text = after "PATH='/opt/homebrew/bin' ${su} true"; fails = [ ]; }
    { name = "prefix inside \"$(...)\""; text = after "x=\"$(${bp} ${su} true)\""; fails = [ ]; }
    { name = "launchctl asuser sudo, no prefix"; text = after "launchctl asuser 501 sudo --user=myuser -- defaults write x y -bool true"; fails = [ ]; }
    { name = "bare sudo, no prefix"; text = after "sudo mv /etc/hosts.new /etc/hosts"; fails = [ ]; }
    { name = "commented-out bad line"; text = after "# env PATH=\"/opt/homebrew/bin:$PATH\" sudo true"; fails = [ ]; }
    { name = "sudo as a later word"; text = after "echo no sudo here; command -v true"; fails = [ ]; }
    { name = "nix-darwin's PATH probe (activate lines 8-25)"; text = after "${nixProbe}${brewPath} ${su} true"; fails = [ ]; }
    { name = "r5 \"$(...)\" inside the Homebrew PATH"; text = after "PATH=\"/opt/homebrew/bin:$(true)\" ${su} true"; fails = [ ]; }
    { name = "r5 unquoted $(...) inside the Homebrew PATH"; text = after "PATH=/opt/homebrew/bin:$(true) ${su} true"; fails = [ ]; }
    { name = "r5 multi-line \"$(...)\" inside the Homebrew PATH"; text = after "PATH=\"/opt/homebrew/bin$(\n  printf ':'\n  echo \"x\"\n):$PATH\" ${su} true"; fails = [ ]; }
    { name = "r5 ; inside a quoted Homebrew PATH"; text = after "PATH=\"/opt/homebrew/bin;x\" ${su} true"; fails = [ ]; }
    { name = "r5 quoted part later in the PATH word"; text = after "PATH=/opt/homebrew/bin:\"$PATH\":'/x y' ${su} true"; fails = [ ]; }
    { name = "r5 \${...} and \\ escapes in the PATH word"; text = after "PATH=\"/opt/homebrew/bin:\${PATH}\\\"\":\${HOME}/b\\ c ${su} true"; fails = [ ]; }
    { name = "M1 30 times activate's size"; text = after "${activateLike (30 * 992)}${bp} ${su} true"; fails = [ ]; }
    { name = "M1 activate's size, then a 3000-line plist"; text = after "${activateLike 992}${bp} ${su} true\n${plist 3000}"; fails = [ ]; }
    { name = "r5 70000 one-word lines (strict forces the list spines)"; text = after "${oneWord 70000}${bp} ${su} true"; fails = [ ]; }

    # The function itself.
    { name = "function missing"; text = "${brewPath} sudo ${sudoArgs}\n"; fails = [ r.count ]; }
    { name = "function defined twice"; text = after lint.fnDef; fails = [ r.count ]; }
    { name = "prefix line before the function"; text = "${brewPath} ${su} true\n${lint.fnDef}\n"; fails = [ r.order ]; }
    { name = "b06 function defined only in a subshell"; text = "(\n${lint.fnDef}\n)\n${brewPath} sudo -u myuser true\n"; fails = [ r.count ]; }
    { name = "another sudo function"; text = after "sudo() { echo; }"; fails = [ r.redefine ]; }
    { name = "function keyword"; text = after "function sudo { echo; }"; fails = [ r.redefine ]; }
    { name = "unset sudo"; text = after "unset sudo"; fails = [ r.redefine ]; }
    { name = "unset -f sudo"; text = after "unset -f sudo"; fails = [ r.redefine ]; }
    { name = "unset -f, sudo not first"; text = after "unset -f foo sudo"; fails = [ r.redefine ]; }
    { name = "B9 unset -f \"sudo\""; text = after "unset -f \"sudo\""; fails = [ r.redefine ]; }

    # Forms that skip the function.
    { name = "command sudo"; text = after "command sudo true"; fails = [ r.bypass ]; }
    { name = "command -p sudo"; text = after "command -p sudo true"; fails = [ r.bypass ]; }
    { name = "exec sudo"; text = after "exec sudo true"; fails = [ r.bypass ]; }
    { name = "exec -a name sudo"; text = after "exec -a x sudo true"; fails = [ r.bypass ]; }
    { name = "builtin sudo"; text = after "builtin sudo true"; fails = [ r.bypass ]; }
    { name = "command sudo behind the prefix"; text = after "${brewPath} command sudo true"; fails = [ r.bypass r.notSudo ]; }

    # The prefix where a program other than this shell reads it.
    { name = "env PATH=... sudo (review u6)"; text = after "env ${brewPath} ${su} true"; fails = [ r.start ]; }
    { name = "bash -c '...' (review u7)"; text = after "bash -c '${brewPath} ${su} true'"; fails = [ r.start ]; }
    { name = "sh -c \"...\""; text = after "sh -c \"PATH=/opt/homebrew/bin:\\$PATH ${su} true\""; fails = [ r.start ]; }
    { name = "launchctl asuser env PATH=..."; text = after "launchctl asuser 501 env ${brewPath} ${su} true"; fails = [ r.start ]; }
    { name = "export, then sudo"; text = after "export ${brewPath}\nsudo true"; fails = [ r.start r.notSudo ]; }
    { name = "after a pipe"; text = after "echo | ${brewPath} ${su} true"; fails = [ r.start ]; }
    { name = "second prefix on the line"; text = after "${brewPath} ${su} a; ${brewPath} ${su} b"; fails = [ r.start ]; }
    { name = "B1 bash -c '$(...)'"; text = after "bash -c '$(${bp} ${su} true)'"; fails = [ r.start ]; }
    { name = "B2 sh -c \"\\$(...)\""; text = after "sh -c \"\\$(PATH=/opt/homebrew/bin:\\$PATH ${su} true)\""; fails = [ r.start ]; }
    { name = "B11 bash -c $'...'"; text = after "bash -c $'${bp} ${su} true'"; fails = [ r.start ]; }
    { name = "m17 $(...) earlier on the line than env PATH="; text = after "echo $(true); env ${bp} ${su} true"; fails = [ r.start ]; }
    { name = "# inside a word is not a comment"; text = after "x=a#b; env ${bp} ${su} true"; fails = [ r.start ]; }
    { name = "m15 no newline at the end"; text = "${lint.fnDef}\nenv ${bp} ${su} true"; fails = [ r.start ]; }
    { name = "b21 bash -c $'\\n...'"; text = after "bash -c $'\\n${bp} sudo -u myuser true\\n'"; fails = [ r.start ]; }
    { name = "b38 bash -c $'true\\t...'"; text = after "bash -c $'true\\t${bp} sudo -u myuser true'"; fails = [ r.start ]; }
    { name = "b37 printf '...\\n...' | bash"; text = after "printf 'true\\n${bp} sudo -u myuser true\\n' | bash"; fails = [ r.start ]; }
    { name = "r5 bash -c $'true\\x0a...'"; text = after "bash -c $'true\\x0a${bp} ${su} true'"; fails = [ r.start ]; }
    { name = "r5 bash -c $'true\\012...'"; text = after "bash -c $'true\\012${bp} ${su} true'"; fails = [ r.start ]; }
    { name = "r5 bash -c $'true\\u000a...'"; text = after "bash -c $'true\\u000a${bp} ${su} true'"; fails = [ r.start ]; }
    { name = "r5 bash -c $'true\\cJ...'"; text = after "bash -c $'true\\cJ${bp} ${su} true'"; fails = [ r.start ]; }
    { name = "r5 printf '...\\012...' | bash"; text = after "printf 'true\\012${bp} ${su} true\\n' | bash"; fails = [ r.start ]; }
    { name = "m27 \\ + newline inside $'...' keeps a gap"; text = after "bash -c $'true\\\n${bp} ${su} true'"; fails = [ r.start ]; }
    { name = "b07 \\ + newline, then #"; text = after "x=y\\\n#; env ${bp} ${su} true"; fails = [ r.start ]; }
    {
      name = "f01 env PATH=... behind sudo --user";
      text = after "${su} env ${bp} brew bundle";
      fails = [ r.start r.notSudo ];
      has = "even when that program runs as another user";
    }

    # Something other than sudo behind the prefix, or sudo staying root.
    { name = "env behind the prefix (review u2)"; text = after "${brewPath} env sudo true"; fails = [ r.notSudo ]; }
    { name = "brew run directly as root"; text = after "PATH=/opt/homebrew/sbin:$PATH brew bundle"; fails = [ r.notSudo ]; }
    { name = "b01 PATH=...; sudo (a plain assignment)"; text = after "${bp}; sudo -u myuser true\nlaunchctl list"; fails = [ r.notSudo ]; }
    { name = "r5 PATH=\"...\"; sudo (a plain assignment)"; text = after "PATH=\"/opt/homebrew/bin\"; sudo -u myuser true\nlaunchctl list"; fails = [ r.notSudo ]; }
    { name = "r5 sudo inside an unquoted \${...} is part of the PATH word"; text = after "PATH=/opt/homebrew/bin:\${x:- sudo -u myuser } brew bundle"; fails = [ r.notSudo ]; }
    { name = "r5 sudo inside a quoted \${...} is part of the PATH word"; text = after "PATH=\"/opt/homebrew/bin:\${x:-\" sudo -u myuser \"}\" brew bundle"; fails = [ r.notSudo ]; }
    { name = "r5 sudo after \\ + space is part of the PATH word"; text = after "PATH=/opt/homebrew/bin\\ sudo -u myuser brew bundle"; fails = [ r.notSudo ]; }
    { name = "rv1 $'...' in the PATH word"; text = after "PATH=/opt/homebrew/bin$' sudo -u myuser ' brew bundle"; fails = [ r.notSudo ]; }
    { name = "rv1 $'\\'...' in the PATH word"; text = after "PATH=/opt/homebrew/bin$'\\' sudo -u myuser true \\'' brew bundle"; fails = [ r.notSudo ]; }
    { name = "rv1 $\"...\" in the PATH word"; text = after "PATH=/opt/homebrew/bin$\" sudo -u myuser \" brew bundle"; fails = [ r.notSudo ]; }
    { name = "rv1 \"...$\" ends the quote"; text = after "PATH=\"/opt/homebrew/bin$\" brew \" sudo -u myuser true\""; fails = [ r.notSudo ]; }
    { name = "rv1 quoted } inside \"\${...}\""; text = after "PATH=\"/opt/homebrew/bin\${x:-\"}\" sudo -u myuser true }\" brew bundle"; fails = [ r.notSudo ]; }
    { name = "rv1 quoted } inside unquoted \${...}"; text = after "PATH=/opt/homebrew/bin\${x:-'} sudo -u myuser true '} brew bundle"; fails = [ r.notSudo ]; }
    { name = "B6 sudo with no --user"; text = after "${bp} sudo env true"; fails = [ r.user ]; }
    { name = "B6b sudo -u root"; text = after "${bp} sudo -u root env true"; fails = [ r.user ]; }
    { name = "sudo --user=0"; text = after "${bp} sudo --user=0 env true"; fails = [ r.user ]; }
    { name = "sudo -u '#0'"; text = after "${bp} sudo -u '#0' env true"; fails = [ r.user ]; }
    { name = "sudo --user=\"root\""; text = after "${bp} sudo --user=\"root\" env true"; fails = [ r.user ]; }
    { name = "sudo -u from a variable"; text = after "${bp} sudo -u \"$USER\" env true"; fails = [ r.user ]; }
    { name = "sudo -u, then -u root"; text = after "${bp} sudo -u myuser -u root env true"; fails = [ r.user ]; }
    { name = "sudo -Eu root"; text = after "${bp} sudo -Eu root env true"; fails = [ r.user ]; }
    { name = "sudo -u myuser, then -Eu root"; text = after "${bp} sudo -u myuser -Eu root env true"; fails = [ r.user ]; }
    { name = "--user after the command"; text = after "${bp} sudo env --user=myuser true"; fails = [ r.user ]; }
    { name = "m25 sudo --user=myuser, then --user=root"; text = after "${bp} sudo --user=myuser --user=root env true"; fails = [ r.user ]; }
    { name = "b02 sudo -u myuser -p x -u root"; text = after "${bp} sudo -u myuser -p x -u root env true"; fails = [ r.user ]; }
    { name = "b03 sudo -u myuser -g staff -u root"; text = after "${bp} sudo -u myuser -g staff -u root env true"; fails = [ r.user ]; }
    { name = "b04 sudo -u myuser --us=root"; text = after "${bp} sudo -u myuser --us=root env true"; fails = [ r.user ]; }
    { name = "sudo -u myuser, then -u with no user"; text = after "${bp} sudo -u myuser -u"; fails = [ r.user ]; }
    { name = "sudo -EHu myuser"; text = after "${bp} sudo -EHu myuser true"; fails = [ ]; }
    { name = "r5 sudo -pu myuser (-p takes u as its prompt)"; text = after "${bp} sudo -pu myuser true"; fails = [ r.user ]; }

    # The homebrew step's PATH line is gone while homebrew is on.
    { name = "B10 brew bundle moved to a store script"; homebrew = true; text = after "/nix/store/x-brew-bundle"; fails = [ r.gone ]; }

    # Shapes that span lines: the rules read logical lines.
    { name = "env \\ continuation (round 3)"; text = after "env \\\n  ${brewPath} ${su} brew bundle"; fails = [ r.start ]; }
    { name = "bash -c '...' over lines (round 3)"; text = after "bash -c '\n${brewPath} ${su} brew bundle\n'"; fails = [ r.start ]; }
    { name = "bash -c, prefix two lines in"; text = after "bash -c '\necho hi\n${brewPath} ${su} true\n'"; fails = [ r.start ]; }
    { name = "sh -c \"...\" over lines"; text = after "sh -c \"\nPATH=/opt/homebrew/bin:\\$PATH ${su} true\n\""; fails = [ r.start ]; }
    { name = "B3 bash -c \"...\" over lines inside \"$(...)\""; text = after "x=\"$(\n  bash -c \"\nPATH=/opt/homebrew/bin:\\$PATH ${su} true\n\"\n)\""; fails = [ r.start ]; }
    { name = "B4 $'\\'' then bash -c '...' over lines"; text = after "echo $'\\''\nbash -c '\n${bp} ${su} true\ntrue\\'"; fails = [ r.start ]; }
    { name = "B5 array over lines, run later"; text = after "cmd=(env\n${bp} ${su} true)\n\"\${cmd[@]}\""; fails = [ r.start ]; }
    { name = "b05 comment inside an array over lines"; text = after "cmd=(env # note\n  ${bp} ${su} true)\n\"\${cmd[@]}\""; fails = [ r.start ]; }
    { name = "m02 subshell over lines"; text = after "(\n${bp} ${su} true\n)"; fails = [ ]; }
    { name = "m03 ; then a comment with an apostrophe"; text = after "true;# x'\n${bp} ${su} true"; fails = [ ]; }
    { name = "m05 apostrophe inside \"...\""; text = after "echo \"don't\"\n${bp} ${su} true"; fails = [ ]; }
    { name = "continued line, then the prefix"; text = after "echo a \\\n  b\n${brewPath} ${su} true"; fails = [ ]; }
    { name = "prefix line continued"; text = after "${brewPath} \\\n  sudo ${sudoArgs}"; fails = [ ]; }
    { name = "multi-line quoted string, then the prefix"; text = after "defaults write x y '<plist>\n<true/>\n</plist>'\n${brewPath} ${su} true"; fails = [ ]; }
    { name = "comment with an apostrophe"; text = after "true # don't\n${brewPath} ${su} true"; fails = [ ]; }
    { name = "F1 prefix line after echo \"x\" in a multi-line \"$(...)\""; text = after "out=\"$(\n  echo \"x\"\n  PATH=\"/opt/homebrew/bin:$PATH\" ${su} true\n)\""; fails = [ ]; }
    { name = "F4 $'...' with an escaped quote"; text = after "printf $'it\\'s\\n'\n${bp} ${su} true"; fails = [ ]; }
    { name = "F6 \${y%% #*}, then a quote"; text = after "x=\${y%% #*}; echo 'a'\n${bp} ${su} true"; fails = [ ]; }
    { name = "F7 escapeShellArg apostrophe"; text = after "defaults write x y 'it'\\''s'\n${bp} ${su} true"; fails = [ ]; }
    { name = "m07 \\\" inside a double-quoted string"; text = after "echo \"a \\\" b\"\n${bp} ${su} true"; fails = [ ]; }
    {
      name = "line numbers count physical lines";
      text = "echo a \\\n  b\necho 'c\nd'\n${brewPath} ${su} true\n${lint.fnDef}\n";
      fails = [ r.order ];
      has = "activate line 5, function at line 6";
    }

    # Text the lint cannot read fails closed.
    { name = "unpaired quote"; text = after "echo it's\n${bp} ${su} true"; fails = [ r.quote r.start ]; has = "activate line 3"; }
    { name = "m11 unpaired double quote"; text = after "echo \"it\n${bp} ${su} true"; fails = [ r.quote r.start ]; has = "activate line 3"; }
    { name = "unclosed $("; text = after "x=$(\n${bp} ${su} true"; fails = [ r.quote ]; has = "activate line 3"; }
    { name = "heredoc with no delimiter word"; text = after "cat <<\nhi\n\n${bp} ${su} true"; fails = [ r.quote ]; }
    { name = "backtick substitution"; text = after "x=`id -u`\n${bp} ${su} true"; fails = [ r.quote ]; }
    { name = "case inside $(...)"; text = after "x=$(case $y in a) echo;; esac)\n${bp} ${su} true"; fails = [ r.quote ]; }
    { name = "f02 --ignore-case inside $(...)"; text = after "x=$(grep --ignore-case foo /etc/hosts)\n${bp} ${su} true"; fails = [ ]; }

    # Heredocs: their text is not read, so one that names the prefix, or
    # never ends, fails.
    { name = "heredoc into a shell"; text = after "bash <<EOF\n${brewPath} ${su} true\nEOF"; fails = [ r.heredoc ]; }
    { name = "quoted heredoc delimiter"; text = after "bash <<-'EOF'\n${brewPath} ${su} true\n\tEOF"; fails = [ r.heredoc ]; }
    { name = "B8 heredoc, digit delimiter"; text = after "bash <<1\n${bp} ${su} true\n1"; fails = [ r.heredoc ]; }
    { name = "B8b heredoc, << -EOF"; text = after "bash << -EOF\n${bp} ${su} true\n-EOF"; fails = [ r.heredoc ]; }
    { name = "prefix on the heredoc's operator line"; text = after "${bp} ${su} cat <<EOF\nhi\nEOF"; fails = [ r.heredoc ]; }
    { name = "heredoc that never ends"; text = after "cat >/etc/x <<EOF\nhi\nEOX\n${bp} ${su} true"; fails = [ r.heredoc ]; }
    { name = "<<- with a tab-indented delimiter"; text = after "cat <<-EOF\n\thi\n\tEOF\n${bp} ${su} true"; fails = [ ]; }
    { name = "F5 heredoc with no Homebrew text"; text = after "cat >/etc/x <<EOF\nit's\nEOF\n${bp} ${su} true"; fails = [ ]; }
    { name = "two heredocs on one line"; text = after "cat <<A - <<'B'\na\nA\nb'\nB\n${bp} ${su} true"; fails = [ ]; }
    { name = "F2 trailing comment naming <<EOF"; text = after "true # see <<EOF in the docs\n${bp} ${su} true"; fails = [ ]; }
    { name = "F3 x=$((1<<n))"; text = after "x=$((1<<n))\n${bp} ${su} true"; fails = [ ]; }
    { name = "here-string"; text = after "read -r x <<<\"$(true)\""; fails = [ ]; }
    { name = "m10 <<<word"; text = after "cat <<<word\n${bp} ${su} true"; fails = [ ]; }
    { name = "m19 quoted heredoc: \\ + newline ends the body line"; text = after "cat <<'EOF'\nx\\\nEOF\n${bp} ${su} true"; fails = [ ]; }
    { name = "b08 unquoted heredoc: \\ + newline joins the delimiter"; text = after "bash <<EOF\ntrue\\\nEOF\n${bp} sudo -u myuser true\nEOF"; fails = [ r.heredoc ]; }
    { name = "m28 delimiter on the last line, no newline after"; text = "${lint.fnDef}\n${bp} ${su} true\ncat <<EOF\nhi\nEOF"; fails = [ ]; }
  ];

  problemsOf = c: lint.problems { inherit prefix; enable = c.homebrew or false; inherit (c) text; };
  sameRules = a: b: lib.sort lib.lessThan a == lib.sort lib.lessThan b;
in
lib.concatMap
  (c:
    let
      ps = problemsOf c;
      got = lib.unique (map (p: p.rule) ps);
    in
    lib.optional (!(sameRules got c.fails))
      "${c.name}: expected [${lib.concatStringsSep ", " c.fails}], got [${lib.concatStringsSep ", " got}]"
    # has: text one of the problems must contain, such as a line number.
    ++ lib.optional (c ? has && !(builtins.any (p: lib.hasInfix c.has p.text) ps))
      "${c.name}: no problem says \"${c.has}\"")
  cases
