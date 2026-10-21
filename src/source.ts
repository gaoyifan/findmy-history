import { setTimeout as delay } from "node:timers/promises";
import type { Snapshot, SourceStatus } from "./types.js";

/** Decode SSE across arbitrary UTF-8 and CRLF transport chunk boundaries. */
export async function* events(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<{ event: string; data: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let event = "message";
  let data: string[] = [];
  let frameSize = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      pending += decoder.decode(result.value, { stream: true });
      if (pending.length + frameSize > 2_000_000)
        throw new Error("Source SSE frame exceeds 2 MB");
      let end: number;
      while ((end = pending.indexOf("\n")) >= 0) {
        let line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (line === "") {
          if (data.length) yield { event, data: data.join("\n") };
          event = "message";
          data = [];
          frameSize = 0;
        } else if (!line.startsWith(":")) {
          const separator = line.indexOf(":");
          const field = separator < 0 ? line : line.slice(0, separator);
          let value = separator < 0 ? "" : line.slice(separator + 1);
          if (value.startsWith(" ")) value = value.slice(1);
          if (field === "event") event = value;
          if (field === "data") {
            data.push(value);
            frameSize += value.length;
          }
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function parseSnapshot(data: string): Snapshot {
  const snapshot = JSON.parse(data) as Snapshot;
  if (
    !snapshot ||
    !validTime(snapshot.observedAt) ||
    !Array.isArray(snapshot.locations) ||
    !snapshot.sources
  )
    throw new Error("Invalid source snapshot");
  snapshot.observedAt = new Date(snapshot.observedAt).toISOString();
  for (const source of ["people", "devices", "items"] as const) {
    const status: SourceStatus = snapshot.sources[source];
    if (
      !status ||
      typeof status.ok !== "boolean" ||
      !Number.isInteger(status.count) ||
      status.count < 0
    )
      throw new Error(`Invalid ${source} status`);
    if (status.updatedAt !== undefined) {
      if (!validTime(status.updatedAt))
        throw new Error(`Invalid ${source} cache timestamp`);
      status.updatedAt = new Date(status.updatedAt).toISOString();
    }
  }
  for (const location of snapshot.locations) {
    if (
      !["person", "device", "item"].includes(location.kind) ||
      typeof location.id !== "string" ||
      !location.id ||
      typeof location.name !== "string" ||
      !coordinate(location.latitude, 90) ||
      !coordinate(location.longitude, 180) ||
      (location.latitude === null) !== (location.longitude === null) ||
      (location.accuracy !== null &&
        (!Number.isFinite(location.accuracy) || location.accuracy < 0)) ||
      (location.timestamp !== null && !validTime(location.timestamp))
    )
      throw new Error("Invalid source location");
    if (location.timestamp !== null)
      location.timestamp = new Date(location.timestamp).toISOString();
  }
  return snapshot;
}
function coordinate(value: number | null, bound: number) {
  return (
    value === null ||
    (typeof value === "number" &&
      Number.isFinite(value) &&
      Math.abs(value) <= bound)
  );
}
function validTime(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

export interface SourceOptions {
  url: string;
  token?: string;
  signal: AbortSignal;
  onSnapshot: (snapshot: Snapshot) => void;
  onConnection: (connected: boolean, error: string | null) => void;
  retryMs?: number;
}

export async function collect(options: SourceOptions): Promise<void> {
  const retryMs = options.retryMs ?? 5_000;
  while (!options.signal.aborted) {
    const controller = new AbortController();
    let idle: ReturnType<typeof setTimeout>;
    const resetIdle = () => {
      clearTimeout(idle);
      idle = setTimeout(
        () => controller.abort(new Error("Source stream idle for 90 seconds")),
        90_000,
      );
    };
    resetIdle();
    try {
      const headers: Record<string, string> = { Accept: "text/event-stream" };
      if (options.token) headers.Authorization = `Bearer ${options.token}`;
      const response = await fetch(options.url, {
        headers,
        signal: AbortSignal.any([options.signal, controller.signal]),
      });
      if (
        !response.ok ||
        !response.body ||
        !response.headers.get("content-type")?.includes("text/event-stream")
      ) {
        await response.body?.cancel();
        throw new Error(
          `Source returned HTTP ${response.status} without an SSE stream`,
        );
      }
      options.onConnection(true, null);
      for await (const event of events(response.body)) {
        resetIdle();
        if (event.event === "snapshot")
          options.onSnapshot(parseSnapshot(event.data));
      }
      throw new Error("Source stream closed");
    } catch (error) {
      if (!options.signal.aborted)
        options.onConnection(
          false,
          error instanceof Error ? error.message : "Source connection failed",
        );
    } finally {
      clearTimeout(idle!);
      controller.abort();
    }
    if (!options.signal.aborted)
      await delay(retryMs, undefined, { signal: options.signal }).catch(
        () => {},
      );
  }
}
