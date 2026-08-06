{
  description = "Node/TypeScript devShell";
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
  outputs = { self, nixpkgs }:
    let
      forAllSystems = f: nixpkgs.lib.genAttrs [ "aarch64-darwin" "x86_64-darwin" "x86_64-linux" ]
        (system: f nixpkgs.legacyPackages.${system});
    in {
      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          # nodePackages.* scope was removed from nixpkgs (2026 drift) — these
          # now live at the top level.
          packages = with pkgs; [ nodejs_22 typescript typescript-language-server ];
        };
      });
    };
}
