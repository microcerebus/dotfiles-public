# The daily updater (scripts/dotfiles-autoupdate) as one program for every
# entry point: the dotfiles-sync agent and `autoupdate-now` (nix/user.nix)
# and the root daemon (nix/host.nix). It carries what macOS lacks, so a run
# from a terminal cannot drift from launchd's: on 14 Oct 2026 the alias ran
# the checkout on the shell's PATH, which has no `timeout`, and every step
# failed. Appended, so macOS's BSD date, stat and sed still come first, as do
# the caller's own git, pnpm and brew (perl too: macOS ships one today, but
# says it may stop). It also pins GitHub's host keys for root's fetch, here
# rather than in the daemon's env, because `rollback` fetches too, and sudo
# drops the caller's env.
{ pkgs, lib }:

pkgs.writeShellScriptBin "dotfiles-autoupdate" ''
  export PATH=''${PATH:+$PATH:}${lib.makeBinPath [ pkgs.coreutils pkgs.jq pkgs.perl ]}
  export AUTOUPDATE_KNOWN_HOSTS=${./github-known-hosts}
  exec ${pkgs.bash}/bin/bash ${../scripts/dotfiles-autoupdate} "$@"
''
