{
  description = "Terraform devShell (enabled on demand; never global)";
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
  outputs = { self, nixpkgs }:
    let
      forAllSystems = f: nixpkgs.lib.genAttrs [ "aarch64-darwin" "x86_64-darwin" "x86_64-linux" ]
        (system: f nixpkgs.legacyPackages.${system});
    in {
      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          # opentofu (FOSS Terraform fork): terraform itself is BSL-licensed
          # ("unfree" in nixpkgs) and fails to evaluate without an unfree
          # override. `tofu` is CLI-compatible; alias it if muscle memory wants
          # `terraform`. Verified 2026-07-05 (PLAN Phase 4).
          packages = with pkgs; [ opentofu tflint ];
        };
      });
    };
}
