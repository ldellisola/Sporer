import type { MapLibreMap } from "maplibre-gl";
import { useEffect } from "react";
import type { Pixel, PixelBox } from "./AreaSelect";
import { LAYER_IDS, type EditPointCollection } from "./layers";
import { nearestTapped } from "./taps";

// What the map does with points in edit mode, apart from drawing them (that is `syncData`'s and the layers'): what a tap is a tap on, which points a
// rectangle holds, and the gestures of the map that give way while it is on.

/**
 * Edit mode for points, given while the owner is in it: what is selected (by the `id` of its feature in `data.editPoints`), what a tap on a point
 * and a rectangle do, and the map's Select area button. While it is given a tap on the map selects the point near it, and opens no place; the
 * map's box zoom and its double-tap zoom are off, and so is its panning while Select area is on, and each is as it was when it is not given any more.
 */
export interface MapEdit {
  /** The ids of the selected points: drawn bigger and red, by feature state, which is set for the ones that change and never for all of them again. */
  selected: ReadonlySet<number>;
  /** Whether Select area is on: a drag draws a rectangle instead of panning, and a tap on the map selects a point as ever. */
  area: boolean;
  /** Called for a press of the Select area button, with what it is to be. */
  onAreaChange: (on: boolean) => void;
  /** Called with the id of the point that a tap is on, the nearest within 12 px of it, or not at all when there is none. */
  onToggle: (id: number) => void;
  /** Called with the ids of every point inside a rectangle that was drawn. */
  onSelect: (ids: readonly number[]) => void;
}

/**
 * The point of edit mode that a tap at `point` (pixels of the map) selects: the one nearest to it, of those that are drawn within the slop of it, or
 * undefined when there is none. Near is by where the point is (`points` has it, by the `id` of the feature: what MapLibre gives back of a feature is
 * cut to the tile it is in), and a point is found by its `id`, which is its index in the day's points. Only the layer of the points is looked in.
 */
export function editPointAt(map: MapLibreMap, point: Pixel, points: EditPointCollection | undefined): number | undefined {
  if (points === undefined) return undefined;
  return nearestTapped(map, point, [LAYER_IDS.editPoints], (feature) => {
    const id = feature.id;
    const found = typeof id === "number" ? points.features[id] : undefined;
    return typeof id === "number" && found !== undefined ? { value: id, at: found.geometry.coordinates } : undefined;
  });
}

/**
 * The ids of the points of edit mode that lie inside `box` (pixels of the map, edges included): each is put on the screen by the map's own `project`
 * and looked at, whether it is drawn or not (a rectangle covers what is under it, and the map has all of them: some forty thousand on a dense day,
 * which this is quick enough for, once at the end of a drag), in the order of the day.
 */
export function editPointsIn(map: MapLibreMap, box: PixelBox, points: EditPointCollection | undefined): number[] {
  const inside: number[] = [];
  for (const point of points?.features ?? []) {
    const { x, y } = map.project(point.geometry.coordinates);
    if (x >= box.left && x <= box.right && y >= box.top && y <= box.bottom) inside.push(point.id);
  }
  return inside;
}

/**
 * Turns the gesture `gesture` of `map` off while `off`, and back on when it is not any more, or when the map goes, if it was on to begin with:
 * a gesture that was off for another reason is left off. The map's own handlers (`boxZoom`, `doubleClickZoom`, `dragPan`) are what is switched.
 */
function useGestureOff(map: MapLibreMap | null, gesture: "boxZoom" | "doubleClickZoom" | "dragPan", off: boolean): void {
  useEffect(() => {
    if (map === null || !off) return;
    const handler = map[gesture];
    const was = handler.isEnabled();
    handler.disable();
    return () => {
      if (was) handler.enable();
    };
  }, [map, gesture, off]);
}

/**
 * The gestures of the map that give way for as long as the component that calls this is there (edit mode): MapLibre's own shift-drag, which zooms to
 * the box, is off, for shift-drag draws a rectangle (`AreaSelect`); two quick taps are two points and not a zoom (the owner goes from one point to the
 * next, and a double tap near the first would zoom in on them); and while Select area is on (`area`) a drag draws a rectangle, so it does not pan.
 * Each is put back as it was found.
 */
export function useEditGestures(map: MapLibreMap | null, area: boolean): void {
  useGestureOff(map, "boxZoom", true);
  useGestureOff(map, "doubleClickZoom", true);
  useGestureOff(map, "dragPan", area);
}
