# Table test for nix/activation-sudo-lint.nix: each crafted activate text
# must pass, or fail with the named rule. Returns the list of cases that did
# not; flake.nix turns a non-empty list into a `nix flake check` failure.
# Pure evaluation: nothing here runs a shell or a sudo.
{ lib }:

let
  lint = import ../nix/activation-sudo-lint.nix { inherit lib; };
  prefix = "/opt/homebrew";
  brewPath = ''PATH="/opt/homebrew/bin:/nix/store/x-mas-7.0.0/bin:$PATH"'';
  sudoArgs = "--preserve-env=PATH --user=myuser --set-home env HOMEBREW_NO_AUTO_UPDATE=1 brew bundle --file='/nix/store/x-Brewfile'";

  # The function first, as nix/activation-sudo.nix puts it, then the line.
  after = line: "#!/usr/bin/env bash\n${lint.fnDef}\n${line}\n";

  rules = {
    count = "exactly once";
    order = "before the sudo function is defined";
    redefine = "redefines or unsets sudo";
    bypass = "calls sudo past the function";
    start = "must start a command";
    notSudo = "only sudo may run";
  };

  # { name; text; fails = [ rule ... ]; } with fails = [ ] for a pass.
  cases = [
    # Upstream shapes and other text that must pass.
    { name = "upstream brew bundle line"; text = after "  ${brewPath} sudo ${sudoArgs} --no-upgrade --zap --force-cleanup"; fails = [ ]; }
    { name = "cleanup = check, inside $(...)"; text = after "  homebrewCleanupResult=$(${brewPath} sudo ${sudoArgs} --cleanup) || homebrewCleanupExitCode=$?"; fails = [ ]; }
    { name = "/usr/bin/sudo behind the prefix"; text = after "${brewPath} /usr/bin/sudo ${sudoArgs}"; fails = [ ]; }
    { name = "unquoted sbin prefix"; text = after "PATH=/opt/homebrew/sbin:$PATH sudo true"; fails = [ ]; }
    { name = "single-quoted prefix"; text = after "PATH='/opt/homebrew/bin' sudo true"; fails = [ ]; }
    { name = "launchctl asuser sudo, no prefix"; text = after "launchctl asuser 501 sudo --user=myuser -- defaults write x y -bool true"; fails = [ ]; }
    { name = "bare sudo, no prefix"; text = after "sudo mv /etc/hosts.new /etc/hosts"; fails = [ ]; }
    { name = "commented-out bad line"; text = after "# env PATH=\"/opt/homebrew/bin:$PATH\" sudo true"; fails = [ ]; }
    { name = "sudo as a later word"; text = after "echo no sudo here; command -v true"; fails = [ ]; }

    # The function itself.
    { name = "function missing"; text = "${brewPath} sudo ${sudoArgs}\n"; fails = [ rules.count ]; }
    { name = "function defined twice"; text = after lint.fnDef; fails = [ rules.count ]; }
    { name = "prefix line before the function"; text = "${brewPath} sudo true\n${lint.fnDef}\n"; fails = [ rules.order ]; }
    { name = "another sudo function"; text = after "sudo() { echo; }"; fails = [ rules.redefine ]; }
    { name = "function keyword"; text = after "function sudo { echo; }"; fails = [ rules.redefine ]; }
    { name = "unset sudo"; text = after "unset sudo"; fails = [ rules.redefine ]; }
    { name = "unset -f sudo"; text = after "unset -f sudo"; fails = [ rules.redefine ]; }
    { name = "unset -f, sudo not first"; text = after "unset -f foo sudo"; fails = [ rules.redefine ]; }

    # Forms that skip the function.
    { name = "command sudo"; text = after "command sudo true"; fails = [ rules.bypass ]; }
    { name = "command -p sudo"; text = after "command -p sudo true"; fails = [ rules.bypass ]; }
    { name = "exec sudo"; text = after "exec sudo true"; fails = [ rules.bypass ]; }
    { name = "exec -a name sudo"; text = after "exec -a x sudo true"; fails = [ rules.bypass ]; }
    { name = "builtin sudo"; text = after "builtin sudo true"; fails = [ rules.bypass ]; }
    { name = "command sudo behind the prefix"; text = after "${brewPath} command sudo true"; fails = [ rules.bypass rules.notSudo ]; }

    # The prefix where a program other than this shell reads it.
    { name = "env PATH=... sudo (review u6)"; text = after "env ${brewPath} sudo --user=myuser true"; fails = [ rules.start ]; }
    { name = "bash -c '...' (review u7)"; text = after "bash -c '${brewPath} sudo --user=myuser true'"; fails = [ rules.start ]; }
    { name = "sh -c \"...\""; text = after "sh -c \"PATH=/opt/homebrew/bin:\\$PATH sudo true\""; fails = [ rules.start ]; }
    { name = "launchctl asuser env PATH=..."; text = after "launchctl asuser 501 env ${brewPath} sudo true"; fails = [ rules.start ]; }
    { name = "export, then sudo"; text = after "export ${brewPath}\nsudo true"; fails = [ rules.start rules.notSudo ]; }
    { name = "after a pipe"; text = after "echo | ${brewPath} sudo true"; fails = [ rules.start ]; }
    { name = "second prefix on the line"; text = after "${brewPath} sudo a; ${brewPath} sudo b"; fails = [ rules.start ]; }

    # Something other than sudo behind the prefix.
    { name = "env behind the prefix (review u2)"; text = after "${brewPath} env sudo true"; fails = [ rules.notSudo ]; }
    { name = "brew run directly as root"; text = after "PATH=/opt/homebrew/sbin:$PATH brew bundle"; fails = [ rules.notSudo ]; }
  ];

  failedRules = text:
    let ps = lint.problems { inherit prefix text; };
    in builtins.filter (r: builtins.any (lib.hasInfix r) ps) (builtins.attrValues rules);
  sameRules = a: b: lib.sort lib.lessThan a == lib.sort lib.lessThan b;
in
lib.concatMap
  (c:
    let got = failedRules c.text;
    in lib.optional (!(sameRules got c.fails))
      "${c.name}: expected [${lib.concatStringsSep ", " c.fails}], got [${lib.concatStringsSep ", " got}]")
  cases
