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

/**
 * Time spent in one place; `place` is null for a stay at a position that matched no place. `home` is true when the place is the home in
 * effect on the day served, and false for every other stay (one with no place too); the server always writes it.
 */
export interface StaySegment extends SegmentBase {
  kind: "stay";
  place: PlaceRef | null;
  home: boolean;
}

/** Travel between two stays; `geometry` is the stored (detail) line. A mode the server could not tell is left out of the JSON, as null is. */
export interface MoveSegment extends SegmentBase {
  kind: "move";
  mode?: Mode | null;
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

/** A move to draw; `geometry` is the coarse line. A mode the server could not tell is left out of the JSON, as null is. */
export interface RangeMove {
  id: number;
  mode?: Mode | null;
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

// --- GET /api/day/{date}/points (Features/Points) and the removal of points ---

/**
 * One raw point of a day: `[t, lon, lat, device]`. `t` is the exact time in epoch microseconds, a whole number that a JavaScript number holds exactly:
 * it is never rounded or turned into milliseconds, and is sent back as it came, for it is what the point is told from the others by. `device` is
 * the index into `devices` of the answer.
 */
export type RawPoint = [t: number, lon: number, lat: number, device: number];

/** The points of a day in time order, those removed earlier left out. A point may be on the neighbouring day too: a day spans the zones of its segments. */
export interface DayPointsResponse {
  date: string;
  devices: string[];
  points: RawPoint[];
}

/** A point to remove, as the server tells it: by the device and the exact time (epoch microseconds). */
export interface PointRef {
  device: string;
  t: number;
}

/** The answer to `POST /api/points/remove`: the batch to restore it by, or null when nothing was removed (the points were removed already), and how many points it holds. */
export interface RemovePointsResponse {
  batch: string | null;
  count: number;
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
  /** The places merged directly into this one, by name (a place with none last); each can be separated again. Empty when there are none. */
  merged: MergedPlace[];
}

/** A place that was merged into the one served: its own id (the one to separate it by) and its name, the owner's or else OpenStreetMap's, or null. */
export interface MergedPlace {
  id: number;
  name: string | null;
}

// --- GET /api/places/{id}/candidates?q= (Features/Places/PlaceResponse.cs, PlaceCandidateDto) ---

/**
 * A place that a place can be merged with: the answer is a bare array of at most 20, nearest first, and never the place itself or one
 * merged into it. `name` is null for a place with none (shown as "Unnamed place"), `address` until the place is named, `distanceM` is
 * the distance in metres from the place asked about and `visits` the stays at it and at the places merged into it.
 */
export interface PlaceCandidate {
  id: number;
  name: string | null;
  address: string | null;
  distanceM: number;
  visits: number;
}

export interface PlaceVisit {
  start: string;
  end: string;
  /** The local date the stay began on, in `timeZone`. */
  date: string;
  /** The IANA zone the stay began in; show its times on that clock. */
  timeZone: string;
}

// --- GET /api/trips and GET /api/trips/{id} (Features/Trips/TripsResponse.cs, TripResponse.cs) ---

/** The trips of the timeline, newest first; empty when there are none. */
export interface TripsResponse {
  trips: TripListItem[];
}

/**
 * What a trip is described by wherever it is served: the list and the trip's own page both have it. `id` is the date of the first away
 * night (`yyyy-MM-dd`), which is the same after every rebuild for as long as the trip starts the same night; `firstNight` and `lastNight`
 * are the dates of the evenings of its first and last away night, and `nights` counts every night between, those with no known position too.
 */
export interface TripSummary {
  id: string;
  /** Made up when asked for: "Lisbon", "Lisbon & Porto", "Portugal & Spain"; "Trip" when nothing is known of where the nights were. */
  name: string;
  firstNight: string;
  lastNight: string;
  nights: number;
  /** When the person left and came back; `end` is null while the trip is `ongoing`. */
  start: string;
  end: string | null;
  startTimeZone: string;
  endTimeZone: string;
  /** The dates of `start` and `end` on the clocks of their zones; for an ongoing trip the end date is the day after its last night. */
  localStartDate: string;
  localEndDate: string;
  ongoing: boolean;
  cities: TripCity[];
  /**
   * Whether the owner has edited the trip: given it a name, or changed its dates (which is why its `id` may not be the night that detection found it on).
   * `name` is the owner's when they gave one and the made-up one when they did not, and nothing else here says which.
   */
  edited: boolean;
}

/** A trip of the list: its summary and the line to draw for it, home, the places it slept at, home (an ongoing trip has not come back, so it stops at the last place). */
export interface TripListItem extends TripSummary {
  thumbnail: LonLat[];
}

/** A city a trip stayed in: its name (the country, for nights whose place has no city), its known nights, and the mean of their positions. */
export interface TripCity {
  name: string;
  country: string | null;
  nights: number;
  lat: number;
  lon: number;
}

/** One trip with all its page is drawn from: its summary (not the list's thumbnail), what it adds up to, its moves and its days. */
export interface TripResponse extends TripSummary {
  stats: TripStats;
  moves: TripMove[];
  days: TripDay[];
}

/** What the trip adds up to: flights, distinct cities and places, and the distance of the moves that are not flights. */
export interface TripStats {
  flights: number;
  cities: number;
  places: number;
  groundDistanceMeters: number;
}

/** A move of the trip to draw; `geometry` is its coarse line. A mode that could not be told is written out as null. */
export interface TripMove {
  id: number;
  mode: Mode | null;
  distanceMeters: number;
  geometry: LonLat[];
}

/** A local day of the trip: where it was spent ("Oslo → Lisbon"), up to three named places with the most time, and the day's moves. */
export interface TripDay {
  date: string;
  description: string;
  highlights: string[];
  groundDistanceMeters: number;
  flights: number;
}

// --- PUT /api/trips/{id}, GET /api/trips/deleted (Features/Trips/EditTripEndpoint.cs, DeletedTripsEndpoints.cs) ---

/** The answer to the edit of a trip: its id now, which is the date of its first night and moves with its start date. */
export interface EditTripResponse {
  id: string;
}

/** A trip that the owner deleted, as the list of them has it: the `key` that restores it, what it was called and when it was (`yyyy-MM-dd`, "Lisbon · 12 – 16 Sep 2026", ISO-8601 UTC). */
export interface DeletedTrip {
  key: string;
  label: string;
  deletedAt: string;
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

/** The answer to `POST /api/status/retry` (Features/Status/RetryFailedEndpoint.cs): how many failed ranges were made due, 0 when none had failed. */
export interface RetryFailedResponse {
  retried: number;
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
