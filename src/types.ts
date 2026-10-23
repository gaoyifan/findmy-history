export type Kind = "person" | "device" | "item";
export interface Location {
  kind: Kind;
  id: string;
  name: string;
  latitude: number | null;
  longitude: number | null;
  accuracy: number | null;
  timestamp: string | null;
  isOwnDevice?: boolean;
}
export interface SourceStatus {
  ok: boolean;
  count: number;
  updatedAt?: string;
  error?: string;
}
export interface Snapshot {
  observedAt: string;
  locations: Location[];
  sources: { people: SourceStatus; devices: SourceStatus; items: SourceStatus };
}
export interface Entity extends Omit<Location, "isOwnDevice"> {
  isOwnDevice: number;
  available: number;
  firstSeen: string;
  lastSeen: string;
  pointCount: number;
}
export interface TrackPoint {
  latitude: number;
  longitude: number;
  accuracy: number | null;
  timestamp: string | null;
  observedAt: string;
}
export interface CollectorStatus {
  connected: boolean;
  lastReceivedAt: string | null;
  observedAt: string | null;
  error: string | null;
  sources: Snapshot["sources"] | null;
  pointCount: number;
  entityCount: number;
}
