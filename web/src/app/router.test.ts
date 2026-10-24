import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { formatRoute, navigate, parseRoute, resolveRoute, useRoute, type Route } from "./router";

const TODAY = "2026-10-24";
const TODAY_ROUTE: Route = { view: "day", date: TODAY };

beforeEach(() => {
  window.history.replaceState(null, "", "/");
});

describe("parseRoute and formatRoute", () => {
  test("parseRoute_round_trips_every_view", () => {
    const routes: [Route, string][] = [
      [{ view: "day", date: "2026-10-22" }, "/day/2026-10-22"],
      [{ view: "day", date: "2028-02-29" }, "/day/2028-02-29"],
      [{ view: "week", start: "2026-10-19" }, "/week/2026-10-19"],
      [{ view: "week", start: "2025-12-29" }, "/week/2025-12-29"],
      [{ view: "month", month: "2026-10" }, "/month/2026-10"],
      [{ view: "year", year: 2026 }, "/year/2026"],
      [{ view: "year", year: 1 }, "/year/0001"],
      [{ view: "range", from: "2026-09-12", to: "2026-09-19" }, "/range/2026-09-12..2026-09-19"],
      [{ view: "range", from: "2026-10-22", to: "2026-10-22" }, "/range/2026-10-22..2026-10-22"],
      [{ view: "place", id: 42 }, "/place/42"],
    ];

    for (const [route, path] of routes) {
      expect(formatRoute(route)).toBe(path);
      expect(parseRoute(path, TODAY)).toEqual(route);
      expect(parseRoute(formatRoute(route), TODAY)).toEqual(route);
    }
  });

  test("parseRoute_rejects_invalid_and_defaults_to_today", () => {
    const invalid = [
      "/day/2026-02-30", // no 30th of February
      "/day/2026-02-29", // 2026 is no leap year
      "/day/2100-02-29", // nor is 2100: a century year not divisible by 400
      "/day/2026-13-01",
      "/day/2026-00-10",
      "/day/2026-10-00",
      "/day/2026-10-32",
      "/day/2026-1-5", // not zero-padded
      "/day/26-10-22",
      "/day/0000-01-01",
      "/day/2026-10-22/extra",
      "/day/2026-10-22..2026-10-23",
      "/day",
      "/day/",
      "/Day/2026-10-22",
      "/nope",
      "/nope/2026-10-22",
      "/week/2026-02-30",
      "/week",
      "/month/2026-13",
      "/month/2026-00",
      "/month/2026-1",
      "/month/2026-10-01",
      "/year/26",
      "/year/20260",
      "/year/0000",
      "/year/abc",
      "/range/2026-10-19",
      "/range/2026-10-19..",
      "/range/..2026-10-19",
      "/range/2026-10-19..2026-02-30",
      "/range/2026-10-19..2026-10-25..2026-10-26",
      "/range/2026-10-25..2026-10-19", // from after to
      "/place",
      "/place/0",
      "/place/-3",
      "/place/1.5",
      "/place/abc",
      "/place/12/visits",
      "/place/99999999999999999999", // beyond the integers a number holds exactly
      "",
      "day/2026-10-22",
    ];
    for (const path of invalid) {
      expect(parseRoute(path, TODAY), path).toBeNull();
      expect(resolveRoute(path, TODAY), path).toEqual(TODAY_ROUTE);
    }

    // The root has nothing to reject: it is today.
    expect(parseRoute("/", TODAY)).toEqual(TODAY_ROUTE);
    expect(resolveRoute("/", TODAY)).toEqual(TODAY_ROUTE);
    // A valid path is never replaced by today.
    expect(resolveRoute("/place/7", TODAY)).toEqual({ view: "place", id: 7 });
  });

  test("parseRoute_accepts_leap_days_and_edges_of_the_calendar", () => {
    expect(parseRoute("/day/2028-02-29", TODAY)).toEqual({ view: "day", date: "2028-02-29" });
    expect(parseRoute("/day/2000-02-29", TODAY)).toEqual({ view: "day", date: "2000-02-29" });
    expect(parseRoute("/day/2026-12-31", TODAY)).toEqual({ view: "day", date: "2026-12-31" });
    expect(parseRoute("/day/0001-01-01", TODAY)).toEqual({ view: "day", date: "0001-01-01" });
    expect(parseRoute("/month/2026-12", TODAY)).toEqual({ view: "month", month: "2026-12" });
    expect(parseRoute("/month/2026-01", TODAY)).toEqual({ view: "month", month: "2026-01" });
    expect(parseRoute("/year/9999", TODAY)).toEqual({ view: "year", year: 9999 });
    expect(parseRoute("/range/2028-02-28..2028-03-01", TODAY)).toEqual({
      view: "range",
      from: "2028-02-28",
      to: "2028-03-01",
    });
  });

  test("parseRoute_tolerates_a_trailing_slash_and_ignores_nothing_else", () => {
    expect(parseRoute("/day/2026-10-22/", TODAY)).toEqual({ view: "day", date: "2026-10-22" });
    expect(parseRoute("/place/007", TODAY)).toEqual({ view: "place", id: 7 });
    expect(parseRoute("/day/2026-10-22//", TODAY)).toBeNull();
  });

  test("week_route_normalises_to_monday", () => {
    expect(parseRoute("/week/2026-10-22", TODAY)).toEqual({ view: "week", start: "2026-10-19" });
    expect(parseRoute("/week/2026-10-19", TODAY)).toEqual({ view: "week", start: "2026-10-19" }); // a Monday stays
    expect(parseRoute("/week/2026-10-25", TODAY)).toEqual({ view: "week", start: "2026-10-19" }); // Sunday ends the week
    expect(parseRoute("/week/2026-10-26", TODAY)).toEqual({ view: "week", start: "2026-10-26" }); // next Monday starts one
    expect(parseRoute("/week/2026-01-01", TODAY)).toEqual({ view: "week", start: "2025-12-29" }); // back over the new year
    expect(parseRoute("/week/2028-03-01", TODAY)).toEqual({ view: "week", start: "2028-02-28" }); // over a leap day
  });
});

describe("useRoute and navigate", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 9, 24, 12, 0, 0)); // noon on the 24th in whatever zone the test runs in
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("useRoute_reads_the_location", () => {
    window.history.replaceState(null, "", "/month/2026-02");

    const { result } = renderHook(() => useRoute());

    expect(result.current).toEqual({ view: "month", month: "2026-02" });
    expect(window.location.pathname).toBe("/month/2026-02");
  });

  test("useRoute_replaces_the_root_and_invalid_paths_with_today", () => {
    for (const path of ["/", "/nope", "/day/2026-02-30", "/range/2026-10-25..2026-10-19"]) {
      window.history.replaceState(null, "", path);
      const lengthBefore = window.history.length;

      const { result, unmount } = renderHook(() => useRoute());

      expect(result.current, path).toEqual(TODAY_ROUTE);
      expect(window.location.pathname, path).toBe("/day/2026-10-24");
      expect(window.history.length, `${path} must replace, not push`).toBe(lengthBefore);
      unmount();
    }
  });

  test("useRoute_rewrites_a_week_to_its_monday_in_the_url", () => {
    window.history.replaceState(null, "", "/week/2026-10-22");

    const { result } = renderHook(() => useRoute());

    expect(result.current).toEqual({ view: "week", start: "2026-10-19" });
    expect(window.location.pathname).toBe("/week/2026-10-19");
  });

  test("navigate_pushes_and_notifies_and_replace_does_not_add_history", () => {
    window.history.replaceState(null, "", "/day/2026-10-22");
    const { result } = renderHook(() => useRoute());
    const lengthBefore = window.history.length;

    act(() => navigate({ view: "day", date: "2026-10-23" }));
    expect(result.current).toEqual({ view: "day", date: "2026-10-23" });
    expect(window.location.pathname).toBe("/day/2026-10-23");
    expect(window.history.length).toBe(lengthBefore + 1);

    act(() => navigate({ view: "week", start: "2026-10-19" }, { replace: true }));
    expect(result.current).toEqual({ view: "week", start: "2026-10-19" });
    expect(window.location.pathname).toBe("/week/2026-10-19");
    expect(window.history.length).toBe(lengthBefore + 1);

    act(() => navigate({ view: "week", start: "2026-10-19" })); // already there: nothing to add
    expect(window.history.length).toBe(lengthBefore + 1);
  });

  test("useRoute_follows_popstate", () => {
    window.history.replaceState(null, "", "/day/2026-10-22");
    const { result } = renderHook(() => useRoute());

    act(() => {
      window.history.replaceState(null, "", "/place/9");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    expect(result.current).toEqual({ view: "place", id: 9 });
  });

  test("useRoute_keeps_its_value_when_nothing_changed", () => {
    window.history.replaceState(null, "", "/year/2026");
    const { result, rerender } = renderHook(() => useRoute());
    const first = result.current;

    rerender();
    act(() => navigate({ view: "year", year: 2026 }));

    expect(result.current).toBe(first);
  });
});
