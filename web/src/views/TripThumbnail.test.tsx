import { render } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import type { LonLat } from "../api/types";
import { TripThumbnail } from "./TripThumbnail";

/** Draws `line` (of a trip that is `ongoing` or has finished) and hands back the svg, its path's `d` (null when there is none) and the centres of its dots. */
function draw(line: LonLat[], ongoing = false) {
  const { container } = render(<TripThumbnail line={line} ongoing={ongoing} />);
  const svg = container.querySelector("svg")!;
  const dots = [...container.querySelectorAll("circle")].map((dot) => `${dot.getAttribute("cx")},${dot.getAttribute("cy")}`);
  return { svg, d: container.querySelector("path")?.getAttribute("d") ?? null, dots };
}

describe("TripThumbnail", () => {
  test("TripThumbnail_projects_the_line_into_its_box", () => {
    // On the equator a degree is as wide as it is tall, and 16 by 10 degrees is the 64 by 40 pixels of the box inside its 4 px of padding:
    // the first point is its bottom left corner (north is up) and the second its top right.
    const { svg, d, dots } = draw([[0, -5], [16, 5]]);

    expect(svg).toHaveAttribute("width", "72");
    expect(svg).toHaveAttribute("height", "48");
    expect(svg).toHaveAttribute("viewBox", "0 0 72 48");
    expect(svg).toHaveAttribute("aria-hidden", "true"); // the card says what it is of; the picture says nothing more
    expect(d).toBe("M4,44 L68,4");
    expect(dots).toEqual([]); // a dot at each point between the ends, and there is none
  });

  test("TripThumbnail_puts_a_dot_at_each_point_between_the_ends", () => {
    const { d, dots } = draw([[0, -5], [8, 0], [12, 2], [16, 5]]);

    expect(d).toBe("M4,44 L36,24 L52,16 L68,4");
    expect(dots).toEqual(["36,24", "52,16"]);
  });

  test("TripThumbnail_leaves_the_last_point_of_a_finished_trip_without_a_dot_as_it_is_where_the_trip_began", () => {
    const { dots } = draw([[0, -5], [8, 0], [12, 2], [16, 5]], false);

    expect(dots).toEqual(["36,24", "52,16"]);
  });

  test("TripThumbnail_puts_a_dot_at_the_last_point_of_an_ongoing_trip_which_is_where_it_is_now", () => {
    // The line does not come back home: its last point is the latest place, and it is not the end of a line that returned.
    const { d, dots } = draw([[0, -5], [8, 0], [12, 2], [16, 5]], true);

    expect(d).toBe("M4,44 L36,24 L52,16 L68,4");
    expect(dots).toEqual(["36,24", "52,16", "68,4"]);
  });

  test("TripThumbnail_shows_the_one_place_of_a_one_night_ongoing_trip_as_a_dot", () => {
    // Home and the place it slept at: nothing is between the ends, and the place is the last point.
    const { d, dots } = draw([[0, -5], [16, 5]], true);

    expect(d).toBe("M4,44 L68,4");
    expect(dots).toEqual(["68,4"]);
  });

  test("TripThumbnail_keeps_the_shape_and_puts_it_in_the_middle_of_the_box_whichever_way_it_is_longer", () => {
    expect(draw([[0, 0], [16, 0]]).d).toBe("M4,24 L68,24"); // wide and flat: as wide as the box, halfway down it
    expect(draw([[0, -5], [0, 5]]).d).toBe("M36,44 L36,4"); // tall and thin: as tall as the box, halfway across it
    expect(draw([[0, -2], [8, 2]]).d).toBe("M4,40 L68,8"); // 8 by 4 degrees is 64 by 32 px in a box of 64 by 40: 4 px of air above it and below
  });

  test("TripThumbnail_shrinks_a_degree_of_longitude_by_the_cosine_of_the_middle_latitude", () => {
    // At 60 degrees north a degree of longitude is half as wide as a degree of latitude: 10 of them are 5, and 2 of latitude are 2.
    // 64 px for 5 is 12.8 px each, so the 2 are 25.6 tall, halfway down the box.
    expect(draw([[0, 59], [10, 61]]).d).toBe("M4,36.8 L68,11.2");
  });

  test("TripThumbnail_draws_one_dot_in_the_middle_for_a_single_point_an_empty_line_and_points_that_are_one", () => {
    for (const line of [[[10.75, 59.91]], [], [[10.75, 59.91], [10.75, 59.91]]] as LonLat[][]) {
      const { d, dots } = draw(line);

      expect(d, JSON.stringify(line)).toBeNull();
      expect(dots, JSON.stringify(line)).toEqual(["36,24"]);
    }
  });

  test("TripThumbnail_draws_a_line_that_comes_back_where_it_began_with_a_dot_for_where_it_turned", () => {
    // Home, a city, home: the ends are the same point, and the city is the dot between them.
    const { d, dots } = draw([[10.75, 59.91], [-9.14, 38.72], [10.75, 59.91]]);

    expect(d).toMatch(/^M[\d.]+,[\d.]+ L[\d.]+,[\d.]+ L[\d.]+,[\d.]+$/);
    expect(d!.split(" ")[0]!.slice(1)).toBe(d!.split(" ")[2]!.slice(1)); // closed
    expect(dots).toHaveLength(1);
    expect(dots[0]).toBe(d!.split(" ")[1]!.slice(1));
  });

  test("TripThumbnail_stays_inside_its_padding_wherever_the_line_is", () => {
    const { d } = draw([[-73.986, 40.755], [10.75, 59.91], [-9.14, 38.72], [12.57, 55.68]]);

    for (const [x, y] of d!.split(/[ML]/).filter(Boolean).map((pair) => pair.trim().split(",").map(Number))) {
      expect(x).toBeGreaterThanOrEqual(4);
      expect(x).toBeLessThanOrEqual(68);
      expect(y).toBeGreaterThanOrEqual(4);
      expect(y).toBeLessThanOrEqual(44);
    }
  });
});
