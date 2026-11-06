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

  describe("with the map's buttons to keep clear of", () => {
    // The buttons are at the top right: 64 wide at the right of a 390 px map, from 80 to 220, with air round them.
    const BUTTONS: Area = { left: 310, top: 72, right: 390, bottom: 228 };

    test("placeCard_ends_the_card_before_the_buttons_where_it_is_level_with_them", () => {
      const place = placeCard({ x: 340, y: 420 }, CARD, AREA, 10, BUTTONS); // above the point: 110 to 410, level with the buttons
      expect(place).toMatchObject({ top: 110, side: "above" });
      expect(place.left + CARD.width).toBeLessThanOrEqual(BUTTONS.left);
      expect(place.maxWidth).toBe(BUTTONS.left - AREA.left);
    });

    test("placeCard_points_at_a_point_in_the_right_strip_below_the_buttons", () => {
      for (const x of [320, 340, 370]) {
        const place = placeCard({ x, y: 500 }, CARD, AREA, 10, BUTTONS);
        expect(place.side).toBe("above"); // above, with a pointer, as for any point that is not under a button
        expect(place.top).toBe(190); // 500 - 10 - 300: level with the buttons, so it ends before them
        expect(place.left + CARD.width).toBeLessThanOrEqual(BUTTONS.left);
        expect(place.pointerX).toBe(CARD.width - 14); // on the card's right edge, nearest the point
      }
    });

    test("placeCard_uses_the_whole_width_where_the_card_is_below_the_buttons", () => {
      const place = placeCard({ x: 370, y: 560 }, { width: 288, height: 300 }, { ...AREA, bottom: 900 }, 10, BUTTONS);
      expect(place).toMatchObject({ side: "above", top: 250, left: 374 - 288 });
    });

    test("placeCard_has_no_pointer_for_a_point_under_a_button", () => {
      expect(placeCard({ x: 350, y: 150 }, CARD, AREA, 10, BUTTONS).side).toBe("away");
    });
  });
});
