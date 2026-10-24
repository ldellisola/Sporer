// The JSON of the API, as the C# records under src/Sporer.Api/Features/ write it: camelCase, `null` written out (never left
// out) wherever a record says so, times as ISO-8601 UTC strings with a `Z`, dates as plain `yyyy-MM-dd`.

/** `done`, or `pending` while points of the period wait to be processed, so that it may still change. */
export type LoadState = "done" | "pending";

export type Mode = "walk" | "cycle" | "drive" | "flight";

/** A position the way GeoJSON writes it: longitude first. */
export type LonLat = [lon: number, lat: number];

export interface LatLon {
  lat: number;
  lon: number;
}

// --- GET /api/day/{date} (Features/Day/DayResponse.cs) ---

export interface DayResponse {
  date: string;
  /** The IANA zone of the day. Each segment carries the zones it starts and ends in; show times in those. */
  timeZone: string;
  state: LoadState;
  summary: DaySummary;
  segments: DaySegment[];
}

export interface DaySummary {
  /** Distinct places among the stays. */
  places: number;
  distanceMeters: number;
  movingSeconds: number;
}

interface SegmentBase {
  id: number;
  start: string;
  end: string;
  startTimeZone: string;
  endTimeZone: string;
}

/** The place of a stay, or of a place-bearing response: the id is the one that survives a merge. */
export interface PlaceRef {
  id: number;
  name: string | null;
  city: string | null;
  country: string | null;
  lat: number;
  lon: number;
}

/** Time spent in one place; `place` is null for a stay at a position that matched no place. */
export interface StaySegment extends SegmentBase {
  kind: "stay";
  place: PlaceRef | null;
}

/** Travel between two stays; `geometry` is the stored (detail) line. */
export interface MoveSegment extends SegmentBase {
  kind: "move";
  mode: Mode | null;
  distanceMeters: number;
  geometry: LonLat[];
}

/** Time with no data, from the last position known before it to the first one after it. */
export interface GapSegment extends SegmentBase {
  kind: "gap";
  from: LatLon | null;
  to: LatLon | null;
}

/** Told apart by `kind`; what is particular to a kind is absent from the others. */
export type DaySegment = StaySegment | MoveSegment | GapSegment;

// --- GET /api/range?from=&to= (Features/Range/RangeResponse.cs) ---

export interface RangeResponse {
  /** The dates asked for, both included. */
  from: string;
  to: string;
  state: LoadState;
  summary: RangeSummary;
  moves: RangeMove[];
  places: RangePlace[];
  days: RangeDay[];
}

export interface RangeSummary {
  places: number;
  distanceMeters: number;
  movingSeconds: number;
  moves: number;
}

/** A move to draw; `geometry` is the coarse line. */
export interface RangeMove {
  id: number;
  mode: Mode | null;
  start: string;
  end: string;
  geometry: LonLat[];
}

export interface RangePlace extends PlaceRef {
  /** Time spent there within the range. */
  seconds: number;
  /** The number of stays that time was spent in. */
  visits: number;
}

/** A local day on which a segment starts. */
export interface RangeDay {
  date: string;
  distanceMeters: number;
  movingSeconds: number;
  places: number;
}

// --- GET /api/heat?from=&to= (Features/Heat/HeatResponse.cs) ---

/** `[lon, lat, seconds]`: the centre of a grid cell and the time spent in it. */
export type HeatCell = [lon: number, lat: number, seconds: number];

export interface HeatResponse {
  /** The seconds of the first cell, to scale the others by; 0 when there are none. */
  maxSeconds: number;
  /** The most time first. */
  cells: HeatCell[];
}

// --- GET /api/places/{id} (Features/Places/PlaceResponse.cs) ---

export interface PlaceResponse {
  id: number;
  name: string | null;
  address: string | null;
  city: string | null;
  country: string | null;
  lat: number;
  lon: number;
  totalSeconds: number;
  visits: number;
  /** When the earliest and the latest stay began. */
  firstVisit: string;
  lastVisit: string;
  /** The latest 50 stays, newest first. */
  recentVisits: PlaceVisit[];
}

export interface PlaceVisit {
  start: string;
  end: string;
  /** The local date the stay began on, in `timeZone`. */
  date: string;
  /** The IANA zone the stay began in; show its times on that clock. */
  timeZone: string;
}

// --- GET /api/status (Features/Status/StatusResponse.cs) ---

export interface StatusResponse {
  algorithmVersion: string | null;
  backfill: BackfillStatus;
  /** Dirty ranges that wait to be processed, the failed ones included. */
  pendingRanges: number;
  failedRanges: FailedRange[];
  lastRunAt: string | null;
  lastError: string | null;
  places: PlaceStatus;
  warnings: string[];
}

export interface BackfillStatus {
  from: string | null;
  to: string | null;
  cursor: string | null;
  /** 0 to 100, rounded down; 100 only for a backfill that is done, and when there is nothing to backfill. */
  percent: number;
  paused: boolean;
}

export interface FailedRange {
  from: string;
  to: string;
  attempts: number;
  lastError: string | null;
}

export interface PlaceStatus {
  total: number;
  unnamed: number;
  failed: number;
}

// --- GET /api/config (Features/Config/GetConfigEndpoint.cs) ---

export interface ConfigResponse {
  /** URL of the MapLibre style document for the light colour scheme. */
  mapStyleLight: string;
  mapStyleDark: string;
}
