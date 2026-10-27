import type { Feature, Geometry } from "./layers";

/** South-west and north-east corner, `[lon, lat]`. The east may be beyond 180 for a box that crosses the antimeridian. */
export type Bounds = [[west: number, south: number], [east: number, north: number]];

/** Calls `visit` with each position of `geometry`. Indexed loops, so that visiting a vertex allocates nothing: a year of a life is 50 000 of them. */
function forEachPosition(geometry: Geometry, visit: (lon: number, lat: number) => void): void {
  if (geometry.type === "Point") {
    visit(geometry.coordinates[0], geometry.coordinates[1]);
    return;
  }
  const { coordinates } = geometry;
  for (let i = 0; i < coordinates.length; i += 1) {
    const position = coordinates[i]!;
    visit(position[0], position[1]);
  }
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
 * world. `west` is in -180 up to 180 and `east` is beyond 180 when the box crosses the antimeridian, which MapLibre takes as it is.
 *
 * Nearly every drawing lies in less than 180 degrees of longitude, and then the shortest stretch is the one from the least to the
 * greatest longitude as given (the stretch left over is more than 180 degrees, wider than any gap inside it), so one pass over the
 * vertices that keeps the four extremes is all there is to do: no allocation for a vertex and no sort, where a drawing of 50 000
 * vertices cost about 42 ms the other way, and a year view makes the box more than once. Anything wider, which may go round the
 * antimeridian, is left to `boundsByGap`, which says the same for the narrow ones.
 */
export function boundsOf(features: readonly Feature<Geometry, unknown>[]): Bounds | null {
  let west = Number.POSITIVE_INFINITY;
  let east = Number.NEGATIVE_INFINITY;
  let south = Number.POSITIVE_INFINITY;
  let north = Number.NEGATIVE_INFINITY;
  const visit = (lon: number, lat: number): void => {
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;
    if (lon < west) west = lon;
    if (lon > east) east = lon;
    if (lat < south) south = lat;
    if (lat > north) north = lat;
  };
  for (const feature of features) forEachPosition(feature.geometry, visit);
  if (west > east) return null; // not one position that is finite

  if (east - west >= 180) return boundsByGap(features);
  // The longitudes as given may lie beyond 180 or below -180 (a flight, or a trip all on the far side), and are put back in range together.
  const first = wrap(west);
  const last = wrap(east);
  return [[first, south], [last < first ? last + 360 : last, north]];
}

/**
 * The same box as `boundsOf`, found by sorting the longitudes round the circle and leaving out the widest gap between neighbouring ones;
 * the box runs from the position after the gap round to the one before it. It is right for every set, across the antimeridian too, and
 * `boundsOf` takes it for the sets that are 180 degrees wide or more. Exported so that the tests can hold the fast path to it.
 */
export function boundsByGap(features: readonly Feature<Geometry, unknown>[]): Bounds | null {
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
