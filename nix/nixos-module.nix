{
  config,
  lib,
  pkgs,
  utils,
  ...
}: let
  cfg = config.services.findmy;
in {
  options.services.findmy = {
    enable = lib.mkEnableOption "the Find My location recorder and dashboard";

    package = lib.mkOption {
      type = lib.types.package;
      default = pkgs.callPackage ./dashboard.nix {};
      defaultText = lib.literalExpression "pkgs.callPackage ./dashboard.nix {}";
      description = "Package providing the Find My dashboard executable.";
    };

    sourceUrl = lib.mkOption {
      type = lib.types.str;
      example = "http://127.0.0.1:8766/events";
      description = "Full URL of the macOS source's snapshot SSE endpoint.";
    };

    dataDir = lib.mkOption {
      type = lib.types.str;
      default = "/var/lib/findmy";
      description = "Directory containing the private SQLite location database.";
    };

    host = lib.mkOption {
      type = lib.types.str;
      default = "127.0.0.1";
      description = "Address on which the dashboard listens.";
    };

    port = lib.mkOption {
      type = lib.types.port;
      default = 8787;
      description = "Port on which the dashboard listens.";
    };

    tokenFile = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      example = "/run/secrets/findmy-source-token";
      description = ''
        Optional runtime file containing the source bearer token. The findmy
        user must be able to read it; its contents must not enter the Nix store.
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    users.groups.findmy = {};
    users.users.findmy = {
      isSystemUser = true;
      group = "findmy";
    };

    systemd.services.findmy = {
      description = "Find My location recorder and dashboard";
      wantedBy = ["multi-user.target"];
      environment =
        {
          FINDMY_SOURCE_URL = cfg.sourceUrl;
          FINDMY_DB = "${cfg.dataDir}/findmy.sqlite";
          HOST = cfg.host;
          PORT = toString cfg.port;
        }
        // lib.optionalAttrs (cfg.tokenFile != null) {
          FINDMY_TOKEN_FILE = cfg.tokenFile;
        };
      serviceConfig = {
        User = "findmy";
        # Run after host-specific mount checks, allowing encrypted data volumes.
        ExecStartPre = [
          "+${pkgs.coreutils}/bin/install ${utils.escapeSystemdExecArgs ["-d" "-o" "findmy" "-g" "findmy" "-m" "0700" cfg.dataDir]}"
        ];
        ExecStart = lib.getExe cfg.package;
        Restart = "always";
        RestartSec = 5;
        UMask = "0077";
        NoNewPrivileges = true;
        ProtectSystem = "full";
        ProtectHome = true;
        PrivateTmp = true;
        RestrictAddressFamilies = ["AF_INET" "AF_INET6" "AF_UNIX"];
      };
    };
  };
}
