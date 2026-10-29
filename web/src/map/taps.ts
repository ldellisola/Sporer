import type { MapLibreMap } from "maplibre-gl";
import type { Pixel } from "./AreaSelect";

/**
 * How far from a dot, a pin or a point a tap still finds it, in pixels. A finger is some 40 px wide and the smallest dot is 8 px across, so a tap
 * is looked for in a box of this much round the point, which is also what the pointer over the map asks.
 */
export const TAP_SLOP_PX = 12;

/** A feature that the map drew, as it gives it back for a position. */
export type TappedFeature = ReturnType<MapLibreMap["queryRenderedFeatures"]>[number];

/** What a feature stands for, and where that is (`[lon, lat]`): the place or the point that a tap on it is a tap on. */
export interface Tapped<T> {
  value: T;
  at: [lon: number, lat: number];
}

/**
 * The thing that a tap at `point` (pixels of the map) is a tap on: of the features of `layers` that are drawn within `TAP_SLOP_PX` of it, the one
 * whose position is the nearest. Near is by the position that `resolve` says the feature has (where its dot or pin is centred), and not by how much
 * of it lies in the box: a big dot's edge is near where its middle is not. `resolve` says what a feature stands for and where it is, or nothing for
 * one that is no use (it is passed over, and the one next to it is found). Only layers that the style has are looked in: MapLibre reports an error
 * for one that it has not (before the style has loaded, say), and finds nothing there. Undefined when there is none.
 */
export function nearestTapped<T>(
  map: MapLibreMap,
  { x, y }: Pixel,
  layers: readonly string[],
  resolve: (feature: TappedFeature) => Tapped<T> | undefined,
): T | undefined {
  const present = layers.filter((id) => map.getLayer(id) !== undefined);
  if (present.length === 0) return undefined;
  const box: [[number, number], [number, number]] = [[x - TAP_SLOP_PX, y - TAP_SLOP_PX], [x + TAP_SLOP_PX, y + TAP_SLOP_PX]];
  let nearest: T | undefined;
  let nearestDistance = Infinity;
  for (const feature of map.queryRenderedFeatures(box, { layers: present })) {
    const tapped = resolve(feature);
    if (tapped === undefined) continue;
    const at = map.project(tapped.at);
    const distance = Math.hypot(at.x - x, at.y - y);
    if (distance < nearestDistance) {
      nearest = tapped.value;
      nearestDistance = distance;
    }
  }
  return nearest;
}
