import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { formatRoute, goBack, isPeriodRoute, navigate, parseRoute, reachedInApp, resolveRoute, useRoute, type Route } from "./router";

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

  test("parseRoute_reads_trips_and_trip_and_rejects_a_bad_trip_id", () => {
    const routes: [Route, string][] = [
      [{ view: "trips" }, "/trips"],
      [{ view: "trip", id: "2026-09-12" }, "/trip/2026-09-12"],
      [{ view: "trip", id: "2028-02-29" }, "/trip/2028-02-29"],
    ];
    for (const [route, path] of routes) {
      expect(formatRoute(route)).toBe(path);
      expect(parseRoute(path, TODAY)).toEqual(route);
      expect(parseRoute(formatRoute(route), TODAY)).toEqual(route);
    }
    expect(parseRoute("/trips/", TODAY)).toEqual({ view: "trips" }); // one trailing slash is ignored, as for every view
    expect(parseRoute("/trip/2026-09-12/", TODAY)).toEqual({ view: "trip", id: "2026-09-12" });

    // A trip is named by the date of its first night, and a date that does not exist names none: the API would answer 404 for it.
    for (const path of [
      "/trip/abc",
      "/trip/2026-02-30",
      "/trip/2026-13-01",
      "/trip/2026-9-12", // not zero-padded
      "/trip/12", // a place's kind of id
      "/trip",
      "/trip/",
      "/trip/2026-09-12/extra",
      "/trip/2026-09-12..2026-09-13",
      "/trips/2026-09-12", // the list has no argument
      "/trips/abc",
      "/trips//",
      "/Trips",
    ]) {
      expect(parseRoute(path, TODAY), path).toBeNull();
      expect(resolveRoute(path, TODAY), path).toEqual(TODAY_ROUTE);
    }
  });

  test("isPeriodRoute_is_false_for_place_trips_and_trip", () => {
    const periods: Route[] = [
      { view: "day", date: "2026-10-22" },
      { view: "week", start: "2026-10-19" },
      { view: "month", month: "2026-10" },
      { view: "year", year: 2026 },
      { view: "range", from: "2026-09-12", to: "2026-09-19" },
    ];
    const others: Route[] = [{ view: "place", id: 42 }, { view: "trips" }, { view: "trip", id: "2026-09-12" }];

    for (const route of periods) expect(isPeriodRoute(route), route.view).toBe(true);
    for (const route of others) expect(isPeriodRoute(route), route.view).toBe(false);
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

  test("parseRoute_cuts_a_range_longer_than_the_api_answers_to_its_first_400_days", () => {
    // 400 dates, both ends counted, are as many as the API takes; the 401st is one too many (a 400 that no Retry would change).
    expect(parseRoute("/range/2025-01-01..2026-02-04", TODAY)).toEqual({ view: "range", from: "2025-01-01", to: "2026-02-04" });
    expect(parseRoute("/range/2025-01-01..2026-02-05", TODAY)).toEqual({ view: "range", from: "2025-01-01", to: "2026-02-04" });
    expect(parseRoute("/range/2025-01-01..2026-12-31", TODAY)).toEqual({ view: "range", from: "2025-01-01", to: "2026-02-04" });
    expect(parseRoute("/range/2028-01-01..2029-12-31", TODAY)).toEqual({ view: "range", from: "2028-01-01", to: "2029-02-03" }); // over a leap day
    expect(parseRoute("/range/0001-01-01..9999-12-31", TODAY)).toEqual({ view: "range", from: "0001-01-01", to: "0002-02-04" });
    expect(parseRoute("/range/9999-01-01..9999-12-31", TODAY)).toEqual({ view: "range", from: "9999-01-01", to: "9999-12-31" }); // 365 dates
    expect(resolveRoute("/range/2025-01-01..2026-12-31", TODAY)).toEqual({ view: "range", from: "2025-01-01", to: "2026-02-04" });
  });

  test("parseRoute_leaves_the_other_views_alone_whatever_their_length", () => {
    expect(parseRoute("/year/2026", TODAY)).toEqual({ view: "year", year: 2026 }); // 365 dates
    expect(parseRoute("/year/2028", TODAY)).toEqual({ view: "year", year: 2028 }); // 366
    expect(parseRoute("/range/2026-01-01..2026-12-31", TODAY)).toEqual({ view: "range", from: "2026-01-01", to: "2026-12-31" });
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

  test("useRoute_reads_trips_and_a_trip_and_leaves_their_addresses_as_they_are", () => {
    for (const [path, route] of [
      ["/trips", { view: "trips" }],
      ["/trip/2026-09-12", { view: "trip", id: "2026-09-12" }],
    ] as const) {
      window.history.replaceState(null, "", path);
      const lengthBefore = window.history.length;

      const { result, unmount } = renderHook(() => useRoute());

      expect(result.current, path).toEqual(route);
      expect(window.location.pathname, path).toBe(path);
      expect(window.history.length, path).toBe(lengthBefore);
      unmount();
    }
  });

  test("useRoute_replaces_a_trip_that_has_no_date_with_today", () => {
    window.history.replaceState(null, "", "/trip/abc");

    const { result } = renderHook(() => useRoute());

    expect(result.current).toEqual(TODAY_ROUTE);
    expect(window.location.pathname).toBe("/day/2026-10-24");
  });

  test("useRoute_rewrites_a_week_to_its_monday_in_the_url", () => {
    window.history.replaceState(null, "", "/week/2026-10-22");

    const { result } = renderHook(() => useRoute());

    expect(result.current).toEqual({ view: "week", start: "2026-10-19" });
    expect(window.location.pathname).toBe("/week/2026-10-19");
  });

  test("useRoute_replaces_a_range_that_is_too_long_with_the_one_that_is_asked_for", () => {
    window.history.replaceState(null, "", "/range/2025-01-01..2026-12-31");
    const lengthBefore = window.history.length;

    const { result } = renderHook(() => useRoute());

    expect(result.current).toEqual({ view: "range", from: "2025-01-01", to: "2026-02-04" }); // nothing below ever sees the long one
    expect(window.location.pathname).toBe("/range/2025-01-01..2026-02-04");
    expect(window.history.length).toBe(lengthBefore); // replaced, not pushed
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

// Back is the browser's only where there is something of the app behind the view. `history.length` cannot say (it counts the first page
// and other sites), so `navigate` marks each entry it pushes, and an entry that carries the mark was reached from a view of the app.
describe("reaching a view in the app", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 9, 24, 12, 0, 0));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("reachedInApp_is_false_for_a_page_that_was_opened_and_true_for_what_navigate_pushed", () => {
    window.history.replaceState(null, "", "/place/5"); // a deep link, a fresh tab
    expect(reachedInApp()).toBe(false);

    act(() => navigate({ view: "day", date: "2026-10-22" }));
    expect(reachedInApp()).toBe(true);

    act(() => navigate({ view: "place", id: 5 }));
    expect(reachedInApp()).toBe(true);
  });

  test("reachedInApp_is_not_taken_in_by_a_state_that_is_not_the_apps", () => {
    for (const state of [null, undefined, "pushed", 42, {}, { sporer: "other" }, { reached: true }]) {
      window.history.replaceState(state, "", "/place/5");
      expect(reachedInApp(), JSON.stringify(state)).toBe(false);
    }
  });

  test("replacing_an_entry_leaves_it_as_it_was_reached", () => {
    window.history.replaceState(null, "", "/day/2026-10-22");
    act(() => navigate({ view: "week", start: "2026-10-19" }, { replace: true })); // an entry that was opened, rewritten
    expect(window.location.pathname).toBe("/week/2026-10-19");
    expect(reachedInApp()).toBe(false);

    act(() => navigate({ view: "month", month: "2026-10" })); // an entry that was pushed, rewritten
    act(() => navigate({ view: "year", year: 2026 }, { replace: true }));
    expect(window.location.pathname).toBe("/year/2026");
    expect(reachedInApp()).toBe(true);
  });

  test("useRoute_keeps_the_mark_of_the_entry_it_normalises", () => {
    // A deep link to a week by a day other than its Monday is rewritten to the Monday: still a page that was opened.
    window.history.replaceState(null, "", "/week/2026-10-22");
    const opened = renderHook(() => useRoute());
    expect(window.location.pathname).toBe("/week/2026-10-19");
    expect(reachedInApp()).toBe(false);
    opened.unmount();

    // And the same address on an entry the app pushed (a history of its own making) stays an entry of the app.
    act(() => navigate({ view: "day", date: "2026-10-22" }));
    window.history.replaceState(window.history.state, "", "/range/2025-01-01..2026-12-31"); // beyond what the API answers for
    const pushed = renderHook(() => useRoute());
    expect(window.location.pathname).toBe("/range/2025-01-01..2026-02-04");
    expect(reachedInApp()).toBe(true);
    pushed.unmount();
  });

  test("reachedInApp_holds_for_a_view_that_is_mounted_afresh_as_after_a_reload_of_an_entry_the_app_pushed", () => {
    // The mark is in the history entry, which a reload keeps (as it keeps the entries behind it): back from that entry still goes to the
    // view the owner came from, and not to today. Nothing about it is in the memory of the page.
    act(() => navigate({ view: "place", id: 5 }));
    const first = renderHook(() => useRoute());
    first.unmount();

    const again = renderHook(() => useRoute());

    expect(again.result.current).toEqual({ view: "place", id: 5 });
    expect(reachedInApp()).toBe(true);
    again.unmount();
  });

  test("goBack_goes_back_in_history_when_the_view_was_reached_in_the_app_and_adds_nothing", () => {
    act(() => navigate({ view: "day", date: "2026-10-22" }));
    act(() => navigate({ view: "place", id: 5 }));
    const back = vi.spyOn(window.history, "back").mockImplementation(() => undefined);
    const lengthBefore = window.history.length;

    goBack();

    expect(back).toHaveBeenCalledTimes(1);
    expect(window.location.pathname).toBe("/place/5"); // the browser moves the address, and tells of it with popstate
    expect(window.history.length).toBe(lengthBefore);
  });

  test("goBack_goes_to_today_in_place_of_the_page_that_was_opened_and_does_not_leave_it_behind", () => {
    window.history.replaceState(null, "", "/place/5");
    const { result } = renderHook(() => useRoute());
    const back = vi.spyOn(window.history, "back").mockImplementation(() => undefined);
    const lengthBefore = window.history.length;

    act(() => goBack());

    expect(back).not.toHaveBeenCalled();
    expect(result.current).toEqual(TODAY_ROUTE); // today in the zone of the browser
    expect(window.location.pathname).toBe("/day/2026-10-24");
    expect(window.history.length).toBe(lengthBefore); // replaced: Back from here is where the owner was before the page, not the place again
    expect(reachedInApp()).toBe(false); // and today's day is a page that was opened too
  });
});
