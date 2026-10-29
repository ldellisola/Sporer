import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ApiError } from "./client";
import {
  createQueryClient,
  dayPointsQueryOptions,
  dayQueryOptions,
  forgetEditedDays,
  noteDayEdited,
  pendingInterval,
  prefetchNeighbours,
  rangeQueryOptions,
  refreshInterval,
  shownOf,
  tripNeighbours,
  tripQueryOptions,
  tripsQueryOptions,
  useConfig,
  useDay,
  useDayPoints,
  useCandidates,
  useDeletedTrips,
  useHeat,
  useHomes,
  usePlace,
  usePlaceSearch,
  useRange,
  useRemovedPoints,
  useSettings,
  useStatus,
  useTrip,
  useTrips,
} from "./queries";
import type {
  DayResponse,
  DeletedTrip,
  HomesResponse,
  LoadState,
  PlaceResponse,
  RangeResponse,
  RemovedBatch,
  SettingsResponse,
  TripListItem,
  TripResponse,
  TripsResponse,
} from "./types";

const SUMMARY = { places: 0, distanceMeters: 0, movingSeconds: 0 };

function day(date: string, state: LoadState = "done"): DayResponse {
  return { date, timeZone: "Europe/Oslo", state, summary: SUMMARY, segments: [] };
}

function range(from: string, to: string, state: LoadState = "done"): RangeResponse {
  return { from, to, state, summary: { ...SUMMARY, moves: 0 }, moves: [], places: [], days: [] };
}

/** A trip of the list, with only what tells it from the others: its id (the date of its first night) and its length. */
function listed(id: string, nights = 2): TripListItem {
  return {
    id,
    name: "Lisbon",
    firstNight: id,
    lastNight: id,
    nights,
    start: `${id}T07:00:00Z`,
    end: `${id}T18:00:00Z`,
    startTimeZone: "Europe/Oslo",
    endTimeZone: "Europe/Oslo",
    localStartDate: id,
    localEndDate: id,
    ongoing: false,
    edited: false,
    ownName: null,
    startEdited: false,
    endEdited: false,
    cities: [{ name: "Lisbon", country: "Portugal", nights, lat: 38.72, lon: -9.14 }],
    thumbnail: [
      [10.75, 59.91],
      [-9.14, 38.72],
    ],
  };
}

const tripsOf = (...ids: string[]): TripsResponse => ({ trips: ids.map((id) => listed(id)) });

/** A trip's own page, with no stay, move or day in it. */
function trip(id: string): TripResponse {
  const { thumbnail: _thumbnail, ...summary } = listed(id);
  return { ...summary, stats: { flights: 0, cities: 1, places: 1, groundDistanceMeters: 0 }, moves: [], days: [] };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** Stubs `fetch` with `answer`, which gets the URL; returns the URLs asked for, in order. */
function stubApi(answer: (url: string) => Response | Promise<Response>): string[] {
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      urls.push(url);
      return answer(url);
    }),
  );
  return urls;
}

function newClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function wrapperFor(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

/**
 * Moves the fake clock on and lets what that sets off finish. TanStack Query tells React about a change through a
 * zero-delay timer, which the fake clock runs one millisecond later, so a test that has just seen an answer arrive ticks 1.
 */
const tick = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

afterEach(() => {
  vi.useRealTimers();
  forgetEditedDays();
});

describe("query hooks", () => {
  test("hooks_ask_the_api_paths_the_server_serves", async () => {
    const urls = stubApi(() => json({}));
    const client = newClient();

    const { result } = renderHook(
      () => ({
        day: useDay("2026-10-22"),
        points: useDayPoints("2026-10-22"),
        range: useRange("2026-10-19", "2026-10-25"),
        heat: useHeat("2026-10-19", "2026-10-25", true),
        place: usePlace(7),
        trips: useTrips(),
        trip: useTrip("2026-09-12"),
        status: useStatus(),
        config: useConfig(),
      }),
      { wrapper: wrapperFor(client) },
    );

    await waitFor(() => {
      for (const query of Object.values(result.current)) expect(query.isSuccess).toBe(true);
    });
    expect([...urls].sort()).toEqual(
      [
        "/api/config",
        "/api/day/2026-10-22",
        "/api/day/2026-10-22/points",
        "/api/heat?from=2026-10-19&to=2026-10-25",
        "/api/places/7",
        "/api/range?from=2026-10-19&to=2026-10-25",
        "/api/status",
        "/api/trips",
        "/api/trips/2026-09-12",
      ].sort(),
    );
  });

  test("useDayPoints_asks_for_nothing_without_a_date_or_while_it_is_not_enabled_even_when_everything_is_refetched", async () => {
    const urls = stubApi(() => json({ date: "2026-10-22", devices: [], points: [] }));
    const client = newClient();
    const { result, rerender } = renderHook(({ date, enabled }: { date: string | null; enabled: boolean }) => useDayPoints(date, enabled), {
      wrapper: wrapperFor(client),
      initialProps: { date: null as string | null, enabled: true },
    });

    await act(() => client.refetchQueries());
    expect(urls).toEqual([]); // no day: nothing is asked for
    rerender({ date: "2026-10-22", enabled: false });
    await act(() => client.refetchQueries());
    expect(urls).toEqual([]); // not in edit mode: the points of a day are heavy, and only edit mode has a use for them

    rerender({ date: "2026-10-22", enabled: true });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(urls).toEqual(["/api/day/2026-10-22/points"]);
  });

  test("useDayPoints_keeps_the_points_of_no_other_day_for_the_day_that_loads", async () => {
    stubApi((url) => (url.includes("2026-10-23") ? new Promise<Response>(() => undefined) : json({ date: "2026-10-22", devices: ["a"], points: [[1, 10, 59, 0]] })));
    const { result, rerender } = renderHook(({ date }: { date: string }) => useDayPoints(date), {
      wrapper: wrapperFor(newClient()),
      initialProps: { date: "2026-10-22" },
    });
    await waitFor(() => expect(result.current.data?.date).toBe("2026-10-22"));

    rerender({ date: "2026-10-23" });

    expect(result.current.data).toBeUndefined(); // the dots of one day under another would be wrong, not just old
  });

  test("useDay_keeps_the_previous_day_while_the_next_loads", async () => {
    let releaseSecond: (response: Response) => void = () => {};
    const second = new Promise<Response>((resolve) => (releaseSecond = resolve));
    stubApi((url) => (url.endsWith("2026-10-22") ? json(day("2026-10-22")) : second));
    const client = newClient();
    const { result, rerender } = renderHook(({ date }) => useDay(date), {
      initialProps: { date: "2026-10-22" },
      wrapper: wrapperFor(client),
    });
    await waitFor(() => expect(result.current.data?.date).toBe("2026-10-22"));
    expect(result.current.isPlaceholderData).toBe(false);

    rerender({ date: "2026-10-23" });

    expect(result.current.data?.date).toBe("2026-10-22"); // still on screen
    expect(result.current.isPlaceholderData).toBe(true);
    expect(result.current.isFetching).toBe(true);

    await act(async () => releaseSecond(json(day("2026-10-23"))));
    await waitFor(() => expect(result.current.data?.date).toBe("2026-10-23"));
    expect(result.current.isPlaceholderData).toBe(false);
  });

  test("useDay_with_no_date_asks_for_nothing_even_when_every_day_is_refetched", async () => {
    const urls = stubApi(() => json(day("2026-10-22")));
    const client = newClient();
    const { result } = renderHook(() => useDay(null), { wrapper: wrapperFor(client) });

    await act(async () => undefined);
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["day"] });
      await client.refetchQueries({ queryKey: ["day"] });
    });

    expect(urls).toEqual([]); // the view on show is not a day, and no day is asked for as `/api/day/`
    expect(result.current.fetchStatus).toBe("idle");
    expect(result.current.data).toBeUndefined();
  });

  test("useDay_can_leave_the_previous_day_to_its_caller_while_the_next_loads", async () => {
    let releaseSecond: (response: Response) => void = () => {};
    const second = new Promise<Response>((resolve) => (releaseSecond = resolve));
    stubApi((url) => (url.endsWith("2026-10-22") ? json(day("2026-10-22")) : second));
    const { result, rerender } = renderHook(({ date }) => useDay(date, false), {
      initialProps: { date: "2026-10-22" },
      wrapper: wrapperFor(newClient()),
    });
    await waitFor(() => expect(result.current.data?.date).toBe("2026-10-22"));

    rerender({ date: "2026-10-23" });

    expect(result.current.data).toBeUndefined(); // no placeholder: what is kept is the caller's to keep
    await act(async () => releaseSecond(json(day("2026-10-23"))));
    await waitFor(() => expect(result.current.data?.date).toBe("2026-10-23"));
  });

  test("useDay_has_no_previous_day_to_show_after_a_visit_to_where_there_is_no_day", async () => {
    // The placeholder is the data of the last query that had any: through a null date too, so that a day the owner left comes back.
    stubApi((url) => (url.endsWith("2026-10-22") ? json(day("2026-10-22")) : new Promise<Response>(() => undefined)));
    const { result, rerender } = renderHook(({ date }: { date: string | null }) => useDay(date, false), {
      initialProps: { date: "2026-10-22" as string | null },
      wrapper: wrapperFor(newClient()),
    });
    await waitFor(() => expect(result.current.data?.date).toBe("2026-10-22"));

    rerender({ date: null });
    rerender({ date: "2026-10-23" });

    expect(result.current.data).toBeUndefined();
  });

  test("useRange_with_no_period_asks_for_nothing_even_when_every_range_is_refetched", async () => {
    const urls = stubApi(() => json(range("2026-10-19", "2026-10-25")));
    const client = newClient();
    const { result } = renderHook(() => useRange(null, null, false), { wrapper: wrapperFor(client) });

    await act(async () => undefined);
    await act(async () => {
      await client.refetchQueries({ queryKey: ["range"] });
    });

    expect(urls).toEqual([]); // the view on show is not a period, and no range is asked for as `/api/range?from=null&to=null`
    expect(result.current.fetchStatus).toBe("idle");
    expect(result.current.data).toBeUndefined();
  });

  test("useRange_keeps_the_previous_period_while_the_next_loads_unless_told_not_to", async () => {
    let releaseSecond: (response: Response) => void = () => {};
    const second = new Promise<Response>((resolve) => (releaseSecond = resolve));
    stubApi((url) => (url.includes("from=2026-10-19") ? json(range("2026-10-19", "2026-10-25")) : second));
    const kept = renderHook(({ from, to }) => useRange(from, to), {
      initialProps: { from: "2026-10-19", to: "2026-10-25" },
      wrapper: wrapperFor(newClient()),
    });
    await waitFor(() => expect(kept.result.current.data?.from).toBe("2026-10-19"));

    kept.rerender({ from: "2026-10-26", to: "2026-11-01" });

    expect(kept.result.current.data?.from).toBe("2026-10-19"); // still on screen
    expect(kept.result.current.isPlaceholderData).toBe(true);
    await act(async () => releaseSecond(json(range("2026-10-26", "2026-11-01"))));
    await waitFor(() => expect(kept.result.current.data?.from).toBe("2026-10-26"));
  });

  test("useRange_can_leave_the_previous_period_to_its_caller_and_has_none_after_a_visit_to_where_there_is_no_period", async () => {
    stubApi((url) => (url.includes("from=2026-10-19") ? json(range("2026-10-19", "2026-10-25")) : new Promise<Response>(() => undefined)));
    const { result, rerender } = renderHook(
      ({ from, to }: { from: string | null; to: string | null }) => useRange(from, to, false),
      { initialProps: { from: "2026-10-19", to: "2026-10-25" } as { from: string | null; to: string | null }, wrapper: wrapperFor(newClient()) },
    );
    await waitFor(() => expect(result.current.data?.from).toBe("2026-10-19"));

    rerender({ from: "2026-10-26", to: "2026-11-01" });
    expect(result.current.data).toBeUndefined(); // no placeholder: what is kept is the caller's to keep

    rerender({ from: "2026-10-19", to: "2026-10-25" });
    await waitFor(() => expect(result.current.data?.from).toBe("2026-10-19"));
    rerender({ from: null, to: null });
    rerender({ from: "2026-10-26", to: "2026-11-01" });
    expect(result.current.data).toBeUndefined(); // the placeholder is the last data there was, through a null period too: not here
  });

  test("useDay_refetches_every_30_seconds_only_while_pending", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-12-01T12:00:00Z")); // a day that is not today, which is asked for as long as it is pending and no longer
    let state: LoadState = "pending";
    const urls = stubApi(() => json(day("2026-10-22", state)));
    const client = newClient();
    const { result } = renderHook(() => useDay("2026-10-22"), { wrapper: wrapperFor(client) });
    await tick(1);
    expect(result.current.data?.state).toBe("pending");
    expect(urls).toHaveLength(1);

    await tick(29_000);
    expect(urls).toHaveLength(1);
    await tick(2_000);
    expect(urls).toHaveLength(2); // 30 s after the first answer, still pending

    state = "done";
    await tick(30_000);
    await tick(1);
    expect(urls).toHaveLength(3);
    expect(result.current.data?.state).toBe("done");

    await tick(120_000);
    expect(urls).toHaveLength(3); // done: nothing more is asked
  });

  // Plan 4: an edit of the points queues the rebuild of the day at once, and the worker has it done within seconds: a day that is pending
  // after an edit is asked for every 3 seconds for two minutes, and after that as every pending day is.
  test("useDay_refetches_every_3_seconds_while_pending_for_two_minutes_after_an_edit_and_every_30_after_that", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-12-01T12:00:00Z")); // a day that is not today
    const edited = Date.now();
    const asked: number[] = []; // when each request was made, in seconds after the edit
    stubApi(() => {
      asked.push((Date.now() - edited) / 1000);
      return json(day("2026-10-22", "pending"));
    });
    noteDayEdited("2026-10-22");
    renderHook(() => useDay("2026-10-22"), { wrapper: wrapperFor(newClient()) });

    await tick(240_000);

    const gaps = asked.slice(1).map((at, i) => Math.round(at - asked[i]!));
    const inTheWindow = asked.filter((at) => at < 120).length;
    expect(gaps.slice(0, inTheWindow - 1)).toEqual(Array.from({ length: inTheWindow - 1 }, () => 3)); // one every 3 s...
    expect(inTheWindow).toBeGreaterThanOrEqual(40);
    expect(gaps.slice(inTheWindow)).toEqual(Array.from({ length: gaps.length - inTheWindow }, () => 30)); // ...then one every 30 s
    expect(asked.length - inTheWindow).toBeGreaterThanOrEqual(3);
    expect(asked.length - inTheWindow).toBeLessThanOrEqual(5);
  });

  test("useDay_that_is_pending_with_no_edit_is_still_asked_for_every_30_seconds", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-12-01T12:00:00Z"));
    const urls = stubApi(() => json(day("2026-10-22", "pending")));
    noteDayEdited("2026-10-25"); // two days on: not this one, nor a neighbour of it
    renderHook(() => useDay("2026-10-22"), { wrapper: wrapperFor(newClient()) });
    await tick(1);

    await tick(29_000);
    expect(urls).toHaveLength(1);
    await tick(2_000);
    expect(urls).toHaveLength(2);
  });

  test("useDay_stops_asking_every_3_seconds_when_the_rebuilt_day_comes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-12-01T12:00:00Z"));
    let state: LoadState = "pending";
    const urls = stubApi(() => json(day("2026-10-22", state)));
    noteDayEdited("2026-10-22");
    const { result } = renderHook(() => useDay("2026-10-22"), { wrapper: wrapperFor(newClient()) });
    await tick(1);
    await tick(3_000);
    expect(urls).toHaveLength(2);

    state = "done";
    await tick(3_000);
    await tick(1);
    expect(result.current.data?.state).toBe("done");
    const done = urls.length;
    await tick(120_000);
    expect(urls).toHaveLength(done); // done: nothing more is asked
  });

  test("useRange_refetches_every_30_seconds_only_while_pending", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-12-01T12:00:00Z")); // a period that does not hold today
    let state: LoadState = "pending";
    const urls = stubApi(() => json(range("2026-10-19", "2026-10-25", state)));
    const client = newClient();
    const { result } = renderHook(() => useRange("2026-10-19", "2026-10-25"), { wrapper: wrapperFor(client) });
    await tick(1);
    expect(result.current.data?.state).toBe("pending");

    await tick(31_000);
    expect(urls).toHaveLength(2);

    state = "done";
    await tick(30_000);
    await tick(1);
    expect(result.current.data?.state).toBe("done");
    await tick(120_000);
    expect(urls).toHaveLength(3);
  });

  // Spec 4.2: today refreshes as new data is processed. Points keep arriving while the app is open, and a day that is "done" is done of
  // the points there were; so a day or a period that holds today is asked for again every minute, whatever its state says.
  test("useDay_of_today_refetches_every_60_seconds_even_when_done_and_stops_when_the_day_has_passed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-22T14:58:30Z")); // 23:58:30 on the 22nd in Tokyo, where the unit tests run: the day ends in 90 s
    const urls = stubApi(() => json(day("2026-10-22", "done")));
    const client = newClient();
    renderHook(() => useDay("2026-10-22"), { wrapper: wrapperFor(client) });
    await tick(1);
    expect(urls).toHaveLength(1);

    await tick(59_000);
    expect(urls).toHaveLength(1);
    await tick(2_000);
    expect(urls).toHaveLength(2); // a minute after the first answer, 23:59:30
    await tick(10 * 60_000);
    expect(urls).toHaveLength(2); // midnight has come: it is yesterday's, and is no longer asked for (the rule is read again every 30 s)
  });

  test("useRange_of_a_period_that_holds_today_refetches_every_60_seconds_even_when_done", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-22T10:00:00Z"));
    const week = stubApi(() => json(range("2026-10-19", "2026-10-25")));
    const client = newClient();
    renderHook(() => useRange("2026-10-19", "2026-10-25"), { wrapper: wrapperFor(client) });
    await tick(1);

    await tick(61_000);
    expect(week).toHaveLength(2);
    await tick(60_000);
    expect(week).toHaveLength(3);
  });

  test("useDay_of_a_day_that_is_not_today_is_not_asked_for_again_once_it_is_done", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-22T10:00:00Z"));
    const urls = stubApi(() => json(day("2026-10-21", "done")));
    renderHook(() => useDay("2026-10-21"), { wrapper: wrapperFor(newClient()) });
    await tick(1);

    await tick(10 * 60_000);

    expect(urls).toHaveLength(1);
  });

  test("useDay_of_today_that_could_not_be_loaded_is_asked_for_again_a_minute_later", async () => {
    // The VPN is not up yet when the app is opened: the day says so, and finds its way back by itself.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-22T10:00:00Z"));
    let up = false;
    const urls = stubApi(() => (up ? json(day("2026-10-22")) : new Response("{}", { status: 503 })));
    const { result } = renderHook(() => useDay("2026-10-22"), { wrapper: wrapperFor(newClient()) });
    await tick(1);
    expect(result.current.isError).toBe(true);

    up = true;
    await tick(61_000);

    expect(urls).toHaveLength(2);
    expect(result.current.data?.date).toBe("2026-10-22");
  });

  test("useDay_with_no_date_never_polls_even_on_the_day_it_would_have_been", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-22T10:00:00Z"));
    const urls = stubApi(() => json(day("2026-10-22")));
    renderHook(() => useDay(null), { wrapper: wrapperFor(newClient()) });
    await tick(1);

    await tick(5 * 60_000);

    expect(urls).toEqual([]);
  });

  test("queries_are_fresh_for_30_seconds", async () => {
    vi.useFakeTimers();
    const urls = stubApi(() => json(day("2026-10-22")));
    const client = newClient();
    const first = renderHook(() => useDay("2026-10-22"), { wrapper: wrapperFor(client) });
    await tick(1);
    first.unmount();

    await tick(29_000);
    const second = renderHook(() => useDay("2026-10-22"), { wrapper: wrapperFor(client) });
    await tick(1);
    expect(second.result.current.data?.date).toBe("2026-10-22");
    expect(urls).toHaveLength(1); // served from the cache

    second.unmount();
    await tick(2_000);
    renderHook(() => useDay("2026-10-22"), { wrapper: wrapperFor(client) });
    await tick(1);
    expect(urls).toHaveLength(2); // stale after 30 s
  });

  test("useHeat_fetches_only_when_enabled", async () => {
    const urls = stubApi(() => json({ maxSeconds: 0, cells: [] }));
    const client = newClient();
    const { result, rerender } = renderHook(({ enabled }) => useHeat("2026-10-19", "2026-10-25", enabled), {
      initialProps: { enabled: false },
      wrapper: wrapperFor(client),
    });

    await act(async () => {});
    expect(urls).toHaveLength(0);
    expect(result.current.fetchStatus).toBe("idle");

    rerender({ enabled: true });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(urls).toEqual(["/api/heat?from=2026-10-19&to=2026-10-25"]);
  });

  test("useHeat_with_no_dates_asks_for_nothing_even_when_enabled", async () => {
    const urls = stubApi(() => json({ maxSeconds: 0, cells: [] }));
    const client = newClient();
    const { result } = renderHook(() => useHeat(null, null, true), { wrapper: wrapperFor(client) });

    await act(async () => undefined);
    await act(async () => {
      await client.refetchQueries({ queryKey: ["heat"] });
    });

    expect(urls).toEqual([]); // a view with no period is not asked for as `/api/heat?from=null&to=null`
    expect(result.current.fetchStatus).toBe("idle");
  });

  test("useHeat_keeps_the_previous_period_while_the_next_loads_unless_told_not_to", async () => {
    stubApi((url) => (url.includes("from=2026-10-19") ? json({ maxSeconds: 5, cells: [] }) : new Promise<Response>(() => undefined)));
    for (const keepPrevious of [true, false]) {
      const { result, rerender, unmount } = renderHook(({ from, to }) => useHeat(from, to, true, keepPrevious), {
        initialProps: { from: "2026-10-19", to: "2026-10-25" },
        wrapper: wrapperFor(newClient()),
      });
      await waitFor(() => expect(result.current.data?.maxSeconds).toBe(5));

      rerender({ from: "2026-10-26", to: "2026-11-01" });

      expect(result.current.data?.maxSeconds, `keepPrevious ${keepPrevious}`).toBe(keepPrevious ? 5 : undefined); // the glow of one period is not another's
      unmount();
    }
  });

  test("usePlace_reports_a_missing_place_as_ApiError_404", async () => {
    stubApi(() => json({ title: "Not Found" }, 404));
    const client = newClient();
    const { result } = renderHook(() => usePlace(404), { wrapper: wrapperFor(client) });

    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(result.current.error).toBeInstanceOf(ApiError);
    expect((result.current.error as ApiError).status).toBe(404);
  });

  // The panels, the bars and the maps of a place and of a trip show them by this, so that what is gone is gone for all of them: one rule for what a
  // 404 does to what a query still holds, whichever the response is.
  describe("shownOf", () => {
    const PLACE = { id: 7, name: "Home" } as PlaceResponse;
    const TRIP = trip("2026-09-12");

    test("shownOf_shows_what_the_query_has", () => {
      expect(shownOf({ data: PLACE, error: null })).toEqual({ gone: false, shown: PLACE });
      expect(shownOf({ data: TRIP, error: null })).toEqual({ gone: false, shown: TRIP });
    });

    test("shownOf_shows_nothing_while_there_is_nothing_yet", () => {
      expect(shownOf<PlaceResponse>({ data: undefined, error: null })).toEqual({ gone: false, shown: undefined });
      expect(shownOf<TripResponse>({ data: undefined, error: null })).toEqual({ gone: false, shown: undefined });
    });

    test("shownOf_drops_what_the_query_still_holds_when_the_server_says_it_is_gone", () => {
      // A 404 is for good: what the query kept from before is not shown any more, on the map or in the panel, of a place or of a trip.
      expect(shownOf({ data: PLACE, error: new ApiError(404, "/api/places/7") })).toEqual({ gone: true, shown: undefined });
      expect(shownOf({ data: undefined, error: new ApiError(404, "/api/places/7") })).toEqual({ gone: true, shown: undefined });
      expect(shownOf({ data: TRIP, error: new ApiError(404, "/api/trips/2026-09-12") })).toEqual({ gone: true, shown: undefined });
    });

    test("shownOf_keeps_what_it_has_under_any_other_failure", () => {
      for (const error of [new ApiError(500, "/api/places/7"), new ApiError(400, "/api/places/7"), new TypeError("Failed to fetch")]) {
        expect(shownOf({ data: PLACE, error }), String(error)).toEqual({ gone: false, shown: PLACE });
        expect(shownOf({ data: TRIP, error }), String(error)).toEqual({ gone: false, shown: TRIP });
      }
    });

    test("shownOf_takes_what_a_query_of_either_kind_holds", async () => {
      // The one function is what the hooks of both are given: the types of their data go through it as they are.
      stubApi(() => json({}, 404));
      const client = newClient();
      const place = renderHook(() => shownOf(usePlace(7)), { wrapper: wrapperFor(client) });
      const aTrip = renderHook(() => shownOf(useTrip("2026-09-12")), { wrapper: wrapperFor(client) });

      await waitFor(() => expect(place.result.current.gone).toBe(true));
      await waitFor(() => expect(aTrip.result.current.gone).toBe(true));
    });
  });

  test("usePlace_with_no_id_asks_for_nothing_even_when_every_place_is_refetched", async () => {
    const urls = stubApi(() => json({}));
    const client = newClient();
    const { result } = renderHook(() => usePlace(null), { wrapper: wrapperFor(client) });

    await act(async () => undefined);
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["place"] });
      await client.refetchQueries({ queryKey: ["place"] });
    });

    expect(urls).toEqual([]); // the view on show is not a place, and none is asked for as `/api/places/null`
    expect(result.current.fetchStatus).toBe("idle");
    expect(result.current.data).toBeUndefined();
  });

  test("usePlace_keeps_no_other_place_for_the_one_that_loads", async () => {
    // The name and the visits of one place under the heading of another would be wrong, and not just old.
    let releaseSecond: (response: Response) => void = () => {};
    stubApi((url) => (url.endsWith("/7") ? json({ id: 7 }) : new Promise<Response>((resolve) => (releaseSecond = resolve))));
    const { result, rerender } = renderHook(({ id }) => usePlace(id), { initialProps: { id: 7 }, wrapper: wrapperFor(newClient()) });
    await waitFor(() => expect(result.current.data?.id).toBe(7));

    rerender({ id: 8 });

    expect(result.current.data).toBeUndefined();
    await act(async () => releaseSecond(json({ id: 8 })));
    await waitFor(() => expect(result.current.data?.id).toBe(8));
  });

  test("useTrips_reads_the_list_the_server_gives_newest_first", async () => {
    stubApi(() => json(tripsOf("2026-10-20", "2026-09-12")));
    const { result } = renderHook(() => useTrips(), { wrapper: wrapperFor(newClient()) });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data?.trips.map((t) => t.id)).toEqual(["2026-10-20", "2026-09-12"]);
  });

  test("useDeletedTrips_reads_the_trips_the_owner_deleted_with_the_key_that_restores_each", async () => {
    const deleted: DeletedTrip[] = [{ key: "2026-09-12", label: "Lisbon · 12 – 16 Sep 2026", deletedAt: "2026-10-24T08:15:00Z" }];
    const urls = stubApi(() => json(deleted));
    const { result } = renderHook(() => useDeletedTrips(), { wrapper: wrapperFor(newClient()) });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(urls).toEqual(["/api/trips/deleted"]);
    expect(result.current.data).toEqual(deleted);
  });

  test("usePlaceSearch_asks_for_the_most_visited_places_with_no_q_and_escapes_the_q_it_is_given", async () => {
    const urls = stubApi(() => json([{ id: 7, name: "Bistro", address: null, visits: 3 }]));
    const client = newClient();

    const all = renderHook(() => usePlaceSearch(""), { wrapper: wrapperFor(client) });
    await waitFor(() => expect(all.result.current.isSuccess).toBe(true));
    const found = renderHook(() => usePlaceSearch("Café & Co"), { wrapper: wrapperFor(client) });
    await waitFor(() => expect(found.result.current.isSuccess).toBe(true));

    expect(urls).toEqual(["/api/places/search", "/api/places/search?q=Caf%C3%A9%20%26%20Co"]);
    expect(found.result.current.data).toEqual([{ id: 7, name: "Bistro", address: null, visits: 3 }]);
  });

  test("usePlaceSearch_and_useCandidates_with_nothing_to_ask_for_ask_for_nothing_even_when_every_query_is_refetched", async () => {
    const urls = stubApi(() => json([]));
    const client = newClient();
    const search = renderHook(() => usePlaceSearch(null), { wrapper: wrapperFor(client) });
    const near = renderHook(() => useCandidates(null, ""), { wrapper: wrapperFor(client) });

    await act(async () => undefined);
    await act(async () => {
      await client.invalidateQueries();
      await client.refetchQueries();
    });

    expect(urls).toEqual([]); // the picker of the places near one is not the search, and neither asks as `/api/places/null/candidates`
    expect(search.result.current.fetchStatus).toBe("idle");
    expect(near.result.current.fetchStatus).toBe("idle");
  });

  test("useHomes_useSettings_and_useRemovedPoints_read_what_the_server_has", async () => {
    const homes: HomesResponse = {
      periods: [{ id: 3, placeId: 7, placeName: "Oslo", from: "2026-01-01", to: null, source: "detected" }],
    };
    const settings: SettingsResponse = { tripMinDistanceKm: 80, tripMinDistanceKmDefault: 50 };
    const removed: RemovedBatch[] = [
      { batch: "3f2504e0-4f89-11d3-9a0c-0305e82c3301", removedAt: "2026-10-24T08:15:00Z", count: 4, from: "2026-10-22T08:00:00Z", to: "2026-10-22T08:03:00Z", localDates: ["2026-10-22"] },
    ];
    const urls = stubApi((url) => json(url === "/api/homes" ? homes : url === "/api/settings" ? settings : removed));
    const client = newClient();

    const home = renderHook(() => useHomes(), { wrapper: wrapperFor(client) });
    const setting = renderHook(() => useSettings(), { wrapper: wrapperFor(client) });
    const points = renderHook(() => useRemovedPoints(), { wrapper: wrapperFor(client) });
    await waitFor(() => expect(home.result.current.isSuccess && setting.result.current.isSuccess && points.result.current.isSuccess).toBe(true));

    expect([...urls].sort()).toEqual(["/api/homes", "/api/points/removed", "/api/settings"]);
    expect(home.result.current.data).toEqual(homes);
    expect(setting.result.current.data).toEqual(settings);
    expect(points.result.current.data).toEqual(removed);
  });

  test("useTrip_with_no_id_asks_for_nothing_even_when_every_trip_is_refetched", async () => {
    const urls = stubApi(() => json(trip("2026-09-12")));
    const client = newClient();
    const { result } = renderHook(() => useTrip(null), { wrapper: wrapperFor(client) });

    await act(async () => undefined);
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["trip"] });
      await client.refetchQueries({ queryKey: ["trip"] });
    });

    expect(urls).toEqual([]); // the view on show is not a trip, and none is asked for as `/api/trips/null`
    expect(result.current.fetchStatus).toBe("idle");
    expect(result.current.data).toBeUndefined();
  });

  test("useTrip_keeps_no_other_trip_for_the_one_that_loads", async () => {
    // The name and the days of one trip under the heading of another would be wrong, and not just old.
    let releaseSecond: (response: Response) => void = () => {};
    stubApi((url) => (url.endsWith("2026-09-12") ? json(trip("2026-09-12")) : new Promise<Response>((resolve) => (releaseSecond = resolve))));
    const { result, rerender } = renderHook(({ id }) => useTrip(id), {
      initialProps: { id: "2026-09-12" },
      wrapper: wrapperFor(newClient()),
    });
    await waitFor(() => expect(result.current.data?.id).toBe("2026-09-12"));

    rerender({ id: "2026-10-20" });

    expect(result.current.data).toBeUndefined();
    await act(async () => releaseSecond(json(trip("2026-10-20"))));
    await waitFor(() => expect(result.current.data?.id).toBe("2026-10-20"));
  });

  test("useTrip_does_not_retry_a_404", async () => {
    // The real retry policy: a trip that the server says is not there will not be there the next time (as for a place), whereas a failure
    // of any other kind is tried once more. The second half is what makes the first one mean something.
    vi.useFakeTimers();
    const gone = stubApi(() => json({ title: "Not Found" }, 404));
    const missing = renderHook(() => useTrip("2026-01-01"), { wrapper: wrapperFor(createQueryClient()) });
    await tick(1);

    expect(missing.result.current.isError).toBe(true); // at once: no retry was waiting
    expect((missing.result.current.error as ApiError).status).toBe(404);
    await tick(10_000);
    expect(gone).toEqual(["/api/trips/2026-01-01"]);

    const broken = stubApi(() => json({}, 500));
    const failing = renderHook(() => useTrip("2026-09-12"), { wrapper: wrapperFor(createQueryClient()) });
    await tick(1);
    expect(failing.result.current.isError).toBe(false); // waiting to try again
    await tick(10_000);
    expect(failing.result.current.isError).toBe(true);
    expect(broken).toEqual(["/api/trips/2026-09-12", "/api/trips/2026-09-12"]);
  });

  test("useStatus_polls_every_30_seconds", async () => {
    vi.useFakeTimers();
    const urls = stubApi(() => json({}));
    const client = newClient();
    renderHook(() => useStatus(), { wrapper: wrapperFor(client) });
    await tick(1);
    expect(urls).toHaveLength(1);

    await tick(31_000);

    expect(urls).toHaveLength(2);
  });
});

describe("refreshInterval", () => {
  const TODAY = "2026-10-22";

  test.each([
    // [from, to, state, interval, what it says]
    ["2026-10-22", "2026-10-22", "done", 60_000, "today, done: points still arrive"],
    ["2026-10-22", "2026-10-22", undefined, 60_000, "today, not loaded yet or failed: asked for again"],
    ["2026-10-19", "2026-10-25", "done", 60_000, "a week that holds today"],
    ["2026-10-01", "2026-10-31", "done", 60_000, "a month that holds today"],
    ["2026-01-01", "2026-12-31", "done", 60_000, "a year that holds today"],
    ["2026-10-22", "2026-11-05", "done", 60_000, "a range that begins today"],
    ["2026-10-01", "2026-10-22", "done", 60_000, "a range that ends today"],
    ["2026-10-22", "2026-10-22", "pending", 30_000, "today, pending: as soon as it is processed, as before"],
    ["2026-10-21", "2026-10-21", "pending", 30_000, "another day, pending"],
    ["2026-10-12", "2026-10-18", "pending", 30_000, "a week before this one, pending"],
    ["2026-10-21", "2026-10-21", "done", false, "yesterday, done"],
    ["2026-10-23", "2026-10-23", "done", false, "tomorrow, done"],
    ["2026-10-12", "2026-10-18", "done", false, "a week that is over"],
    ["2026-11-01", "2026-11-30", "done", false, "a month to come"],
    ["2026-10-21", "2026-10-21", undefined, false, "another day, nothing loaded: nothing to poll for"],
    [null, null, undefined, false, "no period: nothing is asked for"],
    [null, null, "pending", false, "no period, whatever is left of an earlier answer"],
  ] as const)("refreshInterval_%s_to_%s_%s_is_%s_(%s)", (from, to, state, interval, _what) => {
    expect(refreshInterval(from, to, state, TODAY)).toBe(interval);
  });

  test("refreshInterval_reads_today_in_the_zone_of_the_browser_when_it_is_not_told", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-22T14:30:00Z")); // the 22nd in London, the 22nd, 23:30, in Tokyo, where the unit tests run
    expect(refreshInterval("2026-10-22", "2026-10-22", "done")).toBe(60_000);
    vi.setSystemTime(new Date("2026-10-22T15:30:00Z")); // the 23rd in Tokyo
    expect(refreshInterval("2026-10-22", "2026-10-22", "done")).toBe(false);
    expect(refreshInterval("2026-10-23", "2026-10-23", "done")).toBe(60_000);
  });

  test("the_query_options_of_a_day_and_of_a_period_follow_the_rule", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-22T10:00:00Z"));
    const interval = (options: { refetchInterval?: unknown }, state: LoadState | undefined) => {
      const read = options.refetchInterval as (query: { state: { data: { state: LoadState } | undefined } }) => number | false;
      return read({ state: { data: state === undefined ? undefined : { state } } });
    };

    expect(interval(dayQueryOptions("2026-10-22"), "done")).toBe(60_000);
    expect(interval(dayQueryOptions("2026-10-21"), "done")).toBe(false);
    expect(interval(dayQueryOptions("2026-10-21"), "pending")).toBe(30_000);
    expect(interval(dayQueryOptions(null), undefined)).toBe(false);
    expect(interval(rangeQueryOptions("2026-10-01", "2026-10-31"), "done")).toBe(60_000);
    expect(interval(rangeQueryOptions("2026-09-01", "2026-09-30"), "done")).toBe(false);
    expect(interval(rangeQueryOptions("2026-09-01", "2026-09-30"), "pending")).toBe(30_000);
    expect(interval(rangeQueryOptions(null, null), undefined)).toBe(false);
  });
});

describe("pendingInterval", () => {
  const EDITED = Date.parse("2026-12-01T12:00:00Z");

  test.each([
    // [ms since the edit, interval, what it says]
    [0, 3_000, "at the edit"],
    [2_999, 3_000, "just under a second of the first poll"],
    [60_000, 3_000, "a minute after"],
    [119_999, 3_000, "the last ms of the two minutes"],
    [120_000, 30_000, "when the two minutes are up"],
    [600_000, 30_000, "long after"],
  ])("pendingInterval_%i_ms_after_an_edit_is_%i_(%s)", (since, interval) => {
    expect(pendingInterval(EDITED, EDITED + since)).toBe(interval);
  });

  test("pendingInterval_is_30_seconds_for_a_day_that_was_not_edited", () => {
    expect(pendingInterval(undefined, EDITED)).toBe(30_000);
  });

  test("pendingInterval_reads_the_time_of_now_when_it_is_not_told", () => {
    vi.useFakeTimers();
    vi.setSystemTime(EDITED);
    noteDayEdited("2026-10-22");
    expect(refreshInterval("2026-10-22", "2026-10-22", "pending", "2026-12-01")).toBe(3_000);
    vi.setSystemTime(EDITED + 120_000);
    expect(refreshInterval("2026-10-22", "2026-10-22", "pending", "2026-12-01")).toBe(30_000);
  });

  test("refreshInterval_is_3_seconds_for_an_edited_pending_day_and_for_no_other_state_or_period", () => {
    vi.useFakeTimers();
    vi.setSystemTime(EDITED);
    noteDayEdited("2026-10-22");
    const now = "2026-12-01";
    expect(refreshInterval("2026-10-22", "2026-10-22", "pending", now)).toBe(3_000);
    expect(refreshInterval("2026-10-22", "2026-10-22", "done", now)).toBe(false); // rebuilt: nothing more to wait for
    expect(refreshInterval("2026-10-19", "2026-10-25", "pending", now)).toBe(30_000); // a period is not a day that was edited
  });

  test("noteDayEdited_starts_the_two_minutes_again_for_a_second_edit_within_them", () => {
    // Remove, and Undo a minute and a half later, or a second removal: the day is rebuilt again, and is asked for every 3 seconds for two minutes after the last.
    vi.useFakeTimers();
    vi.setSystemTime(EDITED);
    noteDayEdited("2026-10-22");
    vi.setSystemTime(EDITED + 100_000);
    noteDayEdited("2026-10-22");
    const asked = (since: number) => {
      vi.setSystemTime(EDITED + since);
      return refreshInterval("2026-10-22", "2026-10-22", "pending", "2026-12-01");
    };

    expect(asked(200_000)).toBe(3_000); // 200 s after the first edit, which on its own would be over: 100 s after the second
    expect(asked(219_999)).toBe(3_000);
    expect(asked(220_000)).toBe(30_000); // two minutes after the second
    expect(asked(110_000)).toBe(3_000);
  });

  test("noteDayEdited_marks_the_days_either_side_too_as_a_day_spans_into_them", () => {
    vi.useFakeTimers();
    vi.setSystemTime(EDITED);
    noteDayEdited("2026-10-31");
    const now = "2026-12-01";
    for (const date of ["2026-10-30", "2026-10-31", "2026-11-01"]) expect(refreshInterval(date, date, "pending", now), date).toBe(3_000);
    for (const date of ["2026-10-29", "2026-11-02"]) expect(refreshInterval(date, date, "pending", now), date).toBe(30_000);
  });

  test("the_query_options_of_a_day_read_the_edits_and_the_points_have_their_own_key", () => {
    vi.useFakeTimers();
    vi.setSystemTime(EDITED);
    noteDayEdited("2026-10-22");
    const read = dayQueryOptions("2026-10-22").refetchInterval as (query: { state: { data: { state: LoadState } } }) => number | false;
    expect(read({ state: { data: { state: "pending" } } })).toBe(3_000);
    expect(dayPointsQueryOptions("2026-10-22").queryKey).toEqual(["points", "2026-10-22"]);
  });
});

describe("createQueryClient", () => {
  test("createQueryClient_retries_a_failure_once_but_never_a_client_error", () => {
    const retry = createQueryClient().getDefaultOptions().queries?.retry;
    if (typeof retry !== "function") throw new Error("retry must be a function");

    expect(retry(0, new ApiError(404, "/api/places/9"))).toBe(false);
    expect(retry(0, new ApiError(400, "/api/range"))).toBe(false);
    expect(retry(0, new ApiError(500, "/api/day/2026-10-22"))).toBe(true);
    expect(retry(1, new ApiError(500, "/api/day/2026-10-22"))).toBe(false);
    expect(retry(0, new TypeError("Failed to fetch"))).toBe(true);
    expect(retry(1, new TypeError("Failed to fetch"))).toBe(false);
  });
});

describe("tripNeighbours", () => {
  // The list is newest first, so the trip after one in it is the older, and the one before it the newer.
  const LIST = ["2026-10-20", "2026-09-12", "2026-08-01"].map((id) => ({ id }));

  test("tripNeighbours_are_the_trips_either_side_of_a_trip_in_the_list", () => {
    expect(tripNeighbours(LIST, "2026-09-12")).toEqual({ older: "2026-08-01", newer: "2026-10-20" });
  });

  test("tripNeighbours_have_no_newer_trip_for_the_first_and_no_older_for_the_last", () => {
    expect(tripNeighbours(LIST, "2026-10-20")).toEqual({ older: "2026-09-12", newer: null });
    expect(tripNeighbours(LIST, "2026-08-01")).toEqual({ older: null, newer: "2026-09-12" });
    expect(tripNeighbours([{ id: "2026-09-12" }], "2026-09-12")).toEqual({ older: null, newer: null });
  });

  test("tripNeighbours_have_none_for_a_trip_that_is_not_in_the_list_or_for_no_list", () => {
    expect(tripNeighbours(LIST, "2026-01-01")).toEqual({ older: null, newer: null });
    expect(tripNeighbours([], "2026-09-12")).toEqual({ older: null, newer: null });
  });
});

describe("prefetchNeighbours", () => {
  test("prefetchNeighbours_loads_the_previous_and_next_day", async () => {
    const urls = stubApi((url) => json(day(url.split("/").pop() ?? "")));
    const client = newClient();

    await prefetchNeighbours(client, { view: "day", date: "2026-10-22" });

    expect([...urls].sort()).toEqual(["/api/day/2026-10-21", "/api/day/2026-10-23"]);
    expect(client.getQueryData(dayQueryOptions("2026-10-21").queryKey)?.date).toBe("2026-10-21");
    expect(client.getQueryData(dayQueryOptions("2026-10-23").queryKey)?.date).toBe("2026-10-23");
    expect(client.getQueryData(dayQueryOptions("2026-10-22").queryKey)).toBeUndefined();
  });

  test("prefetchNeighbours_loads_the_previous_and_next_period_of_a_range_view", async () => {
    const urls = stubApi(() => json(range("a", "b")));
    const client = newClient();

    await prefetchNeighbours(client, { view: "week", start: "2026-10-19" });
    await prefetchNeighbours(client, { view: "month", month: "2026-02" });
    await prefetchNeighbours(client, { view: "year", year: 2026 });
    await prefetchNeighbours(client, { view: "range", from: "2026-09-12", to: "2026-09-19" });

    expect(urls.sort()).toEqual(
      [
        "/api/range?from=2026-10-12&to=2026-10-18",
        "/api/range?from=2026-10-26&to=2026-11-01",
        "/api/range?from=2026-01-01&to=2026-01-31",
        "/api/range?from=2026-03-01&to=2026-03-31",
        "/api/range?from=2025-01-01&to=2025-12-31",
        "/api/range?from=2027-01-01&to=2027-12-31",
        "/api/range?from=2026-09-04&to=2026-09-11",
        "/api/range?from=2026-09-20&to=2026-09-27",
      ].sort(),
    );
    expect(client.getQueryData(rangeQueryOptions("2026-10-26", "2026-11-01").queryKey)).toBeDefined();
  });

  test("prefetchNeighbours_skips_a_place_and_ranges_the_api_would_refuse", async () => {
    const urls = stubApi(() => json({}));
    const client = newClient();

    await prefetchNeighbours(client, { view: "place", id: 7 });
    // 401 days is one more than a request may cover; its neighbours would be refused with a 400 as well.
    await prefetchNeighbours(client, { view: "range", from: "2025-01-01", to: "2026-02-05" });

    expect(urls).toEqual([]);

    // 400 days is the most a request may cover, and is fine.
    await prefetchNeighbours(client, { view: "range", from: "2025-01-01", to: "2026-02-04" });
    expect(urls).toHaveLength(2);
  });

  test("prefetchNeighbours_does_not_throw_when_the_api_fails", async () => {
    stubApi(() => json({}, 500));
    const client = newClient();

    await expect(prefetchNeighbours(client, { view: "day", date: "2026-10-22" })).resolves.toBeUndefined();
  });

  describe("of a trip", () => {
    /** A client that has the list of trips, newest first, as the top bar leaves it when it has asked for it. */
    function withList(...ids: string[]): QueryClient {
      const client = newClient();
      client.setQueryData(tripsQueryOptions().queryKey, tripsOf(...ids));
      return client;
    }
    const tripAt = (id: string) => ({ view: "trip", id }) as const;

    test("prefetchNeighbours_loads_the_trips_either_side_of_a_trip_from_the_list_it_has", async () => {
      const urls = stubApi((url) => json(trip(url.split("/").pop() ?? "")));
      const client = withList("2026-10-20", "2026-09-12", "2026-08-01");

      await prefetchNeighbours(client, tripAt("2026-09-12"));

      expect([...urls].sort()).toEqual(["/api/trips/2026-08-01", "/api/trips/2026-10-20"]);
      expect(client.getQueryData(tripQueryOptions("2026-08-01").queryKey)?.id).toBe("2026-08-01");
      expect(client.getQueryData(tripQueryOptions("2026-10-20").queryKey)?.id).toBe("2026-10-20");
      expect(client.getQueryData(tripQueryOptions("2026-09-12").queryKey)).toBeUndefined(); // the trip on show is not its own neighbour
    });

    test("prefetchNeighbours_loads_the_one_neighbour_of_the_trip_at_either_end_of_the_list", async () => {
      const urls = stubApi((url) => json(trip(url.split("/").pop() ?? "")));

      // A client for each: what the first loads is fresh for the second, which would not ask for it again.
      await prefetchNeighbours(withList("2026-10-20", "2026-09-12", "2026-08-01"), tripAt("2026-10-20")); // the newest: only an older one
      await prefetchNeighbours(withList("2026-10-20", "2026-09-12", "2026-08-01"), tripAt("2026-08-01")); // the oldest: only a newer one

      expect(urls).toEqual(["/api/trips/2026-09-12", "/api/trips/2026-09-12"]);
    });

    test("prefetchNeighbours_does_nothing_for_a_trip_when_the_list_is_not_there_yet_and_does_not_ask_for_it", async () => {
      const urls = stubApi(() => json({}));

      await prefetchNeighbours(newClient(), tripAt("2026-09-12")); // the list is the top bar's to load: nothing is known of the neighbours until it is

      expect(urls).toEqual([]);
    });

    test("prefetchNeighbours_does_nothing_for_a_trip_that_is_not_in_the_list_and_for_the_list_itself", async () => {
      const urls = stubApi(() => json({}));
      const client = withList("2026-10-20", "2026-09-12");

      await prefetchNeighbours(client, tripAt("2026-01-01"));
      await prefetchNeighbours(client, { view: "trips" });

      expect(urls).toEqual([]);
    });

    test("prefetchNeighbours_does_not_throw_when_a_neighbouring_trip_cannot_be_had", async () => {
      stubApi(() => json({}, 500));

      await expect(prefetchNeighbours(withList("2026-10-20", "2026-09-12"), tripAt("2026-10-20"))).resolves.toBeUndefined();
    });
  });
});
