import { createServer, type ServerResponse } from "node:http";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "./store.js";
import { collect } from "./source.js";
import type { CollectorStatus, Kind } from "./types.js";

process.umask(0o077);
const databasePath = process.env.FINDMY_DB ?? "/var/lib/findmy/findmy.sqlite";
const sourceUrl = process.env.FINDMY_SOURCE_URL;
if (!sourceUrl) throw new Error("FINDMY_SOURCE_URL is required");
mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
const store = new Store(databasePath);
const publicPath = join(dirname(fileURLToPath(import.meta.url)), "public");
const token = process.env.FINDMY_TOKEN_FILE
  ? readFileSync(process.env.FINDMY_TOKEN_FILE, "utf8").trim()
  : undefined;
const clients = new Set<ServerResponse>();
let connection = { connected: false, error: null as string | null };

function status(): CollectorStatus {
  const collection = store.collection();
  return {
    ...connection,
    lastReceivedAt: collection?.receivedAt ?? null,
    observedAt: collection?.observedAt ?? null,
    sources: collection?.sources ?? null,
    ...store.counts(),
  };
}
function publish() {
  const frame = `event: status\ndata: ${JSON.stringify(status())}\n\n`;
  for (const client of clients) if (!client.write(frame)) client.destroy();
}
function json(response: ServerResponse, code: number, value: unknown) {
  response.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(value));
}
function dateParam(value: string | null, fallback: Date): string {
  if (!value) return fallback.toISOString();
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new Error("Invalid date");
  return new Date(milliseconds).toISOString();
}
const types: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
};
const staticFiles = new Set([
  "index.html",
  "app.js",
  "style.css",
  "leaflet.css",
  "images/layers.png",
  "images/layers-2x.png",
  "images/marker-icon.png",
  "images/marker-icon-2x.png",
  "images/marker-shadow.png",
]);
const server = createServer((request, response) => {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://tile.openstreetmap.org; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  );
  if (request.method !== "GET") {
    json(response, 405, { error: "Method not allowed" });
    return;
  }
  try {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname === "/healthz") {
      const current = status();
      const fresh =
        current.lastReceivedAt !== null &&
        current.observedAt !== null &&
        Date.now() - Date.parse(current.lastReceivedAt) < 120_000 &&
        Date.now() - Date.parse(current.observedAt) < 120_000;
      json(response, current.connected && fresh ? 200 : 503, {
        ok: current.connected && fresh,
        ...current,
      });
    } else if (url.pathname === "/api/status") {
      json(response, 200, status());
    } else if (url.pathname === "/api/entities") {
      json(response, 200, store.entities());
    } else if (url.pathname === "/api/track") {
      const kind = url.searchParams.get("kind") as Kind;
      const id = url.searchParams.get("id");
      if (!["person", "device", "item"].includes(kind) || !id) {
        json(response, 400, { error: "kind and id are required" });
        return;
      }
      const from = dateParam(
        url.searchParams.get("from"),
        new Date(Date.now() - 86_400_000),
      );
      const to = dateParam(url.searchParams.get("to"), new Date());
      const limit = Number(url.searchParams.get("limit") ?? 10_000);
      if (
        from > to ||
        Date.parse(to) - Date.parse(from) > 366 * 86_400_000 ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 20_000
      ) {
        json(response, 400, {
          error: "Query range must be at most 366 days; limit must be 1–20000",
        });
        return;
      }
      json(response, 200, store.track(kind, id, from, to, limit));
    } else if (url.pathname === "/api/events") {
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      response.write(
        `retry: 3000\nevent: status\ndata: ${JSON.stringify(status())}\n\n`,
      );
      clients.add(response);
      const heartbeat = setInterval(() => {
        if (!response.write(": heartbeat\n\n")) response.destroy();
      }, 20_000);
      response.on("close", () => {
        clearInterval(heartbeat);
        clients.delete(response);
      });
    } else {
      const filename =
        url.pathname === "/" ? "index.html" : url.pathname.slice(1);
      if (!staticFiles.has(filename)) {
        json(response, 404, { error: "Not found" });
        return;
      }
      const file = join(publicPath, filename);
      const extension = filename.slice(filename.lastIndexOf("."));
      response.writeHead(200, {
        "Content-Type": types[extension] ?? "application/octet-stream",
        "Content-Length": statSync(file).size,
        "Cache-Control": "no-cache",
      });
      response.end(readFileSync(file));
    }
  } catch (error) {
    if (error instanceof Error && error.message === "Invalid date")
      json(response, 400, { error: error.message });
    else {
      console.error(
        "Request failed:",
        error instanceof Error ? error.message : "unknown error",
      );
      if (!response.headersSent)
        json(response, 500, { error: "Request failed" });
      else response.destroy();
    }
  }
});
const stop = new AbortController();
void collect({
  url: sourceUrl,
  token,
  signal: stop.signal,
  onSnapshot(snapshot) {
    store.ingest(snapshot);
    publish();
  },
  onConnection(connected, error) {
    if (connection.connected !== connected || connection.error !== error)
      console.log(
        connected ? "Source connected" : `Source disconnected: ${error}`,
      );
    connection = { connected, error };
    publish();
  },
});
server.listen(
  Number(process.env.PORT ?? 8787),
  process.env.HOST ?? "127.0.0.1",
  () =>
    console.log(
      `Find My history listening on ${JSON.stringify(server.address())}`,
    ),
);
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.once(signal, () => {
    stop.abort();
    for (const client of clients) client.end();
    server.close(() => {
      store.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 5_000).unref();
  });
