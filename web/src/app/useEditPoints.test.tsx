import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, test } from "vitest";
import { ApiError } from "../api/client";
import { forgetEditedDays, refreshInterval } from "../api/queries";
import type { DayPointsResponse } from "../api/types";
import { refusal, stubEdits, type Handler } from "../test/stubEdits";
import type { Route } from "./router";
import { useEditPoints } from "./useEditPoints";

const DAY: Route = { view: "day", date: "2026-10-22" };
const OTHER_DAY: Route = { view: "day", date: "2026-10-23" };
const WEEK: Route = { view: "week", start: "2026-10-19" };
const SETTINGS: Route = { view: "settings" };

// The times are exact in epoch microseconds, which a number holds whole: the last digits are what the server tells the points apart by.
const T0 = 1_761_120_000_123_456;
const POINTS: DayPointsResponse = {
  date: "2026-10-22",
  devices: ["phone", "watch"],
  points: [
    [T0, 10.001, 59.001, 0],
    [T0 + 30_000_001, 10.002, 59.002, 1],
    [T0 + 60_000_002, 10.003, 59.003, 0],
    [T0 + 90_000_003, 10.004, 59.004, 0],
  ],
};
const OTHER_POINTS: DayPointsResponse = { ...POINTS, date: "2026-10-23", points: [[T0 + 86_400_000_000, 11, 60, 0]] };
const BATCH = "0b4d6f5e-2f0a-4e6c-9a39-6d5f7d3d1a11";

function newClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function mount(route: Route = DAY, routes: Record<string, Handler> = {}) {
  const api = stubEdits({
    "GET /api/day/2026-10-22/points": () => Response.json(POINTS),
    "GET /api/day/2026-10-23/points": () => Response.json(OTHER_POINTS),
    ...routes,
  });
  const client = newClient();
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const view = renderHook(({ route }: { route: Route }) => useEditPoints(route), { wrapper, initialProps: { route } });
  return { api, client, ...view };
}

/** Turns edit mode on and waits for the points. */
async function editing(route: Route = DAY, routes: Record<string, Handler> = {}) {
  const mounted = mount(route, routes);
  act(() => mounted.result.current.start());
  await waitFor(() => expect(mounted.result.current.points).toBeDefined());
  return mounted;
}

afterEach(() => {
  forgetEditedDays();
});

describe("useEditPoints mode", () => {
  test("useEditPoints_is_off_to_begin_with_and_asks_for_no_points", async () => {
    const { result, api } = mount();

    expect(result.current.active).toBe(false);
    expect(result.current.points).toBeUndefined();
    expect(result.current.selected.size).toBe(0);
    expect(result.current.area).toBe(false);
    expect(result.current.toast).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(api.calls).toEqual([]); // the points are heavy, and nothing but edit mode has use for them
  });

  test("useEditPoints_start_turns_it_on_for_the_day_on_show_and_asks_for_the_points_of_that_day", async () => {
    const { result, api } = mount();

    act(() => result.current.start());

    expect(result.current.active).toBe(true);
    expect(result.current.load.pending).toBe(true);
    await waitFor(() => expect(result.current.points).toEqual(POINTS));
    expect(result.current.load.pending).toBe(false);
    expect(api.calls.map((call) => `${call.method} ${call.path}`)).toEqual(["GET /api/day/2026-10-22/points"]);
  });

  test("useEditPoints_start_does_nothing_on_a_view_that_is_not_a_day", async () => {
    for (const route of [WEEK, SETTINGS]) {
      const { result, api, unmount } = mount(route);

      act(() => result.current.start());

      expect(result.current.active, route.view).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(api.calls, route.view).toEqual([]);
      unmount();
    }
  });

  test("useEditPoints_ends_when_the_view_leaves_the_day_and_does_not_come_back_with_it", async () => {
    const { result, rerender } = await editing();
    act(() => result.current.toggle(1));
    act(() => result.current.setArea(true));
    expect(result.current.selected.size).toBe(1);

    rerender({ route: WEEK });

    expect(result.current.active).toBe(false);
    expect(result.current.selected.size).toBe(0);
    expect(result.current.area).toBe(false);
    expect(result.current.points).toBeUndefined(); // nothing of the day is held up for a view that has none

    rerender({ route: DAY });

    expect(result.current.active).toBe(false); // a day that is come back to is not in edit mode: it is not a state of the address
    expect(result.current.selected.size).toBe(0);
  });

  test("useEditPoints_ends_when_the_date_changes_and_the_selection_goes_with_it", async () => {
    const { result, rerender, api } = await editing();
    act(() => result.current.toggle(0));

    rerender({ route: OTHER_DAY });

    expect(result.current.active).toBe(false);
    expect(result.current.selected.size).toBe(0);
    expect(result.current.points).toBeUndefined(); // not the points of the day before, which would be drawn on this one
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(api.calls.map((call) => call.path)).toEqual(["/api/day/2026-10-22/points"]); // the new day's points were not asked for: it is not in edit mode
  });

  test("useEditPoints_done_ends_it_and_clears_the_selection_and_the_area", async () => {
    const { result } = await editing();
    act(() => result.current.select([0, 2]));
    act(() => result.current.setArea(true));

    act(() => result.current.done());

    expect(result.current.active).toBe(false);
    expect(result.current.selected.size).toBe(0);
    expect(result.current.area).toBe(false);

    act(() => result.current.start());
    expect(result.current.active).toBe(true);
    expect(result.current.selected.size).toBe(0); // a new start is a clean one
    expect(result.current.area).toBe(false);
  });

  test("useEditPoints_does_not_keep_the_points_once_edit_mode_ends_for_they_are_heavy_and_would_be_old_when_it_begins_again", async () => {
    const { result, client } = await editing();
    expect(client.getQueryData(["points", "2026-10-22"])).toEqual(POINTS);

    act(() => result.current.done());

    await waitFor(() => expect(client.getQueryData(["points", "2026-10-22"])).toBeUndefined());
  });

  test("useEditPoints_says_how_loading_the_points_went_and_asks_again_on_retry", async () => {
    let failing = true;
    const { result, api } = mount(DAY, { "GET /api/day/2026-10-22/points": () => (failing ? new Response("{}", { status: 500 }) : Response.json(POINTS)) });

    act(() => result.current.start());
    await waitFor(() => expect(result.current.load.error).toBeInstanceOf(ApiError));
    expect(result.current.load.pending).toBe(false);
    expect(result.current.points).toBeUndefined();

    failing = false;
    act(() => result.current.load.retry());

    await waitFor(() => expect(result.current.points).toEqual(POINTS));
    expect(result.current.load.error).toBeNull();
    expect(api.reads("/api/day/2026-10-22/points")).toHaveLength(2);
  });
});

describe("useEditPoints selection", () => {
  test("useEditPoints_toggle_adds_a_point_and_takes_it_away_again", async () => {
    const { result } = await editing();

    act(() => result.current.toggle(2));
    expect([...result.current.selected]).toEqual([2]);
    act(() => result.current.toggle(0));
    expect([...result.current.selected].sort()).toEqual([0, 2]);
    act(() => result.current.toggle(2));
    expect([...result.current.selected]).toEqual([0]);
  });

  test("useEditPoints_select_adds_every_index_it_is_given_and_keeps_what_was_selected", async () => {
    const { result } = await editing();
    act(() => result.current.toggle(3));

    act(() => result.current.select([0, 1, 3]));

    expect([...result.current.selected].sort()).toEqual([0, 1, 3]); // 3 was in already: the area adds, it does not toggle
  });

  test("useEditPoints_makes_a_new_selection_for_each_change_so_that_whoever_reads_it_sees_it_change", async () => {
    const { result } = await editing();
    const before = result.current.selected;

    act(() => result.current.toggle(1));

    expect(result.current.selected).not.toBe(before);
    expect(before.size).toBe(0); // and what it was is as it was
  });

  test("useEditPoints_clear_empties_the_selection_and_stays_in_edit_mode", async () => {
    const { result } = await editing();
    act(() => result.current.select([0, 1, 2]));

    act(() => result.current.clear());

    expect(result.current.selected.size).toBe(0);
    expect(result.current.active).toBe(true);
  });

  test("useEditPoints_drops_the_selection_when_the_points_it_is_of_change", async () => {
    // The indices are those of the points: another list is other points, and the same indices would be selecting the wrong ones.
    let served: DayPointsResponse = POINTS;
    const { result, client } = await editing(DAY, { "GET /api/day/2026-10-22/points": () => Response.json(served) });
    act(() => result.current.select([1, 2]));

    served = { ...POINTS, points: POINTS.points.slice(2) }; // 0 and 1 were removed elsewhere
    await act(() => client.invalidateQueries());

    await waitFor(() => expect(result.current.points?.points).toHaveLength(2));
    expect(result.current.selected.size).toBe(0);
  });

  test("useEditPoints_keeps_the_selection_when_the_points_are_asked_for_again_and_are_the_same", async () => {
    const { result, client } = await editing();
    act(() => result.current.select([1, 2]));

    await act(() => client.invalidateQueries());

    expect([...result.current.selected].sort()).toEqual([1, 2]);
  });

  test("useEditPoints_area_is_on_until_it_is_turned_off", async () => {
    const { result } = await editing();

    act(() => result.current.setArea(true));
    act(() => result.current.toggle(0)); // selecting does not turn it off: it stays on until tapped again
    act(() => result.current.select([1]));
    expect(result.current.area).toBe(true);

    act(() => result.current.setArea(false));
    expect(result.current.area).toBe(false);
  });
});

describe("useEditPoints removal", () => {
  const REMOVE = "POST /api/points/remove";

  test("useEditPoints_remove_posts_the_device_and_the_exact_time_of_each_selected_point_in_the_order_of_the_day", async () => {
    const { result, api } = await editing(DAY, { [REMOVE]: () => Response.json({ batch: BATCH, count: 3 }) });
    act(() => result.current.select([3, 1, 0]));

    act(() => result.current.removal.run());
    await waitFor(() => expect(result.current.toast).not.toBeNull());

    expect(api.writes()).toEqual([
      {
        method: "POST",
        path: "/api/points/remove",
        search: "",
        contentType: "application/json",
        body: { points: [{ device: "phone", t: T0 }, { device: "watch", t: T0 + 30_000_001 }, { device: "phone", t: T0 + 90_000_003 }] },
      },
    ]);
    // The times went back as they came, to the microsecond: a rounded one would miss the stored point.
    expect((api.writes()[0]!.body as { points: { t: number }[] }).points.map((point) => point.t)).toEqual([T0, T0 + 30_000_001, T0 + 90_000_003]);
  });

  test("useEditPoints_remove_shows_it_is_on_its_way_and_does_nothing_when_pressed_again", async () => {
    let release: (response: Response) => void = () => undefined;
    const { result, api } = await editing(DAY, { [REMOVE]: () => new Promise<Response>((resolve) => (release = resolve)) });
    act(() => result.current.toggle(0));

    act(() => result.current.removal.run());
    await waitFor(() => expect(result.current.removal.pending).toBe(true));
    act(() => result.current.removal.run());
    expect(api.writes()).toHaveLength(1);

    release(Response.json({ batch: BATCH, count: 1 }));
    await waitFor(() => expect(result.current.removal.pending).toBe(false));
  });

  test("useEditPoints_remove_does_nothing_with_nothing_selected", async () => {
    const { result, api } = await editing();

    act(() => result.current.removal.run());

    expect(api.writes()).toEqual([]);
  });

  test("useEditPoints_remove_that_goes_through_clears_the_selection_and_says_what_it_removed_with_the_batch_to_undo_it_by", async () => {
    const { result } = await editing(DAY, { [REMOVE]: () => Response.json({ batch: BATCH, count: 2 }) });
    act(() => result.current.select([0, 1]));

    act(() => result.current.removal.run());

    await waitFor(() => expect(result.current.toast).toEqual({ id: expect.any(Number), kind: "removed", count: 2, batch: BATCH, date: "2026-10-22" }));
    expect(result.current.selected.size).toBe(0);
    expect(result.current.active).toBe(true); // the owner is still in edit mode: more can be removed
  });

  test("useEditPoints_remove_has_the_day_asked_for_again_every_3_seconds_while_it_is_pending_and_the_points_asked_for_again", async () => {
    const { result, api } = await editing(DAY, { [REMOVE]: () => Response.json({ batch: BATCH, count: 1 }) });
    act(() => result.current.toggle(0));

    act(() => result.current.removal.run());

    await waitFor(() => expect(result.current.toast).not.toBeNull());
    expect(refreshInterval("2026-10-22", "2026-10-22", "pending", "2099-01-01")).toBe(3_000);
    await waitFor(() => expect(api.reads("/api/day/2026-10-22/points")).toHaveLength(2)); // every query that is on screen is asked for again
  });

  test("useEditPoints_remove_that_removed_nothing_says_so_and_offers_no_undo", async () => {
    const { result } = await editing(DAY, { [REMOVE]: () => Response.json({ batch: null, count: 0 }) });
    act(() => result.current.toggle(0));

    act(() => result.current.removal.run());

    await waitFor(() => expect(result.current.toast).toEqual({ id: expect.any(Number), kind: "none" }));
    expect(result.current.selected.size).toBe(0);
  });

  test("useEditPoints_remove_that_the_server_refuses_keeps_the_selection_and_has_the_error_with_its_words_and_no_toast", async () => {
    const { result } = await editing(DAY, { [REMOVE]: () => refusal(400, "At most 50000 points can be removed at once.") });
    act(() => result.current.select([0, 1]));

    act(() => result.current.removal.run());

    await waitFor(() => expect(result.current.removal.error).toBeInstanceOf(ApiError));
    expect((result.current.removal.error as ApiError).status).toBe(400);
    expect((result.current.removal.error as ApiError).detail).toBe("At most 50000 points can be removed at once.");
    expect([...result.current.selected]).toEqual([0, 1]); // nothing was done: the owner can take some off and try again
    expect(result.current.toast).toBeNull();
    expect(refreshInterval("2026-10-22", "2026-10-22", "pending", "2099-01-01")).toBe(30_000); // and no day is pending for it
  });

  test("useEditPoints_remove_that_fails_may_be_sent_again_and_the_error_goes_with_a_new_selection_or_reset", async () => {
    let failing = true;
    const { result, api } = await editing(DAY, { [REMOVE]: () => (failing ? new Response("{}", { status: 503 }) : Response.json({ batch: BATCH, count: 1 })) });
    act(() => result.current.toggle(0));
    act(() => result.current.removal.run());
    await waitFor(() => expect(result.current.removal.error).not.toBeNull());

    failing = false;
    act(() => result.current.removal.run());

    await waitFor(() => expect(result.current.toast?.kind).toBe("removed"));
    expect(result.current.removal.error).toBeNull();
    expect(api.writes().map((call) => call.body)).toEqual([{ points: [{ device: "phone", t: T0 }] }, { points: [{ device: "phone", t: T0 }] }]);

    // And what is on screen of a failure goes when the owner has moved on.
    failing = true;
    act(() => result.current.toggle(2));
    act(() => result.current.removal.run());
    await waitFor(() => expect(result.current.removal.error).not.toBeNull());
    act(() => result.current.removal.reset());
    await waitFor(() => expect(result.current.removal.error).toBeNull());
  });

  test("useEditPoints_remove_that_was_refused_has_its_error_taken_away_by_any_change_of_the_selection", async () => {
    const { result } = await editing(DAY, { [REMOVE]: () => refusal(400, "At most 50000 points can be removed at once.") });
    for (const change of [() => result.current.toggle(1), () => result.current.select([2, 3]), () => result.current.clear()]) {
      act(() => result.current.toggle(0));
      act(() => result.current.removal.run());
      await waitFor(() => expect(result.current.removal.error).not.toBeNull());

      act(change); // what the error said was of the selection that was: the owner has moved on

      await waitFor(() => expect(result.current.removal.error).toBeNull());
      act(() => result.current.clear());
    }
  });

  test("useEditPoints_remove_finishes_after_the_owner_has_left_edit_mode_and_still_says_what_it_did", async () => {
    let release: (response: Response) => void = () => undefined;
    const { result } = await editing(DAY, { [REMOVE]: () => new Promise<Response>((resolve) => (release = resolve)) });
    act(() => result.current.toggle(0));
    act(() => result.current.removal.run());
    await waitFor(() => expect(result.current.removal.pending).toBe(true));

    act(() => result.current.done());
    release(Response.json({ batch: BATCH, count: 1 }));

    await waitFor(() => expect(result.current.toast?.kind).toBe("removed")); // the toast, with its Undo, is there for the owner who did it
  });
});

describe("useEditPoints undo", () => {
  const REMOVE = "POST /api/points/remove";
  const UNDO = `DELETE /api/points/removed/${BATCH}`;

  async function removed(routes: Record<string, Handler>) {
    const mounted = await editing(DAY, { [REMOVE]: () => Response.json({ batch: BATCH, count: 2 }), ...routes });
    act(() => mounted.result.current.select([0, 1]));
    act(() => mounted.result.current.removal.run());
    await waitFor(() => expect(mounted.result.current.toast?.kind).toBe("removed"));
    forgetEditedDays();
    return mounted;
  }

  test("useEditPoints_undo_deletes_the_batch_and_says_how_many_points_were_restored", async () => {
    const { result, api } = await removed({ [UNDO]: () => new Response(null, { status: 204 }) });

    act(() => result.current.undo.run());

    await waitFor(() => expect(result.current.toast).toEqual({ id: expect.any(Number), kind: "restored", count: 2 }));
    expect(api.writes().map((call) => `${call.method} ${call.path}`)).toEqual(["POST /api/points/remove", `DELETE /api/points/removed/${BATCH}`]);
    expect(refreshInterval("2026-10-22", "2026-10-22", "pending", "2099-01-01")).toBe(3_000); // the day is rebuilt for it as for the removal
  });

  test("useEditPoints_undo_shows_it_is_on_its_way_and_is_not_sent_twice", async () => {
    let release: (response: Response) => void = () => undefined;
    const { result, api } = await removed({ [UNDO]: () => new Promise<Response>((resolve) => (release = resolve)) });

    act(() => result.current.undo.run());
    await waitFor(() => expect(result.current.undo.pending).toBe(true));
    act(() => result.current.undo.run());
    expect(api.writes().filter((call) => call.method === "DELETE")).toHaveLength(1);

    release(new Response(null, { status: 204 }));
    await waitFor(() => expect(result.current.undo.pending).toBe(false));
  });

  test("useEditPoints_undo_of_a_batch_that_is_restored_already_has_the_servers_words_keeps_the_toast_and_has_everything_asked_for_again", async () => {
    const { result, api } = await removed({ [UNDO]: () => refusal(404, "That removal has been undone already.") });
    const reads = api.reads("/api/day/2026-10-22/points").length;

    act(() => result.current.undo.run());

    await waitFor(() => expect(result.current.undo.error).toBeInstanceOf(ApiError));
    expect((result.current.undo.error as ApiError).status).toBe(404);
    expect((result.current.undo.error as ApiError).detail).toBe("That removal has been undone already.");
    expect(result.current.toast?.kind).toBe("removed"); // the toast stays, with the error under it, until the owner is done with it
    await waitFor(() => expect(api.reads("/api/day/2026-10-22/points").length).toBeGreaterThan(reads)); // a 404 has what is on screen asked for again
  });

  test("useEditPoints_undo_that_fails_may_be_sent_again", async () => {
    let failing = true;
    const { result } = await removed({ [UNDO]: () => (failing ? new Response("{}", { status: 502 }) : new Response(null, { status: 204 })) });
    act(() => result.current.undo.run());
    await waitFor(() => expect(result.current.undo.error).not.toBeNull());

    failing = false;
    act(() => result.current.undo.run());

    await waitFor(() => expect(result.current.toast?.kind).toBe("restored"));
    expect(result.current.undo.error).toBeNull();
  });

  test("useEditPoints_dismiss_takes_the_toast_and_the_error_of_an_undo_away", async () => {
    const { result } = await removed({ [UNDO]: () => new Response("{}", { status: 502 }) });
    act(() => result.current.undo.run());
    await waitFor(() => expect(result.current.undo.error).not.toBeNull());

    act(() => result.current.dismiss());

    expect(result.current.toast).toBeNull();
    expect(result.current.undo.error).toBeNull();
  });

  test("useEditPoints_makes_a_new_toast_for_each_removal_so_that_its_ten_seconds_start_again", async () => {
    const { result } = await removed({});
    const first = result.current.toast;

    act(() => result.current.toggle(2));
    act(() => result.current.removal.run());

    await waitFor(() => expect(result.current.toast?.id).not.toBe(first?.id));
    expect(result.current.toast?.kind).toBe("removed");
  });

  test("useEditPoints_keeps_the_toast_when_the_view_leaves_the_day_for_the_owner_may_still_want_to_undo", async () => {
    const { result, rerender } = await removed({});

    rerender({ route: WEEK });

    expect(result.current.active).toBe(false);
    expect(result.current.toast?.kind).toBe("removed");
  });
});

