{
  description = "Find My cache collection, SQLite history and live maps";

  inputs.nixpkgs.url = "github:nixos/nixpkgs/nixos-26.05";

  outputs = {
    self,
    nixpkgs,
    ...
  }: let
    systems = ["x86_64-linux" "aarch64-linux" "aarch64-darwin" "x86_64-darwin"];
    forAllSystems = nixpkgs.lib.genAttrs systems;
    pkgsFor = system: import nixpkgs {inherit system;};
  in {
    packages = forAllSystems (system: let
      pkgs = pkgsFor system;
      dashboard = pkgs.callPackage ./nix/dashboard.nix {};
    in
      {
        inherit dashboard;
        default = dashboard;
      }
      // pkgs.lib.optionalAttrs pkgs.stdenv.isDarwin {
        source = pkgs.callPackage ./nix/source.nix {};
      });

    apps = forAllSystems (system: let
      pkgs = pkgsFor system;
    in
      {
        default = {
          type = "app";
          program = "${self.packages.${system}.dashboard}/bin/findmy-dashboard";
        };
      }
      // pkgs.lib.optionalAttrs pkgs.stdenv.isDarwin {
        source = {
          type = "app";
          program = "${self.packages.${system}.source}/bin/findmy-source";
        };
      });

    devShells = forAllSystems (system: let
      pkgs = pkgsFor system;
    in {
      default = pkgs.mkShell {
        packages = [
          pkgs.nodejs_24
          (pkgs.python313.withPackages (ps: [ps.pycryptodome]))
          pkgs.alejandra
          pkgs.ruff
        ];
      };
    });

    checks = forAllSystems (system: let
      pkgs = pkgsFor system;
      python = pkgs.python313.withPackages (ps: [ps.pycryptodome]);
    in {
      dashboard = self.packages.${system}.dashboard;
      reader =
        pkgs.runCommand "findmy-reader-tests" {
          nativeBuildInputs = [python];
        } ''
          export PYTHONDONTWRITEBYTECODE=1
          cd ${./macos}
          python -m unittest discover -p test_source.py -v
          touch "$out"
        '';
    });

    formatter = forAllSystems (system: (pkgsFor system).alejandra);
    nixosModules.default = import ./nix/nixos-module.nix;
    homeManagerModules.source = import ./nix/home-manager-module.nix;
  };
}
