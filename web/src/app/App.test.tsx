import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode, useImperativeHandle } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { MapPadding, MapViewProps } from "../map/MapView";
import type { DayResponse, HeatResponse, PlaceResponse, RangeResponse, StatusResponse, StaySegment, TripResponse, TripsResponse } from "../api/types";
import { dayGeoJson, placeGeoJson, placePoint, rangeGeoJson, tripGeoJson, tripsGeoJson } from "../map/layers";
import flightDay from "../../e2e/fixtures/day-oslo-new-york.json";
import cafe from "../../e2e/fixtures/place-cafe.json";
import october from "../../e2e/fixtures/range-october.json";
import lisbonTrip from "../../e2e/fixtures/trip-2026-09-12.json";
import tripsList from "../../e2e/fixtures/trips.json";
import { periodDays, periodLabel, today } from "../time/dates";
import { App } from "./App";
import { navigate } from "./router";

// The map is MapLibre, which jsdom cannot run (MapView.test.tsx has its own double of it). Here the map is a stand-in that
// keeps the props it was given: what the shell hands the map is what these tests are about.
const map = vi.hoisted(() => ({ props: null as unknown, retries: 0 }));
vi.mock("../map/MapView", () => ({
  MapView: (props: MapViewProps) => {
    map.props = props;
    useImperativeHandle(props.ref, () => ({ retry: () => void (map.retries += 1) }), []); // the handle the shell asks the map to try again by
    return <div role="region" aria-label="Map view" />;
  },
}));

const mapProps = () => map.props as MapViewProps;
const padding = () => mapProps().padding as MapPadding;

// `prefetchNeighbours` is the real one unless a test swaps it; the rest of the queries are always the real ones.
const queries = vi.hoisted(() => ({ prefetch: null as null | ((...args: never[]) => Promise<void>) }));
vi.mock("../api/queries", async (importOriginal) => {
  const original = await importOriginal<typeof import("../api/queries")>();
  return {
    ...original,
    prefetchNeighbours: (...args: Parameters<typeof original.prefetchNeighbours>) =>
      queries.prefetch === null ? original.prefetchNeighbours(...args) : (queries.prefetch as typeof original.prefetchNeighbours)(...args),
  };
});

const STATUS: StatusResponse = {
  algorithmVersion: "test",
  backfill: { from: null, to: null, cursor: null, percent: 100, paused: false },
  pendingRanges: 0,
  failedRanges: [],
  lastRunAt: null,
  lastError: null,
  places: { total: 0, unnamed: 0, failed: 0 },
  warnings: [],
};

function day(date: string, segments = 0): DayResponse {
  return {
    date,
    timeZone: "Europe/Oslo",
    state: "done",
    summary: { places: 0, distanceMeters: 0, movingSeconds: 0 },
    segments: Array.from({ length: segments }, (_, id) => ({
      id,
      kind: "gap" as const,
      start: `${date}T08:00:00Z`,
      end: `${date}T09:00:00Z`,
      startTimeZone: "Europe/Oslo",
      endTimeZone: "Europe/Oslo",
      from: null,
      to: null,
    })),
  };
}

/** A period with nothing in it, for the dates that a request of `/api/range` asks for. */
function emptyRange(path: string): RangeResponse {
  const query = new URLSearchParams(path.split("?")[1]);
  return {
    from: query.get("from")!,
    to: query.get("to")!,
    state: "done",
    summary: { places: 0, distanceMeters: 0, movingSeconds: 0, moves: 0 },
    moves: [],
    places: [],
    days: [],
  };
}

/** A place with nothing known of it and no visit, for the id that a request of `/api/places/{id}` asks for. */
function emptyPlace(path: string): PlaceResponse {
  return {
    id: Number(path.split("/").pop()),
    name: null,
    address: null,
    city: null,
    country: null,
    lat: 59,
    lon: 10,
    totalSeconds: 0,
    visits: 0,
    firstVisit: "2026-10-01T08:00:00Z",
    lastVisit: "2026-10-01T08:00:00Z",
    recentVisits: [],
    merged: [],
  };
}

type Answer = (path: string) => Response | Promise<Response>;

/** Answers a day with a day, a period with a period and a place with a place, none of them with anything in it; no trips, and no trip. */
const answerEmpty: Answer = (path) => {
  if (path.startsWith("/api/range")) return Response.json(emptyRange(path));
  if (path.startsWith("/api/places/")) return Response.json(emptyPlace(path));
  if (path === "/api/trips") return Response.json({ trips: [] } satisfies TripsResponse);
  if (path.startsWith("/api/trips/")) return new Response("{}", { status: 404 });
  return Response.json(day(path.split("/").pop()!));
};

/** Answers the API: the status always, everything else by `answer`; returns the paths asked for. */
function stubApi(answer: Answer = answerEmpty): string[] {
  const paths: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string) => {
      paths.push(path);
      return path === "/api/status" ? Response.json(STATUS) : answer(path);
    }),
  );
  return paths;
}

/** The bottom of the bar, as the browser would measure it, and the resize observer that would tell of it changing. */
function stubLayout(barBottom: number) {
  const observers: (() => void)[] = [];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        observers.push(callback);
      }
      observe() {}
      disconnect() {}
    },
  );
  let bottom = barBottom;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({ bottom }) as DOMRect);
  return {
    move(next: number) {
      bottom = next;
      act(() => observers.forEach((callback) => callback()));
    },
  };
}

function stubDesktop(matches: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: query === "(min-width: 900px)" && matches,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    })),
  );
}

/**
 * The app on a client of its own. `strict` is false for a test that counts the requests for one query: StrictMode mounts what it shows twice,
 * so that what was asked for is asked for again, and a count of them could not tell the panel and the map sharing one request from each asking.
 */
function renderApp(client = new QueryClient({ defaultOptions: { queries: { retry: false } } }), { strict = true } = {}) {
  const app = (
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>
  );
  return { client, ...render(strict ? <StrictMode>{app}</StrictMode> : app) };
}

beforeEach(() => {
  map.props = null;
  map.retries = 0;
  queries.prefetch = null;
  window.history.replaceState(null, "", "/day/2026-10-22");
  vi.stubGlobal("innerHeight", 800);
  stubDesktop(false);
});

afterEach(() => {
  queries.prefetch = null;
});

describe("App layout", () => {
  test("App_on_a_phone_has_a_bottom_sheet_and_pads_the_map_by_the_bar_and_the_sheet", () => {
    stubApi();
    stubLayout(120);

    renderApp();

    expect(screen.getByRole("region", { name: "Details" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Resize panel" })).toBeInTheDocument();
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    // The covered area and 16 px of air: the bar at the top, the sheet (at its peek of 96) at the bottom.
    expect(padding()).toEqual({ top: 136, right: 16, bottom: 112, left: 16 });
  });

  test("App_pads_the_map_by_the_sheet_as_it_moves_and_by_the_bar_as_it_grows", () => {
    stubApi();
    const layout = stubLayout(100);
    renderApp();

    fireEvent.click(screen.getByRole("button", { name: "Resize panel" })); // half of 800
    expect(padding()).toEqual({ top: 116, right: 16, bottom: 416, left: 16 });

    layout.move(160.4); // the range fields open, say: a taller bar, measured up to the next whole pixel
    expect(padding().top).toBe(177);
  });

  test("App_stops_padding_the_map_for_the_sheet_beyond_half_the_screen", () => {
    stubApi();
    stubLayout(100);
    renderApp();
    const sheet = screen.getByRole("region", { name: "Details" });
    const visible = () => parseFloat(sheet.style.height) - Number(/translateY\((-?[\d.]+)px\)/.exec(sheet.style.transform)![1]);

    fireEvent.click(screen.getByRole("button", { name: "Resize panel" })); // half
    const atHalf = padding();
    expect(atHalf.bottom).toBe(416);
    fireEvent.click(screen.getByRole("button", { name: "Resize panel" })); // full: a reading mode that covers the map

    expect(visible()).toBe(680);
    // The map keeps the padding of half: the top and the bottom together would leave no room to fit anything into, and the
    // credit and the buttons would sit under the bar.
    expect(padding()).toEqual(atHalf);
    expect(padding().top + padding().bottom).toBeLessThan(800);
  });

  test("App_follows_the_height_of_the_screen_for_what_half_of_it_is", () => {
    stubApi();
    stubLayout(100);
    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "Resize panel" }));
    fireEvent.click(screen.getByRole("button", { name: "Resize panel" })); // full

    vi.stubGlobal("innerHeight", 600); // a phone turned
    act(() => void window.dispatchEvent(new Event("resize")));

    expect(padding().bottom).toBe(300 + 16);
  });

  test("App_lets_the_sheet_come_up_only_as_far_as_the_bar_allows", () => {
    stubApi();
    const layout = stubLayout(120); // a bar whose bottom is at 120: the viewport less 120 would just fit under it
    renderApp();
    const sheet = screen.getByRole("region", { name: "Details" });

    expect(sheet.style.height).toBe(`${800 - 128}px`); // 120 and a few pixels of air to the bar: 128 is the room

    layout.move(60); // a small bar: the sheet keeps to the 120 px that it is specified to leave
    expect(sheet.style.height).toBe(`${800 - 120}px`);

    layout.move(200); // a tall one (the range fields), or one under a notch
    expect(sheet.style.height).toBe(`${800 - 208}px`);
  });

  test("App_keeps_the_padding_object_while_no_number_in_it_changes", () => {
    stubApi();
    stubLayout(120);
    renderApp();
    const before = padding();

    act(() => mapProps().onStyleError?.(new Error("no style"), false)); // the app renders again, for another reason
    act(() => mapProps().onStyleLoad?.());

    expect(padding()).toBe(before);

    fireEvent.click(screen.getByRole("button", { name: "Resize panel" })); // and now a number does change
    expect(padding()).not.toBe(before);
    expect(padding().bottom).toBe(416);
  });

  test("App_pads_the_map_by_what_the_device_keeps_at_the_sides_when_a_phone_is_on_its_side", () => {
    stubApi();
    stubLayout(100);
    let left = 0;
    let right = 0;
    // jsdom cannot evaluate env(): the probes that the shell measures the sides with are given their widths.
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.className.includes("probeLeft") ? left : this.className.includes("probeRight") ? right : 0;
    });
    left = 59; // the Dynamic Island at the left
    renderApp();

    expect(padding()).toEqual({ top: 116, right: 16, bottom: 112, left: 59 + 16 });

    left = 0;
    right = 59; // turned the other way
    act(() => void window.dispatchEvent(new Event("resize")));
    expect(padding()).toEqual({ top: 116, right: 59 + 16, bottom: 112, left: 16 });
  });

  test("App_does_not_pad_the_sidebar_side_by_the_inset_which_the_sidebar_has_inside_its_width", () => {
    stubDesktop(true);
    stubApi();
    stubLayout(110);
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.className.includes("probe") ? 59 : 0;
    });

    renderApp();

    expect(padding()).toEqual({ top: 126, right: 59 + 16, bottom: 16, left: 336 });
  });

  test("App_on_a_desktop_has_a_sidebar_of_320px_and_pads_the_map_by_it", () => {
    stubDesktop(true);
    stubApi();
    stubLayout(110);

    renderApp();

    expect(screen.getByRole("complementary", { name: "Details" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Resize panel" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Details" })).not.toBeInTheDocument();
    expect(padding()).toEqual({ top: 126, right: 16, bottom: 16, left: 336 });
  });

  test("App_shows_the_bar_the_period_and_the_panel_of_the_route", async () => {
    stubApi((path) => Response.json(day(path.split("/").pop()!, 3)));

    renderApp();

    expect(screen.getByRole("heading")).toHaveTextContent("Thursday 22 October");
    expect(await screen.findAllByText("No data")).toHaveLength(3); // the day's timeline: three gaps
  });

  test("App_is_one_landmark_and_the_map_is_in_it", () => {
    stubApi();

    renderApp();

    expect(screen.getByRole("main")).toContainElement(screen.getByRole("region", { name: "Map view" }));
  });
});

/**
 * The note over the map, which is a status: the page has another, the one that a toast is said in, which is there on every day and says nothing until it
 * has something to say.
 */
const mapNote = () => screen.getAllByRole("status").find((status) => status.textContent !== "")!;

describe("App map note", () => {
  test("App_notes_that_the_map_is_unavailable_until_a_style_loads", () => {
    stubApi();
    renderApp();
    expect(screen.queryByText(/Map unavailable/)).not.toBeInTheDocument();

    act(() => mapProps().onStyleError?.(new Error("blocked"), false));
    expect(mapNote()).toHaveTextContent("Map unavailable");

    act(() => mapProps().onStyleError?.(new Error("blocked again"), false));
    expect(screen.getAllByText(/Map unavailable/)).toHaveLength(1);

    act(() => mapProps().onStyleLoad?.()); // the other colour scheme's style loaded: the map is back
    expect(screen.queryByText(/Map unavailable/)).not.toBeInTheDocument();
  });

  test("App_says_that_only_the_switch_of_the_style_failed_when_the_map_keeps_the_one_it_had", () => {
    stubApi();
    renderApp();

    act(() => mapProps().onStyleError?.(new Error("dark style blocked"), true)); // the system went dark with the network down
    expect(mapNote()).toHaveTextContent("Couldn't switch the map style — Retry");
    expect(screen.queryByText(/Map unavailable/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(map.retries).toBe(1);

    act(() => mapProps().onStyleError?.(new Error("still blocked"), true)); // the attempt failed again: still one note, still this one
    expect(screen.getAllByRole("status").filter((status) => status.textContent !== "")).toHaveLength(1);
    expect(mapNote()).toHaveTextContent("Couldn't switch the map style — Retry");

    act(() => mapProps().onStyleLoad?.());
    expect(screen.queryByText(/Couldn't switch the map style/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
  });

  test("App_says_map_unavailable_when_no_basemap_is_drawn_and_the_note_follows_what_the_map_says_last", () => {
    stubApi();
    renderApp();

    act(() => mapProps().onStyleError?.(new Error("no style"), false)); // MapLibre, or the first style
    expect(mapNote()).toHaveTextContent("Map unavailable — Retry");
    expect(screen.queryByText(/Couldn't switch/)).not.toBeInTheDocument();

    act(() => mapProps().onStyleError?.(new Error("the switch"), true)); // the map came up, and then a switch failed
    expect(mapNote()).toHaveTextContent("Couldn't switch the map style");
    expect(screen.queryByText(/Map unavailable/)).not.toBeInTheDocument();

    act(() => mapProps().onStyleError?.(new Error("gone"), false)); // and the map went wrong again, with no basemap
    expect(mapNote()).toHaveTextContent("Map unavailable");
  });

  test("App_offers_a_Retry_with_the_map_note_that_asks_the_map_to_try_again_once_for_each_press", () => {
    stubApi();
    renderApp();
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();

    act(() => mapProps().onStyleError?.(new Error("blocked"), false));
    expect(mapNote()).toHaveTextContent("Map unavailable — Retry");
    expect(map.retries).toBe(0);

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(map.retries).toBe(1);
    expect(mapNote()).toHaveTextContent("Map unavailable"); // the note stays until the map says that it has a style
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(map.retries).toBe(2);

    act(() => mapProps().onStyleLoad?.()); // the attempt worked
    expect(screen.queryByText(/Map unavailable/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
  });
});

describe("App map taps", () => {
  test("App_opens_the_place_that_a_tap_on_the_map_reports_as_a_new_history_entry_that_Back_leaves", async () => {
    stubApi();
    renderApp();
    const before = window.history.length;

    act(() => mapProps().onPlaceTap?.(7)); // a dot, or a pin: the map says which place

    expect(window.location.pathname).toBe("/place/7");
    expect(screen.getByRole("button", { name: "Back" })).toBeInTheDocument(); // the place's panel
    expect(window.history.length).toBe(before + 1);

    act(() => mapProps().onPlaceTap?.(7)); // the same place again is no new entry
    expect(window.history.length).toBe(before + 1);

    fireEvent.click(screen.getByRole("button", { name: "Back" })); // the view it came from, as for a place that a row opened
    await waitFor(() => expect(window.location.pathname).toBe("/day/2026-10-22"));
  });
});

describe("App day rollover", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("App_brings_a_day_that_was_today_to_the_new_today_when_the_page_comes_back_the_next_day", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 9, 22, 20, 0, 0)); // the evening of the 22nd, on the clock the test runs in
    window.history.replaceState(null, "", "/day/2026-10-22");
    const paths = stubApi();
    renderApp();
    expect(screen.getByRole("heading")).toHaveTextContent("Thursday 22 October");

    vi.setSystemTime(new Date(2026, 9, 23, 8, 0, 0)); // the app was put away, and is brought back in the morning
    act(() => void document.dispatchEvent(new Event("visibilitychange")));

    expect(window.location.pathname).toBe("/day/2026-10-23");
    expect(screen.getByRole("heading")).toHaveTextContent("Friday 23 October");
    await waitFor(() => expect(paths).toContain("/api/day/2026-10-23"));
  });

  test("App_leaves_a_day_the_owner_went_to_where_it_is_when_the_page_comes_back", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 9, 22, 20, 0, 0));
    window.history.replaceState(null, "", "/day/2026-10-20");
    stubApi();
    renderApp();

    vi.setSystemTime(new Date(2026, 9, 23, 8, 0, 0));
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
    act(() => void window.dispatchEvent(new Event("focus")));

    expect(window.location.pathname).toBe("/day/2026-10-20");
    expect(screen.getByRole("heading")).toHaveTextContent("Tuesday 20 October");
  });
});

describe("App prefetch", () => {
  test("App_prefetches_the_neighbours_of_every_route_it_shows", async () => {
    const prefetch = vi.fn(async () => undefined);
    queries.prefetch = prefetch;
    stubApi();
    const { client } = renderApp();

    await waitFor(() => expect(prefetch).toHaveBeenCalled());
    expect(prefetch).toHaveBeenLastCalledWith(client, { view: "day", date: "2026-10-22" });
    const calls = prefetch.mock.calls.length;

    act(() => navigate({ view: "week", start: "2026-10-19" }));
    await waitFor(() => expect(prefetch.mock.calls.length).toBeGreaterThan(calls));
    expect(prefetch).toHaveBeenLastCalledWith(client, { view: "week", start: "2026-10-19" });

    act(() => navigate({ view: "place", id: 7 })); // a place has no neighbours, and the call is still the prefetch's to refuse
    await waitFor(() => expect(prefetch).toHaveBeenLastCalledWith(client, { view: "place", id: 7 }));
  });

  test("App_does_not_prefetch_again_when_it_renders_for_another_reason", async () => {
    const prefetch = vi.fn(async () => undefined);
    queries.prefetch = prefetch;
    stubApi();
    renderApp();
    await waitFor(() => expect(prefetch).toHaveBeenCalled());
    const calls = prefetch.mock.calls.length;

    act(() => mapProps().onStyleError?.(new Error("no style"), false));
    fireEvent.click(screen.getByRole("button", { name: "Resize panel" }));

    expect(prefetch.mock.calls.length).toBe(calls);
  });

  test("App_survives_a_prefetch_that_throws", async () => {
    const prefetch = vi.fn(async () => {
      throw new RangeError("no such date");
    });
    queries.prefetch = prefetch;
    stubApi();

    renderApp();
    await waitFor(() => expect(prefetch).toHaveBeenCalled());
    await act(async () => undefined);

    expect(screen.getByRole("heading")).toHaveTextContent("Thursday 22 October"); // and no unhandled rejection fails this test
  });

  test("App_asks_for_the_days_next_to_the_one_it_shows", async () => {
    const paths = stubApi();

    renderApp();

    await waitFor(() => expect(paths).toEqual(expect.arrayContaining(["/api/day/2026-10-21", "/api/day/2026-10-22", "/api/day/2026-10-23"])));
  });
});

describe("App day panel", () => {
  test("App_keeps_the_previous_day_when_the_next_fails_and_Retry_recovers", async () => {
    let failing = true;
    stubApi((path) => {
      const date = path.split("/").pop()!;
      if (date === "2026-10-22") return Response.json(day(date, 3));
      return failing ? new Response("{}", { status: 500 }) : Response.json(day(date, 1));
    });
    renderApp();
    expect(await screen.findAllByText("No data")).toHaveLength(3);

    fireEvent.click(screen.getByRole("button", { name: "Next day" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't load — Retry");
    expect(screen.getAllByText("No data")).toHaveLength(3); // the day that was shown stays under the error
    expect(screen.getByRole("heading")).toHaveTextContent("Friday 23 October");

    failing = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(screen.getAllByText("No data")).toHaveLength(1));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  test("App_says_when_a_day_has_no_data_and_when_it_is_still_loading", async () => {
    let release: (response: Response) => void = () => undefined;
    stubApi((path) =>
      path.endsWith("2026-10-22") ? new Promise<Response>((resolve) => (release = resolve)) : Response.json(day(path.split("/").pop()!)),
    );

    renderApp();
    expect(screen.getByText("Loading…")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    release(Response.json(day("2026-10-22", 0)));

    expect(await screen.findByText("No data for this day")).toBeInTheDocument();
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
  });

  test("App_shows_the_error_with_no_previous_day_when_the_first_day_fails", async () => {
    stubApi(() => new Response("{}", { status: 500 }));

    renderApp();

    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't load — Retry");
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });

  test("App_keeps_the_day_it_could_not_replace_on_the_map_too", async () => {
    stubApi((path) => {
      const date = path.split("/").pop()!;
      return date === "2026-10-22" ? Response.json(flightDay) : new Response("{}", { status: 500 });
    });
    renderApp();
    await waitFor(() => expect(mapProps().fitTo).not.toBeNull());
    const drawn = mapProps().data;

    fireEvent.click(screen.getByRole("button", { name: "Next day" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't load — Retry");

    expect(mapProps().data.routes).toBe(drawn.routes); // as the panel keeps its rows
    expect(mapProps().data.stops).toBe(drawn.stops);
    expect(mapProps().fitTo).toBeNull(); // but the map is not taken anywhere for a date that has nothing
  });

  test("App_has_a_panel_for_every_other_view", () => {
    stubApi();
    renderApp();

    for (const route of [
      { view: "week", start: "2026-10-19" },
      { view: "month", month: "2026-10" },
      { view: "year", year: 2026 },
      { view: "range", from: "2026-10-01", to: "2026-10-05" },
      { view: "place", id: 3 },
      { view: "trips" },
      { view: "trip", id: "2026-09-12" },
      { view: "settings" },
    ] as const) {
      act(() => navigate(route));
      expect(screen.getByRole("region", { name: "Details" })).not.toBeEmptyDOMElement();
    }
  });
});

describe("App day on the map", () => {
  const OSLO_DAY = flightDay as DayResponse;
  const answerWithTheFlight = (path: string) => Response.json(path.endsWith("2026-10-22") ? OSLO_DAY : day(path.split("/").pop()!, 2));

  test("App_draws_the_day_of_the_panel_on_the_map_and_fits_to_it", async () => {
    stubApi(answerWithTheFlight);

    renderApp();

    await waitFor(() => expect(mapProps().fitTo).not.toBeNull());
    expect(mapProps().data).toEqual(dayGeoJson(OSLO_DAY));
    const { routes, stops } = dayGeoJson(OSLO_DAY);
    expect(mapProps().fitTo).toEqual([...routes.features, ...stops.features]);
  });

  test("App_a_tap_on_a_row_fits_the_map_to_its_segment_each_time_it_is_tapped", async () => {
    stubApi(answerWithTheFlight);
    renderApp();
    await waitFor(() => expect(mapProps().fitTo).not.toBeNull());
    const auto = mapProps().fitTo;
    const home = placePoint((OSLO_DAY.segments[0] as StaySegment).place!);

    fireEvent.click(screen.getByRole("button", { name: "Show home, Home, until 08:32, on the map" }));
    const first = mapProps().fitTo;
    expect(first).toEqual([home]);
    expect(first).not.toBe(auto);

    fireEvent.click(screen.getByRole("button", { name: "Show home, Home, until 08:32, on the map" })); // the same row again: another array, so the map moves again
    expect(mapProps().fitTo).toEqual([home]);
    expect(mapProps().fitTo).not.toBe(first);
  });

  test("App_gives_the_map_the_whole_day_to_recenter_to_and_a_tapped_row_leaves_it_so", async () => {
    stubApi(answerWithTheFlight);
    renderApp();
    await waitFor(() => expect(mapProps().fitTo).not.toBeNull());
    const { routes, stops } = dayGeoJson(OSLO_DAY);
    expect(mapProps().home).toEqual([...routes.features, ...stops.features]);
    const home = mapProps().home;

    fireEvent.click(screen.getByRole("button", { name: "Show stop 1, Café, on the map" }));

    expect(mapProps().fitTo).toHaveLength(1); // the map is taken to the row...
    expect(mapProps().home).toBe(home); // ...and Recenter is still the whole day
  });

  test("App_draws_and_shows_nothing_of_the_day_that_was_left_when_the_next_one_is_not_there_yet", async () => {
    // Day 22, then a week, then day 23 that has to be loaded: the panel is mounted afresh and says "Loading…", and the map is cleared too.
    let release: (response: Response) => void = () => undefined;
    stubApi((path) =>
      path.endsWith("2026-10-22") ? Response.json(OSLO_DAY) : path.endsWith("2026-10-23") ? new Promise<Response>((resolve) => (release = resolve)) : Response.json(day(path.split("/").pop()!)),
    );
    renderApp();
    await waitFor(() => expect(mapProps().data.stops?.features).toHaveLength(5));
    act(() => navigate({ view: "week", start: "2026-10-19" }));
    expect(mapProps().data.routes.features).toEqual([]);

    act(() => navigate({ view: "day", date: "2026-10-23" }));

    expect(screen.getByText("Loading…")).toBeInTheDocument();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
    expect(mapProps().data.routes.features).toEqual([]); // not the 22nd's routes and pins
    expect(mapProps().data.stops).toBeUndefined();
    expect(mapProps().fitTo).toBeNull();
    release(Response.json(day("2026-10-23", 1)));
    expect(await screen.findAllByText("No data")).toHaveLength(1);
  });

  test("App_does_not_take_the_map_back_from_a_row_when_the_day_is_polled", async () => {
    let state: "pending" | "done" = "pending";
    stubApi((path) => Response.json(path.endsWith("2026-10-22") ? { ...OSLO_DAY, state } : day(path.split("/").pop()!)));
    const { client } = renderApp();
    await waitFor(() => expect(mapProps().fitTo).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Show stop 1, Café, on the map" }));
    const tapped = mapProps().fitTo;

    state = "done"; // the poll of a day that was still being processed finds it done
    await act(async () => {
      await client.refetchQueries({ queryKey: ["day", "2026-10-22"] });
    });

    await waitFor(() => expect(screen.queryByText("Updating…")).not.toBeInTheDocument());
    expect(mapProps().fitTo).toBe(tapped);
  });

  test("App_finds_the_next_day_already_asked_for_when_stepping_forward", async () => {
    // Ruling P2-R36: the neighbours of the day on show are prefetched (by the shell, for every route), so › has them at hand.
    const paths = stubApi((path) => Response.json(day(path.split("/").pop()!, 2)));
    const { client } = renderApp();
    await screen.findAllByText("No data");
    await waitFor(() => expect(client.getQueryData(["day", "2026-10-23"])).toBeDefined());
    expect(paths.filter((path) => path === "/api/day/2026-10-23")).toHaveLength(1);
    expect(client.getQueryData(["day", "2026-10-21"])).toBeDefined(); // and the one before

    fireEvent.click(screen.getByRole("button", { name: "Next day" }));

    // The next day is on screen in the same render, with no loading in between and no second request for it.
    expect(screen.getByRole("heading")).toHaveTextContent("Friday 23 October");
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
    expect(screen.getAllByText("No data")).toHaveLength(2);
    expect(document.querySelector("[aria-busy]")).toHaveAttribute("aria-busy", "false"); // it is the day asked for, not the one before
    expect(paths.filter((path) => path === "/api/day/2026-10-23")).toHaveLength(1);
  });
});

describe("App row taps on the sheet", () => {
  const OSLO_DAY = flightDay as DayResponse;
  const sheet = () => screen.getByRole("region", { name: "Details" });
  const resize = () => fireEvent.click(screen.getByRole("button", { name: "Resize panel" }));
  const tapRow = () => fireEvent.click(screen.getByRole("button", { name: "Show stop 1, Café, on the map" }));

  test("App_a_row_tap_lowers_a_full_sheet_to_half_so_that_the_map_can_be_seen", async () => {
    stubApi((path) => Response.json(path.endsWith("2026-10-22") ? OSLO_DAY : day(path.split("/").pop()!)));
    stubLayout(120);
    renderApp();
    await screen.findByRole("list");
    resize();
    resize();
    expect(sheet()).toHaveAttribute("data-snap", "full");
    const before = mapProps().fitTo;

    tapRow();

    expect(sheet()).toHaveAttribute("data-snap", "half");
    expect(mapProps().fitTo).not.toBe(before); // and the map was taken to the row
    expect(padding().bottom).toBe(416); // with the room that half leaves
  });

  test("App_a_row_tap_leaves_a_sheet_at_half_or_at_its_peek_where_it_is", async () => {
    stubApi((path) => Response.json(path.endsWith("2026-10-22") ? OSLO_DAY : day(path.split("/").pop()!)));
    stubLayout(120);
    renderApp();
    await screen.findByRole("list");
    expect(sheet()).toHaveAttribute("data-snap", "peek");

    tapRow();
    expect(sheet()).toHaveAttribute("data-snap", "peek"); // a tap is not a request to open the sheet

    resize();
    expect(sheet()).toHaveAttribute("data-snap", "half");
    tapRow();
    expect(sheet()).toHaveAttribute("data-snap", "half");
  });

  test("App_a_row_tap_on_a_desktop_moves_the_map_and_has_no_sheet_to_lower", async () => {
    stubDesktop(true);
    stubApi((path) => Response.json(path.endsWith("2026-10-22") ? OSLO_DAY : day(path.split("/").pop()!)));
    stubLayout(120);
    renderApp();
    await screen.findByRole("list");
    const before = mapProps().fitTo;

    tapRow();

    expect(mapProps().fitTo).not.toBe(before);
    expect(screen.queryByRole("button", { name: "Resize panel" })).not.toBeInTheDocument();
  });
});

describe("App period panels", () => {
  const OCTOBER = october as RangeResponse; // 2026-10-01 to 2026-10-31: 9 moves, 6 places, 8 days
  /** What a request of `/api/range` is answered with by the dates it asks for; any other period has nothing in it. */
  const answerWith = (periods: Record<string, RangeResponse | Answer>): Answer => (path) => {
    if (!path.startsWith("/api/range")) return answerEmpty(path);
    const { from, to } = emptyRange(path);
    const answer = periods[`${from}..${to}`];
    if (answer === undefined) return Response.json(emptyRange(path));
    return typeof answer === "function" ? answer(path) : Response.json(answer);
  };
  /** A week with a few of the month's routes and places, so that it is told from the month and from another week. */
  const week = (from: string, to: string, moves: number, places: number): RangeResponse => ({
    ...OCTOBER,
    from,
    to,
    summary: { places, distanceMeters: 5000, movingSeconds: 600, moves },
    moves: OCTOBER.moves.slice(0, moves),
    places: OCTOBER.places.slice(0, places),
    days: OCTOBER.days.filter((entry) => entry.date >= from && entry.date <= to),
  });
  const WEEK_19 = week("2026-10-19", "2026-10-25", 2, 3);

  beforeEach(() => {
    window.history.replaceState(null, "", "/week/2026-10-19");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 11, 1, 12, 0, 0)); // after the periods here, which list no date after today
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("App_shows_the_panel_of_each_period_view_and_says_when_a_period_is_empty", async () => {
    stubApi(answerWith({ "2026-10-01..2026-10-31": OCTOBER }));
    renderApp();
    expect(await screen.findByText("No data for this period")).toBeInTheDocument(); // the week of the 19th: the API has nothing

    act(() => navigate({ view: "month", month: "2026-10" }));

    expect(await screen.findByText("6 places")).toBeInTheDocument();
    expect(screen.getByText("41.3 km")).toBeInTheDocument();
    expect(screen.getByText("9 moves")).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Where your time went" })).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Days" })).toBeInTheDocument();

    act(() => navigate({ view: "range", from: "2026-11-02", to: "2026-11-08" }));
    expect(await screen.findByText("No data for this period")).toBeInTheDocument();

    act(() => navigate({ view: "year", year: 2026 }));
    expect(await screen.findByText("No data for this period")).toBeInTheDocument();
  });

  test("App_draws_the_period_of_the_panel_on_the_map_and_fits_to_it", async () => {
    window.history.replaceState(null, "", "/month/2026-10");
    stubApi(answerWith({ "2026-10-01..2026-10-31": OCTOBER }));

    renderApp();

    await waitFor(() => expect(mapProps().fitTo).not.toBeNull());
    expect(mapProps().data).toEqual(rangeGeoJson(OCTOBER));
    const { routes, places } = rangeGeoJson(OCTOBER);
    const all = [...routes.features, ...places.features];
    expect(mapProps().fitTo).toEqual(all);
    expect(mapProps().home).toEqual(all);
  });

  test("App_finds_the_next_week_already_asked_for_when_stepping_forward", async () => {
    // Ruling P2-R44: the neighbours of the period on show are prefetched (by the shell, for every route), so › has them at hand.
    const paths = stubApi(
      answerWith({ "2026-10-19..2026-10-25": WEEK_19, "2026-10-26..2026-11-01": week("2026-10-26", "2026-11-01", 3, 2) }),
    );
    const { client } = renderApp();
    await screen.findByText("3 places");
    await waitFor(() => expect(client.getQueryData(["range", "2026-10-26", "2026-11-01"])).toBeDefined());
    expect(paths.filter((path) => path === "/api/range?from=2026-10-26&to=2026-11-01")).toHaveLength(1);
    expect(client.getQueryData(["range", "2026-10-12", "2026-10-18"])).toBeDefined(); // and the one before

    fireEvent.click(screen.getByRole("button", { name: "Next week" }));

    // The next week is on screen in the same render, with no loading in between and no second request for it.
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("26 Oct – 1 Nov 2026"); // the others are the lists
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
    expect(screen.getByText("2 places")).toBeInTheDocument();
    expect(document.querySelector("[aria-busy]")).toHaveAttribute("aria-busy", "false"); // it is the week asked for, not the one before
    expect(paths.filter((path) => path === "/api/range?from=2026-10-26&to=2026-11-01")).toHaveLength(1);
  });

  test("App_keeps_the_week_it_could_not_replace_under_the_error_and_on_the_map_too", async () => {
    let failing = true;
    stubApi(
      answerWith({
        "2026-10-19..2026-10-25": WEEK_19,
        "2026-10-26..2026-11-01": () => (failing ? new Response("{}", { status: 500 }) : Response.json(week("2026-10-26", "2026-11-01", 3, 2))),
      }),
    );
    renderApp();
    await waitFor(() => expect(mapProps().fitTo).not.toBeNull());
    const drawn = mapProps().data;

    fireEvent.click(screen.getByRole("button", { name: "Next week" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't load — Retry");

    expect(screen.getByText("3 places")).toBeInTheDocument(); // the week that was shown stays under the error...
    expect(mapProps().data.routes).toBe(drawn.routes); // ...and on the map
    expect(mapProps().data.places).toBe(drawn.places);
    expect(mapProps().fitTo).toBeNull(); // which is not taken anywhere for a week that has nothing

    failing = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByText("2 places")).toBeInTheDocument();
    await waitFor(() => expect(mapProps().fitTo).not.toBeNull());
    expect(mapProps().data).toEqual(rangeGeoJson(week("2026-10-26", "2026-11-01", 3, 2)));
  });

  test("App_keeps_the_week_under_the_month_on_the_map_as_in_the_panel_when_the_bar_switches_view", async () => {
    // Week to month is one panel that goes on (nothing remounts), and it keeps the week while the month loads. The map does the same.
    stubApi(answerWith({ "2026-10-19..2026-10-25": WEEK_19, "2026-10-01..2026-10-31": () => new Promise<Response>(() => undefined) }));
    renderApp();
    await screen.findByText("3 places");
    await waitFor(() => expect(mapProps().fitTo).not.toBeNull());
    const drawn = mapProps().data;

    fireEvent.click(screen.getByRole("button", { name: "Month" }));

    expect(window.location.pathname).toBe("/month/2026-10");
    expect(screen.getByText("3 places")).toBeInTheDocument(); // the panel's...
    expect(document.querySelector("[aria-busy]")).toHaveAttribute("aria-busy", "true");
    expect(mapProps().data.routes).toBe(drawn.routes); // ...and the map's
    expect(mapProps().data.places).toBe(drawn.places);
  });

  test("App_draws_and_shows_nothing_of_the_week_that_was_left_when_the_next_one_is_not_there_yet", async () => {
    // Week, then a day, then another week that has to be loaded: the panel is mounted afresh and says "Loading…", and the map is cleared too.
    let release: (response: Response) => void = () => undefined;
    stubApi(
      answerWith({
        "2026-10-19..2026-10-25": WEEK_19,
        "2026-10-26..2026-11-01": () => new Promise<Response>((resolve) => (release = resolve)),
      }),
    );
    renderApp();
    await waitFor(() => expect(mapProps().data.places?.features).toHaveLength(3));
    act(() => navigate({ view: "day", date: "2026-10-22" }));
    expect(await screen.findByText("No data for this day")).toBeInTheDocument();
    expect(mapProps().data.routes.features).toEqual([]);

    act(() => navigate({ view: "week", start: "2026-10-26" }));

    expect(screen.getByText("Loading…")).toBeInTheDocument();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
    expect(mapProps().data.routes.features).toEqual([]); // not the 19th's routes and dots
    expect(mapProps().data.places).toBeUndefined();
    expect(mapProps().fitTo).toBeNull();
    release(Response.json(week("2026-10-26", "2026-11-01", 3, 2)));
    expect(await screen.findByText("2 places")).toBeInTheDocument();
  });

  test("App_does_not_take_the_map_back_when_a_period_that_is_still_being_processed_is_polled", async () => {
    let state: "pending" | "done" = "pending";
    stubApi(answerWith({ "2026-10-19..2026-10-25": () => Response.json({ ...WEEK_19, state }) }));
    const { client } = renderApp();
    await waitFor(() => expect(mapProps().fitTo).not.toBeNull());
    expect(screen.getByText("Updating…")).toBeInTheDocument();
    const fit = mapProps().fitTo;

    state = "done"; // the poll of a period that was still being processed finds it done
    await act(async () => {
      await client.refetchQueries({ queryKey: ["range", "2026-10-19", "2026-10-25"] });
    });

    await waitFor(() => expect(screen.queryByText("Updating…")).not.toBeInTheDocument());
    expect(mapProps().fitTo).toBe(fit);
  });

  test("App_asks_for_the_first_400_days_of_a_range_that_is_longer_and_replaces_the_address", async () => {
    // A deep link to a range that the API would refuse (more than 400 days) is cut where the router reads it: no view asks for it.
    window.history.replaceState(null, "", "/range/2025-01-01..2026-12-31");
    const lengthBefore = window.history.length;
    const paths = stubApi(answerWith({}));

    renderApp();

    expect(await screen.findByText("No data for this period")).toBeInTheDocument();
    expect(window.location.pathname).toBe("/range/2025-01-01..2026-02-04");
    expect(window.history.length).toBe(lengthBefore); // replaced, so that Back does not return to the address that cannot be had
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("1 Jan 2025 – 4 Feb 2026");
    const asked = paths.filter((path) => path.startsWith("/api/range"));
    expect(asked).toContain("/api/range?from=2025-01-01&to=2026-02-04"); // the panel's, and the map's, from the one request
    expect(asked.filter((path) => path.includes("2026-12-31"))).toEqual([]);
    for (const path of asked) {
      const { from, to } = emptyRange(path);
      expect(periodDays({ view: "range", from, to }), path).toBeLessThanOrEqual(400); // and neither are the neighbours that are prefetched
    }
  });

  test("App_a_row_of_the_month_opens_its_day_and_a_row_of_a_place_opens_the_place", async () => {
    window.history.replaceState(null, "", "/month/2026-10");
    stubApi(answerWith({ "2026-10-01..2026-10-31": OCTOBER }));
    renderApp();
    await screen.findByRole("list", { name: "Days" });

    fireEvent.click(screen.getByRole("button", { name: "Open Thu 22 Oct" }));

    expect(window.location.pathname).toBe("/day/2026-10-22");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Thursday 22 October");
    expect(await screen.findByText("No data for this day")).toBeInTheDocument(); // the day view, in the same shell

    act(() => navigate({ view: "month", month: "2026-10" }));
    fireEvent.click(await screen.findByRole("button", { name: "Open Home" }));

    expect(window.location.pathname).toBe("/place/1");
  });
});

describe("App place", () => {
  const CAFE = cafe as PlaceResponse; // place 2, the Café of the 22nd
  const OSLO_DAY = flightDay as DayResponse;
  /** The Café for place 2 and the day of the fixture for the 22nd; a 404 for any other place, and nothing in any other day or period. */
  const answerWithTheCafe: Answer = (path) => {
    if (path === "/api/places/2") return Response.json(CAFE);
    if (path.startsWith("/api/places/")) return new Response("{}", { status: 404 });
    return path.endsWith("2026-10-22") ? Response.json(OSLO_DAY) : answerEmpty(path);
  };

  test("App_shows_the_place_of_the_address_and_draws_its_pin_with_no_heat_button", async () => {
    window.history.replaceState(null, "", "/place/2");
    stubApi(answerWithTheCafe);

    renderApp();

    expect(await screen.findByRole("heading", { level: 1, name: "Café" })).toBeInTheDocument();
    await waitFor(() => expect(mapProps().fitTo).not.toBeNull());
    expect(mapProps().data).toEqual(placeGeoJson(CAFE));
    expect(mapProps().fitTo).toEqual(placeGeoJson(CAFE).stops.features);
    expect(mapProps().home).toEqual(placeGeoJson(CAFE).stops.features);
    expect(mapProps().heatToggle).toBeUndefined(); // there is no period to show the heat of
    expect(screen.getByRole("button", { name: "Back" })).toBeInTheDocument();
    expect(screen.queryByText("Coming soon: the place view.")).not.toBeInTheDocument();
  });

  test("App_asks_for_the_place_and_for_no_day_or_period_to_draw_it", async () => {
    window.history.replaceState(null, "", "/place/2");
    const paths = stubApi(answerWithTheCafe);

    renderApp();
    await screen.findByRole("heading", { level: 1, name: "Café" });

    // The panel and the map ask for the same place, and the cache gives them the one request (StrictMode may make it twice, as it does
    // for every query: it mounts what it shows twice).
    expect(new Set(paths.filter((path) => path !== "/api/status"))).toEqual(new Set(["/api/places/2"]));
  });

  test("App_says_a_place_no_longer_exists_and_draws_nothing_of_it", async () => {
    window.history.replaceState(null, "", "/place/9");
    stubApi(answerWithTheCafe);

    renderApp();

    expect(await screen.findByText("This place no longer exists")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
    expect(mapProps().data.stops).toBeUndefined();
    expect(mapProps().data.routes.features).toEqual([]);
    expect(mapProps().fitTo).toBeNull();
    expect(mapProps().home).toBeNull();
  });

  test("App_a_visit_of_the_place_opens_its_day", async () => {
    window.history.replaceState(null, "", "/place/2");
    stubApi(answerWithTheCafe);
    renderApp();

    fireEvent.click(await screen.findByRole("button", { name: /Thu 22 Oct 2026/ }));

    expect(window.location.pathname).toBe("/day/2026-10-22");
    expect(await screen.findByText("5 places")).toBeInTheDocument(); // the day, in the same shell
    expect(screen.queryByRole("heading", { level: 1, name: "Café" })).not.toBeInTheDocument();
  });

  test("App_a_place_opened_from_a_full_sheet_lowers_it_to_half_so_that_the_map_flies_to_somewhere_that_can_be_seen", async () => {
    stubApi(answerWithTheCafe);
    stubLayout(120);
    renderApp();
    await screen.findByRole("list");
    const sheet = screen.getByRole("region", { name: "Details" });
    fireEvent.click(screen.getByRole("button", { name: "Resize panel" }));
    fireEvent.click(screen.getByRole("button", { name: "Resize panel" }));
    expect(sheet).toHaveAttribute("data-snap", "full");

    fireEvent.click(screen.getByRole("button", { name: "Café" }));

    expect(await screen.findByRole("heading", { level: 1, name: "Café" })).toBeInTheDocument();
    expect(sheet).toHaveAttribute("data-snap", "half");
  });

  test("App_a_place_leaves_a_sheet_that_is_at_its_peek_or_at_half_where_it_is_and_lets_it_be_raised_again", async () => {
    window.history.replaceState(null, "", "/place/2");
    stubApi(answerWithTheCafe);
    stubLayout(120);
    renderApp();
    await screen.findByRole("heading", { level: 1, name: "Café" });
    const sheet = screen.getByRole("region", { name: "Details" });
    expect(sheet).toHaveAttribute("data-snap", "peek"); // the page was opened on the place: the sheet is as it always starts

    fireEvent.click(screen.getByRole("button", { name: "Resize panel" }));
    fireEvent.click(screen.getByRole("button", { name: "Resize panel" }));
    expect(sheet).toHaveAttribute("data-snap", "full"); // raised by the owner on the place: not brought down again by anything
    act(() => void window.dispatchEvent(new Event("resize")));
    expect(sheet).toHaveAttribute("data-snap", "full");
  });

  test("App_back_from_a_place_that_a_day_opened_is_that_day_and_the_map_comes_back_to_it", async () => {
    stubApi(answerWithTheCafe);
    renderApp();
    await waitFor(() => expect(mapProps().fitTo).not.toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "Café" })); // the name of a stop opens the place
    expect(await screen.findByRole("heading", { level: 1, name: "Café" })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/place/2");
    await waitFor(() => expect(mapProps().data).toEqual(placeGeoJson(CAFE)));

    fireEvent.click(screen.getByRole("button", { name: "Back" }));

    await waitFor(() => expect(window.location.pathname).toBe("/day/2026-10-22")); // the browser's own Back
    expect(await screen.findByText("5 places")).toBeInTheDocument();
    await waitFor(() => expect(mapProps().data).toEqual(dayGeoJson(OSLO_DAY)));
    expect(mapProps().fitTo).toEqual([...dayGeoJson(OSLO_DAY).routes.features, ...dayGeoJson(OSLO_DAY).stops.features]);
  });

  test("App_back_from_a_place_that_was_opened_as_a_page_is_today", async () => {
    window.history.replaceState(null, "", "/place/2"); // a deep link
    stubApi(answerWithTheCafe);
    renderApp();

    fireEvent.click(await screen.findByRole("button", { name: "Back" }));

    expect(window.location.pathname).toBe(`/day/${today()}`);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(periodLabel({ view: "day", date: today() })); // the day view of today, with its bar
    expect(screen.queryByRole("button", { name: "Back" })).not.toBeInTheDocument();
  });
});

describe("App trips", () => {
  const TRIPS = tripsList as TripsResponse; // newest first: 2026-10-22 (New York, ongoing), 2026-09-12 (Lisbon & Sintra), 2026-08-01 (Copenhagen)
  const LISBON = lisbonTrip as TripResponse;
  /** The list and the trips of the fixtures; a trip that is not in it is a 404, as the server says; anything else is as empty as `answerEmpty` has it. */
  const answerWithTrips: Answer = (path) => {
    if (path.startsWith("/api/heat")) return Response.json({ maxSeconds: 0, cells: [] } satisfies HeatResponse);
    if (path === "/api/trips") return Response.json(TRIPS);
    if (path === "/api/trips/2026-09-12") return Response.json(LISBON);
    const listed = TRIPS.trips.find((trip) => path === `/api/trips/${trip.id}`);
    if (listed !== undefined) {
      const { thumbnail: _thumbnail, ...summary } = listed;
      return Response.json({ ...LISBON, ...summary } satisfies TripResponse);
    }
    return answerEmpty(path);
  };
  const details = () => screen.getByRole("region", { name: "Details" });
  /** What the app asks for that is a period: a day, a range, a heat. */
  const periodRequests = (paths: string[]) => paths.filter((path) => /^\/api\/(day|range|heat)/.test(path));

  // A trips route has no period: nothing that is made from the dates of a period (a range, a heat, a day, a step) may be asked of it, and the
  // heat that was turned on for the views that have a period stays turned on and is not asked for here.
  beforeEach(() => {
    window.localStorage.setItem("heat", "true");
  });
  afterEach(() => {
    window.localStorage.removeItem("heat");
  });

  test("App_shows_the_trips_route_with_a_title_the_cards_the_map_of_their_cities_and_no_request_for_a_period_or_its_heat", async () => {
    window.history.replaceState(null, "", "/trips");
    const paths = stubApi(answerWithTrips);

    renderApp(undefined, { strict: false }); // the requests are counted below

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Trips"); // the bar's title row
    expect(within(details()).getByRole("heading", { name: "Trips" })).toBeInTheDocument(); // and the panel, until the list is
    expect(mapProps().data.places).toBeUndefined(); // the map has nothing either while the list is on its way
    expect(mapProps().fitTo).toBeNull();
    expect(await within(details()).findByRole("list", { name: "Trips" })).toBeInTheDocument(); // the real list was asked for and came
    expect(within(details()).queryByText("Loading…")).not.toBeInTheDocument();
    expect(paths.filter((path) => path === "/api/trips")).toHaveLength(1); // one request, for the panel and the map (counted, not collapsed into a set)
    expect(paths.filter((path) => path !== "/api/status" && path !== "/api/trips")).toEqual([]); // and nothing else
    expect(periodRequests(paths)).toEqual([]);
    expect(mapProps().heatToggle).toBeUndefined(); // there is no period to show the heat of
    // What the panel lists is what the map draws: a dot for each city, no routes, and the map brought to all of them.
    expect(mapProps().data).toEqual({ ...tripsGeoJson(TRIPS), view: "trips" });
    expect(mapProps().data.places?.features).toHaveLength(4);
    expect(mapProps().fitTo).toEqual(tripsGeoJson(TRIPS).places.features);
    expect(mapProps().home).toEqual(tripsGeoJson(TRIPS).places.features);
  });

  test("App_opens_a_trip_from_its_card_and_draws_that_trip_and_none_of_the_cities_of_the_others", async () => {
    window.history.replaceState(null, "", "/trips");
    stubApi(answerWithTrips);
    renderApp();
    const list = await within(details()).findByRole("list", { name: "Trips" });
    expect(mapProps().data.places?.features).toHaveLength(4); // the cities of all the trips

    fireEvent.click(within(list).getByRole("button", { name: /^Open Lisbon & Sintra/ }));

    expect(window.location.pathname).toBe("/trip/2026-09-12");
    expect(await screen.findByRole("heading", { level: 1, name: "Lisbon & Sintra" })).toBeInTheDocument();
    await waitFor(() => expect(mapProps().data.view).toBe("trip")); // the trip's own map: its routes and the dots of its two cities, and not the four
    expect(mapProps().data.places?.features).toHaveLength(2);
    expect(mapProps().data.routes.features).toHaveLength(LISBON.moves.length);
  });

  test("App_shows_a_trip_with_its_name_in_the_bar_its_stats_and_days_in_the_panel_and_its_routes_and_cities_on_the_map", async () => {
    window.history.replaceState(null, "", "/trip/2026-09-12");
    const paths = stubApi(answerWithTrips);

    renderApp(undefined, { strict: false }); // the requests are counted below

    expect(screen.getByText("Loading…")).toBeInTheDocument(); // the panel, until the trip is there
    expect(mapProps().data.routes.features).toEqual([]); // and the map
    expect(await screen.findByRole("heading", { level: 1, name: "Lisbon & Sintra" })).toBeInTheDocument();
    expect(screen.getByText("12 – 16 Sep 2026")).toBeInTheDocument();
    expect(await within(details()).findByText("2 flights")).toBeInTheDocument();
    expect(within(details()).getByText("169 km on the ground")).toBeInTheDocument();
    expect(within(details()).getByRole("list", { name: "Day by day" })).toBeInTheDocument();
    expect(within(details()).queryByText("Loading…")).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Older trip" })).toBeEnabled()); // the list came as well
    // What the panel lists is what the map draws: the trip's routes and the dots of its cities, and the map is brought to all of them.
    expect(mapProps().data).toMatchObject({ ...tripGeoJson(LISBON), view: "trip" });
    expect(mapProps().fitTo).toEqual([...tripGeoJson(LISBON).routes.features, ...tripGeoJson(LISBON).places.features]);
    expect(mapProps().home).toEqual(mapProps().fitTo);
    // The trip asked for once, for the bar, the panel and the map; the heat (it is on) of its dates and of no others.
    expect(paths.filter((path) => path === "/api/trips/2026-09-12")).toHaveLength(1);
    expect(paths.filter((path) => path === "/api/trips")).toHaveLength(1);
    await waitFor(() => expect(paths).toContain("/api/heat?from=2026-09-12&to=2026-09-16"));
    expect(periodRequests(paths)).toEqual(["/api/heat?from=2026-09-12&to=2026-09-16"]); // no day, no range
    await waitFor(() => expect(mapProps().data.heat).toBeDefined()); // and what came is what the map is given, under the routes of the trip
    expect(mapProps().heatToggle).toMatchObject({ on: true }); // the button is there on a trip, as on a day
  });

  test("App_opens_a_day_from_a_day_of_the_trip", async () => {
    window.history.replaceState(null, "", "/trip/2026-09-12");
    stubApi(answerWithTrips);
    renderApp();
    const days = await within(details()).findByRole("list", { name: "Day by day" });

    fireEvent.click(within(days).getByRole("button", { name: /^Open Mon 14 Sep/ }));

    expect(window.location.pathname).toBe("/day/2026-09-14");
    expect(await screen.findByRole("heading", { level: 1, name: "Monday 14 September" })).toBeInTheDocument();
  });

  test("App_says_a_trip_that_the_server_does_not_have_no_longer_exists_and_draws_nothing_of_it", async () => {
    window.history.replaceState(null, "", "/trip/2026-01-01");
    const paths = stubApi(answerWithTrips);

    renderApp();

    expect(await within(details()).findByText("This trip no longer exists")).toBeInTheDocument();
    expect(within(details()).queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
    expect(within(details()).queryByText("Loading…")).not.toBeInTheDocument();
    expect(mapProps().data.routes.features).toEqual([]);
    expect(mapProps().data.places).toBeUndefined();
    expect(mapProps().fitTo).toBeNull();
    expect(mapProps().home).toBeNull();
    expect(periodRequests(paths)).toEqual([]); // a trip that is gone has no dates to ask the heat of
    expect(mapProps().heatToggle).toBeUndefined(); // and no button for the heat of what does not exist (P3-R22)

    fireEvent.click(within(details()).getByRole("button", { name: "See all trips" }));

    expect(window.location.pathname).toBe("/trips");
    expect(await within(details()).findByRole("list", { name: "Trips" })).toBeInTheDocument();
  });

  test("App_shows_an_error_for_a_trip_that_could_not_be_had_with_a_retry_that_asks_again_and_not_the_message_of_a_trip_that_is_gone", async () => {
    window.history.replaceState(null, "", "/trip/2026-09-12");
    let failing = true;
    stubApi((path) => (path === "/api/trips/2026-09-12" && failing ? new Response("{}", { status: 500 }) : answerWithTrips(path)));
    renderApp();

    expect(await within(details()).findByRole("alert")).toHaveTextContent("Couldn't load — Retry");
    expect(within(details()).queryByText("This trip no longer exists")).not.toBeInTheDocument();
    expect(mapProps().data.routes.features).toEqual([]);

    failing = false;
    fireEvent.click(within(details()).getByRole("button", { name: "Retry" }));

    expect(await within(details()).findByRole("list", { name: "Day by day" })).toBeInTheDocument();
    await waitFor(() => expect(mapProps().data.routes.features).toHaveLength(LISBON.moves.length));
  });

  test("App_goes_to_the_trips_with_the_button_of_the_bar_and_back_to_the_day_that_was_shown_asking_for_no_period_on_the_way", async () => {
    const paths = stubApi(answerWithTrips);
    renderApp();
    await screen.findByText("No data for this day");
    await waitFor(() => expect(paths).toContain("/api/heat?from=2026-10-22&to=2026-10-22")); // the heat is on for a day
    const before = periodRequests(paths).length;

    fireEvent.click(screen.getByRole("button", { name: "Trips" }));

    expect(window.location.pathname).toBe("/trips");
    expect(screen.getByRole("button", { name: "Trips", pressed: true })).toBeInTheDocument();
    await waitFor(() => expect(within(details()).queryByText("Loading…")).not.toBeInTheDocument());
    expect(periodRequests(paths)).toHaveLength(before);
    expect(mapProps().heatToggle).toBeUndefined();

    fireEvent.click(screen.getByRole("button", { name: "Week" })); // a view that has a period again, at the day that was last shown
    expect(window.location.pathname).toBe("/week/2026-10-19");
    expect(mapProps().heatToggle).toBeDefined();
    await screen.findByText("No data for this period");
  });

  test("App_goes_from_one_trip_to_the_next_and_has_the_neighbours_of_the_trip_it_is_at_ready", async () => {
    window.history.replaceState(null, "", "/trip/2026-10-22");
    const paths = stubApi(answerWithTrips);
    const { client } = renderApp();
    await waitFor(() => expect(screen.getByRole("button", { name: "Older trip" })).toBeEnabled()); // the list is known now
    expect(screen.getByRole("button", { name: "Newer trip" })).toBeDisabled(); // the newest
    expect(client.getQueryData(["trip", "2026-08-01"])).toBeUndefined(); // the neighbours of a trip that was opened as a page are not known before the list is

    fireEvent.click(screen.getByRole("button", { name: "Older trip" }));

    expect(window.location.pathname).toBe("/trip/2026-09-12");
    expect(await screen.findByRole("heading", { level: 1, name: "Lisbon & Sintra" })).toBeInTheDocument();
    await waitFor(() => expect(client.getQueryData(["trip", "2026-08-01"])).toBeDefined()); // the trip after this one, which nothing has asked for
    expect(paths.filter((path) => path === "/api/trips/2026-08-01")).toHaveLength(1);
    // The heat is on, and is asked for of the dates of the trips that were shown (New York's and Lisbon's); a neighbour that was only
    // prefetched is not shown, and its heat is not asked for. No day and no range is asked for.
    await waitFor(() => expect(periodRequests(paths)).toContain("/api/heat?from=2026-09-12&to=2026-09-16"));
    expect(periodRequests(paths).filter((path) => !path.startsWith("/api/heat"))).toEqual([]);
    expect(periodRequests(paths)).not.toContain("/api/heat?from=2026-08-01&to=2026-08-03");

    fireEvent.click(screen.getByRole("button", { name: "Older trip" }));

    expect(await screen.findByRole("heading", { level: 1, name: "Copenhagen" })).toBeInTheDocument(); // from the cache: the prefetch's one request
    expect(paths.filter((path) => path === "/api/trips/2026-08-01")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Older trip" })).toBeDisabled();
  });

  test("App_leaves_a_trip_that_the_server_does_not_have_as_Trip_with_no_period_asked_for", async () => {
    window.history.replaceState(null, "", "/trip/2026-01-01");
    const paths = stubApi(answerWithTrips);

    const { client } = renderApp();

    expect(await screen.findByRole("heading", { level: 1, name: "Trip" })).toBeInTheDocument();
    await waitFor(() => expect(client.getQueryState(["trips"])?.status).toBe("success")); // the list is there...
    await act(async () => await new Promise((resolve) => setTimeout(resolve, 0))); // ...and the bar has been told so
    expect(paths).toContain("/api/trips");
    expect(periodRequests(paths)).toEqual([]);
    expect(screen.getByRole("button", { name: "Older trip" })).toBeDisabled(); // the trip is not in it: no trip is older or newer than it
    expect(screen.getByRole("button", { name: "Newer trip" })).toBeDisabled();
  });
});

describe("App settings", () => {
  const OSLO_DAY = flightDay as DayResponse;
  const answerWithTheFlight: Answer = (path) =>
    path.startsWith("/api/heat") ? Response.json({ maxSeconds: 0, cells: [] } satisfies HeatResponse) : path.endsWith("2026-10-22") ? Response.json(OSLO_DAY) : answerEmpty(path);
  const details = () => screen.getByRole("region", { name: "Details" });
  /** What the app asks for that is a period: a day, a range, a heat. */
  const periodRequests = (paths: string[]) => paths.filter((path) => /^\/api\/(day|range|heat)/.test(path));

  // The heat is on, as the owner left it: the map of the view that the settings were opened from has its glow, which stays.
  beforeEach(() => {
    window.localStorage.setItem("heat", "true");
  });
  afterEach(() => {
    window.localStorage.removeItem("heat");
  });

  test("App_opens_the_settings_with_the_gear_shows_processing_and_about_and_leaves_the_map_as_it_was", async () => {
    const paths = stubApi(answerWithTheFlight);
    renderApp();
    await waitFor(() => expect(mapProps().fitTo).not.toBeNull());
    await waitFor(() => expect(paths).toContain("/api/heat?from=2026-10-22&to=2026-10-22"));
    await waitFor(() => expect(mapProps().data.heat).toBeDefined());
    const { data, fitTo, home } = mapProps();
    const before = periodRequests(paths).length;

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));

    expect(window.location.pathname).toBe("/settings");
    expect(screen.getByRole("heading", { level: 1, name: "Settings" })).toBeInTheDocument(); // in the bar, in the place of the date
    expect(within(details()).getByRole("region", { name: "Processing" })).toBeInTheDocument();
    expect(within(details()).getByRole("region", { name: "About" })).toBeInTheDocument();
    expect(await within(details()).findByText("Nothing has failed")).toBeInTheDocument();
    // The map is the day's still: the same collections, nothing to bring it anywhere, and its heat button.
    expect(mapProps().data).toBe(data);
    expect(mapProps().fitTo).toBe(fitTo);
    expect(mapProps().home).toBe(home);
    expect(mapProps().heatToggle).toBeDefined();
    expect(periodRequests(paths)).toHaveLength(before);
  });

  test("App_back_from_the_settings_is_the_day_it_was_opened_from_with_the_map_where_it_was", async () => {
    stubApi(answerWithTheFlight);
    renderApp();
    await waitFor(() => expect(mapProps().fitTo).not.toBeNull());
    const { data, fitTo } = mapProps();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(window.location.pathname).toBe("/settings");

    act(() => window.history.back()); // the browser's own Back

    await waitFor(() => expect(window.location.pathname).toBe("/day/2026-10-22"));
    expect(await screen.findByText("5 places")).toBeInTheDocument();
    expect(mapProps().data).toBe(data); // never cleared, so nothing to draw again
    expect(mapProps().fitTo).toBe(fitTo); // and not brought to the day again
  });

  test("App_draws_nothing_and_asks_for_no_period_for_settings_that_were_opened_as_a_page", async () => {
    window.history.replaceState(null, "", "/settings");
    const paths = stubApi(answerWithTheFlight);

    renderApp();

    expect(await within(details()).findByText("Nothing has failed")).toBeInTheDocument();
    expect(mapProps().data).toEqual({ routes: { type: "FeatureCollection", features: [] } });
    expect(mapProps().fitTo).toBeNull();
    expect(mapProps().heatToggle).toBeUndefined(); // there is no period to show the heat of
    expect(periodRequests(paths)).toEqual([]);
  });

  test("App_goes_from_the_settings_to_a_view_of_time_that_has_its_map_and_its_heat_button_again", async () => {
    stubApi(answerWithTheFlight);
    renderApp();
    await waitFor(() => expect(mapProps().fitTo).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));

    fireEvent.click(screen.getByRole("button", { name: "Week" })); // at the day that was shown last

    expect(window.location.pathname).toBe("/week/2026-10-19");
    expect(screen.getByRole("button", { name: "Settings", pressed: false })).toBeInTheDocument();
    expect(mapProps().heatToggle).toBeDefined();
    await screen.findByText("No data for this period");
  });
});

describe("App edit points", () => {
  const T0 = 1_761_120_000_123_456;
  const POINTS = {
    date: "2026-10-22",
    devices: ["phone"],
    points: [
      [T0, 10.0, 59.0, 0],
      [T0 + 30_000_001, 10.001, 59.001, 0],
      [T0 + 60_000_002, 10.002, 59.002, 0],
      [T0 + 90_000_003, 10.003, 59.003, 0],
    ],
  };
  const details = () => screen.getByRole("region", { name: "Details" });
  const sidebar = () => screen.getByRole("complementary", { name: "Details" });
  const edit = () => mapProps().edit!;

  /** The API with a day to edit, its points, and the writes of edit mode; returns what was asked for (a write with its body). */
  function stubEditing(writes: Record<string, () => Response> = {}) {
    const calls: { method: string; path: string; body: unknown }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        calls.push({ method, path, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
        if (method !== "GET") return (writes[`${method} ${path}`] ?? (() => new Response("{}", { status: 501 })))();
        if (path === "/api/status") return Response.json(STATUS);
        if (path.endsWith("/points")) return Response.json(POINTS);
        return path.endsWith("2026-10-22") ? Response.json(flightDay) : answerEmpty(path);
      }),
    );
    return calls;
  }
  const writesOf = <T extends { method: string }>(calls: T[]): T[] => calls.filter((call) => call.method !== "GET");

  async function intoEditMode() {
    renderApp();
    fireEvent.click(await screen.findByRole("button", { name: "Edit points" }));
    await waitFor(() => expect(mapProps().data.editPoints).toBeDefined());
  }

  test("App_is_not_in_edit_mode_to_begin_with_the_map_has_no_edit_and_no_points_are_asked_for", async () => {
    const calls = stubEditing();
    stubLayout(100);

    renderApp();

    expect(await screen.findByRole("button", { name: "Edit points" })).toBeInTheDocument();
    expect(mapProps().edit).toBeUndefined();
    expect(mapProps().data.editPoints).toBeUndefined();
    expect(calls.some((call) => call.path.endsWith("/points"))).toBe(false);
    expect(screen.queryByRole("group", { name: "Edit points" })).not.toBeInTheDocument();
  });

  test("App_edit_points_turns_edit_mode_on_for_the_panel_and_the_map_which_draws_the_points_of_the_day", async () => {
    const calls = stubEditing();
    stubLayout(100);

    await intoEditMode();

    expect(screen.getByRole("group", { name: "Edit points" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit points" })).not.toBeInTheDocument();
    expect(mapProps().edit).toEqual({ selected: new Set(), area: false, onAreaChange: expect.any(Function), onToggle: expect.any(Function), onSelect: expect.any(Function) });
    expect(mapProps().data.editPoints?.features).toHaveLength(4);
    expect(mapProps().data.routes).toEqual(dayGeoJson(flightDay as DayResponse).routes); // over the day's routes
    expect(calls.filter((call) => call.path.endsWith("/points")).map((call) => call.path)).toEqual(["/api/day/2026-10-22/points"]);
  });

  test("App_brings_a_sheet_that_is_up_down_to_its_peek_when_edit_mode_begins_for_the_map_is_what_is_edited_on", async () => {
    stubEditing();
    stubLayout(100);
    renderApp();
    const button = await screen.findByRole("button", { name: "Edit points" });
    fireEvent.click(screen.getByRole("button", { name: "Resize panel" })); // half
    fireEvent.click(screen.getByRole("button", { name: "Resize panel" })); // full
    expect(details()).toHaveAttribute("data-snap", "full");

    fireEvent.click(button);

    await waitFor(() => expect(details()).toHaveAttribute("data-snap", "peek"));
    expect(screen.getByRole("group", { name: "Edit points" })).toBeInTheDocument(); // and the bar is what a peek shows
  });

  test("App_selects_what_the_map_says_is_tapped_or_drawn_and_the_bar_counts_it", async () => {
    stubEditing();
    stubLayout(100);
    await intoEditMode();
    const bar = () => screen.getByRole("group", { name: "Edit points" });
    expect(within(bar()).getByText("0 selected")).toBeInTheDocument();

    act(() => edit().onToggle(1));
    expect(within(bar()).getByText("1 selected")).toBeInTheDocument();
    expect(edit().selected).toEqual(new Set([1]));

    act(() => edit().onSelect([0, 1, 3]));
    expect(within(bar()).getByText("3 selected")).toBeInTheDocument();
    expect(edit().selected).toEqual(new Set([0, 1, 3]));

    act(() => edit().onToggle(0));
    expect(within(bar()).getByText("2 selected")).toBeInTheDocument();

    fireEvent.click(within(bar()).getByRole("button", { name: "Clear" }));
    expect(within(bar()).getByText("0 selected")).toBeInTheDocument();
    expect(edit().selected.size).toBe(0);
  });

  test("App_select_area_is_the_maps_button_and_the_map_has_what_it_says", async () => {
    stubEditing();
    stubLayout(100);
    await intoEditMode();

    act(() => edit().onAreaChange(true));

    expect(edit().area).toBe(true);
    act(() => edit().onAreaChange(false));
    expect(edit().area).toBe(false);
  });

  test("App_removes_the_selected_points_by_device_and_time_and_says_so_in_a_toast_that_is_not_in_the_panel", async () => {
    const calls = stubEditing({ "POST /api/points/remove": () => Response.json({ batch: "b-7", count: 2 }) });
    stubLayout(100);
    await intoEditMode();
    act(() => edit().onSelect([0, 2]));

    fireEvent.click(screen.getByRole("button", { name: "Remove 2 points" }));

    const toast = await screen.findByText("Removed 2 points");
    expect(writesOf(calls)).toEqual([{ method: "POST", path: "/api/points/remove", body: { points: [{ device: "phone", t: T0 }, { device: "phone", t: T0 + 60_000_002 }] } }]);
    expect(details()).not.toContainElement(toast); // the sheet may be collapsed or scrolled: the toast is the page's
    expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
    expect(edit().selected.size).toBe(0); // done with them
    expect(screen.getByRole("group", { name: "Edit points" })).toBeInTheDocument(); // and still in edit mode
  });

  test("App_undoes_the_removal_from_the_toast", async () => {
    const calls = stubEditing({
      "POST /api/points/remove": () => Response.json({ batch: "b-7", count: 2 }),
      "DELETE /api/points/removed/b-7": () => new Response(null, { status: 204 }),
    });
    stubLayout(100);
    await intoEditMode();
    act(() => edit().onSelect([0, 2]));
    fireEvent.click(screen.getByRole("button", { name: "Remove 2 points" }));
    await screen.findByText("Removed 2 points");

    fireEvent.click(screen.getByRole("button", { name: "Undo" }));

    expect(await screen.findByText("Restored 2 points")).toBeInTheDocument();
    expect(writesOf(calls).map((call) => `${call.method} ${call.path}`)).toEqual(["POST /api/points/remove", "DELETE /api/points/removed/b-7"]);
  });

  test("App_asks_for_the_day_and_the_points_again_after_a_removal", async () => {
    const calls = stubEditing({ "POST /api/points/remove": () => Response.json({ batch: "b-7", count: 1 }) });
    stubLayout(100);
    await intoEditMode();
    act(() => edit().onToggle(0));

    fireEvent.click(screen.getByRole("button", { name: "Remove 1 point" }));

    await screen.findByText("Removed 1 point");
    await waitFor(() => expect(calls.filter((call) => call.method === "GET" && call.path === "/api/day/2026-10-22/points")).toHaveLength(2));
    expect(calls.filter((call) => call.method === "GET" && call.path === "/api/day/2026-10-22").length).toBeGreaterThanOrEqual(2);
  });

  test("App_ends_edit_mode_when_the_owner_leaves_the_day_and_the_toast_stays_to_be_undone", async () => {
    stubEditing({ "POST /api/points/remove": () => Response.json({ batch: "b-7", count: 1 }) });
    stubLayout(100);
    await intoEditMode();
    act(() => edit().onToggle(0));
    fireEvent.click(screen.getByRole("button", { name: "Remove 1 point" }));
    await screen.findByText("Removed 1 point");

    fireEvent.click(screen.getByRole("button", { name: "Week" }));

    await waitFor(() => expect(window.location.pathname).toBe("/week/2026-10-19"));
    expect(mapProps().edit).toBeUndefined();
    expect(mapProps().data.editPoints).toBeUndefined();
    expect(screen.queryByRole("group", { name: "Edit points" })).not.toBeInTheDocument();
    expect(screen.getByText("Removed 1 point")).toBeInTheDocument(); // the owner may still want it back
    expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
  });

  test("App_ends_edit_mode_and_clears_the_selection_when_the_date_changes", async () => {
    stubEditing();
    stubLayout(100);
    await intoEditMode();
    act(() => edit().onToggle(2));

    fireEvent.click(screen.getByRole("button", { name: "Next day" }));

    await waitFor(() => expect(window.location.pathname).toBe("/day/2026-10-23"));
    expect(mapProps().edit).toBeUndefined();
    expect(screen.queryByRole("group", { name: "Edit points" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Previous day" }));
    await waitFor(() => expect(window.location.pathname).toBe("/day/2026-10-22"));
    expect(mapProps().edit).toBeUndefined(); // back on the day: not in edit mode, and nothing is still selected
    expect(await screen.findByRole("button", { name: "Edit points" })).toBeInTheDocument();
  });

  test("App_done_ends_edit_mode_and_the_focus_goes_back_to_the_edit_points_button", async () => {
    stubEditing();
    stubLayout(100);
    await intoEditMode();
    act(() => edit().onToggle(1));
    act(() => edit().onAreaChange(true));

    fireEvent.click(within(screen.getByRole("group", { name: "Edit points" })).getByRole("button", { name: "Done" }));

    expect(mapProps().edit).toBeUndefined();
    expect(mapProps().data.editPoints).toBeUndefined();
    expect(screen.getByRole("button", { name: "Edit points" })).toHaveFocus();
  });

  test("App_has_the_edit_bar_in_the_sidebar_on_a_desktop", async () => {
    stubDesktop(true);
    stubEditing();
    stubLayout(110);

    await intoEditMode();

    expect(within(sidebar()).getByRole("group", { name: "Edit points" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Details" })).not.toBeInTheDocument();
  });

  test("App_keeps_a_status_for_the_toast_on_the_day_view_so_that_a_removal_that_finishes_after_done_is_announced_in_it", async () => {
    let release: (response: Response) => void = () => undefined;
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string, init?: RequestInit) => {
        calls.push(`${init?.method ?? "GET"} ${path}`);
        if (init?.method === "POST") return new Promise<Response>((resolve) => (release = resolve));
        if (path === "/api/status") return Response.json(STATUS);
        if (path.endsWith("/points")) return Response.json(POINTS);
        return path.endsWith("2026-10-22") ? Response.json(flightDay) : answerEmpty(path);
      }),
    );
    stubLayout(100);
    renderApp();
    await screen.findByRole("button", { name: "Edit points" });

    // There before edit mode, and empty: it is what the message is put into, whenever it comes.
    const empty = screen.getAllByRole("status").filter((status) => status.textContent === "");
    expect(empty).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Edit points" }));
    await waitFor(() => expect(mapProps().data.editPoints).toBeDefined());
    act(() => edit().onToggle(1));
    fireEvent.click(screen.getByRole("button", { name: "Remove 1 point" }));
    await waitFor(() => expect(calls).toContain("POST /api/points/remove"));
    fireEvent.click(within(screen.getByRole("group", { name: "Edit points" })).getByRole("button", { name: "Done" })); // the removal is still on its way
    expect(screen.queryByRole("group", { name: "Edit points" })).not.toBeInTheDocument();

    await act(async () => release(Response.json({ batch: "b-9", count: 1 })));

    await waitFor(() => expect(empty[0]).toHaveTextContent("Removed 1 point")); // the one that was there: a region is announced when what is in it changes
    expect(screen.getAllByRole("status").filter((status) => status.textContent === "")).toHaveLength(0);
  });

  test("App_has_no_status_for_toasts_on_the_other_views_until_there_is_a_toast", async () => {
    stubEditing();
    window.history.replaceState(null, "", "/week/2026-10-19");
    stubLayout(100);

    renderApp();

    await screen.findByText("No data for this period");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  test("App_has_no_edit_points_button_on_the_other_views", async () => {
    stubEditing();
    window.history.replaceState(null, "", "/week/2026-10-19");
    stubLayout(100);

    renderApp();

    await screen.findByText("No data for this period");
    expect(screen.queryByRole("button", { name: "Edit points" })).not.toBeInTheDocument();
    expect(mapProps().edit).toBeUndefined();
  });
});
