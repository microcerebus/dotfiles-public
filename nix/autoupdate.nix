# The daily updater (scripts/dotfiles-autoupdate) as one program for every
# entry point: the dotfiles-sync agent and `autoupdate-now` (nix/user.nix)
# and the root daemon (nix/host.nix). It carries what macOS lacks, so a run
# from a terminal cannot drift from launchd's: on 14 Oct 2026 the alias ran
# the checkout on the shell's PATH, which has no `timeout`, and every step
# failed. Appended, so macOS's BSD date, stat and sed still come first, as do
# the caller's own git, pnpm and brew.
{ pkgs, lib }:

pkgs.writeShellScriptBin "dotfiles-autoupdate" ''
  export PATH=''${PATH:+$PATH:}${lib.makeBinPath [ pkgs.coreutils pkgs.jq ]}
  exec ${pkgs.bash}/bin/bash ${../scripts/dotfiles-autoupdate} "$@"
''
