import { DatabaseSync } from "node:sqlite";
import type { Entity, Kind, Snapshot, TrackPoint } from "./types.js";

export class Store {
  readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS entities (
        kind TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL,
        latitude REAL, longitude REAL, accuracy REAL, timestamp TEXT,
        available INTEGER NOT NULL, firstSeen TEXT NOT NULL, lastSeen TEXT NOT NULL,
        isOwnDevice INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (kind, id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS points (
        seq INTEGER PRIMARY KEY, kind TEXT NOT NULL, id TEXT NOT NULL,
        timestamp TEXT, timestampKey TEXT NOT NULL,
        latitude REAL NOT NULL, longitude REAL NOT NULL, accuracy REAL,
        observedAt TEXT NOT NULL,
        FOREIGN KEY (kind, id) REFERENCES entities(kind, id),
        UNIQUE (kind, id, timestampKey, latitude, longitude)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS points_track ON points(kind, id, COALESCE(timestamp, observedAt), seq);
      CREATE TABLE IF NOT EXISTS collection (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        observedAt TEXT NOT NULL, receivedAt TEXT NOT NULL, sources TEXT NOT NULL
      ) STRICT;
    `);
    if (
      !this.db
        .prepare("PRAGMA table_info(entities)")
        .all()
        .some((column) => column.name === "isOwnDevice")
    )
      this.db.exec(
        "ALTER TABLE entities ADD COLUMN isOwnDevice INTEGER NOT NULL DEFAULT 0",
      );
  }

  ingest(snapshot: Snapshot, receivedAt = new Date().toISOString()): void {
    const entity = this.db.prepare(`
      INSERT INTO entities (kind, id, name, latitude, longitude, accuracy,
        timestamp, available, firstSeen, lastSeen, isOwnDevice)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (kind, id) DO UPDATE SET
        name = excluded.name, isOwnDevice = excluded.isOwnDevice,
        latitude = CASE WHEN excluded.available = 1 AND
          (entities.timestamp IS NULL OR excluded.timestamp >= entities.timestamp)
          THEN excluded.latitude ELSE entities.latitude END,
        longitude = CASE WHEN excluded.available = 1 AND
          (entities.timestamp IS NULL OR excluded.timestamp >= entities.timestamp)
          THEN excluded.longitude ELSE entities.longitude END,
        accuracy = CASE WHEN excluded.available = 1 AND
          (entities.timestamp IS NULL OR excluded.timestamp >= entities.timestamp)
          THEN excluded.accuracy ELSE entities.accuracy END,
        timestamp = CASE WHEN excluded.available = 1 AND
          (entities.timestamp IS NULL OR excluded.timestamp >= entities.timestamp)
          THEN excluded.timestamp ELSE entities.timestamp END,
        available = excluded.available, lastSeen = excluded.lastSeen
    `);
    const point = this.db.prepare(`INSERT OR IGNORE INTO points
      (kind, id, timestamp, timestampKey, latitude, longitude, accuracy, observedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const location of snapshot.locations) {
        const available =
          location.latitude !== null && location.longitude !== null;
        entity.run(
          location.kind,
          location.id,
          location.name,
          location.latitude,
          location.longitude,
          location.accuracy,
          location.timestamp,
          Number(available),
          snapshot.observedAt,
          snapshot.observedAt,
          Number(location.kind === "device" && location.isOwnDevice === true),
        );
        if (available) {
          point.run(
            location.kind,
            location.id,
            location.timestamp,
            location.timestamp ?? "",
            location.latitude,
            location.longitude,
            location.accuracy,
            snapshot.observedAt,
          );
        }
      }
      this.db
        .prepare(
          `INSERT INTO collection VALUES (1, ?, ?, ?)
        ON CONFLICT (singleton) DO UPDATE SET observedAt = excluded.observedAt,
        receivedAt = excluded.receivedAt, sources = excluded.sources`,
        )
        .run(snapshot.observedAt, receivedAt, JSON.stringify(snapshot.sources));
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  collection(): {
    observedAt: string;
    receivedAt: string;
    sources: Snapshot["sources"];
  } | null {
    const row = this.db
      .prepare("SELECT * FROM collection WHERE singleton = 1")
      .get();
    return row
      ? {
          observedAt: row.observedAt as string,
          receivedAt: row.receivedAt as string,
          sources: JSON.parse(row.sources as string) as Snapshot["sources"],
        }
      : null;
  }

  counts(): { pointCount: number; entityCount: number } {
    return {
      pointCount: Number(
        this.db.prepare("SELECT count(*) AS n FROM points").get()!.n,
      ),
      entityCount: Number(
        this.db.prepare("SELECT count(*) AS n FROM entities").get()!.n,
      ),
    };
  }

  entities(): Entity[] {
    return this.db
      .prepare(
        `SELECT entities.*,
      (SELECT count(*) FROM points WHERE points.kind=entities.kind AND points.id=entities.id) AS pointCount
      FROM entities ORDER BY latitude IS NULL, isOwnDevice DESC, kind, name`,
      )
      .all() as unknown as Entity[];
  }

  track(
    kind: Kind,
    id: string,
    from: string,
    to: string,
    limit: number,
  ): { points: TrackPoint[]; truncated: boolean } {
    // Timeless fixes remain timeless. The observation date only places them in a query window.
    const rows = this.db
      .prepare(
        `SELECT latitude, longitude, accuracy, timestamp, observedAt FROM points
      WHERE kind = ? AND id = ? AND COALESCE(timestamp, observedAt) >= ? AND COALESCE(timestamp, observedAt) <= ?
      ORDER BY COALESCE(timestamp, observedAt) DESC, seq DESC LIMIT ?`,
      )
      .all(kind, id, from, to, limit + 1) as unknown as TrackPoint[];
    return {
      points: rows.slice(0, limit).reverse(),
      truncated: rows.length > limit,
    };
  }

  close() {
    this.db.close();
  }
}
