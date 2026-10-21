{
  lib,
  python313,
  stdenvNoCC,
}: let
  python = python313.withPackages (ps: [ps.pycryptodome]);
in
  stdenvNoCC.mkDerivation {
    pname = "findmy-source";
    version = (builtins.fromJSON (builtins.readFile ../package.json)).version;
    src = lib.fileset.toSource {
      root = ../.;
      fileset = lib.fileset.unions [../macos/source.py ../LICENSE ../THIRD_PARTY_NOTICES.md];
    };
    dontBuild = true;
    installPhase = ''
      runHook preInstall
      mkdir -p "$out/bin" "$out/share/doc/findmy-history"
      {
        echo '#!${python}/bin/python3'
        cat macos/source.py
      } > "$out/bin/findmy-source"
      chmod 755 "$out/bin/findmy-source"
      cp LICENSE THIRD_PARTY_NOTICES.md "$out/share/doc/findmy-history/"
      runHook postInstall
    '';
    meta = {
      description = "Stream local macOS Find My cache snapshots over SSE";
      homepage = "https://github.com/gaoyifan/findmy-history";
      license = lib.licenses.mit;
      platforms = lib.platforms.darwin;
      mainProgram = "findmy-source";
    };
  }
