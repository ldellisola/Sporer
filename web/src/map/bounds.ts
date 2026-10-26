import type { Feature, Geometry } from "./layers";

/** South-west and north-east corner, `[lon, lat]`. The east may be beyond 180 for a box that crosses the antimeridian. */
export type Bounds = [[west: number, south: number], [east: number, north: number]];

function forEachPosition(geometry: Geometry, visit: (lon: number, lat: number) => void): void {
  if (geometry.type === "Point") {
    visit(geometry.coordinates[0], geometry.coordinates[1]);
    return;
  }
  for (const [lon, lat] of geometry.coordinates) visit(lon, lat);
}

/** `lon` as the same meridian within -180 up to (not including) 180. */
function wrap(lon: number): number {
  const wrapped = ((((lon + 180) % 360) + 360) % 360) - 180;
  // Longitudes that are in range already come back untouched, not off by the rounding of the arithmetic above.
  return lon >= -180 && lon < 180 ? lon : wrapped;
}

/**
 * The smallest box that holds all positions of `features`, or null when there are none.
 *
 * A longitude is a position on a circle, and the box is the shortest stretch of it that has them all. That matters across the
 * antimeridian: the server draws a flight over the Pacific with longitudes that go on past 180 (Tokyo to Los Angeles ends at
 * 241.6), while the place it lands at is at -118.4, and a plain minimum and maximum over both would be a box as wide as the
 * world. The stretch is found by leaving out the widest gap between neighbouring longitudes; `west` is in -180 up to 180 and
 * `east` is beyond 180 when the box crosses the antimeridian, which MapLibre takes as it is.
 */
export function boundsOf(features: readonly Feature<Geometry, unknown>[]): Bounds | null {
  const positions: { lon: number; turn: number }[] = []; // the longitude as given, and where it lies on the circle, 0 to 360
  let south = Number.POSITIVE_INFINITY;
  let north = Number.NEGATIVE_INFINITY;
  for (const feature of features) {
    forEachPosition(feature.geometry, (lon, lat) => {
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;
      positions.push({ lon, turn: ((lon % 360) + 360) % 360 });
      south = Math.min(south, lat);
      north = Math.max(north, lat);
    });
  }
  if (positions.length === 0) return null;

  positions.sort((a, b) => a.turn - b.turn);
  // The gap after position i runs to the next one; after the last it runs on round the circle to the first.
  let widest = -1;
  let after = 0;
  for (let i = 0; i < positions.length; i += 1) {
    const next = positions[(i + 1) % positions.length]!;
    const gap = i + 1 < positions.length ? next.turn - positions[i]!.turn : next.turn + 360 - positions[i]!.turn;
    if (gap > widest) {
      widest = gap;
      after = i;
    }
  }

  // The box runs from the position after the widest gap round to the one before it.
  const west = wrap(positions[(after + 1) % positions.length]!.lon);
  let east = wrap(positions[after]!.lon);
  if (east < west) east += 360;
  return [[west, south], [east, north]];
}
