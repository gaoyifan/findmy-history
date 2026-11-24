{
  lib,
  python3,
  stdenvNoCC,
}: let
  version = (builtins.fromJSON (builtins.readFile ../package.json)).version;
  python = python3.withPackages (ps: [ps.pycryptodome]);
in
  stdenvNoCC.mkDerivation {
    pname = "findmy-source";
    inherit version;
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
      app="$out/FindMySource.app"
      # Keep the executable attributed to this bundle for macOS TCC.  The
      # Python environment itself is exposed through PYTHONPATH below so the
      # process does not resolve to a nix-store interpreter path.
      install -Dm755 "${python3}/bin/python${python3.pythonVersion}" "$app/Contents/MacOS/findmy-source"
      install -Dm644 macos/source.py "$app/Contents/Resources/source.py"
      cat > "$app/Contents/Info.plist" <<'PLIST'
      <?xml version="1.0" encoding="UTF-8"?>
      <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
      <plist version="1.0">
      <dict>
        <key>CFBundleDevelopmentRegion</key>
        <string>en</string>
        <key>CFBundleExecutable</key>
        <string>findmy-source</string>
        <key>CFBundleIdentifier</key>
        <string>com.gaoyifan.findmy-source</string>
        <key>CFBundleInfoDictionaryVersion</key>
        <string>6.0</string>
        <key>CFBundleName</key>
        <string>Find My Source</string>
        <key>CFBundlePackageType</key>
        <string>APPL</string>
        <key>CFBundleShortVersionString</key>
        <string>${version}</string>
        <key>CFBundleVersion</key>
        <string>${version}</string>
        <key>LSUIElement</key>
        <true/>
      </dict>
      </plist>
      PLIST
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
