import { describe, expect, test } from "vitest";
import type { LonLat } from "../api/types";
import { boundsOf } from "./bounds";
import type { Feature, LineString, Point } from "./layers";

const line = (...coordinates: LonLat[]): Feature<LineString, object> => ({
  type: "Feature",
  properties: {},
  geometry: { type: "LineString", coordinates },
});

const point = (lon: number, lat: number): Feature<Point, object> => ({
  type: "Feature",
  properties: {},
  geometry: { type: "Point", coordinates: [lon, lat] },
});

/** A great-circle-like arc with a vertex every few degrees, longitudes unwrapped the way the server writes them. */
function arc(from: LonLat, to: LonLat, steps = 40): LonLat[] {
  return Array.from({ length: steps + 1 }, (_, i): LonLat => {
    const t = i / steps;
    return [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t + Math.sin(Math.PI * t) * 10];
  });
}

describe("boundsOf", () => {
  test("boundsOf_returns_south_west_and_north_east_of_all_positions", () => {
    const bounds = boundsOf([line([10.7, 59.9], [10.9, 59.8]), point(10.5, 60.1)]);

    expect(bounds).toEqual([[10.5, 59.8], [10.9, 60.1]]);
  });

  test("boundsOf_is_null_without_features_or_positions", () => {
    expect(boundsOf([])).toBeNull();
    expect(boundsOf([line()])).toBeNull();
  });

  test("boundsOf_of_one_point_is_that_point", () => {
    expect(boundsOf([point(-0.1, 51.5)])).toEqual([[-0.1, 51.5], [-0.1, 51.5]]);
  });

  test("boundsOf_handles_antimeridian_flight", () => {
    // Tokyo to Los Angeles over the Pacific; the server unwraps the longitudes, so the arc ends at 241.6 (-118.4).
    const flight = line(...arc([139.7, 35.7], [241.6, 34.0]));

    const bounds = boundsOf([flight]);

    expect(bounds).not.toBeNull();
    const [[west, south], [east, north]] = bounds as [[number, number], [number, number]];
    expect(west).toBeCloseTo(139.7, 6);
    expect(east).toBeCloseTo(241.6, 6);
    expect(east - west).toBeLessThan(180); // the way over the Pacific, not the world
    expect(south).toBeCloseTo(34.0, 6);
    expect(north).toBeGreaterThan(44); // the arc bulges north, as a great circle does
  });

  test("boundsOf_does_not_span_the_world_when_the_stops_use_plain_longitudes", () => {
    // The same flight with a stop at each end: Los Angeles is -118.4 as a place, but 241.6 as the end of the arc.
    const bounds = boundsOf([line(...arc([139.7, 35.7], [241.6, 34.0])), point(139.7, 35.7), point(-118.4, 34.0)]);

    const [[west], [east]] = bounds as [[number, number], [number, number]];
    expect(east - west).toBeCloseTo(101.9, 6);
    expect(west).toBeCloseTo(139.7, 6);
  });

  test("boundsOf_covers_points_either_side_of_the_antimeridian_by_the_short_way", () => {
    const bounds = boundsOf([point(179.5, -17.7), point(-179.5, -16.5)]); // two Fijian islands

    const [[west, south], [east, north]] = bounds as [[number, number], [number, number]];
    expect(east - west).toBeCloseTo(1, 6);
    expect(south).toBe(-17.7);
    expect(north).toBe(-16.5);
    expect(west).toBeCloseTo(179.5, 6);
  });

  test("boundsOf_keeps_the_west_in_range_when_everything_lies_beyond_180", () => {
    const bounds = boundsOf([line([200, 10], [230, 20])]);

    const [[west], [east]] = bounds as [[number, number], [number, number]];
    expect(west).toBeCloseTo(-160, 6);
    expect(east).toBeCloseTo(-130, 6);
  });

  test("boundsOf_of_a_trip_around_the_atlantic_is_not_wider_than_the_trip", () => {
    const bounds = boundsOf([point(-74.0, 40.7), point(10.7, 59.9), point(-0.1, 51.5)]);

    const [[west], [east]] = bounds as [[number, number], [number, number]];
    expect(west).toBeCloseTo(-74.0, 6);
    expect(east).toBeCloseTo(10.7, 6);
  });

  test("boundsOf_ignores_positions_that_are_not_finite", () => {
    const bounds = boundsOf([line([10, 59], [Number.NaN, 60], [11, Number.POSITIVE_INFINITY], [12, 61])]);

    expect(bounds).toEqual([[10, 59], [12, 61]]);
  });
});
