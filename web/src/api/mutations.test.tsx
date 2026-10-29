import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, test, vi } from "vitest";
import { ApiError } from "./client";
import { useWrite } from "./mutations";

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return { client, wrapper };
}

describe("useWrite", () => {
  test("useWrite_runs_the_write_with_what_it_is_given_and_hands_back_its_answer", async () => {
    const { wrapper } = setup();
    const write = vi.fn(async (name: string) => ({ saved: name }));

    const { result } = renderHook(() => useWrite(write), { wrapper });
    expect(result.current.isPending).toBe(false);
    act(() => result.current.mutate("Home"));

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0]?.[0]).toBe("Home");
    expect(result.current.data).toEqual({ saved: "Home" });
  });

  test("useWrite_is_pending_while_the_write_is_on_its_way", async () => {
    const { wrapper } = setup();
    let finish: () => void = () => undefined;
    const write = () => new Promise<void>((resolve) => (finish = resolve));

    const { result } = renderHook(() => useWrite(write), { wrapper });
    act(() => result.current.mutate());

    await waitFor(() => expect(result.current.isPending).toBe(true));
    await act(async () => finish());
    await waitFor(() => expect(result.current.isPending).toBe(false));
    expect(result.current.isSuccess).toBe(true);
  });

  test("useWrite_invalidates_every_query_on_success_the_active_ones_refetch_and_the_others_go_stale", async () => {
    const { client, wrapper } = setup();
    const asked: string[] = [];
    const answer = (key: string) => async () => {
      asked.push(key);
      return key;
    };
    // Two queries on screen and one that nothing shows any more (it is in the cache until it is collected).
    renderHook(() => [useQuery({ queryKey: ["day", "2026-10-22"], queryFn: answer("day"), staleTime: Infinity }), useQuery({ queryKey: ["status"], queryFn: answer("status"), staleTime: Infinity })], {
      wrapper,
    });
    await client.prefetchQuery({ queryKey: ["place", 7], queryFn: answer("place"), staleTime: Infinity });
    await waitFor(() => expect(asked.sort()).toEqual(["day", "place", "status"]));
    asked.length = 0;
    expect(client.getQueryState(["place", 7])?.isInvalidated).toBe(false);

    const { result } = renderHook(() => useWrite(async () => "ok"), { wrapper });
    act(() => result.current.mutate());

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    await waitFor(() => expect(asked.sort()).toEqual(["day", "status"])); // what is on screen is asked for again, and only that
    expect(client.getQueryState(["place", 7])?.isInvalidated).toBe(true); // the rest is asked for when it is next shown
  });

  test("useWrite_invalidates_with_no_filter_so_that_nothing_is_left_out", async () => {
    const { client, wrapper } = setup();
    const invalidate = vi.spyOn(client, "invalidateQueries");

    const { result } = renderHook(() => useWrite(async () => undefined), { wrapper });
    act(() => result.current.mutate());

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate.mock.calls[0]).toEqual([]);
  });

  test("useWrite_exposes_the_error_of_a_write_that_fails_and_invalidates_nothing", async () => {
    const { client, wrapper } = setup();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const write = vi.fn(async () => {
      throw new ApiError(409, "/api/trips/2026-09-12", "PUT");
    });

    const { result } = renderHook(() => useWrite(write), { wrapper });
    act(() => result.current.mutate());

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toBeInstanceOf(ApiError);
    expect((result.current.error as ApiError).status).toBe(409);
    expect(result.current.isPending).toBe(false);
    expect(invalidate).not.toHaveBeenCalled(); // nothing changed on the server: what is on screen is still right
  });

  test("useWrite_tries_a_write_again_with_the_same_variables_and_clears_the_error_when_it_goes_through", async () => {
    const { wrapper } = setup();
    let fail = true;
    const write = vi.fn(async (_name: string) => {
      if (fail) throw new ApiError(500, "/api/places/7/name", "PUT");
    });

    const { result } = renderHook(() => useWrite(write), { wrapper });
    act(() => result.current.mutate("Café"));
    await waitFor(() => expect(result.current.isError).toBe(true));

    fail = false;
    act(() => result.current.mutate(result.current.variables!)); // what a Retry button does

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.error).toBeNull();
    expect(write.mock.calls.map(([name]) => name)).toEqual(["Café", "Café"]);
  });

  test("useWrite_does_not_wait_for_the_refetch_to_say_the_write_went_through", async () => {
    // The write has been made once the server says so; a query that is slow to come back (or cannot) must not leave the control pending.
    const { client, wrapper } = setup();
    const slow = vi.fn(() => new Promise<string>(() => undefined)); // never answers
    renderHook(() => useQuery({ queryKey: ["day", "x"], queryFn: slow, staleTime: Infinity }), { wrapper });
    await waitFor(() => expect(slow).toHaveBeenCalledTimes(1));

    const { result } = renderHook(() => useWrite(async () => "ok"), { wrapper });
    act(() => result.current.mutate());

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(client.isFetching()).toBe(1);
  });
});
