import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ApiError } from "./client";
import {
  createQueryClient,
  dayQueryOptions,
  prefetchNeighbours,
  rangeQueryOptions,
  useConfig,
  useDay,
  useHeat,
  usePlace,
  useRange,
  useStatus,
} from "./queries";
import type { DayResponse, LoadState, RangeResponse } from "./types";

const SUMMARY = { places: 0, distanceMeters: 0, movingSeconds: 0 };

function day(date: string, state: LoadState = "done"): DayResponse {
  return { date, timeZone: "Europe/Oslo", state, summary: SUMMARY, segments: [] };
}

function range(from: string, to: string, state: LoadState = "done"): RangeResponse {
  return { from, to, state, summary: { ...SUMMARY, moves: 0 }, moves: [], places: [], days: [] };
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
});

describe("query hooks", () => {
  test("hooks_ask_the_api_paths_the_server_serves", async () => {
    const urls = stubApi(() => json({}));
    const client = newClient();

    const { result } = renderHook(
      () => ({
        day: useDay("2026-10-22"),
        range: useRange("2026-10-19", "2026-10-25"),
        heat: useHeat("2026-10-19", "2026-10-25", true),
        place: usePlace(7),
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
        "/api/heat?from=2026-10-19&to=2026-10-25",
        "/api/places/7",
        "/api/range?from=2026-10-19&to=2026-10-25",
        "/api/status",
      ].sort(),
    );
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

  test("useRange_refetches_every_30_seconds_only_while_pending", async () => {
    vi.useFakeTimers();
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
});
