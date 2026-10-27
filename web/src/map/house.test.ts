import { describe, expect, test } from "vitest";
import { HOME_IMAGE, HOME_IMAGE_OPTIONS, HOME_IMAGE_SIZE, HOUSE, HOUSE_PATH, homeImage } from "./house";

/** The alpha of the pixel at (`x`, `y`) of the image, which is where an SDF image keeps its distance. */
const alphaAt = (image: ReturnType<typeof homeImage>, x: number, y: number): number => image.data[(y * image.width + x) * 4 + 3]!;

/** What an SDF image says is the edge of the shape: 0.75 of full alpha, which the map's shader draws the edge at. */
const EDGE = 0.75 * 255;

describe("homeImage", () => {
  test("homeImage_is_a_square_of_32_pixels_with_four_bytes_to_each", () => {
    const image = homeImage();

    expect(HOME_IMAGE).toBe("sporer-home");
    expect(HOME_IMAGE_SIZE).toBe(32);
    expect([image.width, image.height]).toEqual([32, 32]);
    expect(image.data).toHaveLength(32 * 32 * 4);
    expect(image.data).toBeInstanceOf(Uint8Array);
  });

  test("homeImage_is_an_SDF_a_house_is_inside_and_the_corners_are_far_outside", () => {
    const image = homeImage();

    // Inside the walls and under the roof: past the edge, and at the top of the scale a little way in.
    expect(alphaAt(image, 16, 16)).toBeGreaterThan(EDGE);
    expect(alphaAt(image, 10, 22)).toBe(255);
    expect(alphaAt(image, 22, 22)).toBe(255);
    // Far from the shape there is nothing at all, and between the two the field falls off in a few pixels as an SDF does (the edge is at 0.75).
    for (const [x, y] of [[0, 0], [31, 0], [0, 31], [31, 31], [16, 0], [2, 8]] as const) expect(alphaAt(image, x!, y!), `${x},${y}`).toBe(0);
    // Across the left wall, which is at x = 7: nothing three pixels out, the field rising to the wall, and the edge (0.75) between the pixels either side of it.
    const across = [3, 4, 5, 6, 7].map((x) => alphaAt(image, x, 22));
    expect(across[0]).toBe(0);
    expect(across).toEqual([...across].sort((a, b) => a - b));
    expect(new Set(across).size).toBe(5);
    expect(across[3]).toBeLessThan(EDGE);
    expect(across[4]).toBeGreaterThan(EDGE);
  });

  test("homeImage_has_a_door_that_is_a_notch_at_the_foot_of_the_walls", () => {
    const image = homeImage();

    expect(alphaAt(image, 16, 24)).toBeLessThan(EDGE); // in the door: no house, so the pin shows through
    expect(alphaAt(image, 10, 24)).toBeGreaterThan(EDGE); // and the wall at its side is there
    expect(alphaAt(image, 22, 24)).toBeGreaterThan(EDGE);
    expect(alphaAt(image, 16, 22)).toBeLessThan(EDGE); // the door's top is at 20 and the roof is well above it
    expect(alphaAt(image, 16, 18)).toBeGreaterThan(EDGE);
  });

  test("homeImage_is_a_roof_over_a_body_that_is_the_same_on_both_sides", () => {
    const image = homeImage();

    expect(alphaAt(image, 16, 6)).toBeGreaterThan(EDGE); // the roof near its top...
    expect(alphaAt(image, 6, 6)).toBeLessThan(EDGE); // ...is a triangle: its corner is not
    for (const y of [5, 8, 12, 15, 19, 24, 26]) {
      for (let x = 0; x < 16; x += 1) expect(Math.abs(alphaAt(image, x, y) - alphaAt(image, 31 - x, y)), `${x},${y}`).toBeLessThanOrEqual(1); // symmetrical about the middle, to a rounding
    }
  });

  test("homeImage_is_the_same_each_time_it_is_made_and_the_shape_stays_inside_the_square", () => {
    expect(homeImage().data).toEqual(homeImage().data);
    // Room is left round the shape for the field to fall off in (3 pixels of it, which the image would otherwise cut off).
    for (const [x, y] of HOUSE) {
      expect(x).toBeGreaterThanOrEqual(3);
      expect(x).toBeLessThanOrEqual(29);
      expect(y).toBeGreaterThanOrEqual(3);
      expect(y).toBeLessThanOrEqual(29);
    }
  });

  test("homeImage_options_ask_for_an_SDF_at_twice_the_density_so_that_it_is_drawn_16_pixels_across", () => {
    expect(HOME_IMAGE_OPTIONS).toEqual({ sdf: true, pixelRatio: 2 });
  });
});

describe("HOUSE_PATH", () => {
  test("HOUSE_PATH_is_one_closed_outline_through_the_corners_of_the_house", () => {
    expect(HOUSE_PATH.startsWith("M16 4L")).toBe(true); // the top of the roof
    expect(HOUSE_PATH.endsWith("Z")).toBe(true);
    expect(HOUSE_PATH.match(/[ML]/g)).toHaveLength(HOUSE.length); // one corner each, and one subpath: the door is a notch in it, not a hole to draw
    expect(HOUSE_PATH.match(/M/g)).toHaveLength(1);
  });
});
