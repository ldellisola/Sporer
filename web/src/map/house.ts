import type { MapLibreMap } from "maplibre-gl";

/**
 * The house that marks home: on the pin of a place that is home, where the number would be, and in the row of the day's list where the number
 * goes (`HouseIcon`). It is made here, from the corners below, and nothing is fetched for it: no style has an image of ours, and the app asks
 * nothing of any server it does not have to.
 */

/** The name the image has in the style, which the layer of the houses draws from. */
export const HOME_IMAGE = "sporer-home";

/** The image is a square of this many pixels; the corners of the house are in the same units. */
export const HOME_IMAGE_SIZE = 32;

/**
 * The house is an SDF (a field of distances in the alpha channel, with the edge at 0.75), so that the layer colours it with `icon-color` and the
 * map keeps its edge sharp, in a light theme and a dark one alike. At twice the density it is drawn 16 pixels across the screen.
 */
export const HOME_IMAGE_OPTIONS = { sdf: true, pixelRatio: 2 } as const;

/**
 * The outline of the house, clockwise from the top of its roof: the roof with its eaves over the walls, and a door that is a notch at the foot of
 * them, so that what is under the icon shows through it. One outline and no hole, so that it is one shape to draw in the list as well. It is
 * 26 units across and 23 high in a square of 32, which leaves the 3 pixels that the field needs to fall off in all round it.
 */
export const HOUSE: readonly (readonly [x: number, y: number])[] = [
  [16, 4],
  [29, 16],
  [25, 16],
  [25, 27],
  [19, 27],
  [19, 20],
  [13, 20],
  [13, 27],
  [7, 27],
  [7, 16],
  [3, 16],
];

/** The outline as the `d` of an SVG path, for the house in the list. */
export const HOUSE_PATH = `M${HOUSE.map(([x, y]) => `${x} ${y}`).join("L")}Z`;

/**
 * The field is a ramp from full to nothing across `FIELD_SPAN` pixels, and `FIELD_INSIDE` of the ramp lies inside the shape, which puts the edge
 * at 0.75: alpha = 255 · (0.75 − distance / `FIELD_SPAN`). So it is 0 at 3 pixels out of the shape (the room round it that `HOUSE` leaves), and
 * full at 1 pixel inside it.
 */
const FIELD_SPAN = 4;
const FIELD_INSIDE = 0.25;

/** The distance in pixels from (`x`, `y`) to the outline of the house: negative inside it. */
function distanceToHouse(x: number, y: number): number {
  let inside = false;
  let nearest = Number.POSITIVE_INFINITY;
  for (let i = 0, j = HOUSE.length - 1; i < HOUSE.length; j = i, i += 1) {
    const [ax, ay] = HOUSE[j]!;
    const [bx, by] = HOUSE[i]!;
    if (ay > y !== by > y && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) inside = !inside; // a ray to the right crosses this side: even and odd
    const [dx, dy] = [bx - ax, by - ay];
    const along = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
    nearest = Math.min(nearest, Math.hypot(x - (ax + along * dx), y - (ay + along * dy)));
  }
  return inside ? -nearest : nearest;
}

/** The image of the house, in the form that the map takes (`width`, `height` and the RGBA bytes of `ImageData`), made from the outline. */
export function homeImage(): { width: number; height: number; data: Uint8Array } {
  const data = new Uint8Array(HOME_IMAGE_SIZE * HOME_IMAGE_SIZE * 4);
  for (let y = 0; y < HOME_IMAGE_SIZE; y += 1) {
    for (let x = 0; x < HOME_IMAGE_SIZE; x += 1) {
      const distance = distanceToHouse(x + 0.5, y + 0.5); // from the middle of the pixel
      const alpha = 255 - 255 * (distance / FIELD_SPAN + FIELD_INSIDE);
      data[(y * HOME_IMAGE_SIZE + x) * 4 + 3] = Math.max(0, Math.min(255, Math.round(alpha)));
    }
  }
  return { width: HOME_IMAGE_SIZE, height: HOME_IMAGE_SIZE, data };
}

/**
 * Gives the style of `map` the image of the house, if it has not got it. A style has none of ours when it has just loaded (a theme switch loads
 * another, and its images are its own), and has it when the same one loads again, which adding twice would only report. Call it once a style
 * has loaded, before the layers that draw it are added.
 */
export function addHomeImage(map: MapLibreMap): void {
  if (!map.hasImage(HOME_IMAGE)) map.addImage(HOME_IMAGE, homeImage(), HOME_IMAGE_OPTIONS);
}
