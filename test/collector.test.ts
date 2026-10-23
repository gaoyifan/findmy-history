import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store.js";
import { collect, events, parseSnapshot } from "../src/source.js";
import type { Snapshot } from "../src/types.js";
function snapshot(
  timestamp: string | null = "2026-10-21T07:00:00.000Z",
): Snapshot {
  return {
    observedAt: "2026-10-21T08:00:00.000Z",
    locations: [
      {
        kind: "person",
        id: "test-person",
        name: "<script>not HTML</script>",
        latitude: 31.2,
        longitude: 121.4,
        accuracy: 12,
        timestamp,
      },
    ],
    sources: {
      people: { ok: true, count: 1 },
      devices: { ok: false, count: 0, error: "unavailable" },
      items: { ok: false, count: 0, error: "missing cache" },
    },
  };
}
test("replays deduplicate fixes with or without source timestamps, while newer source times remain latest", () => {
  const store = new Store(":memory:");
  try {
    store.ingest(snapshot());
    const replay = snapshot();
    replay.observedAt = "2026-10-21T08:01:00.000Z";
    store.ingest(replay);
    assert.equal(store.counts().pointCount, 1);
    store.ingest(snapshot("2026-10-21T07:01:00.000Z"));
    store.ingest(snapshot("2026-10-21T06:59:00.000Z"));
    assert.equal(store.counts().pointCount, 3);
    assert.equal(store.entities()[0].timestamp, "2026-10-21T07:01:00.000Z");
    store.ingest(snapshot(null));
    store.ingest(snapshot(null));
    assert.equal(store.counts().pointCount, 4);
    assert.equal(store.entities()[0].timestamp, "2026-10-21T07:01:00.000Z");
    const untimed = snapshot(null);
    untimed.locations[0].latitude = 30;
    store.ingest(untimed);
    assert.equal(store.entities()[0].latitude, 31.2);
    assert.equal(store.counts().pointCount, 5);
    assert.equal(
      store.track(
        "person",
        "test-person",
        "2026-10-20T00:00:00.000Z",
        "2026-10-22T00:00:00.000Z",
        2,
      ).truncated,
      true,
    );
  } finally {
    store.close();
  }
});
test("unavailable fixes and failed sources preserve history without fabricating fixes", () => {
  const store = new Store(":memory:");
  try {
    store.ingest(snapshot());
    const unavailable = snapshot();
    unavailable.locations[0].latitude = null;
    unavailable.locations[0].longitude = null;
    unavailable.locations[0].timestamp = null;
    store.ingest(unavailable);
    assert.equal(store.entities()[0].available, 0);
    assert.equal(store.entities()[0].latitude, 31.2);
    assert.equal(store.entities()[0].timestamp, "2026-10-21T07:00:00.000Z");
    const failed = snapshot();
    failed.locations = [];
    failed.sources.people = { ok: false, count: 0, error: "permission denied" };
    store.ingest(failed);
    assert.equal(store.entities().length, 1);
    assert.equal(store.counts().pointCount, 1);
    assert.equal(store.collection()!.sources.people.ok, false);
  } finally {
    store.close();
  }
});
test("ownership migration preserves history and sorts located own devices first without name assumptions", () => {
  const directory = mkdtempSync(join(tmpdir(), "findmy-ownership-"));
  const path = join(directory, "history.sqlite");
  const legacy = new DatabaseSync(path);
  legacy.exec(`CREATE TABLE entities (
    kind TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL,
    latitude REAL, longitude REAL, accuracy REAL, timestamp TEXT,
    available INTEGER NOT NULL, firstSeen TEXT NOT NULL, lastSeen TEXT NOT NULL,
    PRIMARY KEY (kind, id)
  ) STRICT;
  INSERT INTO entities VALUES ('device', 'legacy', 'Legacy', 31, 121, 12,
    '2026-10-21T07:00:00.000Z', 1, '2026-10-21T08:00:00.000Z', '2026-10-21T08:00:00.000Z');
  CREATE TABLE points (
    seq INTEGER PRIMARY KEY, kind TEXT, id TEXT, timestamp TEXT, timestampKey TEXT,
    latitude REAL, longitude REAL, accuracy REAL, observedAt TEXT,
    UNIQUE (kind, id, timestampKey, latitude, longitude)
  );
  INSERT INTO points VALUES (1, 'device', 'legacy', '2026-10-21T07:00:00.000Z',
    '2026-10-21T07:00:00.000Z', 31, 121, 12, '2026-10-21T08:00:00.000Z');`);
  legacy.close();
  const store = new Store(path);
  try {
    assert.equal(store.entities()[0].id, "legacy");
    assert.equal(store.entities()[0].latitude, 31);
    assert.equal(store.entities()[0].isOwnDevice, 0);
    const value = snapshot();
    value.locations = [
      {
        ...value.locations[0],
        kind: "device",
        id: "family",
        name: "A",
        isOwnDevice: false,
      },
      {
        ...value.locations[0],
        kind: "device",
        id: "own",
        name: "Z",
        isOwnDevice: true,
      },
      {
        ...value.locations[0],
        kind: "device",
        id: "missing",
        name: "B",
        latitude: null,
        longitude: null,
        isOwnDevice: true,
      },
    ];
    store.ingest(parseSnapshot(JSON.stringify(value)));
    assert.deepEqual(
      store.entities().map((entity) => entity.id),
      ["own", "family", "legacy", "missing"],
    );
    assert.equal(store.counts().pointCount, 3);
    // Ownership can change without a new GPS fix or a new history point.
    value.locations[0].isOwnDevice = true;
    value.locations[1].isOwnDevice = false;
    store.ingest(value);
    assert.equal(store.entities()[0].id, "family");
    assert.equal(store.counts().pointCount, 3);
  } finally {
    store.close();
    rmSync(directory, { recursive: true });
  }
});
test("SSE decoding handles comments, CRLF, multi-line data and split UTF-8", async () => {
  const bytes = new TextEncoder().encode(
    ": comment\r\nevent: snapshot\r\ndata: 第一行\r\ndata: 第二行\r\n\r\n",
  );
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
      controller.close();
    },
  });
  const result = [];
  for await (const event of events(stream)) result.push(event);
  assert.deepEqual(result, [{ event: "snapshot", data: "第一行\n第二行" }]);
});
test("snapshot validation normalizes timestamp offsets and rejects invalid coordinates", () => {
  const value = snapshot("2026-10-21T15:00:00+08:00");
  value.sources.devices.updatedAt = "2026-10-21T14:59:00+08:00";
  const parsed = parseSnapshot(JSON.stringify(value));
  assert.equal(parsed.locations[0].timestamp, "2026-10-21T07:00:00.000Z");
  assert.equal(parsed.sources.devices.updatedAt, "2026-10-21T06:59:00.000Z");
  value.sources.devices.updatedAt = "invalid";
  assert.throws(
    () => parseSnapshot(JSON.stringify(value)),
    /Invalid devices cache timestamp/,
  );
  delete value.sources.devices.updatedAt;
  value.locations[0].isOwnDevice = "false" as unknown as boolean;
  assert.throws(
    () => parseSnapshot(JSON.stringify(value)),
    /Invalid source location/,
  );
  delete value.locations[0].isOwnDevice;
  value.locations[0].latitude = 91;
  assert.throws(
    () => parseSnapshot(JSON.stringify(value)),
    /Invalid source location/,
  );
});
test("collector reconnects and a replay does not duplicate stored fixes", async () => {
  const store = new Store(":memory:");
  let attempts = 0;
  const controller = new AbortController();
  const server = createServer((request, response) => {
    assert.equal(request.headers.authorization, "Bearer test-source-token");
    attempts++;
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(`event: snapshot\ndata: ${JSON.stringify(snapshot())}\n\n`);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const states: boolean[] = [];
  try {
    await collect({
      url: `http://127.0.0.1:${address.port}/events`,
      token: "test-source-token",
      signal: controller.signal,
      retryMs: 5,
      onSnapshot(value) {
        store.ingest(value);
        if (attempts >= 2) controller.abort();
      },
      onConnection(connected) {
        states.push(connected);
      },
    });
    assert.ok(attempts >= 2);
    assert.ok(states.includes(false));
    assert.equal(store.counts().pointCount, 1);
  } finally {
    server.closeAllConnections();
    server.close();
    store.close();
  }
});
