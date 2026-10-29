import { beforeEach, describe, expect, test } from "vitest";
import { takeHeadingFocus, wantHeadingFocus } from "./headingFocus";

beforeEach(() => {
  window.history.replaceState(null, "", "/trips");
  takeHeadingFocus(); // what an earlier test asked for and did not take
});

describe("headingFocus", () => {
  test("takeHeadingFocus_is_false_when_nothing_was_asked_for", () => {
    expect(takeHeadingFocus()).toBe(false);
  });

  test("takeHeadingFocus_tells_the_panel_that_was_asked_for_once_and_only_when_its_view_is_the_one_on_show", () => {
    wantHeadingFocus({ view: "trip", id: "2026-09-10" });
    window.history.replaceState(null, "", "/trip/2026-09-10");

    expect(takeHeadingFocus()).toBe(true);
    expect(takeHeadingFocus()).toBe(false); // once: the next panel of that view, which is made again for the same trip, is not asked to
  });

  test("takeHeadingFocus_forgets_a_request_for_a_view_that_is_not_the_one_on_show", () => {
    wantHeadingFocus({ view: "trip", id: "2026-09-10" });

    expect(takeHeadingFocus()).toBe(false); // the owner is on /trips: the request was for a trip that they have left since
    window.history.replaceState(null, "", "/trip/2026-09-10");
    expect(takeHeadingFocus()).toBe(false); // and it is not there when they come to that trip later
  });

  test("wantHeadingFocus_takes_the_place_of_an_earlier_request", () => {
    wantHeadingFocus({ view: "trip", id: "2026-09-10" });
    wantHeadingFocus({ view: "trips" });

    expect(takeHeadingFocus()).toBe(true); // on /trips
  });
});
