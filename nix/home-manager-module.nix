{
  config,
  lib,
  pkgs,
  ...
}: let
  cfg = config.services.findmy-source;
  logs = "${config.home.homeDirectory}/Library/Logs";
in {
  options.services.findmy-source = {
    enable = lib.mkEnableOption "the macOS Find My snapshot SSE source";

    package = lib.mkOption {
      type = lib.types.package;
      default = pkgs.callPackage ./source.nix {};
      defaultText = lib.literalExpression "pkgs.callPackage ./source.nix {}";
      description = "Package providing the macOS Find My source executable.";
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = pkgs.stdenv.isDarwin;
        message = "services.findmy-source is supported only on macOS.";
      }
    ];

    # Terminal supplies the worker's existing Full Disk Access. Decryption keys
    # stay in private runtime files under ~/.local/state/findmy/keys.
    launchd.agents.findmy-source = {
      enable = true;
      config = {
        ProgramArguments = [(lib.getExe cfg.package)];
        RunAtLoad = true;
        KeepAlive = true;
        ThrottleInterval = 15;
        ProcessType = "Background";
        LimitLoadToSessionType = "Aqua";
        StandardOutPath = "${logs}/findmy-source.log";
        StandardErrorPath = "${logs}/findmy-source.log";
      };
    };
  };
}
