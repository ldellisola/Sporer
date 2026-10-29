import type { MapLibreMap } from "maplibre-gl";
import { describe, expect, test } from "vitest";
import { nearestTapped, TAP_SLOP_PX, type TappedFeature } from "./taps";

/** A map that has `layers` and has drawn `features`, each in a layer and at a pixel of the screen (`project` is the identity: a position is a pixel). */
function fakeMap(layers: string[], drawn: { layer: string; at: [number, number]; name: string }[] = []) {
  const queries: { box: unknown; layers: string[] }[] = [];
  const map = {
    getLayer: (id: string) => (layers.includes(id) ? {} : undefined),
    queryRenderedFeatures: (box: [[number, number], [number, number]], options: { layers: string[] }) => {
      queries.push({ box, layers: options.layers });
      const [[left, top], [right, bottom]] = box;
      return drawn
        .filter(({ layer, at: [x, y] }) => options.layers.includes(layer) && x >= left && x <= right && y >= top && y <= bottom)
        .map(({ layer, at, name }) => ({ layer: { id: layer }, properties: { name }, geometry: { type: "Point", coordinates: at } }));
    },
    project: ([x, y]: [number, number]) => ({ x, y }),
  };
  return { map: map as unknown as MapLibreMap, queries };
}

const nameAt = (feature: TappedFeature) => {
  const { name } = feature.properties as { name: string };
  return feature.geometry.type === "Point" ? { value: name, at: feature.geometry.coordinates as [number, number] } : undefined;
};

describe("nearestTapped", () => {
  test("nearestTapped_looks_in_a_box_of_the_slop_round_the_tap_in_the_layers_that_the_style_has_only", () => {
    const { map, queries } = fakeMap(["dots"]);

    expect(nearestTapped(map, { x: 200, y: 300 }, ["dots", "not-there"], nameAt)).toBeUndefined();

    expect(TAP_SLOP_PX).toBe(12);
    expect(queries).toEqual([{ box: [[188, 288], [212, 312]], layers: ["dots"] }]); // a layer that is not there is an error for MapLibre, and no place to look
  });

  test("nearestTapped_asks_nothing_when_the_style_has_none_of_the_layers", () => {
    const { map, queries } = fakeMap([]);

    expect(nearestTapped(map, { x: 10, y: 10 }, ["a", "b"], nameAt)).toBeUndefined();

    expect(queries).toEqual([]);
  });

  test("nearestTapped_picks_the_nearest_by_the_position_that_is_resolved_and_not_the_one_the_feature_says", () => {
    const { map } = fakeMap(["dots"], [
      { layer: "dots", at: [100, 100], name: "far" },
      { layer: "dots", at: [108, 100], name: "near" },
    ]);

    expect(nearestTapped(map, { x: 106, y: 100 }, ["dots"], nameAt)).toBe("near");
    // The position the caller has for a feature is the one that counts: the features above are where they are drawn, the points are elsewhere.
    expect(nearestTapped(map, { x: 106, y: 100 }, ["dots"], (feature) => ({ value: nameAt(feature)!.value, at: nameAt(feature)!.value === "far" ? [106, 101] : [200, 200] }))).toBe("far");
  });

  test("nearestTapped_passes_over_a_feature_that_is_resolved_to_nothing_and_finds_the_next", () => {
    const { map } = fakeMap(["dots"], [
      { layer: "dots", at: [100, 100], name: "none" },
      { layer: "dots", at: [108, 100], name: "other" },
    ]);

    expect(nearestTapped(map, { x: 100, y: 100 }, ["dots"], (feature) => (nameAt(feature)!.value === "none" ? undefined : nameAt(feature)))).toBe("other");
  });

  test("nearestTapped_is_undefined_when_nothing_is_within_reach", () => {
    const { map } = fakeMap(["dots"], [{ layer: "dots", at: [100, 100], name: "far" }]);

    expect(nearestTapped(map, { x: 113, y: 100 }, ["dots"], nameAt)).toBeUndefined(); // 13 px: out of the box
  });
});
