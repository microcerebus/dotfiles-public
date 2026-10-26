# Activation runs as root, and nix-darwin's homebrew step runs
#   PATH="/opt/homebrew/bin:...:$PATH" sudo --preserve-env=PATH --user=... brew bundle ...
# Bash looks a command up through a temporary PATH= prefix, and myuser owns
# /opt/homebrew/bin, so a `sudo` dropped there would run as root.
#
# Fix: define a shell function `sudo` before every other activation step.
# Bash finds a function before it searches PATH, also behind a PATH= prefix
# and inside $(...), so every sudo the activate shell itself runs is
# /usr/bin/sudo, whatever upstream's homebrew text (or system.checks under
# cleanup = "check") says. Upstream's --preserve-env=PATH still carries the
# Homebrew PATH through to brew and mas, which run as myuser.
# The function does not reach programs activate starts: the
# `launchctl asuser ... sudo` lines are exec'd by launchctl and look sudo up
# in activate's own PATH, which holds only root-owned dirs (the store,
# /usr/bin, /bin, /usr/sbin, /sbin), so they get /usr/bin/sudo anyway.
#
# The assertion fails evaluation (the daily routine's system.drvPath eval,
# `darwin-rebuild` and `nix flake check` alike) when the built activate:
# - lacks the function, defines `sudo` twice, or unsets it;
# - runs anything behind a PATH="/opt/homebrew..." prefix before the
#   function is defined;
# - has that prefix anywhere but the start of a command (the trimmed line
#   start, or right after `$(`): `env PATH=... sudo` or
#   `bash -c 'PATH=... sudo'` hand it to a program that never sees the
#   function;
# - runs any command other than `sudo` or `/usr/bin/sudo` behind that prefix
#   (env, launchctl, brew ... there would be looked up as root in a dir myuser
#   owns);
# - calls sudo through a form that skips functions (`command sudo`,
#   `exec [-a name] sudo`, `builtin sudo`).
# It reads the literal `PATH=/opt/homebrew`, `PATH="/opt/homebrew` or
# `PATH='/opt/homebrew` forms. It does not see the prefix through a variable
# such as $HOMEBREW_PREFIX, or later in the PATH list.
# Comment lines in activate are skipped.
# The rules live in nix/activation-sudo-lint.nix and are pinned by
# tests/activation_sudo_lint_test.nix.
# Once nix-darwin calls /usr/bin/sudo itself, the function is a no-op and
# this module can go.
{ config, lib, ... }:

let
  lint = import ./activation-sudo-lint.nix { inherit lib; };
  inherit (lint) fnDef;
  problems = lint.problems {
    inherit (config.homebrew) prefix;
    inherit (config.system.activationScripts.script) text;
  };
in
{
  system.activationScripts.preActivation.text = lib.mkBefore ''
    # Every sudo this shell runs below is /usr/bin/sudo, also behind the
    # Homebrew PATH prefix of the homebrew step. launchctl asuser ... sudo
    # lines bypass it but search only root-owned dirs (nix/activation-sudo.nix).
    ${fnDef}
  '';

  assertions = [
    {
      assertion = problems == [ ];
      message = "nix/activation-sudo.nix: root could run a command looked up in a directory myuser owns:\n"
        + lib.concatMapStrings (p: "  - ${p}\n") problems;
    }
  ];
}
