// How the app writes times, durations, distances and counts. English, 24-hour clock, metric.

const integer = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 0 });

const clocks = new Map<string, Intl.DateTimeFormat>();

function clock(zone: string): Intl.DateTimeFormat {
  let format = clocks.get(zone);
  if (format === undefined) {
    const make = (timeZone: string) =>
      new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    try {
      format = make(zone);
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      // A zone this browser has never heard of must not take the screen down with it: show UTC.
      format = make("UTC");
    }
    clocks.set(zone, format);
  }
  return format;
}

/**
 * The time of day of an instant (`isoUtc`, ISO-8601 with a `Z`) on the clock of `zone`, an IANA name: "08:46". It is the zone
 * of the segment the time belongs to, not the browser's, so a stay in New York reads in New York time wherever it is looked at.
 */
export function formatTime(isoUtc: string, zone: string): string {
  return clock(zone).format(new Date(isoUtc));
}

/** "8h 32m", "24m" or "45s": whole units, the smaller ones left out once there is a larger one but seconds. */
export function formatDuration(seconds: number): string {
  const total = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours > 0) return `${integer.format(hours)}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${total}s`;
}

/** "1 place" or "5 places": the count (grouped, as the distances are) and the noun, with an s unless the count is one. */
export function formatCount(count: number, noun: string): string {
  return `${integer.format(count)} ${count === 1 ? noun : `${noun}s`}`;
}

/** "850 m", "1.1 km" (one decimal below 100 km) or "412 km". */
export function formatDistance(meters: number): string {
  const m = Number.isFinite(meters) ? Math.max(0, meters) : 0;
  const wholeMeters = Math.round(m);
  if (wholeMeters < 1000) return `${wholeMeters} m`; // 999.6 is "1.0 km", not "1000 m": it is rounded first
  const tenthsOfKm = Math.round(m / 100);
  if (tenthsOfKm < 1000) return `${(tenthsOfKm / 10).toFixed(1)} km`;
  return `${integer.format(Math.round(m / 1000))} km`;
}
