import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { DayResponse, StaySegment } from "../api/types";
import { dayGeoJson, placePoint } from "../map/layers";
import newYorkDay from "../../e2e/fixtures/day-new-york.json";
import flightDay from "../../e2e/fixtures/day-oslo-new-york.json";
import type { Route } from "./router";
import { useViewMap } from "./useViewMap";

const OSLO_DAY = flightDay as DayResponse; // 2026-10-22: 4 moves and 5 pins
const NEW_YORK_DAY = newYorkDay as DayResponse; // 2026-10-23

const DAY_22: Route = { view: "day", date: "2026-10-22" };
const DAY_23: Route = { view: "day", date: "2026-10-23" };

const emptyDay = (date: string, state: DayResponse["state"] = "done"): DayResponse => ({
  date,
  timeZone: "Europe/Oslo",
  state,
  summary: { places: 0, distanceMeters: 0, movingSeconds: 0 },
  segments: [],
});

type Answer = DayResponse | Response | (() => Response | Promise<Response>);

/** What the API answers for each date; a test changes it to change what the next request finds. Returns it and the paths asked for. */
function stubApi(answers: Record<string, Answer>): { answers: Record<string, Answer>; paths: string[] } {
  const paths: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string) => {
      paths.push(path);
      const answer = answers[path.split("/").pop()!];
      if (answer === undefined) return new Response("{}", { status: 404 });
      if (answer instanceof Response) return answer.clone();
      return typeof answer === "function" ? answer() : Response.json(answer);
    }),
  );
  return { answers, paths };
}

function setup(route: Route) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const hook = renderHook(({ at }: { at: Route }) => useViewMap(at), { initialProps: { at: route }, wrapper });
  const refetch = async (date: string) => {
    await act(async () => {
      await client.refetchQueries({ queryKey: ["day", date] });
    });
  };
  return { ...hook, client, refetch, go: (at: Route) => hook.rerender({ at }) };
}

const featuresOf = (day: DayResponse) => {
  const { routes, stops } = dayGeoJson(day);
  return [...routes.features, ...stops.features];
};

afterEach(() => {
  vi.useRealTimers();
});

describe("useViewMap data", () => {
  test("useViewMap_draws_the_day_of_the_route_as_routes_and_pins", async () => {
    stubApi({ "2026-10-22": OSLO_DAY });

    const { result } = setup(DAY_22);

    expect(result.current.data.stops).toBeUndefined(); // nothing yet, and no pins to draw: the map is waiting for the day
    expect(result.current.data.routes.features).toEqual([]);
    await waitFor(() => expect(result.current.data.stops).toBeDefined());
    expect(result.current.data).toEqual(dayGeoJson(OSLO_DAY));
    expect(result.current.data.routes.features).toHaveLength(4); // the flight is one of them, and it is a line like the others
    expect(result.current.data.stops?.features).toHaveLength(5);
  });

  test("useViewMap_keeps_the_collections_it_gave_while_the_day_is_the_same", async () => {
    stubApi({ "2026-10-22": OSLO_DAY });
    const { result, rerender } = setup(DAY_22);
    await waitFor(() => expect(result.current.data.stops).toBeDefined());
    const before = result.current.data;

    rerender({ at: DAY_22 }); // rendered again for another reason: the map is not sent the same data again

    expect(result.current.data.routes).toBe(before.routes);
    expect(result.current.data.stops).toBe(before.stops);
  });

  test("useViewMap_draws_nothing_for_the_other_views_and_asks_for_no_day", async () => {
    const { paths } = stubApi({ "2026-10-22": OSLO_DAY });

    const { result } = setup({ view: "week", start: "2026-10-19" });

    await act(async () => undefined);
    expect(result.current.data.routes.features).toEqual([]);
    expect(result.current.data.stops).toBeUndefined(); // a period is drawn faint, with no pins
    expect(result.current.fitTo).toBeNull();
    expect(paths).toEqual([]); // no day was asked for to draw nothing of it
  });

  test("useViewMap_stops_drawing_the_day_when_the_view_is_not_a_day_and_draws_it_again_after", async () => {
    stubApi({ "2026-10-22": OSLO_DAY });
    const { result, go } = setup(DAY_22);
    await waitFor(() => expect(result.current.data.stops).toBeDefined());

    go({ view: "month", month: "2026-10" });
    expect(result.current.data.routes.features).toEqual([]);
    expect(result.current.data.stops).toBeUndefined();
    expect(result.current.fitTo).toBeNull();

    go(DAY_22);
    expect(result.current.data).toEqual(dayGeoJson(OSLO_DAY)); // from the cache, at once
  });

  test("useViewMap_keeps_drawing_the_last_day_while_the_next_one_loads", async () => {
    let release: (response: Response) => void = () => undefined;
    stubApi({ "2026-10-22": OSLO_DAY, "2026-10-23": () => new Promise<Response>((resolve) => (release = resolve)) });
    const { result, go } = setup(DAY_22);
    await waitFor(() => expect(result.current.data.stops).toBeDefined());
    const drawn = result.current.data;

    go(DAY_23);

    expect(result.current.data.routes).toBe(drawn.routes); // the day that was on screen stays under the one on its way
    expect(result.current.data.stops).toBe(drawn.stops);
    release(Response.json(NEW_YORK_DAY));
    await waitFor(() => expect(result.current.data).toEqual(dayGeoJson(NEW_YORK_DAY)));
  });

  test("useViewMap_keeps_drawing_the_last_day_under_an_error_and_does_not_fit_it_again", async () => {
    stubApi({ "2026-10-22": OSLO_DAY, "2026-10-23": new Response("{}", { status: 500 }) });
    const { result, go, client } = setup(DAY_22);
    await waitFor(() => expect(result.current.fitTo).not.toBeNull());
    const drawn = result.current.data;

    go(DAY_23);
    await waitFor(() => expect(client.getQueryState(["day", "2026-10-23"])?.status).toBe("error"));

    expect(result.current.data.routes).toBe(drawn.routes); // as the panel keeps its rows under the error
    expect(result.current.data.stops).toBe(drawn.stops);
    expect(result.current.fitTo).toBeNull(); // and the map is not taken to the 22nd for the 23rd
  });
});

describe("useViewMap leaving the day view", () => {
  const WEEK: Route = { view: "week", start: "2026-10-19" };

  test("useViewMap_does_not_draw_the_day_that_was_left_while_the_next_one_loads", async () => {
    // The panel of a day that is shown after another view starts afresh, and says "Loading…": the map must say the same.
    let release: (response: Response) => void = () => undefined;
    stubApi({ "2026-10-22": OSLO_DAY, "2026-10-23": () => new Promise<Response>((resolve) => (release = resolve)) });
    const { result, go } = setup(DAY_22);
    await waitFor(() => expect(result.current.fitTo).not.toBeNull());
    go(WEEK);

    go(DAY_23);

    expect(result.current.data.routes.features).toEqual([]);
    expect(result.current.data.stops).toBeUndefined();
    expect(result.current.fitTo).toBeNull();
    expect(result.current.home).toBeNull();
    release(Response.json(NEW_YORK_DAY));
    await waitFor(() => expect(result.current.data).toEqual(dayGeoJson(NEW_YORK_DAY)));
    expect(result.current.fitTo).toEqual(featuresOf(NEW_YORK_DAY));
  });

  test("useViewMap_does_not_draw_the_day_that_was_left_when_the_next_one_fails", async () => {
    stubApi({ "2026-10-22": OSLO_DAY, "2026-10-23": new Response("{}", { status: 500 }) });
    const { result, go, client } = setup(DAY_22);
    await waitFor(() => expect(result.current.fitTo).not.toBeNull());
    go(WEEK);

    go(DAY_23);
    await waitFor(() => expect(client.getQueryState(["day", "2026-10-23"])?.status).toBe("error"));

    expect(result.current.data.routes.features).toEqual([]); // the panel shows the error and no rows, and so does the map
    expect(result.current.data.stops).toBeUndefined();
    expect(result.current.fitTo).toBeNull();
  });

  test("useViewMap_still_keeps_the_day_under_the_next_one_when_the_view_stays_a_day", async () => {
    let release: (response: Response) => void = () => undefined;
    stubApi({ "2026-10-22": OSLO_DAY, "2026-10-23": () => new Promise<Response>((resolve) => (release = resolve)) });
    const { result, go } = setup(DAY_22);
    await waitFor(() => expect(result.current.fitTo).not.toBeNull());
    const drawn = result.current.data;

    go(DAY_23); // stepping, with no other view between

    expect(result.current.data.routes).toBe(drawn.routes);
    release(Response.json(NEW_YORK_DAY));
    await waitFor(() => expect(result.current.data).toEqual(dayGeoJson(NEW_YORK_DAY)));
  });
});

describe("useViewMap home", () => {
  test("useViewMap_gives_the_whole_day_as_home_and_a_tapped_row_does_not_change_it", async () => {
    stubApi({ "2026-10-22": OSLO_DAY });
    const { result } = setup(DAY_22);
    expect(result.current.home).toBeNull(); // nothing to go back to before the day is there
    await waitFor(() => expect(result.current.fitTo).not.toBeNull());
    const home = result.current.home;
    expect(home).toEqual(featuresOf(OSLO_DAY));

    act(() => result.current.onFocus([placePoint((OSLO_DAY.segments[2] as StaySegment).place!)]));

    expect(result.current.fitTo).toHaveLength(1); // the map is at the row...
    expect(result.current.home).toBe(home); // ...and Recenter is for the whole day
  });

  test("useViewMap_has_no_home_for_the_other_views_or_a_day_with_nothing_on_it", async () => {
    stubApi({ "2026-10-22": emptyDay("2026-10-22") });
    const { result, go } = setup(DAY_22);
    await waitFor(() => expect(result.current.data.stops).toBeDefined());
    expect(result.current.home).toBeNull();

    go({ view: "month", month: "2026-10" });
    expect(result.current.home).toBeNull();
  });
});

describe("useViewMap fit", () => {
  test("useViewMap_fits_to_the_whole_day_when_its_data_first_arrives", async () => {
    stubApi({ "2026-10-22": OSLO_DAY });

    const { result } = setup(DAY_22);

    expect(result.current.fitTo).toBeNull(); // nothing to fit to before the day is there
    await waitFor(() => expect(result.current.fitTo).not.toBeNull());
    expect(result.current.fitTo).toEqual(featuresOf(OSLO_DAY)); // every route and every pin
    expect(result.current.fitTo).toHaveLength(9);
  });

  test("useViewMap_does_not_fit_again_when_the_same_day_is_refetched_or_polled", async () => {
    // Today is polled every 30 s while it is pending, and the map must not be pulled back from where the owner has put it.
    const { answers } = stubApi({ "2026-10-22": { ...OSLO_DAY, state: "pending" } });
    const { result, refetch } = setup(DAY_22);
    await waitFor(() => expect(result.current.fitTo).not.toBeNull());
    const fit = result.current.fitTo;
    const drawn = result.current.data;

    answers["2026-10-22"] = { ...OSLO_DAY, state: "done", segments: OSLO_DAY.segments.slice(0, 5) }; // the poll finds the day changed
    await refetch("2026-10-22");

    await waitFor(() => expect(result.current.data.routes.features).toHaveLength(2)); // the map is given the new day...
    expect(result.current.data.routes).not.toBe(drawn.routes);
    expect(result.current.fitTo).toBe(fit); // ...and is not asked to move
    await refetch("2026-10-22");
    expect(result.current.fitTo).toBe(fit);
  });

  test("useViewMap_fits_each_date_once_when_it_is_shown_and_again_when_it_is_shown_again", async () => {
    stubApi({ "2026-10-22": OSLO_DAY, "2026-10-23": NEW_YORK_DAY });
    const { result, go } = setup(DAY_22);
    await waitFor(() => expect(result.current.fitTo).not.toBeNull());
    const first = result.current.fitTo;

    go(DAY_23);
    await waitFor(() => expect(result.current.fitTo).toEqual(featuresOf(NEW_YORK_DAY)));
    const second = result.current.fitTo;
    expect(second).not.toBe(first);

    go(DAY_22); // back to a day that was looked at before: the map comes back to it
    await waitFor(() => expect(result.current.fitTo).toEqual(featuresOf(OSLO_DAY)));
    expect(result.current.fitTo).not.toBe(first);
    expect(result.current.fitTo).not.toBe(second);
  });

  test("useViewMap_fits_a_day_that_is_in_the_cache_in_the_render_that_shows_it", async () => {
    stubApi({ "2026-10-22": OSLO_DAY, "2026-10-23": NEW_YORK_DAY });
    const { result, go, client } = setup(DAY_22);
    await waitFor(() => expect(result.current.fitTo).not.toBeNull());
    await client.prefetchQuery({ queryKey: ["day", "2026-10-23"], queryFn: async () => NEW_YORK_DAY });

    go(DAY_23); // stepping › onto a day that was prefetched

    expect(result.current.fitTo).toEqual(featuresOf(NEW_YORK_DAY)); // no wait for it
  });

  test("useViewMap_does_not_fit_the_previous_day_for_the_date_that_is_loading", async () => {
    let release: (response: Response) => void = () => undefined;
    stubApi({ "2026-10-22": OSLO_DAY, "2026-10-23": () => new Promise<Response>((resolve) => (release = resolve)) });
    const { result, go } = setup(DAY_22);
    await waitFor(() => expect(result.current.fitTo).not.toBeNull());

    go(DAY_23); // the 22nd is still what is drawn, and it is not what is being looked at

    expect(result.current.fitTo).toBeNull();
    release(Response.json(NEW_YORK_DAY));
    await waitFor(() => expect(result.current.fitTo).toEqual(featuresOf(NEW_YORK_DAY)));
  });

  test("useViewMap_fits_a_day_that_starts_empty_when_it_first_has_something_and_only_then", async () => {
    // Today before its points are processed: nothing to fit to, so nothing is spent of the one fit the date gets.
    const { answers } = stubApi({ "2026-10-22": emptyDay("2026-10-22", "pending") });
    const { result, refetch } = setup(DAY_22);
    await waitFor(() => expect(result.current.data.stops).toBeDefined());
    expect(result.current.fitTo).toBeNull();

    answers["2026-10-22"] = { ...OSLO_DAY, state: "pending" };
    await refetch("2026-10-22");
    await waitFor(() => expect(result.current.fitTo).toEqual(featuresOf(OSLO_DAY)));
    const fit = result.current.fitTo;

    answers["2026-10-22"] = { ...OSLO_DAY, state: "done" };
    await refetch("2026-10-22");
    await waitFor(() => expect(result.current.data.routes.features).toHaveLength(4));
    expect(result.current.fitTo).toBe(fit); // once
  });

  test("useViewMap_fits_the_day_again_when_the_view_comes_back_to_it_from_another", async () => {
    stubApi({ "2026-10-22": OSLO_DAY });
    const { result, go } = setup(DAY_22);
    await waitFor(() => expect(result.current.fitTo).not.toBeNull());
    const first = result.current.fitTo;

    go({ view: "week", start: "2026-10-19" });
    go(DAY_22);

    await waitFor(() => expect(result.current.fitTo).not.toBeNull());
    expect(result.current.fitTo).toEqual(first);
    expect(result.current.fitTo).not.toBe(first);
  });
});

describe("useViewMap onFocus", () => {
  test("useViewMap_onFocus_brings_the_map_to_what_it_is_given_and_each_call_is_a_new_array", async () => {
    stubApi({ "2026-10-22": OSLO_DAY });
    const { result } = setup(DAY_22);
    await waitFor(() => expect(result.current.fitTo).not.toBeNull());
    const row = [placePoint((OSLO_DAY.segments[2] as StaySegment).place!)];

    act(() => result.current.onFocus(row));
    const tapped = result.current.fitTo;
    expect(tapped).toEqual(row);

    act(() => result.current.onFocus(row)); // the same row again: the map is to come back to it, so it is another array
    expect(result.current.fitTo).toEqual(row);
    expect(result.current.fitTo).not.toBe(tapped);
    expect(result.current.fitTo).not.toBe(row);
  });

  test("useViewMap_leaves_a_tapped_row_alone_when_the_day_is_refetched", async () => {
    const { answers } = stubApi({ "2026-10-22": { ...OSLO_DAY, state: "pending" } });
    const { result, refetch } = setup(DAY_22);
    await waitFor(() => expect(result.current.fitTo).not.toBeNull());
    act(() => result.current.onFocus([placePoint((OSLO_DAY.segments[0] as StaySegment).place!)]));
    const tapped = result.current.fitTo;

    answers["2026-10-22"] = { ...OSLO_DAY, state: "done" };
    await refetch("2026-10-22");
    await waitFor(() => expect(result.current.data.routes).toBeDefined());

    expect(result.current.fitTo).toBe(tapped); // a poll does not take the map back from the row the owner asked for
  });

  test("useViewMap_onFocus_is_heard_while_the_next_day_loads_too", async () => {
    // The rows of the day that is still on screen are tappable under the next day's loading, or its error.
    stubApi({ "2026-10-22": OSLO_DAY, "2026-10-23": () => new Promise<Response>(() => undefined) });
    const { result, go } = setup(DAY_22);
    await waitFor(() => expect(result.current.fitTo).not.toBeNull());
    go(DAY_23);
    const row = [placePoint((OSLO_DAY.segments[0] as StaySegment).place!)];

    act(() => result.current.onFocus(row));

    expect(result.current.fitTo).toEqual(row);
  });

  test("useViewMap_onFocus_is_one_function_for_as_long_as_the_hook_lives", async () => {
    stubApi({ "2026-10-22": OSLO_DAY });
    const { result, go } = setup(DAY_22);
    const onFocus = result.current.onFocus;
    await waitFor(() => expect(result.current.fitTo).not.toBeNull());

    go(DAY_23);

    expect(result.current.onFocus).toBe(onFocus); // the panels it goes to are not rendered again for it
  });
});
