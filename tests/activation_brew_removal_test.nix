# The host's activate never uninstalls a brew package. The hourly
# auto-update daemon runs it as root with no terminal, and a removal there
# can need the owner's password: a pkg cask's uninstall runs `sudo -u root rm`,
# which fails without a terminal, and the failed brew bundle aborts
# everything after it, Home Manager included (the dotnet-sdk zap of 29 Oct
# 2026). It also removed tools he was using, unattended. Removal runs in
# `rebuild` instead, in his terminal (nix/user.nix).
# Takes the evaluated host config; returns one line per way activation
# would remove a package. flake.nix turns a non-empty list into a
# `nix flake check` failure. Pure evaluation: nothing here runs brew.
# Not a proof: a text scan cannot see a removal hidden in a wrapper script
# (`${pkgs.writeShellScript ...}`), a flag held in a shell variable
# (`f=--force-cleanup; brew bundle $f`) or brew called through a variable
# (`"$b" uninstall`). Review those shapes by hand.
{ lib, config }:

let
  text = config.system.activationScripts.script.text;
  ob = config.homebrew.onActivation;

  # Commands only: comments and messages may name a removal command.
  commands = lib.filter
    (l: l != "" && !(lib.hasPrefix "#" l) && !(lib.hasPrefix "echo " l) && !(lib.hasPrefix "printf " l))
    (map (l: lib.trim l) (lib.splitString "\n" text));
  # brew bundle's removal flags (cleanup = "uninstall" or "zap") and its
  # cleanup subcommand (cleanup = "check" aborts activation on any
  # undeclared package), and brew's own removal commands.
  removes = l:
    builtins.match ".*brew bundle.*(--zap|--force-cleanup|--cleanup| cleanup).*" l != null
    || builtins.match ".*brew (uninstall|remove|rm|autoremove|cleanup)( .*)?" l != null;

  # brew reads these from the environment and turns on `brew bundle
  # install --cleanup` / `--force-cleanup` (env_config.rb), so they remove
  # packages with no flag on the command line. They may reach activation
  # through extraEnv, an export in activate, any env attrset, or a brew.env
  # file brew loads (/etc/homebrew, the prefix, ~/.homebrew,
  # ~/.config/homebrew).
  cleanupVar = ".*HOMEBREW_BUNDLE_(FORCE_)?INSTALL_CLEANUP.*";
  setsCleanup = s: builtins.match cleanupVar s != null;
  textVars = map (l: "activate sets a brew cleanup variable: ${l}")
    (lib.filter setsCleanup (lib.splitString "\n" text));

  envSets = {
    "homebrew.onActivation.extraEnv" = ob.extraEnv;
    "environment.variables" = config.environment.variables;
  }
  // lib.mapAttrs' (n: d: lib.nameValuePair "launchd.daemons.${n}"
    (d.serviceConfig.EnvironmentVariables or { })) config.launchd.daemons
  // lib.mapAttrs' (n: d: lib.nameValuePair "launchd.agents.${n}"
    (d.serviceConfig.EnvironmentVariables or { })) config.launchd.agents;
  envVars = lib.concatLists (lib.mapAttrsToList
    (where: env: map (v: "${where} sets brew cleanup variable ${v}")
      (lib.filter setsCleanup (lib.attrNames (if env == null then { } else env))))
    envSets);

  # A managed brew.env must not turn cleanup on; one whose text cannot be
  # read here fails too, so nobody adds an unchecked one. A file set by
  # `source` has text null (Home Manager) or "" (nix-darwin's etc).
  isBrewEnv = p: lib.hasSuffix "homebrew/brew.env" p;
  checkFile = where: f:
    let t = f.text or null; in
    if t == null || t == "" then [ "${where} manages a brew.env without inline text; set it with .text so this check can read it" ]
    else lib.optional (setsCleanup t) "${where} sets a brew cleanup variable";
  etcFiles = lib.concatLists (lib.mapAttrsToList
    (n: f: lib.optionals (f.enable && isBrewEnv (f.target or n)) (checkFile "environment.etc.${n}" f))
    config.environment.etc);
  hmFiles = lib.concatLists (lib.mapAttrsToList
    (u: hm: lib.concatLists (lib.mapAttrsToList
      (n: f: lib.optionals (f.enable && isBrewEnv f.target) (checkFile "home-manager.users.${u}.home.file.${n}" f))
      hm.home.file))
    (config.home-manager.users or { }));

  removalFlags = [ "--cleanup" "--force-cleanup" "--zap" ];
  configChecks =
    lib.optional (ob.cleanup != "none")
      "homebrew.onActivation.cleanup is \"${ob.cleanup}\"; it must stay \"none\""
    ++ map (f: "homebrew.onActivation.extraFlags has ${f}")
      (lib.filter (f: lib.elem f removalFlags) ob.extraFlags);
in
map (l: "activate removes brew packages unattended: ${l}") (lib.filter removes commands)
++ textVars ++ envVars ++ etcFiles ++ hmFiles ++ configChecks
