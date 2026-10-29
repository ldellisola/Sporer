import type { Page } from "@playwright/test";

/** A position, longitude first. */
export type LonLat = [lon: number, lat: number];

/** A position as a point of the world on a map of Web Mercator, from 0 to 1 each way, y growing southward. */
export const worldOf = ([lon, lat]: LonLat) => ({
  x: (lon + 180) / 360,
  y: (1 - Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / Math.PI) / 2,
});

/**
 * The air that the fit leaves at the left and at the right of what is free while a dot has a label, for the dots at the edges to lie in whole (`LABEL_AIR_PX`
 * of MapView). The cities of the trips are all named, so their fit has it; the padding that the controls are set in (`--map-padding-*`) has not, and nor has
 * a drawing with no label (a day). A label goes toward the inside of the drawing, so none of them needs more room than this.
 */
export const LABEL_AIR = 24;

/** The closest that the map is brought to anything (`FIT_MAX_ZOOM` of MapView), and the width of the world in pixels there: 512 px tiles, 2 to the zoom of them. */
const MAX_FIT_ZOOM = 16;
const WORLD_AT_MAX_ZOOM = 512 * 2 ** MAX_FIT_ZOOM;

/**
 * Where on the page a position is once the map has been brought to all of `positions`, as the map is when it is fitted (read from the map as it is
 * now: the room that the bar and the panel leave free is its padding, `--map-padding-*`, less `sideAir` at the left and at the right). The free part is
 * filled by the box of the positions on the side that it is longer, no closer than `MAX_FIT_ZOOM`, and the box is in the middle of it: so a position that
 * is the only one, or a few that are a street apart, are shown as close as the map goes. A map that has been fitted to dots that carry no label has no
 * `sideAir`. This is also the check that the fit leaves the room for the labels: the dots of the easternmost and the westernmost city are drawn
 * where the air puts them.
 *
 * A map is kept inside the world, which is as high as it is wide and ends at ±85° of latitude: the middle of the map is never nearer to the top or to
 * the bottom of it than half the map's height. A box that is wide and a free width that is narrow (a phone, with the air) fit at a zoom at which the world
 * is hardly higher than the map, and then the middle of the box is not where the middle of what is free is.
 *
 * What it says is where the camera comes to rest, not that it has: a test that taps there reads the pixel first (`pixel.ts`), which is how it knows.
 */
export async function fitOf(page: Page, positions: LonLat[], sideAir = 0): Promise<(at: LonLat) => { x: number; y: number }> {
  const free = await page.getByRole("region", { name: "Map view" }).evaluate((element, air) => {
    const read = (side: string) => parseFloat(element.style.getPropertyValue(`--map-padding-${side}`));
    const box = element.getBoundingClientRect();
    return {
      left: box.left + read("left") + air,
      top: box.top + read("top"),
      width: box.width - read("left") - read("right") - 2 * air,
      height: box.height - read("top") - read("bottom"),
      mapMiddle: box.top + box.height / 2,
      mapHeight: box.height,
    };
  }, sideAir);
  const world = positions.map(worldOf);
  const [west, east] = [Math.min(...world.map((p) => p.x)), Math.max(...world.map((p) => p.x))];
  const [north, south] = [Math.min(...world.map((p) => p.y)), Math.max(...world.map((p) => p.y))];
  const scale = Math.min(free.width / (east - west), free.height / (south - north), WORLD_AT_MAX_ZOOM); // pixels for the width of the world (a box with no extent fits as close as it goes)
  const half = free.mapHeight / 2 / scale; // half the height of the map, as a share of the world's
  const middleOfMap = (north + south) / 2 + (free.mapMiddle - (free.top + free.height / 2)) / scale; // where the map's middle is, if it is not kept in
  const kept = Math.min(Math.max(middleOfMap, half), 1 - half);
  return (at) => {
    const target = worldOf(at);
    return {
      x: Math.round(free.left + free.width / 2 + (target.x - (west + east) / 2) * scale),
      y: Math.round(free.mapMiddle + (target.y - kept) * scale),
    };
  };
}

/** Where on the page `at` is once the map has been brought to all of `positions` (see `fitOf`). */
export async function whereOnThePage(page: Page, positions: LonLat[], at: LonLat, sideAir = 0): Promise<{ x: number; y: number }> {
  return (await fitOf(page, positions, sideAir))(at);
}
