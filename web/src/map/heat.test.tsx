import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { DayResponse, HeatResponse, RangeResponse, StatusResponse } from "../api/types";
import { App } from "../app/App";
import { navigate } from "../app/router";
import { useStoredFlag } from "../app/useStoredFlag";

// The shell as the owner has it: the real App with the real map control, from the button to the request. jsdom has no WebGL, so the map
// itself cannot start (which is a state of MapView's: it says "Map unavailable", draws nothing, and its buttons are there). What the
// map is given of the heat, and what it does with it, is for the tests of `useViewMap` and of `MapView`.
vi.mock("maplibre-gl", () => ({
  MapLibreMap: class {
    constructor() {
      throw new Error("No WebGL here.");
    }
  },
  setWorkerUrl: () => undefined,
}));

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

const HEAT: HeatResponse = { maxSeconds: 7200, cells: [[10.7, 59.9, 7200], [10.71, 59.91, 3600]] };

const datesOf = (path: string): [string, string] => {
  const query = new URLSearchParams(path.split("?")[1]);
  return [query.get("from")!, query.get("to")!];
};

/** What the API answers for a request: a day and a period with nothing in them, the heat of `heat`, and the config and status. */
function answerFor(path: string, heat: () => Response): Response {
  if (path === "/api/status") return Response.json(STATUS);
  if (path === "/api/config") return Response.json({ mapStyleLight: "/style-light.json", mapStyleDark: "/style-dark.json" });
  if (path.startsWith("/api/heat")) return heat();
  if (path.startsWith("/api/range")) {
    const [from, to] = datesOf(path);
    const range: RangeResponse = { from, to, state: "done", summary: { places: 0, distanceMeters: 0, movingSeconds: 0, moves: 0 }, moves: [], places: [], days: [] };
    return Response.json(range);
  }
  const date = path.split("/").pop()!;
  const day: DayResponse = { date, timeZone: "Europe/Oslo", state: "done", summary: { places: 0, distanceMeters: 0, movingSeconds: 0 }, segments: [] };
  return Response.json(day);
}

/** Answers the API (the heat by `heat`, which a test changes to change what the next request finds); returns the paths asked for. */
function stubApi(heat: () => Response = () => Response.json(HEAT)): string[] {
  const paths: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string) => {
      paths.push(path);
      return answerFor(path, heat);
    }),
  );
  return paths;
}

const heatPaths = (paths: string[]): string[] => paths.filter((path) => path.startsWith("/api/heat"));

/**
 * A visit to the app: its own query cache, as a page that is loaded again has. Not in StrictMode, which in development mounts every
 * component twice and so asks for what it shows twice (the first request is cancelled): the page as built asks once, and that is what
 * these tests count.
 */
function visit() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>,
  );
}

const heatButton = () => screen.getByRole("button", { name: "Heat map" });

beforeEach(() => {
  // The flag is kept in memory for as long as the page lives (see `useStoredFlag`), which for these tests is all of them: start each off.
  window.localStorage.clear();
  const flag = renderHook(() => useStoredFlag("heat", false));
  act(() => flag.result.current[1](false));
  window.localStorage.clear();
  flag.unmount();
  window.history.replaceState(null, "", "/month/2026-10");
});

describe("the heat toggle", () => {
  test("heat_toggle_is_remembered_and_fetches_only_when_on", async () => {
    const paths = stubApi();
    const first = visit();
    await waitFor(() => expect(paths).toContain("/api/range?from=2026-11-01&to=2026-11-30")); // the months either side were asked for
    expect(heatButton()).toHaveAttribute("aria-pressed", "false");
    expect(heatPaths(paths)).toEqual([]); // off: no request for it at all, not for the month and not for the ones either side

    fireEvent.click(heatButton());

    expect(heatButton()).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(heatPaths(paths)).toEqual(["/api/heat?from=2026-10-01&to=2026-10-31"]));
    await act(async () => undefined);
    expect(heatPaths(paths)).toHaveLength(1); // once, for the period, and not for its neighbours
    expect(window.localStorage.getItem("heat")).toBe("true");

    // The page is loaded again (a new cache): the choice is where it was left, and the heat is asked for as soon as the month is.
    first.unmount();
    const again = stubApi();
    const second = visit();
    expect(heatButton()).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(heatPaths(again)).toEqual(["/api/heat?from=2026-10-01&to=2026-10-31"]));

    fireEvent.click(heatButton()); // off again, and remembered
    expect(heatButton()).toHaveAttribute("aria-pressed", "false");
    expect(window.localStorage.getItem("heat")).toBe("false");
    await act(async () => undefined);
    expect(heatPaths(again)).toHaveLength(1);
    second.unmount();
    const last = stubApi();
    visit();
    await waitFor(() => expect(last).toContain("/api/range?from=2026-10-01&to=2026-10-31"));
    expect(heatButton()).toHaveAttribute("aria-pressed", "false");
    expect(heatPaths(last)).toEqual([]);
  });

  test("heat_asks_for_the_dates_of_the_period_at_every_time_scale", async () => {
    const scales: [path: string, heat: string][] = [
      ["/day/2026-10-22", "/api/heat?from=2026-10-22&to=2026-10-22"],
      ["/week/2026-10-19", "/api/heat?from=2026-10-19&to=2026-10-25"],
      ["/month/2026-10", "/api/heat?from=2026-10-01&to=2026-10-31"],
      ["/year/2026", "/api/heat?from=2026-01-01&to=2026-12-31"],
      ["/range/2026-10-05..2026-10-12", "/api/heat?from=2026-10-05&to=2026-10-12"],
    ];
    for (const [index, [path, heat]] of scales.entries()) {
      window.history.replaceState(null, "", path);
      const paths = stubApi();
      const view = visit();

      if (index === 0) fireEvent.click(heatButton()); // turned on once: it stays on for the other scales, as it is remembered

      expect(heatButton()).toHaveAttribute("aria-pressed", "true");
      await waitFor(() => expect(heatPaths(paths)).toEqual([heat]));
      view.unmount();
    }
  });

  test("heat_stays_on_as_the_view_steps_and_is_asked_for_each_period_it_shows", async () => {
    const paths = stubApi();
    visit();
    fireEvent.click(heatButton());
    await waitFor(() => expect(heatPaths(paths)).toHaveLength(1));

    act(() => navigate({ view: "month", month: "2026-11" }));

    expect(heatButton()).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(heatPaths(paths)).toEqual(["/api/heat?from=2026-10-01&to=2026-10-31", "/api/heat?from=2026-11-01&to=2026-11-30"]));
  });

  test("heat_has_no_button_for_a_place_and_asks_for_nothing_there", async () => {
    const paths = stubApi();
    visit();
    fireEvent.click(heatButton());
    await waitFor(() => expect(heatPaths(paths)).toHaveLength(1));

    act(() => navigate({ view: "place", id: 3 })); // a place has no period

    expect(screen.queryByRole("button", { name: "Heat map" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Recenter map" })).toBeInTheDocument(); // the map's other button is there
    await act(async () => undefined);
    expect(heatPaths(paths)).toHaveLength(1);

    act(() => navigate({ view: "day", date: "2026-10-22" })); // and back to a view that has one: the choice was kept

    expect(heatButton()).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(heatPaths(paths)).toHaveLength(2));
    expect(heatPaths(paths)[1]).toBe("/api/heat?from=2026-10-22&to=2026-10-22");
  });
});

describe("a heat that cannot be loaded", () => {
  const note = () => screen.queryByText(/Couldn't load the heat map/);

  test("heat_that_fails_says_so_without_blocking_and_Retry_asks_again", async () => {
    let failing = true;
    const paths = stubApi(() => (failing ? new Response("{}", { status: 500 }) : Response.json(HEAT)));
    visit();
    expect(note()).not.toBeInTheDocument();

    fireEvent.click(heatButton());

    const heatNote = await screen.findByText(/Couldn't load the heat map/);
    expect(heatNote).toHaveAttribute("role", "status"); // a note, not an alert that takes the screen
    expect(heatButton()).toHaveAttribute("aria-pressed", "true"); // the toggle stays where the owner put it
    expect(screen.getByRole("button", { name: "Recenter map" })).toBeInTheDocument(); // and the map goes on

    failing = false;
    fireEvent.click(within(heatNote).getByRole("button", { name: "Retry" })); // the map cannot start here either, and says so with a Retry of its own

    await waitFor(() => expect(note()).not.toBeInTheDocument());
    expect(heatPaths(paths)).toHaveLength(2);
  });

  test("heat_that_failed_is_not_reported_once_it_is_turned_off", async () => {
    stubApi(() => new Response("{}", { status: 500 }));
    visit();
    fireEvent.click(heatButton());
    await screen.findByText(/Couldn't load the heat map/);

    fireEvent.click(heatButton());

    expect(note()).not.toBeInTheDocument();
  });
});
