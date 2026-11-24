{
  config,
  lib,
  pkgs,
  ...
}: let
  cfg = config.services.findmy-source;
  logs = "${config.home.homeDirectory}/Library/Logs";
  python = pkgs.python3.withPackages (ps: [ps.pycryptodome]);
in {
  options.services.findmy-source = {
    enable = lib.mkEnableOption "the macOS Find My snapshot SSE source";

    package = lib.mkOption {
      type = lib.types.package;
      default = pkgs.callPackage ./source.nix {};
      defaultText = lib.literalExpression "pkgs.callPackage ./source.nix {}";
      description = "Package providing the macOS Find My source executable.";
    };

    host = lib.mkOption {
      type = lib.types.str;
      default = "127.0.0.1";
      description = "Address on which the snapshot SSE source listens.";
    };

    tokenFile = lib.mkOption {
      type = lib.types.str;
      default = "${config.home.homeDirectory}/.local/state/findmy/source.token";
      description = "Runtime file containing the required HTTP bearer token; never import its contents into the Nix store.";
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = pkgs.stdenv.isDarwin;
        message = "services.findmy-source is supported only on macOS.";
      }
    ];

    # The app bundle is the stable Full Disk Access subject. Decryption keys
    # stay in private runtime files under ~/.local/state/findmy/keys.
    home.activation.findmySourceApp = lib.hm.dag.entryBetween ["setupLaunchAgents"] ["writeBoundary"] ''
      app="$HOME/Applications/FindMySource.app"
      rm -rf "$app"
      mkdir -p "$HOME/Applications"
      cp -R "${cfg.package}/FindMySource.app" "$app"
      chmod -R u+w "$app"
      /usr/bin/codesign --force --deep --sign - "$app"
    '';
    launchd.agents.findmy-source = {
      enable = true;
      config = {
        ProgramArguments = [
          "${config.home.homeDirectory}/Applications/FindMySource.app/Contents/MacOS/findmy-source"
          "${config.home.homeDirectory}/Applications/FindMySource.app/Contents/Resources/source.py"
          "--worker"
          "--host"
          cfg.host
          "--token-file"
          cfg.tokenFile
        ];
        EnvironmentVariables = {
          PYTHONPATH = "${python}/${python.sitePackages}";
        };
        KeepAlive = true;
        ProcessType = "Background";
        LimitLoadToSessionType = "Aqua";
        StandardOutPath = "${logs}/findmy-source.log";
        StandardErrorPath = "${logs}/findmy-source.log";
      };
    };
  };
}
