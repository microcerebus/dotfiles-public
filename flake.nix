{
  description = "Mac-first terminal agent workstation (nix-darwin + Home Manager)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

    nix-darwin = {
      url = "github:nix-darwin/nix-darwin/master";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    home-manager = {
      url = "github:nix-community/home-manager";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    # Restrict transitive per-system enumeration to this machine's arch.
    # hunk's bun2nix input defaults to nix-systems/default, which includes
    # x86_64-darwin - dropped by nixpkgs 26.11, so evaluating it aborts.
    systems.url = "github:nix-systems/aarch64-darwin";

    hunk = {
      url = "github:modem-dev/hunk";
      inputs.nixpkgs.follows = "nixpkgs";
      inputs.bun2nix.inputs.systems.follows = "systems";
    };

    herdr = {
      url = "github:ogulcancelik/herdr";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    # no-mistakes: validation-gate pipeline (docs/workflow-north-star.md).
    # Pinned to a release tag; bump deliberately, vendorHash lives in user.nix.
    no-mistakes-src = {
      url = "github:kunchenguid/no-mistakes/v1.31.2";
      flake = false;
    };

    # treehouse: worktree pool used by firstmate crewmates (workflow north
    # star). Same pattern: pinned release tag, vendorHash in user.nix.
    treehouse-src = {
      url = "github:kunchenguid/treehouse/v2.0.0";
      flake = false;
    };
  };

  outputs = inputs@{ self, nixpkgs, nix-darwin, home-manager, ... }:
    let
      # ── Phase 0 fills these in ────────────────────────────────────────────
      username = "CHANGE_ME";           # short macOS username (whoami)
      hostname = "CHANGE_ME";           # scutil --get LocalHostName
      system   = "aarch64-darwin";      # Apple Silicon; "x86_64-darwin" for Intel
      # ─────────────────────────────────────────────────────────────────────
    in
    {
      darwinConfigurations.${hostname} = nix-darwin.lib.darwinSystem {
        inherit system;
        specialArgs = { inherit inputs username; };
        modules = [
          ./nix/host.nix

          home-manager.darwinModules.home-manager
          {
            home-manager.useGlobalPkgs = true;
            home-manager.useUserPackages = true;
            home-manager.backupFileExtension = "hm-backup";
            home-manager.extraSpecialArgs = { inherit inputs username; };
            home-manager.users.${username} = import ./nix/user.nix;
          }
        ];
      };

      # Convenience: `nix build .#darwinConfigurations.<hostname>.system --dry-run`
    };
}
