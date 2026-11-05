import type { PointDetailResponse, PointNeighbour, PointSegment } from "../api/types";
import { dateRangeLabel } from "../time/dates";
import { formatDistance, formatInteger, formatTime } from "../time/format";
import { MODE_WORDS } from "./layers";

// What the card of a point says, in words: pure, so that what is said of each case is tested without a map. Units: speed in km/h with one decimal, distances
// as everywhere (`formatDistance`), gaps as "1 min 1 s", accuracy and altitude in whole metres.

/** What the card says for what the device did not send. */
export const NOT_RECORDED = "not recorded";

/** A number and its unit are not to be parted by a line break. */
const NBSP = "\u00a0";

/** "12 m": whole metres, grouped by thousands. */
export const formatMetres = (metres: number): string => `${formatInteger(Math.round(metres))}${NBSP}m`;

/** "72.0 km/h" from kilometres an hour, and "5.0 km/h" for 1.4 metres a second. */
export const formatKmh = (kmh: number): string => `${kmh.toFixed(1)}${NBSP}km/h`;
export const formatSpeedMps = (mps: number): string => formatKmh(mps * 3.6);

/** "45 s", "1 min 1 s", "2 min", "2 h 3 min", "3 h": whole seconds, and the unit below the leading one left out when it is zero. */
export function formatGap(seconds: number): string {
  const total = Number.isFinite(seconds) ? Math.max(0, Math.round(seconds)) : 0;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  const h = `${hours}${NBSP}h`;
  const min = `${minutes}${NBSP}min`;
  if (hours > 0) return minutes > 0 ? `${h} ${min}` : h;
  if (minutes > 0) return rest > 0 ? `${min} ${rest}${NBSP}s` : min;
  return `${rest}${NBSP}s`;
}

/** "59.912345, 10.754321": latitude and longitude, 6 decimals (about 10 cm), as text that can be copied. */
export const formatCoordinates = (lat: number, lon: number): string => `${lat.toFixed(6)}, ${lon.toFixed(6)}`;

/** The clock of the point with seconds ("08:46:12"), from its local time (`yyyy-MM-ddTHH:mm:ss`). */
export const localClock = (localTime: string): string => localTime.slice(11, 19);

/** "22 Oct 2026", from its local time (the date on the clock of the place, which is not the browser's), as the app writes a date. */
export function localDate(localTime: string): string {
  const date = localTime.slice(0, 10);
  return dateRangeLabel(date, date);
}

/** The short name of the zone at the time of the point ("CEST", "GMT+9"), or the zone's own name when this browser cannot tell. */
export function zoneName(t: number, zone: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone: zone, timeZoneName: "short" }).formatToParts(new Date(t / 1000));
    return parts.find((part) => part.type === "timeZoneName")?.value ?? zone;
  } catch {
    return zone; // a zone this browser has never heard of
  }
}

/** The accuracy of a point that was ignored for it, in whole metres, but with a decimal when that would not read as above the limit ("100.4 m" against 100 m). */
function accuracyIn(accuracyM: number, maxAccuracyM: number): string {
  return Math.round(accuracyM) > maxAccuracyM ? formatMetres(accuracyM) : `${accuracyM.toFixed(1)}${NBSP}m`;
}

/** The status in words: whether the timeline uses the point, and if not, why. */
export function statusText({ status, accuracyM, maxAccuracyM }: Pick<PointDetailResponse, "status" | "accuracyM" | "maxAccuracyM">): string {
  switch (status) {
    case "used":
      return "Used by the timeline";
    case "poorAccuracy":
      return accuracyM !== null && accuracyM >= 0
        ? `Ignored: the GPS accuracy was ${accuracyIn(accuracyM, maxAccuracyM)} (more than ${formatMetres(maxAccuracyM)})`
        : "Ignored: the GPS accuracy was not valid";
    case "glitch":
      return "Ignored: an out-and-back jump";
    case "duplicate":
      return "Ignored: a repeat of an earlier point";
    case "removed":
      return "Removed by you";
  }
}

/** Where the point is in the day: "In a stay at Home (08:00–09:30)", "In a move: Drive (…)", "In a gap (…)"; null when no segment covers it. */
export function segmentText(segment: PointSegment | null, zone: string): string | null {
  if (segment === null) return null;
  const times = `${formatTime(segment.startUtc, zone)}–${formatTime(segment.endUtc, zone)}`;
  if (segment.kind === "stay") return `In a stay at ${segment.place?.name ?? "a place with no name"} (${times})`;
  if (segment.kind === "move") {
    const mode = segment.mode !== undefined && segment.mode in MODE_WORDS ? MODE_WORDS[segment.mode as keyof typeof MODE_WORDS] : MODE_WORDS.unknown;
    return `In a move${mode === MODE_WORDS.unknown ? "" : `: ${mode}`} (${times})`;
  }
  return `In a gap (${times})`;
}

/** "1 min 1 s and 1.2 km after the previous point (72.0 km/h)", or the same "before the next point"; the way to say there is none when there is not. */
export function neighbourText(neighbour: PointNeighbour | null, which: "previous" | "next"): string {
  if (neighbour === null) return which === "previous" ? "No earlier point" : "No later point";
  const how = `${formatGap(neighbour.gapSeconds)} and ${formatDistance(neighbour.distanceM).replace(" ", NBSP)}`;
  return `${how} ${which === "previous" ? "after the previous point" : "before the next point"} (${formatKmh(neighbour.speedKmh)})`;
}
