import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { DayResponse, HeatResponse, PlaceResponse, RangeResponse, StaySegment, TripResponse, TripsResponse } from "../api/types";
import { dayGeoJson, heatGeoJson, placeGeoJson, placePoint, rangeGeoJson, tripGeoJson, tripsGeoJson } from "../map/layers";
import newYorkDay from "../../e2e/fixtures/day-new-york.json";
import flightDay from "../../e2e/fixtures/day-oslo-new-york.json";
import cafe from "../../e2e/fixtures/place-cafe.json";
import october from "../../e2e/fixtures/range-october.json";
import lisbonTrip from "../../e2e/fixtures/trip-2026-09-12.json";
import tripsList from "../../e2e/fixtures/trips.json";
import type { Route } from "./router";
import { useViewMap } from "./useViewMap";

const OSLO_DAY = flightDay as DayResponse; // 2026-10-22: 4 moves and 5 pins
const NEW_YORK_DAY = newYorkDay as DayResponse; // 2026-10-23
const OCTOBER = october as RangeResponse; // 2026-10-01 to 2026-10-31: 9 moves and 6 places
const CAFE = cafe as PlaceResponse; // place 2, the Café of the 22nd
const TRIPS_LIST = tripsList as TripsResponse; // New York (ongoing), Lisbon & Sintra, Copenhagen: four cities
const LISBON = lisbonTrip as TripResponse; // trip 2026-09-12 (12 to 16 September): 9 moves and 2 cities

/** Two weeks of the month, each with some of its moves and places, so that one is told from the other by what is drawn. */
const weekOf = (from: string, to: string, moves: number[], places: number[], over: Partial<RangeResponse> = {}): RangeResponse => ({
  ...OCTOBER,
  from,
  to,
  moves: moves.map((i) => OCTOBER.moves[i]!),
  places: places.map((i) => OCTOBER.places[i]!),
  ...over,
});
const WEEK_19_RANGE = weekOf("2026-10-19", "2026-10-25", [4, 5], [0, 1]); // 2 routes and 2 dots
const WEEK_26_RANGE = weekOf("2026-10-26", "2026-11-01", [6, 7, 8], [2, 3, 4]); // 3 routes and 3 dots

const DAY_22: Route = { view: "day", date: "2026-10-22" };
const DAY_23: Route = { view: "day", date: "2026-10-23" };
const WEEK_19: Route = { view: "week", start: "2026-10-19" };
const WEEK_26: Route = { view: "week", start: "2026-10-26" };
const MONTH: Route = { view: "month", month: "2026-10" };
const PLACE_2: Route = { view: "place", id: 2 };
const TRIPS: Route = { view: "trips" };
const TRIP: Route = { view: "trip", id: "2026-09-12" };
const OTHER_TRIP: Route = { view: "trip", id: "2026-08-01" };

const emptyDay = (date: string, state: DayResponse["state"] = "done"): DayResponse => ({
  date,
  timeZone: "Europe/Oslo",
  state,
  summary: { places: 0, distanceMeters: 0, movingSeconds: 0 },
  segments: [],
});

type Answer = DayResponse | RangeResponse | HeatResponse | PlaceResponse | TripsResponse | TripResponse | Response | (() => Response | Promise<Response>);

/** What a request is answered by: the date of a day (`2026-10-22`), the dates of a range (`2026-10-19..2026-10-25`), `heatKey` of a heat, `placeKey` of a place, `tripKey` of a trip, `trips` of the list of trips. */
function keyOf(path: string): string {
  if (path.startsWith("/api/places/")) return placeKey(Number(path.split("/").pop()));
  if (path.startsWith("/api/trips/")) return tripKey(path.split("/").pop()!);
  if (!path.startsWith("/api/range") && !path.startsWith("/api/heat")) return path.split("/").pop()!;
  const query = new URLSearchParams(path.split("?")[1]);
  const dates = `${query.get("from")}..${query.get("to")}`;
  return path.startsWith("/api/heat") ? `heat:${dates}` : dates;
}

/** The key that a place is answered by. */
const placeKey = (id: number): string => `place:${id}`;

/** The key that a trip is answered by: its id is a date, which a day is answered by as well. */
const tripKey = (id: string): string => `trip:${id}`;

/** The key that a heat of these dates is answered by. */
const heatKey = (from: string, to = from): string => `heat:${from}..${to}`;

/** What the API answers for each day and range; a test changes it to change what the next request finds. Returns it and the paths asked for. */
function stubApi(answers: Record<string, Answer>): { answers: Record<string, Answer>; paths: string[] } {
  const paths: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string) => {
      paths.push(path);
      const answer = answers[keyOf(path)];
      if (answer === undefined) return new Response("{}", { status: 404 });
      if (answer instanceof Response) return answer.clone();
      return typeof answer === "function" ? answer() : Response.json(answer);
    }),
  );
  return { answers, paths };
}

function setup(route: Route, heatOn = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  // Both props are always given: a render that left `on` out would quietly turn the heat off.
  const { rerender, ...hook } = renderHook(({ at, on }: { at: Route; on: boolean }) => useViewMap(at, on), {
    initialProps: { at: route, on: heatOn },
    wrapper,
  });
  const refetch = async (date: string) => {
    await act(async () => {
      await client.refetchQueries({ queryKey: ["day", date] });
    });
  };
  const refetchRange = async (from: string, to: string) => {
    await act(async () => {
      await client.refetchQueries({ queryKey: ["range", from, to] });
    });
  };
  /** Refetches a place, and lets the observers hear how it went. */
  const refetchPlace = async (id: number) => {
    await act(async () => {
      await client.refetchQueries({ queryKey: ["place", id] });
      await new Promise((resolve) => setTimeout(resolve, 0)); // the observers are told on the next tick
    });
  };
  /** Refetches the list of trips, and lets the observers hear how it went. */
  const refetchTrips = async () => {
    await act(async () => {
      await client.refetchQueries({ queryKey: ["trips"] });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };
  /** Refetches a heat, and lets the observers hear how it went (they are told on the next tick, which a refetch does not wait for). */
  const refetchHeat = async (from: string, to = from) => {
    await act(async () => {
      await client.refetchQueries({ queryKey: ["heat", from, to] });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };
  let at = route;
  let on = heatOn;
  return {
    ...hook,
    client,
    refetch,
    refetchRange,
    refetchHeat,
    refetchPlace,
    refetchTrips,
    /** Renders again on the same route with the heat as it was, for a render that is made for another reason. */
    again: () => rerender({ at, on }),
    go: (next: Route) => {
      at = next;
      rerender({ at, on });
    },
    /** Turns the heat on or off, on the route that is shown. */
    setHeat: (next: boolean) => {
      on = next;
      rerender({ at, on });
    },
  };
}

const featuresOf = (day: DayResponse) => {
  const { routes, stops } = dayGeoJson(day);
  return [...routes.features, ...stops.features];
};

const periodFeaturesOf = (range: RangeResponse) => {
  const { routes, places } = rangeGeoJson(range);
  return [...routes.features, ...places.features];
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
    const { result, again } = setup(DAY_22);
    await waitFor(() => expect(result.current.data.stops).toBeDefined());
    const before = result.current.data;

    again(); // rendered again for another reason: the map is not sent the same data again

    expect(result.current.data.routes).toBe(before.routes);
    expect(result.current.data.stops).toBe(before.stops);
  });

  test("useViewMap_draws_a_place_as_one_pin_and_asks_for_that_place_only", async () => {
    const { paths } = stubApi({ "2026-10-22": OSLO_DAY, "2026-10-01..2026-10-31": OCTOBER, [placeKey(2)]: CAFE });

    const { result } = setup(PLACE_2);

    expect(result.current.data.stops).toBeUndefined(); // nothing yet, and no pin to draw: the map is waiting for the place
    expect(result.current.data.routes.features).toEqual([]);
    await waitFor(() => expect(result.current.data.stops).toBeDefined());
    expect(result.current.data).toEqual(placeGeoJson(CAFE));
    expect(result.current.data.stops?.features).toHaveLength(1);
    expect(result.current.data.stops?.features[0]?.properties).toMatchObject({ label: "", name: "Café" }); // a pin of a stop, with no number
    expect(result.current.data.places).toBeUndefined();
    expect(paths).toEqual(["/api/places/2"]); // neither a day nor a period was asked for to draw the place
  });

  test("useViewMap_stops_drawing_the_day_when_the_view_is_not_a_day_and_draws_it_again_after", async () => {
    stubApi({ "2026-10-22": OSLO_DAY });
    const { result, go } = setup(DAY_22);
    await waitFor(() => expect(result.current.data.stops).toBeDefined());

    go({ view: "place", id: 3 });
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
  test("useViewMap_does_not_draw_the_day_that_was_left_while_the_next_one_loads", async () => {
    // The panel of a day that is shown after another view starts afresh, and says "Loading…": the map must say the same.
    let release: (response: Response) => void = () => undefined;
    stubApi({ "2026-10-22": OSLO_DAY, "2026-10-19..2026-10-25": WEEK_19_RANGE, "2026-10-23": () => new Promise<Response>((resolve) => (release = resolve)) });
    const { result, go } = setup(DAY_22);
    await waitFor(() => expect(result.current.fitTo).not.toBeNull());
    go(WEEK_19);

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
    stubApi({ "2026-10-22": OSLO_DAY, "2026-10-19..2026-10-25": WEEK_19_RANGE, "2026-10-23": new Response("{}", { status: 500 }) });
    const { result, go, client } = setup(DAY_22);
    await waitFor(() => expect(result.current.fitTo).not.toBeNull());
    go(WEEK_19);

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

  test("useViewMap_has_no_home_for_a_place_or_a_day_with_nothing_on_it", async () => {
    stubApi({ "2026-10-22": emptyDay("2026-10-22") });
    const { result, go } = setup(DAY_22);
    await waitFor(() => expect(result.current.data.stops).toBeDefined());
    expect(result.current.home).toBeNull();

    go({ view: "place", id: 3 });
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

    go(WEEK_19);
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
    const drawn = result.current.data;

    answers["2026-10-22"] = { ...OSLO_DAY, state: "done" };
    await refetch("2026-10-22");
    // The poll's answer is a day that has changed (it is done now), so the map is given new collections: that is what is waited for.
    await waitFor(() => expect(result.current.data.routes).not.toBe(drawn.routes));

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

describe("useViewMap periods", () => {
  test("useViewMap_draws_the_period_of_the_route_as_faint_routes_and_place_dots", async () => {
    stubApi({ "2026-10-01..2026-10-31": OCTOBER });

    const { result } = setup(MONTH);

    expect(result.current.data.places).toBeUndefined(); // nothing yet: the map is waiting for the month
    expect(result.current.data.routes.features).toEqual([]);
    await waitFor(() => expect(result.current.data.places).toBeDefined());
    expect(result.current.data).toEqual(rangeGeoJson(OCTOBER));
    expect(result.current.data.routes.features).toHaveLength(9);
    expect(result.current.data.places?.features).toHaveLength(6);
    expect(result.current.data.stops).toBeUndefined(); // a period has dots and no pins, which is how the map knows to draw it faint
  });

  test("useViewMap_asks_for_the_dates_of_each_period_of_a_view_that_has_one", async () => {
    const answered = {
      "2026-10-19..2026-10-25": WEEK_19_RANGE,
      "2026-10-01..2026-10-31": OCTOBER,
      "2026-01-01..2026-12-31": { ...OCTOBER, from: "2026-01-01", to: "2026-12-31" },
      "2026-09-12..2026-09-19": { ...OCTOBER, from: "2026-09-12", to: "2026-09-19" },
    };
    const asks: [Route, string][] = [
      [WEEK_19, "/api/range?from=2026-10-19&to=2026-10-25"],
      [MONTH, "/api/range?from=2026-10-01&to=2026-10-31"],
      [{ view: "year", year: 2026 }, "/api/range?from=2026-01-01&to=2026-12-31"],
      [{ view: "range", from: "2026-09-12", to: "2026-09-19" }, "/api/range?from=2026-09-12&to=2026-09-19"],
    ];
    for (const [route, path] of asks) {
      const { paths } = stubApi(answered);

      const { result, unmount } = setup(route);
      await waitFor(() => expect(result.current.fitTo).not.toBeNull());

      expect(paths).toEqual([path]);
      unmount();
    }
  });

  test("useViewMap_keeps_the_collections_it_gave_while_the_period_is_the_same", async () => {
    stubApi({ "2026-10-01..2026-10-31": OCTOBER });
    const { result, again } = setup(MONTH);
    await waitFor(() => expect(result.current.data.places).toBeDefined());
    const before = result.current.data;

    again(); // rendered again for another reason: the map is not sent the same data again

    expect(result.current.data.routes).toBe(before.routes);
    expect(result.current.data.places).toBe(before.places);
  });

  test("useViewMap_gives_every_route_and_dot_of_the_period_as_home_and_a_tapped_row_does_not_change_it", async () => {
    stubApi({ "2026-10-01..2026-10-31": OCTOBER });
    const { result } = setup(MONTH);
    expect(result.current.home).toBeNull(); // nothing to go back to before the period is there
    await waitFor(() => expect(result.current.fitTo).not.toBeNull());
    const home = result.current.home;
    expect(home).toEqual(periodFeaturesOf(OCTOBER));
    expect(home).toHaveLength(15);

    act(() => result.current.onFocus([placePoint(OCTOBER.places[0]!)]));

    expect(result.current.fitTo).toHaveLength(1);
    expect(result.current.home).toBe(home);
  });

  test("useViewMap_has_no_home_for_a_period_with_nothing_on_it", async () => {
    stubApi({ "2026-10-01..2026-10-31": { ...OCTOBER, moves: [], places: [], days: [] } });
    const { result } = setup(MONTH);

    await waitFor(() => expect(result.current.data.places).toBeDefined());

    expect(result.current.home).toBeNull();
    expect(result.current.fitTo).toBeNull();
  });

  test("useViewMap_keeps_drawing_the_last_period_while_the_next_one_loads", async () => {
    let release: (response: Response) => void = () => undefined;
    stubApi({ "2026-10-19..2026-10-25": WEEK_19_RANGE, "2026-10-26..2026-11-01": () => new Promise<Response>((resolve) => (release = resolve)) });
    const { result, go } = setup(WEEK_19);
    await waitFor(() => expect(result.current.data.places).toBeDefined());
    const drawn = result.current.data;

    go(WEEK_26);

    expect(result.current.data.routes).toBe(drawn.routes); // the period that was on screen stays under the one on its way
    expect(result.current.data.places).toBe(drawn.places);
    expect(result.current.home).toEqual(periodFeaturesOf(WEEK_19_RANGE)); // and so does what Recenter goes back to
    release(Response.json(WEEK_26_RANGE));
    await waitFor(() => expect(result.current.data).toEqual(rangeGeoJson(WEEK_26_RANGE)));
  });

  test("useViewMap_keeps_drawing_the_last_period_under_an_error_and_does_not_fit_it_again", async () => {
    stubApi({ "2026-10-19..2026-10-25": WEEK_19_RANGE, "2026-10-26..2026-11-01": new Response("{}", { status: 500 }) });
    const { result, go, client } = setup(WEEK_19);
    await waitFor(() => expect(result.current.fitTo).not.toBeNull());
    const drawn = result.current.data;

    go(WEEK_26);
    await waitFor(() => expect(client.getQueryState(["range", "2026-10-26", "2026-11-01"])?.status).toBe("error"));

    expect(result.current.data.routes).toBe(drawn.routes); // as the panel keeps its rows under the error
    expect(result.current.data.places).toBe(drawn.places);
    expect(result.current.fitTo).toBeNull(); // and the map is not taken to the week of the 19th for the week of the 26th
  });

  test("useViewMap_keeps_the_period_under_the_next_when_the_view_changes_between_periods", async () => {
    // Week to month with the bar's buttons: the panel is the one component of all of them and keeps what it showed, so the map does too.
    let release: (response: Response) => void = () => undefined;
    stubApi({ "2026-10-19..2026-10-25": WEEK_19_RANGE, "2026-10-01..2026-10-31": () => new Promise<Response>((resolve) => (release = resolve)) });
    const { result, go } = setup(WEEK_19);
    await waitFor(() => expect(result.current.data.places).toBeDefined());
    const drawn = result.current.data;

    go(MONTH);

    expect(result.current.data.routes).toBe(drawn.routes);
    expect(result.current.fitTo).toBeNull(); // not the week's, for the month
    release(Response.json(OCTOBER));
    await waitFor(() => expect(result.current.fitTo).toEqual(periodFeaturesOf(OCTOBER)));
  });
});

describe("useViewMap leaving the period views", () => {
  test("useViewMap_does_not_draw_the_period_that_was_left_while_the_next_one_loads", async () => {
    // The panel of a period that is shown after a day starts afresh, and says "Loading…": the map must say the same.
    let release: (response: Response) => void = () => undefined;
    stubApi({
      "2026-10-19..2026-10-25": WEEK_19_RANGE,
      "2026-10-22": OSLO_DAY,
      "2026-10-26..2026-11-01": () => new Promise<Response>((resolve) => (release = resolve)),
    });
    const { result, go } = setup(WEEK_19);
    await waitFor(() => expect(result.current.fitTo).not.toBeNull());
    go(DAY_22);

    go(WEEK_26);

    expect(result.current.data.routes.features).toEqual([]);
    expect(result.current.data.places).toBeUndefined();
    expect(result.current.fitTo).toBeNull();
    expect(result.current.home).toBeNull();
    release(Response.json(WEEK_26_RANGE));
    await waitFor(() => expect(result.current.data).toEqual(rangeGeoJson(WEEK_26_RANGE)));
    expect(result.current.fitTo).toEqual(periodFeaturesOf(WEEK_26_RANGE));
  });

  test("useViewMap_does_not_draw_the_period_that_was_left_when_the_next_one_fails", async () => {
    stubApi({ "2026-10-19..2026-10-25": WEEK_19_RANGE, "2026-10-22": OSLO_DAY, "2026-10-26..2026-11-01": new Response("{}", { status: 500 }) });
    const { result, go, client } = setup(WEEK_19);
    await waitFor(() => expect(result.current.fitTo).not.toBeNull());
    go(DAY_22);

    go(WEEK_26);
    await waitFor(() => expect(client.getQueryState(["range", "2026-10-26", "2026-11-01"])?.status).toBe("error"));

    expect(result.current.data.routes.features).toEqual([]); // the panel shows the error and nothing else, and so does the map
    expect(result.current.data.places).toBeUndefined();
    expect(result.current.fitTo).toBeNull();
  });

  test("useViewMap_does_not_draw_the_period_that_was_left_for_a_place_either", async () => {
    let release: (response: Response) => void = () => undefined;
    stubApi({ "2026-10-19..2026-10-25": WEEK_19_RANGE, "2026-10-26..2026-11-01": () => new Promise<Response>((resolve) => (release = resolve)) });
    const { result, go } = setup(WEEK_19);
    await waitFor(() => expect(result.current.fitTo).not.toBeNull());
    go({ view: "place", id: 3 });
    expect(result.current.data.routes.features).toEqual([]);

    go(WEEK_26);

    expect(result.current.data.routes.features).toEqual([]);
    expect(result.current.fitTo).toBeNull();
    release(Response.json(WEEK_26_RANGE));
    await waitFor(() => expect(result.current.data).toEqual(rangeGeoJson(WEEK_26_RANGE)));
  });

  test("useViewMap_draws_a_period_that_is_in_the_cache_at_once_when_it_comes_back_from_a_day", async () => {
    stubApi({ "2026-10-19..2026-10-25": WEEK_19_RANGE, "2026-10-22": OSLO_DAY });
    const { result, go } = setup(WEEK_19);
    await waitFor(() => expect(result.current.fitTo).not.toBeNull());
    go(DAY_22);

    go(WEEK_19); // what the cache has is what the panel shows at once, and the map draws the same

    expect(result.current.data).toEqual(rangeGeoJson(WEEK_19_RANGE));
  });

  test("useViewMap_does_not_draw_the_day_that_was_left_for_a_period_that_is_loading", async () => {
    stubApi({ "2026-10-22": OSLO_DAY, "2026-10-26..2026-11-01": () => new Promise<Response>(() => undefined) });
    const { result, go } = setup(DAY_22);
    await waitFor(() => expect(result.current.fitTo).not.toBeNull());

    go(WEEK_26);

    expect(result.current.data.routes.features).toEqual([]); // not the day's routes and pins
    expect(result.current.data.stops).toBeUndefined();
    expect(result.current.fitTo).toBeNull();
    expect(result.current.home).toBeNull();
  });
});

describe("useViewMap period fit", () => {
  test("useViewMap_fits_to_every_route_and_dot_of_the_period_when_its_data_first_arrives", async () => {
    stubApi({ "2026-10-01..2026-10-31": OCTOBER });

    const { result } = setup(MONTH);

    expect(result.current.fitTo).toBeNull(); // nothing to fit to before the month is there
    await waitFor(() => expect(result.current.fitTo).not.toBeNull());
    expect(result.current.fitTo).toEqual(periodFeaturesOf(OCTOBER));
    expect(result.current.fitTo).toHaveLength(15);
  });

  test("useViewMap_does_not_fit_again_when_the_same_period_is_refetched_or_polled", async () => {
    // A period that includes today is polled every 30 s while it is pending, and the map must not be pulled back from where the owner has put it.
    const { answers } = stubApi({ "2026-10-19..2026-10-25": { ...WEEK_19_RANGE, state: "pending" } });
    const { result, refetchRange } = setup(WEEK_19);
    await waitFor(() => expect(result.current.fitTo).not.toBeNull());
    const fit = result.current.fitTo;
    const drawn = result.current.data;

    answers["2026-10-19..2026-10-25"] = { ...WEEK_19_RANGE, state: "done", moves: WEEK_19_RANGE.moves.slice(0, 1) }; // the poll finds it changed
    await refetchRange("2026-10-19", "2026-10-25");

    await waitFor(() => expect(result.current.data.routes.features).toHaveLength(1)); // the map is given the new period...
    expect(result.current.data.routes).not.toBe(drawn.routes);
    expect(result.current.fitTo).toBe(fit); // ...and is not asked to move
    await refetchRange("2026-10-19", "2026-10-25");
    expect(result.current.fitTo).toBe(fit);
  });

  test("useViewMap_fits_each_period_once_when_it_is_shown_and_again_when_it_is_shown_again", async () => {
    stubApi({ "2026-10-19..2026-10-25": WEEK_19_RANGE, "2026-10-26..2026-11-01": WEEK_26_RANGE });
    const { result, go } = setup(WEEK_19);
    await waitFor(() => expect(result.current.fitTo).not.toBeNull());
    const first = result.current.fitTo;

    go(WEEK_26);
    await waitFor(() => expect(result.current.fitTo).toEqual(periodFeaturesOf(WEEK_26_RANGE)));
    const second = result.current.fitTo;
    expect(second).not.toBe(first);

    go(WEEK_19); // back to a period that was looked at before: the map comes back to it
    await waitFor(() => expect(result.current.fitTo).toEqual(periodFeaturesOf(WEEK_19_RANGE)));
    expect(result.current.fitTo).not.toBe(first);
    expect(result.current.fitTo).not.toBe(second);
  });

  test("useViewMap_fits_a_period_that_is_in_the_cache_in_the_render_that_shows_it", async () => {
    stubApi({ "2026-10-19..2026-10-25": WEEK_19_RANGE, "2026-10-26..2026-11-01": WEEK_26_RANGE });
    const { result, go, client } = setup(WEEK_19);
    await waitFor(() => expect(result.current.fitTo).not.toBeNull());
    await client.prefetchQuery({ queryKey: ["range", "2026-10-26", "2026-11-01"], queryFn: async () => WEEK_26_RANGE });

    go(WEEK_26); // stepping › onto a week that was prefetched

    expect(result.current.fitTo).toEqual(periodFeaturesOf(WEEK_26_RANGE)); // no wait for it
  });

  test("useViewMap_does_not_fit_the_previous_period_for_the_dates_that_are_loading", async () => {
    let release: (response: Response) => void = () => undefined;
    stubApi({ "2026-10-19..2026-10-25": WEEK_19_RANGE, "2026-10-26..2026-11-01": () => new Promise<Response>((resolve) => (release = resolve)) });
    const { result, go } = setup(WEEK_19);
    await waitFor(() => expect(result.current.fitTo).not.toBeNull());

    go(WEEK_26); // the week of the 19th is still what is drawn, and it is not what is being looked at

    expect(result.current.fitTo).toBeNull();
    release(Response.json(WEEK_26_RANGE));
    await waitFor(() => expect(result.current.fitTo).toEqual(periodFeaturesOf(WEEK_26_RANGE)));
  });

  test("useViewMap_fits_a_period_that_starts_empty_when_it_first_has_something_and_only_then", async () => {
    // The week that includes today before its points are processed: nothing to fit to, so nothing is spent of the one fit it gets.
    const { answers } = stubApi({ "2026-10-19..2026-10-25": { ...OCTOBER, from: "2026-10-19", to: "2026-10-25", state: "pending", moves: [], places: [], days: [] } });
    const { result, refetchRange } = setup(WEEK_19);
    await waitFor(() => expect(result.current.data.places).toBeDefined());
    expect(result.current.fitTo).toBeNull();

    answers["2026-10-19..2026-10-25"] = { ...WEEK_19_RANGE, state: "pending" };
    await refetchRange("2026-10-19", "2026-10-25");
    await waitFor(() => expect(result.current.fitTo).toEqual(periodFeaturesOf(WEEK_19_RANGE)));
    const fit = result.current.fitTo;

    answers["2026-10-19..2026-10-25"] = { ...WEEK_19_RANGE, state: "done", moves: WEEK_19_RANGE.moves.slice(0, 1) };
    await refetchRange("2026-10-19", "2026-10-25");
    await waitFor(() => expect(result.current.data.routes.features).toHaveLength(1));
    expect(result.current.fitTo).toBe(fit); // once
  });

  test("useViewMap_fits_the_period_again_when_the_view_comes_back_to_it_from_a_day", async () => {
    stubApi({ "2026-10-19..2026-10-25": WEEK_19_RANGE, "2026-10-22": OSLO_DAY });
    const { result, go } = setup(WEEK_19);
    await waitFor(() => expect(result.current.fitTo).not.toBeNull());
    const first = result.current.fitTo;

    go(DAY_22);
    go(WEEK_19);

    await waitFor(() => expect(result.current.fitTo).not.toBeNull());
    expect(result.current.fitTo).toEqual(first);
    expect(result.current.fitTo).not.toBe(first);
  });
});

// --- Places ---

const featuresOfPlace = (place: PlaceResponse) => placeGeoJson(place).stops.features;

describe("useViewMap places", () => {
  test("useViewMap_brings_the_map_to_the_pin_of_a_place_once_and_has_the_pin_as_home", async () => {
    stubApi({ [placeKey(2)]: CAFE });

    const { result } = setup(PLACE_2);

    expect(result.current.fitTo).toBeNull(); // nothing to bring the map to before the place is there
    expect(result.current.home).toBeNull();
    await waitFor(() => expect(result.current.fitTo).not.toBeNull());
    expect(result.current.fitTo).toEqual(featuresOfPlace(CAFE));
    expect(result.current.home).toEqual(featuresOfPlace(CAFE)); // what Recenter brings back
    expect(result.current.heat.available).toBe(false); // there is no period to show the heat of
  });

  test("useViewMap_does_not_fit_a_place_again_when_it_is_refetched", async () => {
    const { answers } = stubApi({ [placeKey(2)]: CAFE });
    const { result, refetchPlace } = setup(PLACE_2);
    await waitFor(() => expect(result.current.fitTo).not.toBeNull());
    const fit = result.current.fitTo;
    const drawn = result.current.data;

    answers[placeKey(2)] = { ...CAFE, name: "Coffee corner" }; // the place was renamed since: what is drawn is new
    await refetchPlace(2);

    await waitFor(() => expect(result.current.data.stops?.features[0]?.properties.name).toBe("Coffee corner"));
    expect(result.current.data.stops).not.toBe(drawn.stops);
    expect(result.current.fitTo).toBe(fit); // and the map, which the owner may have moved, is not asked to move
  });

  test("useViewMap_fits_a_place_each_time_it_is_shown_and_has_it_in_the_render_that_shows_it_when_it_is_in_the_cache", async () => {
    stubApi({ [placeKey(2)]: CAFE, "2026-10-22": OSLO_DAY });
    const { result, go } = setup(PLACE_2);
    await waitFor(() => expect(result.current.fitTo).not.toBeNull());
    const first = result.current.fitTo;
    go(DAY_22);
    await waitFor(() => expect(result.current.data.stops?.features).toHaveLength(5));

    go(PLACE_2); // back to a place that was looked at before: the cache has it, and the map comes back to it at once

    expect(result.current.data).toEqual(placeGeoJson(CAFE));
    expect(result.current.fitTo).toEqual(first);
    expect(result.current.fitTo).not.toBe(first);
  });

  test("useViewMap_draws_nothing_for_a_place_that_no_longer_exists", async () => {
    stubApi({}); // a 404 for everything
    const { result, client } = setup(PLACE_2);

    await waitFor(() => expect(client.getQueryState(["place", 2])?.status).toBe("error"));

    expect(result.current.data.routes.features).toEqual([]);
    expect(result.current.data.stops).toBeUndefined();
    expect(result.current.fitTo).toBeNull();
    expect(result.current.home).toBeNull();
  });

  test("useViewMap_stops_drawing_a_place_that_turns_out_to_be_gone_when_it_is_asked_for_again", async () => {
    // A 404 is not a failure to try again: the place is not there, and the panel says so in place of what it had. The map is the same.
    const { answers } = stubApi({ [placeKey(2)]: CAFE });
    const { result, refetchPlace } = setup(PLACE_2);
    await waitFor(() => expect(result.current.fitTo).not.toBeNull());
    const fit = result.current.fitTo;

    answers[placeKey(2)] = new Response("{}", { status: 404 });
    await refetchPlace(2);

    await waitFor(() => expect(result.current.data.stops).toBeUndefined());
    expect(result.current.home).toBeNull(); // nothing to go back to
    expect(result.current.fitTo).toBe(fit); // and the map is not moved by it
  });

  test("useViewMap_keeps_the_pin_when_a_refetch_of_the_place_fails_for_another_reason", async () => {
    const { answers } = stubApi({ [placeKey(2)]: CAFE });
    const { result, refetchPlace } = setup(PLACE_2);
    await waitFor(() => expect(result.current.fitTo).not.toBeNull());
    const drawn = result.current.data;
    const fit = result.current.fitTo;

    answers[placeKey(2)] = new Response("{}", { status: 500 });
    await refetchPlace(2);

    expect(result.current.data.stops).toBe(drawn.stops); // as the panel keeps what it showed, under its error and Retry
    expect(result.current.fitTo).toBe(fit);
  });

  test("useViewMap_does_not_draw_the_place_that_was_left_while_a_day_loads", async () => {
    // The panel of a day that is shown after a place starts afresh, and says "Loading…": the map must say the same.
    stubApi({ [placeKey(2)]: CAFE, "2026-10-22": () => new Promise<Response>(() => undefined) });
    const { result, go } = setup(PLACE_2);
    await waitFor(() => expect(result.current.fitTo).not.toBeNull());

    go(DAY_22);

    expect(result.current.data.routes.features).toEqual([]);
    expect(result.current.data.stops).toBeUndefined(); // not the pin of the place under the day that loads
    expect(result.current.fitTo).toBeNull();
    expect(result.current.home).toBeNull();
  });

  test("useViewMap_does_not_draw_the_day_that_was_left_while_a_place_loads", async () => {
    stubApi({ "2026-10-22": OSLO_DAY, [placeKey(2)]: () => new Promise<Response>(() => undefined) });
    const { result, go } = setup(DAY_22);
    await waitFor(() => expect(result.current.fitTo).not.toBeNull());

    go(PLACE_2);

    expect(result.current.data.routes.features).toEqual([]); // not the day's routes and pins
    expect(result.current.data.stops).toBeUndefined();
    expect(result.current.fitTo).toBeNull();
    expect(result.current.home).toBeNull();
  });
});

// --- Heat ---

/** The heat of a day or a period: cells at places of the fixtures, and a first cell that is told apart by its weight. */
const heatOf = (seconds: number): HeatResponse => ({ maxSeconds: seconds, cells: [[10.7, 59.9, seconds], [10.71, 59.91, seconds / 2]] });
const HEAT_22 = heatOf(7200);
const HEAT_23 = heatOf(3600);
const HEAT_WEEK_19 = heatOf(36_000);
const HEAT_LISBON_TRIP = heatOf(50_000);
const HEAT_WEEK_26 = heatOf(18_000);

const heatPaths = (paths: string[]): string[] => paths.filter((path) => path.startsWith("/api/heat"));

const tripsFeaturesOf = (list: TripsResponse) => tripsGeoJson(list).places.features;

// The trips draw a dot for each city they slept in, from the list that the panel asks for as well; they have no period to ask a range or a
// heat for (`periodRange` would be handed a route it has no dates for).
describe("useViewMap trips", () => {
  test("useViewMap_draws_the_cities_of_the_trips_as_dots_and_asks_for_the_list_and_nothing_else", async () => {
    const { paths } = stubApi({ trips: TRIPS_LIST });

    const { result } = setup(TRIPS, true); // the heat is on, and there is no period to show it for

    expect(result.current.data.routes.features).toEqual([]); // nothing yet: the map is waiting for the list
    expect(result.current.data.places).toBeUndefined();
    await waitFor(() => expect(result.current.data.places).toBeDefined());
    expect(result.current.data).toEqual({ ...tripsGeoJson(TRIPS_LIST), view: "trips" }); // the trips' own layers: no routes
    expect(result.current.data.places?.features).toHaveLength(4); // New York, Lisbon, Sintra, Copenhagen
    expect(result.current.data.stops).toBeUndefined();
    expect(result.current.data.heat).toBeUndefined();
    expect(result.current.heat).toMatchObject({ available: false, failed: false }); // no button for the heat of a period that is not there
    expect(paths).toEqual(["/api/trips"]); // no day, no range, no heat
  });

  test("useViewMap_keeps_the_collections_it_gave_while_the_list_of_trips_is_the_same", async () => {
    stubApi({ trips: TRIPS_LIST });
    const { result, again } = setup(TRIPS);
    await waitFor(() => expect(result.current.data.places).toBeDefined());
    const before = result.current.data;

    again(); // rendered again for another reason: the map is not sent the same data again

    expect(result.current.data).toBe(before);
  });

  test("useViewMap_gives_every_dot_of_the_trips_as_home_and_a_tapped_row_does_not_change_it", async () => {
    stubApi({ trips: TRIPS_LIST });
    const { result } = setup(TRIPS);
    await waitFor(() => expect(result.current.home).not.toBeNull());

    expect(result.current.home).toEqual(tripsFeaturesOf(TRIPS_LIST));
    const [first] = tripsFeaturesOf(TRIPS_LIST);
    act(() => result.current.onFocus([first!]));

    expect(result.current.fitTo).toEqual([first]);
    expect(result.current.home).toEqual(tripsFeaturesOf(TRIPS_LIST)); // Recenter still goes back to all of them
  });

  test("useViewMap_has_no_home_and_nothing_to_fit_for_trips_that_have_no_city", async () => {
    stubApi({ trips: { trips: [] } });
    const { result, client } = setup(TRIPS);
    await waitFor(() => expect(client.getQueryState(["trips"])?.status).toBe("success"));
    await act(async () => undefined);

    expect(result.current.data.routes.features).toEqual([]);
    expect(result.current.data.places?.features).toEqual([]);
    expect(result.current.fitTo).toBeNull();
    expect(result.current.home).toBeNull();
  });

  test("useViewMap_fits_the_trips_map_once", async () => {
    const { answers } = stubApi({ trips: TRIPS_LIST, "2026-10-22": OSLO_DAY });
    const { result, go, refetchTrips } = setup(TRIPS);
    expect(result.current.fitTo).toBeNull(); // nothing to fit to until the list is there
    await waitFor(() => expect(result.current.fitTo).toEqual(tripsFeaturesOf(TRIPS_LIST))); // all the dots
    const fitted = result.current.fitTo;

    // A refetch of the list that brings other dots (a trip is gone) never moves a map that the owner has panned.
    answers["trips"] = { trips: [TRIPS_LIST.trips[1]!] };
    await refetchTrips();
    expect(result.current.data.places?.features).toHaveLength(2); // Lisbon and Sintra: the dots are the new list's...
    expect(result.current.fitTo).toBe(fitted); // ...and the map is where it was

    // Another view and back is another visit: fitted again, in the render that shows the list when it is in the cache.
    go(DAY_22);
    await waitFor(() => expect(result.current.fitTo).toEqual(featuresOf(OSLO_DAY)));
    go(TRIPS);
    expect(result.current.fitTo).toEqual(tripsFeaturesOf({ trips: [TRIPS_LIST.trips[1]!] })); // the list that the cache has by now
    expect(result.current.fitTo).not.toBe(fitted);
  });

  test("useViewMap_fits_the_trips_when_they_first_have_a_city_and_only_then", async () => {
    const { answers } = stubApi({ trips: { trips: [] } });
    const { result, client, refetchTrips } = setup(TRIPS);
    await waitFor(() => expect(client.getQueryState(["trips"])?.status).toBe("success"));
    await act(async () => undefined);
    expect(result.current.fitTo).toBeNull();

    answers["trips"] = TRIPS_LIST;
    await refetchTrips();

    expect(result.current.fitTo).toEqual(tripsFeaturesOf(TRIPS_LIST));
  });

  test("useViewMap_keeps_drawing_the_trips_under_an_error_and_does_not_fit_them_again", async () => {
    const { answers } = stubApi({ trips: TRIPS_LIST });
    const { result, client, refetchTrips } = setup(TRIPS);
    await waitFor(() => expect(result.current.fitTo).not.toBeNull());
    const fitted = result.current.fitTo;
    const drawn = result.current.data;

    answers["trips"] = new Response("{}", { status: 500 });
    await refetchTrips();

    expect(client.getQueryState(["trips"])?.status).toBe("error"); // the panel shows its list under the error, and so does the map
    expect(result.current.data).toBe(drawn);
    expect(result.current.fitTo).toBe(fitted);
  });

  test("useViewMap_draws_none_of_the_trips_on_a_day_that_loads_or_on_a_trip_that_loads_and_all_of_them_from_the_cache_on_return", async () => {
    stubApi({ trips: TRIPS_LIST, "2026-10-22": OSLO_DAY, "2026-10-23": () => new Promise<Response>(() => undefined), [tripKey("2026-09-12")]: () => new Promise<Response>(() => undefined) }); // the 23rd and the trip never come
    const { result, go } = setup(TRIPS);
    await waitFor(() => expect(result.current.fitTo).not.toBeNull());

    go(DAY_23); // a day that is loading is no place for the cities of the trips, which the panel of the day does not show either
    expect(result.current.data.routes.features).toEqual([]);
    expect(result.current.data.places).toBeUndefined();
    expect(result.current.data.view).toBeUndefined();
    expect(result.current.fitTo).toBeNull();
    expect(result.current.home).toBeNull();

    go(TRIP); // nor is a trip that is loading (the cities of the trips are for the list; a trip draws its own)
    expect(result.current.data.places).toBeUndefined();
    expect(result.current.fitTo).toBeNull();

    go(TRIPS); // the list is in the cache: its dots at once, and the map is brought to them
    expect(result.current.data.places?.features).toHaveLength(4);
    expect(result.current.fitTo).toEqual(tripsFeaturesOf(TRIPS_LIST));
  });

  test("useViewMap_does_not_draw_the_day_or_the_period_that_was_left_for_the_trips_while_the_list_loads", async () => {
    let release: (response: Response) => void = () => undefined;
    stubApi({
      "2026-10-22": OSLO_DAY,
      "2026-10-19..2026-10-25": WEEK_19_RANGE,
      trips: () => new Promise<Response>((resolve) => (release = resolve)),
    });
    const { result, go } = setup(DAY_22);
    await waitFor(() => expect(result.current.fitTo).not.toBeNull());

    go(TRIPS);
    expect(result.current.data.routes.features).toEqual([]); // the panel says "Loading…", and so does the map
    expect(result.current.data.stops).toBeUndefined();
    expect(result.current.fitTo).toBeNull();
    expect(result.current.home).toBeNull();

    go(WEEK_19);
    await waitFor(() => expect(result.current.fitTo).not.toBeNull());
    go(TRIPS);
    expect(result.current.data.places).toBeUndefined();
    expect(result.current.fitTo).toBeNull();

    release(Response.json(TRIPS_LIST));
    await waitFor(() => expect(result.current.fitTo).toEqual(tripsFeaturesOf(TRIPS_LIST)));
    go(DAY_22); // and the day is on show again, with nothing of what was drawn in between: fitted afresh
    await waitFor(() => expect(result.current.fitTo).toEqual(featuresOf(OSLO_DAY)));
    expect(result.current.data.places).toBeUndefined();
  });
});

const tripFeaturesOf = (trip: TripResponse) => {
  const { routes, places } = tripGeoJson(trip);
  return [...routes.features, ...places.features];
};

/** The trip of 1 August, which the list has and the fixture's trip is not: Copenhagen, one night, no moves. */
const COPENHAGEN: TripResponse = {
  ...LISBON,
  id: "2026-08-01",
  name: "Copenhagen",
  localStartDate: "2026-08-01",
  localEndDate: "2026-08-03",
  cities: [{ name: "Copenhagen", country: "Denmark", nights: 2, lat: 55.68, lon: 12.57 }],
  moves: [{ id: 401, mode: "drive", distanceMeters: 9000, geometry: [[12.5, 55.6], [12.57, 55.68]] }],
  days: [],
};

// A trip is drawn as the day is (bold routes) with the dots of its cities, from the query that its panel and its bar ask as well (one request).
describe("useViewMap a trip", () => {
  test("useViewMap_draws_a_trip_as_bold_routes_and_the_dots_of_its_cities_and_asks_for_that_trip_only", async () => {
    const { paths } = stubApi({ [tripKey("2026-09-12")]: LISBON });

    const { result } = setup(TRIP);

    expect(result.current.data.routes.features).toEqual([]); // nothing yet: the map is waiting for the trip
    expect(result.current.data.places).toBeUndefined();
    await waitFor(() => expect(result.current.data.places).toBeDefined());
    expect(result.current.data).toEqual({ ...tripGeoJson(LISBON), view: "trip" });
    expect(result.current.data.routes.features).toHaveLength(9);
    expect(result.current.data.places?.features).toHaveLength(2); // Lisbon and Sintra
    expect(result.current.data.stops).toBeUndefined();
    expect(paths).toEqual(["/api/trips/2026-09-12"]); // no list, no day, no range, no heat
  });

  test("useViewMap_brings_the_map_to_every_route_and_dot_of_the_trip_once_and_has_them_as_home", async () => {
    const { answers } = stubApi({ [tripKey("2026-09-12")]: LISBON, "2026-10-22": OSLO_DAY });
    const { result, go, client } = setup(TRIP);
    expect(result.current.fitTo).toBeNull(); // nothing to fit to until the trip is there
    expect(result.current.home).toBeNull();
    await waitFor(() => expect(result.current.fitTo).toEqual(tripFeaturesOf(LISBON)));
    const fitted = result.current.fitTo;
    expect(result.current.home).toEqual(tripFeaturesOf(LISBON));

    // A row tapped moves the map and never Recenter's target.
    act(() => result.current.onFocus([result.current.data.places!.features[1]!]));
    expect(result.current.fitTo).toHaveLength(1);
    expect(result.current.home).toEqual(tripFeaturesOf(LISBON));

    // A refetch of the same trip (it was edited: a move is gone) never moves a map that the owner has panned...
    act(() => result.current.onFocus(fitted!));
    const refetched = { ...LISBON, moves: LISBON.moves.slice(0, 3) };
    answers[tripKey("2026-09-12")] = refetched;
    await act(async () => {
      await client.refetchQueries({ queryKey: ["trip", "2026-09-12"] });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(result.current.data.routes.features).toHaveLength(3); // ...the routes are the new ones...
    expect(result.current.fitTo).toEqual(fitted); // ...and the map was not brought to them again

    // Another view and back is another visit: fitted again, in the render that shows the trip when it is in the cache.
    go(DAY_22);
    await waitFor(() => expect(result.current.fitTo).toEqual(featuresOf(OSLO_DAY)));
    go(TRIP);
    expect(result.current.fitTo).toEqual(tripFeaturesOf(refetched));
    expect(result.current.fitTo).not.toBe(fitted);
  });

  test("useViewMap_keeps_the_collections_it_gave_while_the_trip_is_the_same", async () => {
    stubApi({ [tripKey("2026-09-12")]: LISBON });
    const { result, again } = setup(TRIP);
    await waitFor(() => expect(result.current.data.places).toBeDefined());
    const before = result.current.data;

    again(); // rendered again for another reason: the map is not sent the same data again

    expect(result.current.data).toBe(before);
  });

  test("useViewMap_has_no_home_and_nothing_to_fit_for_a_trip_with_no_move_and_no_city", async () => {
    stubApi({ [tripKey("2026-09-12")]: { ...LISBON, moves: [], cities: [] } });
    const { result, client } = setup(TRIP);
    await waitFor(() => expect(client.getQueryState(["trip", "2026-09-12"])?.status).toBe("success"));
    await act(async () => undefined);

    expect(result.current.data.routes.features).toEqual([]);
    expect(result.current.data.places?.features).toEqual([]);
    expect(result.current.fitTo).toBeNull();
    expect(result.current.home).toBeNull();
  });

  test("useViewMap_draws_a_trip_and_never_a_stale_one", async () => {
    // Trip A is drawn; the list of trips is shown; trip B has not been asked for before and has not come: nothing is drawn of A, nor of the
    // trips, for B, as its panel has nothing of them. When B comes, B is drawn, and the map is brought to it and not to A.
    let release: (response: Response) => void = () => undefined;
    stubApi({
      [tripKey("2026-09-12")]: LISBON,
      [tripKey("2026-08-01")]: () => new Promise<Response>((resolve) => (release = resolve)),
      trips: TRIPS_LIST,
    });
    const { result, go } = setup(TRIP);
    await waitFor(() => expect(result.current.fitTo).toEqual(tripFeaturesOf(LISBON)));

    go(TRIPS);
    await waitFor(() => expect(result.current.data.view).toBe("trips"));
    go(OTHER_TRIP);

    expect(result.current.data.routes.features).toEqual([]);
    expect(result.current.data.places).toBeUndefined();
    expect(result.current.data.view).toBeUndefined();
    expect(result.current.fitTo).toBeNull();
    expect(result.current.home).toBeNull();

    release(Response.json(COPENHAGEN));
    await waitFor(() => expect(result.current.data.places).toBeDefined());
    expect(result.current.data).toEqual({ ...tripGeoJson(COPENHAGEN), view: "trip" });
    expect(result.current.fitTo).toEqual(tripFeaturesOf(COPENHAGEN));
    expect(result.current.home).toEqual(tripFeaturesOf(COPENHAGEN));
  });

  test("useViewMap_does_not_draw_the_trip_that_was_left_for_the_next_trip_that_loads", async () => {
    // Stepping from a trip to the next with ‹ and ›: the panel is made again for the trip (the bar says "Loading trip…" and the panel "Loading…"),
    // and the map draws nothing, where a day that loads leaves the day before on the map as its panel leaves the rows.
    stubApi({ [tripKey("2026-09-12")]: LISBON, [tripKey("2026-08-01")]: () => new Promise<Response>(() => undefined) });
    const { result, go } = setup(TRIP);
    await waitFor(() => expect(result.current.fitTo).not.toBeNull());

    go(OTHER_TRIP);

    expect(result.current.data.routes.features).toEqual([]);
    expect(result.current.data.places).toBeUndefined();
    expect(result.current.fitTo).toBeNull();
    expect(result.current.home).toBeNull();
  });

  test("useViewMap_draws_a_trip_that_is_in_the_cache_at_once_when_it_is_stepped_to_and_fits_it", async () => {
    stubApi({ [tripKey("2026-09-12")]: LISBON, [tripKey("2026-08-01")]: COPENHAGEN });
    const { result, go, client } = setup(TRIP);
    await waitFor(() => expect(result.current.fitTo).not.toBeNull());
    await client.prefetchQuery({ queryKey: ["trip", "2026-08-01"], queryFn: async () => COPENHAGEN });

    go(OTHER_TRIP);

    expect(result.current.data).toEqual({ ...tripGeoJson(COPENHAGEN), view: "trip" }); // in the render that shows it: no wait
    expect(result.current.fitTo).toEqual(tripFeaturesOf(COPENHAGEN));
  });

  test("useViewMap_draws_nothing_for_a_trip_that_no_longer_exists", async () => {
    const { paths } = stubApi({}); // a 404 for every trip

    const { result, client } = setup({ view: "trip", id: "2026-01-01" });
    await waitFor(() => expect(client.getQueryState(["trip", "2026-01-01"])?.status).toBe("error"));
    await act(async () => undefined);

    expect(result.current.data.routes.features).toEqual([]);
    expect(result.current.data.places).toBeUndefined();
    expect(result.current.fitTo).toBeNull();
    expect(result.current.home).toBeNull();
    expect(paths).toEqual(["/api/trips/2026-01-01"]);
  });

  test("useViewMap_stops_drawing_a_trip_that_turns_out_to_be_gone_when_it_is_asked_for_again", async () => {
    const { answers } = stubApi({ [tripKey("2026-09-12")]: LISBON });
    const { result, client } = setup(TRIP);
    await waitFor(() => expect(result.current.data.places).toBeDefined());

    answers[tripKey("2026-09-12")] = () => new Response("{}", { status: 404 }); // deleted since: the panel says so in place of what it showed
    await act(async () => {
      await client.refetchQueries({ queryKey: ["trip", "2026-09-12"] });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(result.current.data.routes.features).toEqual([]);
    expect(result.current.data.places).toBeUndefined();
    expect(result.current.home).toBeNull();
  });

  test("useViewMap_keeps_drawing_the_trip_under_an_error_of_a_refetch_and_does_not_fit_it_again", async () => {
    const { answers } = stubApi({ [tripKey("2026-09-12")]: LISBON });
    const { result, client } = setup(TRIP);
    await waitFor(() => expect(result.current.fitTo).not.toBeNull());
    const fitted = result.current.fitTo;
    const drawn = result.current.data;

    answers[tripKey("2026-09-12")] = new Response("{}", { status: 500 });
    await act(async () => {
      await client.refetchQueries({ queryKey: ["trip", "2026-09-12"] });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(client.getQueryState(["trip", "2026-09-12"])?.status).toBe("error"); // the panel shows the trip under the error, and so does the map
    expect(result.current.data).toBe(drawn);
    expect(result.current.fitTo).toBe(fitted);
  });

  test("useViewMap_does_not_draw_the_trip_that_was_left_on_a_day_that_loads", async () => {
    stubApi({ [tripKey("2026-09-12")]: LISBON, "2026-10-23": () => new Promise<Response>(() => undefined) });
    const { result, go } = setup(TRIP);
    await waitFor(() => expect(result.current.fitTo).not.toBeNull());

    go(DAY_23);

    expect(result.current.data.routes.features).toEqual([]);
    expect(result.current.data.places).toBeUndefined();
    expect(result.current.data.view).toBeUndefined();
    expect(result.current.fitTo).toBeNull();
    expect(result.current.home).toBeNull();
  });
});

// The heat of a trip is the heat of its dates, from the day it left to the day it came back, for the trip that is on screen: the glow of another
// trip (or of a day, or of the dates that the trip had before it was loaded) is never under its routes.
describe("useViewMap the heat of a trip", () => {
  const HEAT_COPENHAGEN = heatOf(9000);

  test("useViewMap_asks_for_the_heat_of_the_dates_of_the_trip_and_draws_it_with_the_routes_once_heat_is_on", async () => {
    const { paths } = stubApi({ [tripKey("2026-09-12")]: LISBON, [heatKey("2026-09-12", "2026-09-16")]: HEAT_LISBON_TRIP });

    const { result } = setup(TRIP, true);

    await waitFor(() => expect(result.current.data.heat).toBeDefined());
    expect(result.current.data.heat).toEqual(heatGeoJson(HEAT_LISBON_TRIP));
    expect(result.current.data.routes).toEqual(tripGeoJson(LISBON).routes); // in addition to the routes and the dots, not instead
    expect(result.current.data.places).toEqual(tripGeoJson(LISBON).places);
    expect(result.current.data.view).toBe("trip");
    expect(heatPaths(paths)).toEqual(["/api/heat?from=2026-09-12&to=2026-09-16"]); // localStartDate to localEndDate
    expect(result.current.heat).toMatchObject({ available: true, failed: false });
  });

  test("useViewMap_asks_for_no_heat_of_a_trip_while_heat_is_off_and_has_the_button_to_turn_it_on_before_the_trip_has_come", async () => {
    let release: (response: Response) => void = () => undefined;
    const { paths } = stubApi({
      [tripKey("2026-09-12")]: () => new Promise<Response>((resolve) => (release = resolve)),
      [heatKey("2026-09-12", "2026-09-16")]: HEAT_LISBON_TRIP,
    });
    const { result, setHeat } = setup(TRIP);
    expect(result.current.heat.available).toBe(true); // a trip is a view that has a heat, with its dates not yet known

    release(Response.json(LISBON));
    await waitFor(() => expect(result.current.fitTo).not.toBeNull());
    await act(async () => undefined);
    expect(heatPaths(paths)).toEqual([]);
    expect(result.current.data.heat).toBeUndefined();

    setHeat(true);
    await waitFor(() => expect(result.current.data.heat).toBeDefined());
    expect(heatPaths(paths)).toEqual(["/api/heat?from=2026-09-12&to=2026-09-16"]);
  });

  test("useViewMap_asks_for_no_heat_of_a_trip_that_is_loading_and_for_the_dates_of_the_trip_that_comes", async () => {
    // The dates are the trip's own, which are not known before it has come: nothing is asked for in their place.
    let release: (response: Response) => void = () => undefined;
    const { paths } = stubApi({
      [tripKey("2026-09-12")]: () => new Promise<Response>((resolve) => (release = resolve)),
      [heatKey("2026-09-12", "2026-09-16")]: HEAT_LISBON_TRIP,
    });
    const { result } = setup(TRIP, true); // heat is on from the start
    await act(async () => undefined);

    expect(heatPaths(paths)).toEqual([]);
    expect(result.current.data.heat).toBeUndefined();

    release(Response.json(LISBON));
    await waitFor(() => expect(result.current.data.heat).toEqual(heatGeoJson(HEAT_LISBON_TRIP)));
    expect(heatPaths(paths)).toEqual(["/api/heat?from=2026-09-12&to=2026-09-16"]);
  });

  test("useViewMap_asks_for_the_heat_of_an_ongoing_trip_up_to_the_day_after_its_last_night", async () => {
    const ongoing: TripResponse = { ...LISBON, ongoing: true, end: null, localEndDate: "2026-09-17" };
    const { paths } = stubApi({ [tripKey("2026-09-12")]: ongoing, [heatKey("2026-09-12", "2026-09-17")]: HEAT_LISBON_TRIP });

    const { result } = setup(TRIP, true);

    await waitFor(() => expect(result.current.data.heat).toBeDefined());
    expect(heatPaths(paths)).toEqual(["/api/heat?from=2026-09-12&to=2026-09-17"]);
  });

  test("useViewMap_asks_for_the_heat_of_the_first_400_days_of_a_trip_that_is_longer_which_the_API_answers_for", async () => {
    // A heat of more than 400 days is refused with a 400, and no Retry would ever bring it: the dates are cut as a range's are.
    const long: TripResponse = { ...LISBON, id: "2025-01-01", localStartDate: "2025-01-01", localEndDate: "2026-12-31" };
    const { paths } = stubApi({ [tripKey("2025-01-01")]: long, [heatKey("2025-01-01", "2026-02-04")]: HEAT_LISBON_TRIP });

    const { result } = setup({ view: "trip", id: "2025-01-01" }, true);

    await waitFor(() => expect(result.current.data.heat).toBeDefined());
    expect(heatPaths(paths)).toEqual(["/api/heat?from=2025-01-01&to=2026-02-04"]);
  });

  test("useViewMap_does_not_draw_the_heat_of_a_trip_under_the_routes_of_another", async () => {
    // Trip A with its heat; then trip B, whose heat is there before it is (a prefetch, or a quick answer), and then both: A's glow is never under
    // B's routes, and B's is under them only once they are drawn.
    let releaseTrip: (response: Response) => void = () => undefined;
    stubApi({
      [tripKey("2026-09-12")]: LISBON,
      [tripKey("2026-08-01")]: () => new Promise<Response>((resolve) => (releaseTrip = resolve)),
      [heatKey("2026-09-12", "2026-09-16")]: HEAT_LISBON_TRIP,
      [heatKey("2026-08-01", "2026-08-03")]: HEAT_COPENHAGEN,
    });
    const { result, go, client } = setup(TRIP, true);
    await waitFor(() => expect(result.current.data.heat).toEqual(heatGeoJson(HEAT_LISBON_TRIP)));
    await client.prefetchQuery({ queryKey: ["heat", "2026-08-01", "2026-08-03"], queryFn: async () => HEAT_COPENHAGEN });

    go(OTHER_TRIP);

    expect(result.current.data.routes.features).toEqual([]); // nothing of A...
    expect(result.current.data.heat).toBeUndefined(); // ...no glow of A, and not B's either, for routes that are not there
    releaseTrip(Response.json(COPENHAGEN));
    await waitFor(() => expect(result.current.data.routes).toEqual(tripGeoJson(COPENHAGEN).routes));
    expect(result.current.data.heat).toEqual(heatGeoJson(HEAT_COPENHAGEN)); // B's routes and B's heat
  });

  test("useViewMap_does_not_draw_the_heat_of_a_trip_that_was_left_under_the_trips_a_day_or_a_gone_trip", async () => {
    const { answers } = stubApi({
      [tripKey("2026-09-12")]: LISBON,
      trips: TRIPS_LIST,
      "2026-10-22": OSLO_DAY,
      [heatKey("2026-09-12", "2026-09-16")]: HEAT_LISBON_TRIP,
      [heatKey("2026-10-22")]: HEAT_22,
    });
    const { result, go, client } = setup(TRIP, true);
    await waitFor(() => expect(result.current.data.heat).toBeDefined());

    go(TRIPS);
    await waitFor(() => expect(result.current.data.places).toBeDefined());
    expect(result.current.data.heat).toBeUndefined(); // the list of trips has no period: no heat, and no button for it
    expect(result.current.heat.available).toBe(false);

    go(DAY_22);
    await waitFor(() => expect(result.current.data.heat).toEqual(heatGeoJson(HEAT_22))); // the day's heat, which is the day's and nobody else's
    expect(result.current.data.routes).toEqual(dayGeoJson(OSLO_DAY).routes);

    go(TRIP);
    expect(result.current.data.heat).toEqual(heatGeoJson(HEAT_LISBON_TRIP)); // the trip's, from the cache, at once

    answers[tripKey("2026-09-12")] = () => new Response("{}", { status: 404 }); // and then it is gone: nothing is drawn, glow included
    await act(async () => {
      await client.refetchQueries({ queryKey: ["trip", "2026-09-12"] });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(result.current.data.routes.features).toEqual([]);
    expect(result.current.data.heat).toBeUndefined();
    expect(result.current.heat.available).toBe(false); // nor the button
  });

  test("useViewMap_reports_a_heat_of_a_trip_that_could_not_be_had_and_asks_again_on_retry", async () => {
    let failing = true;
    const { paths } = stubApi({
      [tripKey("2026-09-12")]: LISBON,
      [heatKey("2026-09-12", "2026-09-16")]: () => (failing ? new Response("{}", { status: 500 }) : Response.json(HEAT_LISBON_TRIP)),
    });
    const { result } = setup(TRIP, true);

    await waitFor(() => expect(result.current.heat.failed).toBe(true));
    expect(result.current.data.routes).toEqual(tripGeoJson(LISBON).routes); // the trip is drawn without it, routes and all
    expect(result.current.data.heat).toBeUndefined();

    failing = false;
    act(() => result.current.heat.retry());

    await waitFor(() => expect(result.current.data.heat).toEqual(heatGeoJson(HEAT_LISBON_TRIP)));
    expect(result.current.heat.failed).toBe(false);
    expect(heatPaths(paths)).toHaveLength(2);
  });

  test("useViewMap_has_no_heat_for_a_trip_that_is_gone_and_asks_for_none", async () => {
    const { paths } = stubApi({});

    const { result, client } = setup({ view: "trip", id: "2026-01-01" }, true);
    await waitFor(() => expect(client.getQueryState(["trip", "2026-01-01"])?.status).toBe("error"));
    await act(async () => undefined);

    expect(heatPaths(paths)).toEqual([]);
    expect(result.current.data.heat).toBeUndefined();
    expect(result.current.heat.failed).toBe(false);
    expect(result.current.heat.available).toBe(false); // and no button for a heat that there is nothing to show of
  });

  test("useViewMap_has_the_heat_button_for_a_trip_while_it_loads_and_takes_it_away_when_the_trip_turns_out_to_be_gone", async () => {
    // P3-R22: the button is there as soon as the trip is asked for, so that it does not come in late, and goes if the answer is a 404.
    let release: (response: Response) => void = () => undefined;
    stubApi({ [tripKey("2026-01-01")]: () => new Promise<Response>((resolve) => (release = resolve)) });
    const { result } = setup({ view: "trip", id: "2026-01-01" }, true);
    expect(result.current.heat.available).toBe(true);

    release(new Response("{}", { status: 404 }));

    await waitFor(() => expect(result.current.heat.available).toBe(false));
  });

  test("useViewMap_has_the_heat_button_again_when_a_trip_that_is_gone_is_stepped_away_from_to_one_that_is_there", async () => {
    stubApi({ [tripKey("2026-09-12")]: LISBON });
    const { result, go } = setup({ view: "trip", id: "2026-01-01" });
    await waitFor(() => expect(result.current.heat.available).toBe(false));

    go(TRIP);

    await waitFor(() => expect(result.current.heat.available).toBe(true));
  });
});

describe("useViewMap heat", () => {
  test("useViewMap_asks_for_no_heat_and_draws_none_while_heat_is_off", async () => {
    for (const [route, answers] of [
      [DAY_22, { "2026-10-22": OSLO_DAY, [heatKey("2026-10-22")]: HEAT_22 }],
      [MONTH, { "2026-10-01..2026-10-31": OCTOBER, [heatKey("2026-10-01", "2026-10-31")]: HEAT_22 }],
    ] as const) {
      const { paths } = stubApi({ ...answers });

      const { result, unmount } = setup(route);
      await waitFor(() => expect(result.current.fitTo).not.toBeNull());
      await act(async () => undefined);

      expect(heatPaths(paths)).toEqual([]);
      expect(result.current.data.heat).toBeUndefined();
      expect(result.current.heat).toMatchObject({ available: true, failed: false }); // the button is there to turn it on
      unmount();
    }
  });

  test("useViewMap_draws_the_heat_of_the_day_with_its_routes_once_heat_is_on", async () => {
    const { paths } = stubApi({ "2026-10-22": OSLO_DAY, [heatKey("2026-10-22")]: HEAT_22 });

    const { result } = setup(DAY_22, true);

    await waitFor(() => expect(result.current.data.heat).toBeDefined());
    expect(result.current.data.heat).toEqual(heatGeoJson(HEAT_22));
    expect(result.current.data.routes).toEqual(dayGeoJson(OSLO_DAY).routes); // in addition to the routes and the pins, not instead
    expect(result.current.data.stops).toEqual(dayGeoJson(OSLO_DAY).stops);
    expect(heatPaths(paths)).toEqual(["/api/heat?from=2026-10-22&to=2026-10-22"]); // a day is a period of its one date
  });

  test("useViewMap_asks_for_the_heat_of_the_dates_of_each_period_of_a_view_that_has_one", async () => {
    const asks: [Route, string, string, string][] = [
      [WEEK_19, "2026-10-19", "2026-10-25", "/api/heat?from=2026-10-19&to=2026-10-25"],
      [MONTH, "2026-10-01", "2026-10-31", "/api/heat?from=2026-10-01&to=2026-10-31"],
      [{ view: "year", year: 2026 }, "2026-01-01", "2026-12-31", "/api/heat?from=2026-01-01&to=2026-12-31"],
      [{ view: "range", from: "2026-09-12", to: "2026-09-19" }, "2026-09-12", "2026-09-19", "/api/heat?from=2026-09-12&to=2026-09-19"],
    ];
    for (const [route, from, to, path] of asks) {
      const { paths } = stubApi({ [`${from}..${to}`]: { ...OCTOBER, from, to }, [heatKey(from, to)]: HEAT_WEEK_19 });

      const { result, unmount } = setup(route, true);
      await waitFor(() => expect(result.current.data.heat).toEqual(heatGeoJson(HEAT_WEEK_19)));

      expect(heatPaths(paths)).toEqual([path]);
      expect(result.current.data.places).toBeDefined(); // with the dots of the period
      unmount();
    }
  });

  test("useViewMap_has_no_heat_for_a_place_whatever_the_setting_and_asks_for_none", async () => {
    const { paths } = stubApi({ "2026-10-22": OSLO_DAY, [placeKey(2)]: CAFE });

    const { result } = setup(PLACE_2, true);
    await waitFor(() => expect(result.current.data.stops).toBeDefined());

    expect(result.current.heat).toMatchObject({ available: false, failed: false }); // no button: there is no period to show the heat of
    expect(result.current.data.heat).toBeUndefined();
    expect(paths).toEqual(["/api/places/2"]); // the place, and no heat
  });

  test("useViewMap_has_heat_for_the_day_again_when_the_view_comes_back_from_a_place", async () => {
    const { paths } = stubApi({ "2026-10-22": OSLO_DAY, [heatKey("2026-10-22")]: HEAT_22 });
    const { result, go } = setup(DAY_22, true);
    await waitFor(() => expect(result.current.data.heat).toBeDefined());

    go({ view: "place", id: 3 });
    expect(result.current.heat.available).toBe(false);
    expect(result.current.data.heat).toBeUndefined();

    go(DAY_22);
    expect(result.current.heat.available).toBe(true);
    expect(result.current.data.heat).toEqual(heatGeoJson(HEAT_22)); // from the cache, at once
    expect(heatPaths(paths)).toHaveLength(1);
  });

  test("useViewMap_asks_for_the_heat_when_it_is_turned_on_and_draws_none_when_it_is_turned_off", async () => {
    const { paths } = stubApi({ "2026-10-22": OSLO_DAY, [heatKey("2026-10-22")]: HEAT_22 });
    const { result, setHeat } = setup(DAY_22);
    await waitFor(() => expect(result.current.fitTo).not.toBeNull());
    expect(heatPaths(paths)).toEqual([]);

    setHeat(true);
    await waitFor(() => expect(result.current.data.heat).toBeDefined());
    expect(heatPaths(paths)).toHaveLength(1);

    setHeat(false);
    expect(result.current.data.heat).toBeUndefined();
    expect(result.current.heat.available).toBe(true); // the button stays, to turn it on again

    setHeat(true); // within the time an answer counts as fresh: from the cache, with no new request
    expect(result.current.data.heat).toEqual(heatGeoJson(HEAT_22));
    expect(heatPaths(paths)).toHaveLength(1);
  });

  test("useViewMap_keeps_the_collection_it_gave_for_the_heat_while_the_period_is_the_same", async () => {
    stubApi({ "2026-10-22": OSLO_DAY, [heatKey("2026-10-22")]: HEAT_22 });
    const { result, again } = setup(DAY_22, true);
    await waitFor(() => expect(result.current.data.heat).toBeDefined());
    const before = result.current.data;

    again(); // rendered again for another reason: the map is not sent the same data again

    expect(result.current.data.heat).toBe(before.heat);
    expect(result.current.data.routes).toBe(before.routes);
  });
});

// The heat is of the period of the routes that are drawn with it: the glow of one day is never under the routes of another, as
// the panel never has the rows of one period under the heading of another. While the period asked for loads, either of the two, the
// map shows its routes with no heat, or no routes.
describe("useViewMap heat and the routes shown", () => {
  test("useViewMap_does_not_draw_the_heat_of_the_next_day_under_the_routes_of_the_day_before", async () => {
    // The 23rd's heat is there before its routes are, and the 22nd's routes are what is still drawn.
    let release: (response: Response) => void = () => undefined;
    stubApi({
      "2026-10-22": OSLO_DAY,
      "2026-10-23": () => new Promise<Response>((resolve) => (release = resolve)),
      [heatKey("2026-10-22")]: HEAT_22,
      [heatKey("2026-10-23")]: HEAT_23,
    });
    const { result, go, client } = setup(DAY_22, true);
    await waitFor(() => expect(result.current.data.heat).toEqual(heatGeoJson(HEAT_22)));
    const drawn = result.current.data;

    go(DAY_23);
    await waitFor(() => expect(client.getQueryState(["heat", "2026-10-23", "2026-10-23"])?.status).toBe("success"));

    expect(result.current.data.routes).toBe(drawn.routes); // the routes of the 22nd stay...
    expect(result.current.data.heat).toBeUndefined(); // ...and neither the 22nd's heat nor the 23rd's is under them
    release(Response.json(NEW_YORK_DAY));
    await waitFor(() => expect(result.current.data.routes).toEqual(dayGeoJson(NEW_YORK_DAY).routes));
    expect(result.current.data.heat).toEqual(heatGeoJson(HEAT_23)); // the 23rd's routes and the 23rd's heat
  });

  test("useViewMap_draws_no_heat_when_a_trip_gives_way_to_a_day_until_the_day_is_drawn", async () => {
    // P2-R52 across the kinds of view: a trip's routes do not stay for a day (it is another kind of view), so nor does its glow, and the day's
    // heat, which is there before the day's routes are, is not drawn under no routes, or under the routes of the trip.
    let release: (response: Response) => void = () => undefined;
    stubApi({
      [tripKey("2026-09-12")]: LISBON,
      "2026-10-22": () => new Promise<Response>((resolve) => (release = resolve)),
      [heatKey("2026-09-12", "2026-09-16")]: HEAT_LISBON_TRIP,
      [heatKey("2026-10-22")]: HEAT_22,
    });
    const { result, go, client } = setup(TRIP, true);
    await waitFor(() => expect(result.current.data.heat).toEqual(heatGeoJson(HEAT_LISBON_TRIP)));

    go(DAY_22);
    await waitFor(() => expect(client.getQueryState(["heat", "2026-10-22", "2026-10-22"])?.status).toBe("success")); // the day's heat has come...

    expect(result.current.data.routes.features).toEqual([]); // ...and its routes have not, and none of the trip's are left
    expect(result.current.data.heat).toBeUndefined(); // so there is no glow of either
    release(Response.json(OSLO_DAY));
    await waitFor(() => expect(result.current.data.routes).toEqual(dayGeoJson(OSLO_DAY).routes));
    expect(result.current.data.heat).toEqual(heatGeoJson(HEAT_22)); // the day's routes and the day's heat, together
  });

  test("useViewMap_does_not_draw_the_heat_of_the_period_before_under_the_routes_of_the_next_while_its_heat_loads", async () => {
    // The week of the 26th has its routes (they were prefetched) and not its heat: the week of the 19th's heat is not a stand-in for it.
    let release: (response: Response) => void = () => undefined;
    stubApi({
      "2026-10-19..2026-10-25": WEEK_19_RANGE,
      "2026-10-26..2026-11-01": WEEK_26_RANGE,
      [heatKey("2026-10-19", "2026-10-25")]: HEAT_WEEK_19,
      [heatKey("2026-10-26", "2026-11-01")]: () => new Promise<Response>((resolve) => (release = resolve)),
    });
    const { result, go, client } = setup(WEEK_19, true);
    await waitFor(() => expect(result.current.data.heat).toEqual(heatGeoJson(HEAT_WEEK_19)));
    await client.prefetchQuery({ queryKey: ["range", "2026-10-26", "2026-11-01"], queryFn: async () => WEEK_26_RANGE });

    go(WEEK_26);

    expect(result.current.data.routes).toEqual(rangeGeoJson(WEEK_26_RANGE).routes); // the routes of the week asked for
    expect(result.current.data.heat).toBeUndefined(); // and no heat yet, not the other week's
    release(Response.json(HEAT_WEEK_26));
    await waitFor(() => expect(result.current.data.heat).toEqual(heatGeoJson(HEAT_WEEK_26)));
    expect(result.current.data.routes).toEqual(rangeGeoJson(WEEK_26_RANGE).routes);
  });

  test("useViewMap_does_not_draw_the_heat_of_a_day_that_was_left_under_the_routes_of_a_period", async () => {
    let release: (response: Response) => void = () => undefined;
    stubApi({
      "2026-10-22": OSLO_DAY,
      "2026-10-26..2026-11-01": () => new Promise<Response>((resolve) => (release = resolve)),
      [heatKey("2026-10-22")]: HEAT_22,
      [heatKey("2026-10-26", "2026-11-01")]: HEAT_WEEK_26,
    });
    const { result, go } = setup(DAY_22, true);
    await waitFor(() => expect(result.current.data.heat).toBeDefined());

    go(WEEK_26);

    expect(result.current.data.routes.features).toEqual([]); // nothing drawn of the day that was left, heat included
    expect(result.current.data.heat).toBeUndefined();
    release(Response.json(WEEK_26_RANGE));
    await waitFor(() => expect(result.current.data.heat).toEqual(heatGeoJson(HEAT_WEEK_26)));
  });
});

describe("useViewMap heat that cannot be had", () => {
  test("useViewMap_reports_a_heat_that_could_not_be_had_and_asks_again_on_retry", async () => {
    let failing = true;
    const { paths } = stubApi({
      "2026-10-22": OSLO_DAY,
      [heatKey("2026-10-22")]: () => (failing ? new Response("{}", { status: 500 }) : Response.json(HEAT_22)),
    });

    const { result } = setup(DAY_22, true);

    await waitFor(() => expect(result.current.heat.failed).toBe(true));
    expect(result.current.data.heat).toBeUndefined(); // no heat, so nothing is drawn that fades the routes
    expect(result.current.data.routes).toEqual(dayGeoJson(OSLO_DAY).routes); // and the routes are drawn all the same
    expect(heatPaths(paths)).toHaveLength(1);

    failing = false;
    act(() => result.current.heat.retry());

    await waitFor(() => expect(result.current.data.heat).toEqual(heatGeoJson(HEAT_22)));
    expect(result.current.heat.failed).toBe(false);
    expect(heatPaths(paths)).toHaveLength(2);
  });

  test("useViewMap_stays_quiet_and_keeps_the_glow_when_a_refetch_of_a_heat_it_has_fails", async () => {
    // A note that says the heat could not be had, over a glow that is on the map, would be wrong: the heat of the period is there.
    const { answers } = stubApi({ "2026-10-22": OSLO_DAY, [heatKey("2026-10-22")]: HEAT_22 });
    const { result, refetchHeat } = setup(DAY_22, true);
    await waitFor(() => expect(result.current.data.heat).toEqual(heatGeoJson(HEAT_22)));
    const drawn = result.current.data.heat;

    answers[heatKey("2026-10-22")] = new Response("{}", { status: 500 }); // the next time it is asked for, the server fails
    await refetchHeat("2026-10-22");

    expect(result.current.heat.failed).toBe(false); // no note...
    expect(result.current.data.heat).toBe(drawn); // ...and the glow stays, the very collection that was drawn
  });

  test("useViewMap_reports_a_heat_that_fails_again_once_there_is_none_to_draw_for_the_period", async () => {
    // The glow of the 22nd is not the 23rd's: for a period with no heat of its own the failure is still the note's to tell.
    const { answers } = stubApi({
      "2026-10-22": OSLO_DAY,
      "2026-10-23": NEW_YORK_DAY,
      [heatKey("2026-10-22")]: HEAT_22,
      [heatKey("2026-10-23")]: new Response("{}", { status: 500 }),
    });
    const { result, go, refetchHeat } = setup(DAY_22, true);
    await waitFor(() => expect(result.current.data.heat).toBeDefined());
    answers[heatKey("2026-10-22")] = new Response("{}", { status: 500 });
    await refetchHeat("2026-10-22");
    expect(result.current.heat.failed).toBe(false); // the 22nd keeps what it had

    go(DAY_23);

    await waitFor(() => expect(result.current.heat.failed).toBe(true));
    expect(result.current.data.heat).toBeUndefined();
  });

  test("useViewMap_reports_no_failure_of_a_heat_that_is_not_asked_for", async () => {
    stubApi({ "2026-10-22": OSLO_DAY, [heatKey("2026-10-22")]: new Response("{}", { status: 500 }) });
    const { result, setHeat, go } = setup(DAY_22, true);
    await waitFor(() => expect(result.current.heat.failed).toBe(true));

    setHeat(false); // the error of a heat that is turned off is nobody's to see
    expect(result.current.heat.failed).toBe(false);

    setHeat(true);
    go({ view: "place", id: 3 }); // and a place has none
    expect(result.current.heat.failed).toBe(false);
  });

  test("useViewMap_reports_the_failure_of_the_heat_asked_for_and_not_of_the_one_before_it", async () => {
    stubApi({
      "2026-10-22": OSLO_DAY,
      "2026-10-23": NEW_YORK_DAY,
      [heatKey("2026-10-22")]: new Response("{}", { status: 500 }),
      [heatKey("2026-10-23")]: HEAT_23,
    });
    const { result, go } = setup(DAY_22, true);
    await waitFor(() => expect(result.current.heat.failed).toBe(true));

    go(DAY_23);

    await waitFor(() => expect(result.current.data.heat).toEqual(heatGeoJson(HEAT_23)));
    expect(result.current.heat.failed).toBe(false);
  });
});
