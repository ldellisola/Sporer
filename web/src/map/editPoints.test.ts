import { renderHook } from "@testing-library/react";
import type { MapLibreMap } from "maplibre-gl";
import { describe, expect, test } from "vitest";
import { editPointAt, editPointsIn, useEditGestures } from "./editPoints";
import { LAYER_IDS, type EditPointCollection } from "./layers";

const pointsAt = (...at: [number, number][]): EditPointCollection => ({
  type: "FeatureCollection",
  features: at.map(([x, y], id) => ({ type: "Feature", id, properties: {}, geometry: { type: "Point", coordinates: [x, y] } })),
});

/** A map where a position is the pixel that it is, which has drawn the features at the pixels given, each with the id it says. */
function fakeMap(drawn: { id: number; at: [number, number] }[] = []) {
  return {
    getLayer: (id: string) => (id === LAYER_IDS.editPoints ? {} : undefined),
    queryRenderedFeatures: (box: [[number, number], [number, number]]) => {
      const [[left, top], [right, bottom]] = box;
      return drawn
        .filter(({ at: [x, y] }) => x >= left && x <= right && y >= top && y <= bottom)
        .map(({ id, at }) => ({ id, layer: { id: LAYER_IDS.editPoints }, properties: {}, geometry: { type: "Point", coordinates: at } }));
    },
    project: ([x, y]: [number, number]) => ({ x, y }),
  } as unknown as MapLibreMap;
}

describe("editPointAt", () => {
  const POINTS = pointsAt([100, 100], [140, 100]);

  test("editPointAt_finds_the_point_nearest_to_a_tap_by_its_id_from_where_the_points_say_it_is", () => {
    const map = fakeMap([{ id: 0, at: [100, 100] }, { id: 1, at: [104, 100] }]); // the feature of 1 is cut at 104: the point is at 140

    expect(editPointAt(map, { x: 105, y: 100 }, POINTS)).toBe(0);
  });

  test("editPointAt_passes_over_a_feature_that_has_no_id_or_whose_id_the_points_do_not_have", () => {
    const map = fakeMap([{ id: 99, at: [101, 100] }, { id: undefined as unknown as number, at: [100, 100] }, { id: 1, at: [108, 100] }]);

    expect(editPointAt(map, { x: 105, y: 100 }, POINTS)).toBe(1); // the nearest of those that are points: 1 is at 140, 35 px away, and is all there is
  });

  test("editPointAt_is_undefined_without_points_and_for_a_tap_with_nothing_near", () => {
    expect(editPointAt(fakeMap([{ id: 0, at: [100, 100] }]), { x: 100, y: 100 }, undefined)).toBeUndefined();
    expect(editPointAt(fakeMap([{ id: 0, at: [100, 100] }]), { x: 300, y: 300 }, POINTS)).toBeUndefined();
  });
});

describe("editPointsIn", () => {
  const POINTS = pointsAt([100, 100], [140, 100], [100, 140], [300, 300]);

  test("editPointsIn_has_the_ids_of_the_points_in_a_box_in_the_order_of_the_day_edges_included", () => {
    expect(editPointsIn(fakeMap(), { left: 100, top: 100, right: 140, bottom: 140 }, POINTS)).toEqual([0, 1, 2]);
    expect(editPointsIn(fakeMap(), { left: 101, top: 99, right: 299, bottom: 299 }, POINTS)).toEqual([1]);
  });

  test("editPointsIn_has_none_for_a_box_with_none_in_it_and_for_no_points", () => {
    expect(editPointsIn(fakeMap(), { left: 400, top: 400, right: 500, bottom: 500 }, POINTS)).toEqual([]);
    expect(editPointsIn(fakeMap(), { left: 0, top: 0, right: 500, bottom: 500 }, undefined)).toEqual([]);
  });

  test("editPointsIn_reads_the_points_where_the_map_puts_them", () => {
    const shifted = { project: ([x, y]: [number, number]) => ({ x: x + 1000, y }) } as unknown as MapLibreMap; // the map has been moved

    expect(editPointsIn(shifted, { left: 1000, top: 0, right: 1200, bottom: 200 }, POINTS)).toEqual([0, 1, 2]);
  });
});

describe("useEditGestures", () => {
  class Gesture {
    readonly calls: string[] = [];
    constructor(public enabled = true) {}
    isEnabled() {
      return this.enabled;
    }
    enable() {
      this.calls.push("enable");
      this.enabled = true;
    }
    disable() {
      this.calls.push("disable");
      this.enabled = false;
    }
  }
  const gestures = () => ({ boxZoom: new Gesture(), doubleClickZoom: new Gesture(), dragPan: new Gesture() });
  const asMap = (g: ReturnType<typeof gestures>) => g as unknown as MapLibreMap;

  test("useEditGestures_turns_box_zoom_and_double_tap_zoom_off_for_as_long_as_it_is_there_and_panning_only_with_select_area", () => {
    const g = gestures();
    const { rerender, unmount } = renderHook(({ area }) => useEditGestures(asMap(g), area), { initialProps: { area: false } });
    expect([g.boxZoom.enabled, g.doubleClickZoom.enabled, g.dragPan.enabled]).toEqual([false, false, true]);

    rerender({ area: true });
    expect(g.dragPan.enabled).toBe(false);
    rerender({ area: false });
    expect(g.dragPan.enabled).toBe(true);

    unmount();
    expect([g.boxZoom.enabled, g.doubleClickZoom.enabled, g.dragPan.enabled]).toEqual([true, true, true]);
  });

  test("useEditGestures_leaves_off_what_was_off_before", () => {
    const g = gestures();
    g.boxZoom.enabled = false;

    renderHook(() => useEditGestures(asMap(g), false)).unmount();

    expect(g.boxZoom.enabled).toBe(false);
    expect(g.boxZoom.calls).toEqual(["disable"]); // not turned on by something that did not turn it off
    expect(g.doubleClickZoom.enabled).toBe(true);
  });

  test("useEditGestures_does_nothing_before_there_is_a_map", () => {
    expect(() => renderHook(() => useEditGestures(null, true)).unmount()).not.toThrow();
  });
});
