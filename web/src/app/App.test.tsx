import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { MapPadding, MapViewProps } from "../map/MapView";
import type { DayResponse, StatusResponse } from "../api/types";
import { App } from "./App";
import { navigate } from "./router";

// The map is MapLibre, which jsdom cannot run (MapView.test.tsx has its own double of it). Here the map is a stand-in that
// keeps the props it was given: what the shell hands the map is what these tests are about.
const map = vi.hoisted(() => ({ props: null as unknown }));
vi.mock("../map/MapView", () => ({
  MapView: (props: unknown) => {
    map.props = props;
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

type Answer = (path: string) => Response | Promise<Response>;

/** Answers the API: the status always, everything else by `answer`; returns the paths asked for. */
function stubApi(answer: Answer = (path) => Response.json(day(path.split("/").pop()!))): string[] {
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

function renderApp(client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  return {
    client,
    ...render(
      <StrictMode>
        <QueryClientProvider client={client}>
          <App />
        </QueryClientProvider>
      </StrictMode>,
    ),
  };
}

beforeEach(() => {
  map.props = null;
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
    fireEvent.click(screen.getByRole("button", { name: "Resize panel" })); // full: the viewport less 120
    expect(padding().bottom).toBe(696);

    layout.move(160.4); // the range fields open, say: a taller bar, measured up to the next whole pixel
    expect(padding().top).toBe(177);
  });

  test("App_lets_the_sheet_come_up_only_as_far_as_the_bar_allows", () => {
    stubApi();
    const layout = stubLayout(120); // a bar whose bottom is at 120: the viewport less 120 would just fit under it
    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "Resize panel" }));
    fireEvent.click(screen.getByRole("button", { name: "Resize panel" }));
    expect(padding().bottom).toBe(800 - 128 + 16); // 120 and a few pixels of air to the bar: 128 is the room

    layout.move(60); // a small bar: the sheet keeps to the 120 px that it is specified to leave
    expect(padding().bottom).toBe(800 - 120 + 16);

    layout.move(200); // a tall one (the range fields), or one under a notch
    expect(padding().bottom).toBe(800 - 208 + 16);
  });

  test("App_keeps_the_padding_object_while_no_number_in_it_changes", () => {
    stubApi();
    stubLayout(120);
    renderApp();
    const before = padding();

    act(() => mapProps().onStyleError?.(new Error("no style"))); // the app renders again, for another reason
    act(() => mapProps().onStyleLoad?.());

    expect(padding()).toBe(before);

    fireEvent.click(screen.getByRole("button", { name: "Resize panel" })); // and now a number does change
    expect(padding()).not.toBe(before);
    expect(padding().bottom).toBe(416);
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
    expect(await screen.findByText("3 segments")).toBeInTheDocument();
  });

  test("App_is_one_landmark_and_the_map_is_in_it", () => {
    stubApi();

    renderApp();

    expect(screen.getByRole("main")).toContainElement(screen.getByRole("region", { name: "Map view" }));
  });
});

describe("App map note", () => {
  test("App_notes_that_the_map_is_unavailable_until_a_style_loads", () => {
    stubApi();
    renderApp();
    expect(screen.queryByText("Map unavailable")).not.toBeInTheDocument();

    act(() => mapProps().onStyleError?.(new Error("blocked")));
    expect(screen.getByRole("status")).toHaveTextContent("Map unavailable");

    act(() => mapProps().onStyleError?.(new Error("blocked again")));
    expect(screen.getAllByText("Map unavailable")).toHaveLength(1);

    act(() => mapProps().onStyleLoad?.()); // the other colour scheme's style loaded: the map is back
    expect(screen.queryByText("Map unavailable")).not.toBeInTheDocument();
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

    act(() => mapProps().onStyleError?.(new Error("no style")));
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
    expect(await screen.findByText("3 segments")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Next day" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't load — Retry");
    expect(screen.getByText("3 segments")).toBeInTheDocument(); // the day that was shown stays under the error
    expect(screen.getByRole("heading")).toHaveTextContent("Friday 23 October");

    failing = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByText("1 segment")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByText("3 segments")).not.toBeInTheDocument();
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
    expect(screen.getByText("0 segments")).toBeInTheDocument();
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
  });

  test("App_shows_the_error_with_no_previous_day_when_the_first_day_fails", async () => {
    stubApi(() => new Response("{}", { status: 500 }));

    renderApp();

    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't load — Retry");
    expect(screen.queryByText(/segments?$/)).not.toBeInTheDocument();
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
    ] as const) {
      act(() => navigate(route));
      expect(screen.getByRole("region", { name: "Details" })).not.toBeEmptyDOMElement();
    }
  });
});
