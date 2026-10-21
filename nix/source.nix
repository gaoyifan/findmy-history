{
  lib,
  python3,
  stdenvNoCC,
}: let
  python = python3.withPackages (ps: [ps.pycryptodome]);
in
  stdenvNoCC.mkDerivation {
    pname = "findmy-source";
    version = (builtins.fromJSON (builtins.readFile ../package.json)).version;
    src = lib.fileset.toSource {
      root = ../.;
      fileset = lib.fileset.unions [../macos/source.py ../LICENSE ../THIRD_PARTY_NOTICES.md];
    };
    buildInputs = [python];
    dontBuild = true;
    installPhase = ''
      runHook preInstall
      install -Dm755 macos/source.py "$out/bin/findmy-source"
      install -Dm644 -t "$out/share/doc/findmy-history" LICENSE THIRD_PARTY_NOTICES.md
      runHook postInstall
    '';
    doInstallCheck = true;
    installCheckPhase = ''
      runHook preInstallCheck
      env -i HOME="$TMPDIR" PATH="$out/bin" "$out/bin/findmy-source" --help > /dev/null
      runHook postInstallCheck
    '';
    meta = {
      description = "Stream local macOS Find My cache snapshots over SSE";
      homepage = "https://github.com/gaoyifan/findmy-history";
      license = lib.licenses.mit;
      platforms = lib.platforms.darwin;
      mainProgram = "findmy-source";
    };
  }
