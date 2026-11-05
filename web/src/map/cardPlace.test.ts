import { describe, expect, test } from "vitest";
import { placeCard, type Area } from "./cardPlace";

const AREA: Area = { left: 16, top: 80, right: 374, bottom: 600 };
const CARD = { width: 288, height: 300 };

describe("placeCard", () => {
  test("placeCard_puts_the_card_above_the_point_centred_on_it", () => {
    const place = placeCard({ x: 195, y: 450 }, CARD, AREA, 10);
    expect(place).toMatchObject({ left: 51, top: 140, side: "above" });
    expect(place.pointerX).toBe(144);
  });

  test("placeCard_flips_below_the_point_when_there_is_no_room_above", () => {
    expect(placeCard({ x: 195, y: 200 }, CARD, AREA, 10)).toMatchObject({ top: 210, side: "below" });
  });

  test("placeCard_keeps_the_card_inside_the_area_along_the_map_and_the_pointer_on_the_point", () => {
    const left = placeCard({ x: 20, y: 450 }, CARD, AREA, 10);
    expect(left.left).toBe(16);
    expect(left.pointerX).toBe(14); // the pointer is not past the corner of the card
    const right = placeCard({ x: 370, y: 450 }, CARD, AREA, 10);
    expect(right.left).toBe(374 - 288);
    expect(right.pointerX).toBe(288 - 14);
  });

  test("placeCard_lies_over_the_point_in_the_free_part_when_there_is_room_neither_above_nor_below", () => {
    const place = placeCard({ x: 195, y: 340 }, CARD, AREA, 10);
    expect(place.side).toBe("over");
    expect(place.top).toBeGreaterThanOrEqual(AREA.top);
    expect(place.top + CARD.height).toBeLessThanOrEqual(AREA.bottom);
  });

  test("placeCard_says_the_most_the_card_may_be_when_the_free_part_is_smaller_than_it", () => {
    const small: Area = { left: 16, top: 80, right: 200, bottom: 250 };
    const place = placeCard({ x: 100, y: 160 }, CARD, small, 10);
    expect(place).toMatchObject({ maxHeight: 170, maxWidth: 184, side: "over", left: 16, top: 80 });
  });

  test("placeCard_has_no_pointer_for_a_point_that_is_out_of_the_area_and_keeps_one_for_a_point_in_it", () => {
    expect(placeCard({ x: 195, y: 450 }, CARD, AREA, 10).side).toBe("above");
    expect(placeCard({ x: 500, y: 450 }, CARD, AREA, 10).side).toBe("away"); // to the right of what is shown
    expect(placeCard({ x: 195, y: 20 }, CARD, AREA, 10).side).toBe("away"); // under the bar
    expect(placeCard({ x: 195, y: 900 }, CARD, AREA, 10).side).toBe("away"); // under the sheet
  });

  test("placeCard_puts_a_card_on_a_point_that_is_off_the_area_into_the_area", () => {
    const place = placeCard({ x: 195, y: 900 }, CARD, AREA, 10); // under the sheet
    expect(place.top + CARD.height).toBeLessThanOrEqual(AREA.bottom);
    expect(place.top).toBeGreaterThanOrEqual(AREA.top);
  });
});
