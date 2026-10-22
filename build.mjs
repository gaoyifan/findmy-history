import { build } from "esbuild";
import { cp, mkdir } from "node:fs/promises";
await mkdir("dist/public", { recursive: true });
await build({
  entryPoints: ["src/server.ts"],
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  outfile: "dist/server.js",
});
await build({
  entryPoints: ["web/app.ts"],
  bundle: true,
  platform: "browser",
  target: ["safari17", "chrome120"],
  outfile: "dist/public/app.js",
  minify: true,
});
await cp("web/index.html", "dist/public/index.html");
await cp("web/style.css", "dist/public/style.css");
await cp(
  "node_modules/maplibre-gl/dist/maplibre-gl.css",
  "dist/public/maplibre-gl.css",
);
await cp(
  "node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs",
  "dist/public/maplibre-worker.js",
);
await build({
  entryPoints: ["test/collector.test.ts"],
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  outfile: "dist/test/collector.test.js",
});
