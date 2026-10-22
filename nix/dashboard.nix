{
  lib,
  buildNpmPackage,
  nodejs,
  makeWrapper,
}:
buildNpmPackage {
  pname = "findmy-dashboard";
  version = (builtins.fromJSON (builtins.readFile ../package.json)).version;
  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../LICENSE
      ../THIRD_PARTY_NOTICES.md
      ../package.json
      ../package-lock.json
      ../build.mjs
      ../tsconfig.json
      ../src
      ../web
      ../test
    ];
  };
  npmDepsHash = "sha256-FBS11GBT/dxCvdm0QYMapetIE124++t6YFBgDhetbJ0=";
  nativeBuildInputs = [makeWrapper];
  doCheck = true;
  checkPhase = ''
    runHook preCheck
    npm run check
    node --test dist/test/*.test.js
    runHook postCheck
  '';
  installPhase = ''
    runHook preInstall
    mkdir -p $out/lib/findmy $out/share/doc/findmy-history
    cp LICENSE THIRD_PARTY_NOTICES.md $out/share/doc/findmy-history/
    cp dist/server.js $out/lib/findmy/
    cp -r dist/public $out/lib/findmy/
    makeWrapper ${nodejs}/bin/node $out/bin/findmy-dashboard \
      --add-flags $out/lib/findmy/server.js
    runHook postInstall
  '';
  meta = {
    description = "Record Find My snapshots in SQLite and display location history";
    homepage = "https://github.com/gaoyifan/findmy-history";
    license = lib.licenses.mit;
    mainProgram = "findmy-dashboard";
  };
}
