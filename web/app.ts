import * as L from "leaflet";
import type {
  CollectorStatus,
  Entity,
  Kind,
  TrackPoint,
} from "../src/types.js";

function element<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}
function text(id: string, value: string) {
  element(id).textContent = value;
}
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  value?: string,
) {
  const node = document.createElement(tag);
  node.className = className;
  if (value !== undefined) node.textContent = value;
  return node;
}
const labels: Record<Kind, string> = {
  person: "联系人",
  device: "设备",
  item: "物品",
};
const icons: Record<Kind, string> = { person: "♙", device: "▯", item: "◇" };
const sourceKeys: Record<Kind, "people" | "devices" | "items"> = {
  person: "people",
  device: "devices",
  item: "items",
};
const formatter = new Intl.DateTimeFormat("zh-CN", {
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});
function date(value: string | null) {
  return value ? formatter.format(new Date(value)) : "定位时间未知";
}
function relative(value: string | null): string {
  if (!value) return "定位时间未知";
  const seconds = Math.max(
    0,
    Math.floor((Date.now() - Date.parse(value)) / 1000),
  );
  if (seconds < 60) return "刚刚定位";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} 小时前`;
  return `${Math.floor(seconds / 86_400)} 天前`;
}
function isFresh(value: string | null) {
  return value !== null && Date.now() - Date.parse(value) < 300_000;
}
const map = L.map("map", { zoomControl: false }).setView([31.23, 121.47], 10);
L.control.zoom({ position: "bottomright" }).addTo(map);
let tiles: L.TileLayer | null = null;
function enableTiles() {
  if (!tiles)
    tiles = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a>',
    }).addTo(map);
}
const layers = L.featureGroup().addTo(map);
let entities: Entity[] = [];
let selected: Entity | null = null;
let filter: Kind | "all" = "all";
let currentStatus: CollectorStatus | null = null;
let currentPoints: TrackPoint[] = [];
let hasFitted = false;
let trackAbort: AbortController | null = null;
const range = element<HTMLSelectElement>("range");
const initialEntity = new URL(location.href).searchParams.get("entity");

async function api<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`读取失败（HTTP ${response.status}）`);
  return response.json() as Promise<T>;
}
function showMessage(message: string | null) {
  const box = element("map-message");
  box.hidden = message === null;
  box.textContent = message;
}
function renderStatus(status: CollectorStatus) {
  currentStatus = status;
  const recent =
    status.lastReceivedAt !== null &&
    Date.now() - Date.parse(status.lastReceivedAt) < 120_000;
  const observedRecently =
    status.observedAt !== null &&
    Date.now() - Date.parse(status.observedAt) < 120_000;
  const healthy = status.connected && recent && observedRecently;
  text(
    "connection",
    healthy
      ? "持续采集中"
      : status.connected
        ? "已连接 · 等待新数据"
        : "采集连接中断 · 正在重连",
  );
  element("connection-dot").className = `dot ${healthy ? "online" : "warning"}`;
  element("connection").title = status.error ?? "";
  text("entity-count", status.entityCount.toLocaleString("zh-CN"));
  text("point-count", status.pointCount.toLocaleString("zh-CN"));
  text(
    "last-received",
    status.lastReceivedAt
      ? `最近接收 ${date(status.lastReceivedAt)}`
      : "尚未收到采集数据",
  );
  const sources = element("sources");
  sources.replaceChildren();
  for (const kind of ["person", "device", "item"] as const) {
    const source = status.sources?.[sourceKeys[kind]];
    const chip = el(
      "div",
      `source ${source ? (source.ok ? "ok" : "failed") : ""}`,
      `${labels[kind]} ${source ? (source.ok ? String(source.count) : "未就绪") : "等待"}`,
    );
    chip.title =
      source?.error ??
      (source
        ? `${source.count} 个对象，状态来自最近一次采集`
        : "尚未收到状态");
    sources.append(chip);
  }
}
function renderEntities() {
  const list = element("entities");
  list.replaceChildren();
  const shown = entities.filter(
    (entity) => filter === "all" || entity.kind === filter,
  );
  if (!shown.length)
    list.append(
      el(
        "p",
        "empty",
        entities.length ? "此类型尚无记录" : "等待第一批位置数据…",
      ),
    );
  for (const entity of shown) {
    const button = el(
      "button",
      `entity ${selected?.kind === entity.kind && selected.id === entity.id ? "active" : ""}`,
    );
    button.type = "button";
    button.setAttribute(
      "aria-pressed",
      String(selected?.kind === entity.kind && selected.id === entity.id),
    );
    button.append(el("span", "entity-icon", icons[entity.kind]));
    const info = el("span", "entity-info");
    info.append(el("span", "entity-name", entity.name || entity.id));
    info.append(
      el(
        "span",
        "entity-time",
        entity.available
          ? relative(entity.timestamp)
          : entity.latitude !== null
            ? `暂不可用 · ${relative(entity.timestamp)}`
            : "暂无定位",
      ),
    );
    button.append(
      info,
      el(
        "span",
        `entity-state ${entity.available && isFresh(entity.timestamp) ? "fresh" : ""}`,
      ),
    );
    button.addEventListener("click", () => {
      selected = entity;
      hasFitted = false;
      renderEntities();
      void loadTrack();
      const url = new URL(location.href);
      url.searchParams.set("entity", `${entity.kind}:${entity.id}`);
      history.replaceState(null, "", url);
    });
    list.append(button);
  }
}
async function loadEntities() {
  entities = await api<Entity[]>("/api/entities");
  if (selected)
    selected =
      entities.find(
        (entity) =>
          entity.kind === selected!.kind && entity.id === selected!.id,
      ) ?? selected;
  else
    selected =
      entities.find(
        (entity) => `${entity.kind}:${entity.id}` === initialEntity,
      ) ??
      entities.find((entity) => entity.latitude !== null) ??
      entities[0] ??
      null;
  renderEntities();
  await loadTrack();
}
function popup(point: TrackPoint, index: number) {
  const content = el("div", "");
  content.append(
    el("div", "popup-title", `${selected?.name ?? ""} · 第 ${index + 1} 点`),
    el("div", "popup-detail", date(point.timestamp)),
    el(
      "div",
      "popup-detail",
      `${point.latitude.toFixed(6)}, ${point.longitude.toFixed(6)}`,
    ),
    el(
      "div",
      "popup-detail",
      point.accuracy === null
        ? "精度未知"
        : `精度约 ${Math.round(point.accuracy)} 米`,
    ),
  );
  if (point.timestamp === null)
    content.append(
      el("div", "popup-detail", `采集于 ${date(point.observedAt)}`),
    );
  return content;
}
function fitMap() {
  if (layers.getLayers().length) {
    map.fitBounds(layers.getBounds(), { padding: [42, 42], maxZoom: 16 });
    hasFitted = true;
  }
}
async function loadTrack() {
  if (!selected) return;
  trackAbort?.abort();
  const controller = new AbortController();
  trackAbort = controller;
  const selection = selected;
  text("selection-kind", labels[selection.kind]);
  text("selection-name", selection.name || selection.id);
  text("latest-fix", date(selection.timestamp));
  text(
    "accuracy",
    selection.accuracy === null
      ? "—"
      : `约 ${Math.round(selection.accuracy)} 米`,
  );
  try {
    let from: Date, to: Date;
    if (range.value === "custom") {
      from = new Date(element<HTMLInputElement>("from").value);
      to = new Date(element<HTMLInputElement>("to").value);
      if (
        !Number.isFinite(from.getTime()) ||
        !Number.isFinite(to.getTime()) ||
        from > to
      ) {
        showMessage("请选择有效的起止时间");
        return;
      }
      if (to.getTime() - from.getTime() > 366 * 86_400_000) {
        showMessage("时间范围最长为 366 天");
        return;
      }
    } else {
      to = new Date();
      from = new Date(to.getTime() - Number(range.value) * 3_600_000);
    }
    const query = new URLSearchParams({
      kind: selection.kind,
      id: selection.id,
      from: from.toISOString(),
      to: to.toISOString(),
      limit: "10000",
    });
    const result = await api<{ points: TrackPoint[]; truncated: boolean }>(
      `/api/track?${query}`,
      controller.signal,
    );
    if (controller.signal.aborted) return;
    currentPoints = result.points;
    layers.clearLayers();
    const coords = currentPoints.map(
      (point) => [point.latitude, point.longitude] as L.LatLngTuple,
    );
    if (coords.length) {
      enableTiles();
      L.polyline(coords, { color: "#4f805b", weight: 3, opacity: 0.8 }).addTo(
        layers,
      );
      const stride = Math.max(1, Math.ceil(currentPoints.length / 300));
      currentPoints.forEach((point, i) => {
        const last = i === currentPoints.length - 1;
        if (i % stride !== 0 && !last) return;
        L.circleMarker([point.latitude, point.longitude], {
          radius: last ? 7 : 3.5,
          color: last ? "#fff" : "#52775b",
          weight: last ? 3 : 1.5,
          fillColor: "#4f805b",
          fillOpacity: last ? 1 : 0.65,
        })
          .bindPopup(popup(point, i))
          .addTo(layers);
        if (last && point.accuracy !== null && point.accuracy > 0)
          L.circle([point.latitude, point.longitude], {
            radius: point.accuracy,
            color: "#7d9c7b",
            weight: 1,
            fillOpacity: 0.08,
            interactive: false,
          }).addTo(layers);
      });
      if (!hasFitted) fitMap();
    }
    element("map-empty").hidden = coords.length > 0;
    if (!coords.length) {
      const empty = element("map-empty");
      empty.querySelector("h3")!.textContent = "此时间范围内暂无轨迹";
      empty.querySelector("p")!.textContent =
        selection.latitude !== null
          ? "可尝试扩大时间范围。"
          : "等待此对象提供有效位置。";
    }
    text(
      "track-count",
      `${currentPoints.length.toLocaleString("zh-CN")} 个点${result.truncated ? "（已截取）" : ""}`,
    );
    element<HTMLButtonElement>("export").disabled = !currentPoints.length;
    showMessage(
      result.truncated
        ? "轨迹较长，当前展示最近 10,000 个点。请缩短时间范围。"
        : !selection.available && coords.length
          ? "当前定位不可用，显示已保存的历史位置。"
          : null,
    );
    renderTimeline();
  } catch (error) {
    if (!controller.signal.aborted)
      showMessage(error instanceof Error ? error.message : "读取轨迹失败");
  }
}
function renderTimeline() {
  const timeline = element("timeline");
  timeline.replaceChildren();
  const recent = currentPoints.slice(-60).reverse();
  text(
    "timeline-caption",
    currentPoints.length > 60
      ? "展示最近 60 个点 · 按定位时间排列"
      : "按定位时间排列",
  );
  if (!recent.length) timeline.append(el("p", "empty", "暂无轨迹点"));
  for (const point of recent) {
    const button = el("button", "timeline-point");
    const time = el("time", "", date(point.timestamp));
    if (point.timestamp) time.dateTime = point.timestamp;
    button.append(
      time,
      el(
        "span",
        "",
        `${point.latitude.toFixed(5)}, ${point.longitude.toFixed(5)}`,
      ),
    );
    button.title =
      point.timestamp === null
        ? `定位时间未知；采集于 ${date(point.observedAt)}`
        : `精度 ${point.accuracy === null ? "未知" : `${Math.round(point.accuracy)} 米`}`;
    button.addEventListener("click", () => {
      map.setView([point.latitude, point.longitude], 16);
      L.popup()
        .setLatLng([point.latitude, point.longitude])
        .setContent(popup(point, currentPoints.indexOf(point)))
        .openOn(map);
    });
    timeline.append(button);
  }
}
for (const button of document.querySelectorAll<HTMLButtonElement>(".filter"))
  button.addEventListener("click", () => {
    filter = button.dataset.kind as Kind | "all";
    document.querySelectorAll(".filter").forEach((item) => {
      const active = item === button;
      item.classList.toggle("active", active);
      item.setAttribute("aria-pressed", String(active));
    });
    renderEntities();
  });
range.addEventListener("change", () => {
  element("custom-range").hidden = range.value !== "custom";
  hasFitted = false;
  if (range.value !== "custom") void loadTrack();
});
element("apply-range").addEventListener("click", () => {
  hasFitted = false;
  void loadTrack();
});
element("fit-map").addEventListener("click", fitMap);
element("export").addEventListener("click", () => {
  if (!selected || !currentPoints.length) return;
  const features = currentPoints.map((point) => ({
    type: "Feature",
    geometry: { type: "Point", coordinates: [point.longitude, point.latitude] },
    properties: {
      kind: selected!.kind,
      id: selected!.id,
      name: selected!.name,
      timestamp: point.timestamp,
      observedAt: point.observedAt,
      accuracy: point.accuracy,
    },
  }));
  const blob = new Blob(
    [JSON.stringify({ type: "FeatureCollection", features }, null, 2)],
    { type: "application/geo+json" },
  );
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `findmy-${selected.kind}-${new Date().toISOString().slice(0, 10)}.geojson`;
  anchor.click();
  URL.revokeObjectURL(url);
});
function localDateTime(value: Date) {
  return new Date(value.getTime() - value.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16);
}
element<HTMLInputElement>("from").value = localDateTime(
  new Date(Date.now() - 86_400_000),
);
element<HTMLInputElement>("to").value = localDateTime(new Date());
const updates = new EventSource("/api/events");
let refreshRunning = false;
let refreshPending = false;
async function refresh() {
  if (refreshRunning) {
    refreshPending = true;
    return;
  }
  refreshRunning = true;
  try {
    await loadEntities();
  } catch (error) {
    showMessage(error instanceof Error ? error.message : "无法读取数据");
  } finally {
    refreshRunning = false;
    if (refreshPending) {
      refreshPending = false;
      void refresh();
    }
  }
}
updates.addEventListener("status", (event) => {
  renderStatus(JSON.parse((event as MessageEvent).data) as CollectorStatus);
  void refresh();
});
updates.onerror = () => {
  text("connection", "页面连接中断 · 正在重连");
  element("connection-dot").className = "dot warning";
};
setInterval(() => {
  if (currentStatus && updates.readyState === EventSource.OPEN)
    renderStatus(currentStatus);
  renderEntities();
}, 30_000);
