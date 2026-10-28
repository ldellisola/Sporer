import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Route } from "./router";
import { useDayRollover } from "./useDayRollover";

// The unit tests run on the clock of Tokyo (see globalSetup): noon there on the 22nd is 03:00 UTC.
const NOON_22 = "2026-10-22T03:00:00Z";
const NOON_23 = "2026-10-23T03:00:00Z";
const NOON_24 = "2026-10-24T03:00:00Z";

const day = (date: string): Route => ({ view: "day", date });

/** Puts the clock of the page at `iso`, and the page in the foreground or the background. */
function setPage(iso: string, visibility: "visible" | "hidden" = "visible"): void {
  vi.setSystemTime(new Date(iso));
  vi.spyOn(document, "visibilityState", "get").mockReturnValue(visibility);
}

const comesBack = () => document.dispatchEvent(new Event("visibilitychange"));
const getsFocus = () => window.dispatchEvent(new Event("focus"));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  window.history.replaceState(null, "", "/day/2026-10-22");
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useDayRollover", () => {
  test("useDayRollover_takes_a_day_that_was_today_to_the_new_today_when_the_page_comes_back_into_view", () => {
    setPage(NOON_22);
    renderHook(() => useDayRollover(day("2026-10-22")));
    const entries = window.history.length;
    const state = window.history.state;

    setPage(NOON_23, "hidden"); // the night went by with the page in the background
    comesBack(); // going away is no reason
    expect(window.location.pathname).toBe("/day/2026-10-22");
    setPage(NOON_23);
    comesBack();

    expect(window.location.pathname).toBe("/day/2026-10-23");
    expect(window.history.length).toBe(entries); // the day is replaced: Back does not lead to a day that is gone
    expect(window.history.state).toBe(state);
  });

  test("useDayRollover_does_the_same_when_the_window_gets_the_focus", () => {
    setPage(NOON_22);
    renderHook(() => useDayRollover(day("2026-10-22")));

    setPage(NOON_23);
    getsFocus();

    expect(window.location.pathname).toBe("/day/2026-10-23");
  });

  test("useDayRollover_leaves_a_day_that_was_not_today_when_it_was_shown_where_it_is", () => {
    window.history.replaceState(null, "", "/day/2026-10-20");
    setPage(NOON_22);
    renderHook(() => useDayRollover(day("2026-10-20"))); // the owner went to the day before yesterday

    setPage(NOON_24);
    comesBack();
    getsFocus();

    expect(window.location.pathname).toBe("/day/2026-10-20");
  });

  test("useDayRollover_leaves_a_day_to_come_alone_even_after_it_has_become_today", () => {
    window.history.replaceState(null, "", "/day/2026-10-23");
    setPage(NOON_22);
    renderHook(() => useDayRollover(day("2026-10-23"))); // tomorrow, looked at on purpose

    setPage(NOON_23); // and now it is today: where it is, is right
    comesBack();
    expect(window.location.pathname).toBe("/day/2026-10-23");

    setPage(NOON_24); // and then it is yesterday: it was chosen as a day to come, not shown as today, and it is not the app's to move
    comesBack();
    expect(window.location.pathname).toBe("/day/2026-10-23");
  });

  test("useDayRollover_does_nothing_while_the_day_is_still_today", () => {
    setPage(NOON_22);
    renderHook(() => useDayRollover(day("2026-10-22")));
    const entries = window.history.length;

    setPage("2026-10-22T14:00:00Z"); // 23:00 in Tokyo
    comesBack();
    getsFocus();

    expect(window.location.pathname).toBe("/day/2026-10-22");
    expect(window.history.length).toBe(entries);
  });

  test.each([
    ["a week", { view: "week", start: "2026-10-19" } as Route, "/week/2026-10-19"],
    ["a month", { view: "month", month: "2026-10" } as Route, "/month/2026-10"],
    ["a place", { view: "place", id: 4 } as Route, "/place/4"],
    ["the trips", { view: "trips" } as Route, "/trips"],
    ["a trip", { view: "trip", id: "2026-10-22" } as Route, "/trip/2026-10-22"],
    ["a range", { view: "range", from: "2026-10-20", to: "2026-10-22" } as Route, "/range/2026-10-20..2026-10-22"],
  ])("useDayRollover_leaves_%s_alone", (_name, route, path) => {
    window.history.replaceState(null, "", path);
    setPage(NOON_22);
    renderHook(() => useDayRollover(route));

    setPage(NOON_24);
    comesBack();
    getsFocus();

    expect(window.location.pathname).toBe(path);
  });

  test("useDayRollover_notes_again_each_day_it_is_shown_and_takes_a_day_that_was_stepped_back_to_to_today_too", () => {
    setPage(NOON_22);
    const { rerender } = renderHook(({ route }) => useDayRollover(route), { initialProps: { route: day("2026-10-22") } });

    // The owner steps to yesterday: that is a day that is not today, and stays put whatever the night does.
    window.history.replaceState(null, "", "/day/2026-10-21");
    rerender({ route: day("2026-10-21") });
    setPage(NOON_23);
    comesBack();
    expect(window.location.pathname).toBe("/day/2026-10-21");

    // And back to today, which was the 23rd by now: from there on it is a day that was today when it was shown.
    window.history.replaceState(null, "", "/day/2026-10-23");
    rerender({ route: day("2026-10-23") });
    setPage(NOON_24);
    comesBack();

    expect(window.location.pathname).toBe("/day/2026-10-24");
  });

  test("useDayRollover_goes_on_after_the_roll_over_it_made_itself", () => {
    setPage(NOON_22);
    const { rerender } = renderHook(({ route }) => useDayRollover(route), { initialProps: { route: day("2026-10-22") } });
    setPage(NOON_23);
    comesBack();
    expect(window.location.pathname).toBe("/day/2026-10-23");
    rerender({ route: day("2026-10-23") }); // the app has taken the new address

    setPage(NOON_24);
    comesBack();

    expect(window.location.pathname).toBe("/day/2026-10-24"); // the new today is a day that was today when it was shown, too
  });

  test("useDayRollover_stops_listening_when_it_is_unmounted", () => {
    setPage(NOON_22);
    const { unmount } = renderHook(() => useDayRollover(day("2026-10-22")));
    unmount();

    setPage(NOON_23);
    comesBack();
    getsFocus();

    expect(window.location.pathname).toBe("/day/2026-10-22");
  });
});
