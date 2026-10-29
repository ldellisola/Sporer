import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import type { RemovedBatch } from "../api/types";
import { refusal, stubEdits, type Call, type Handler } from "../test/stubEdits";
import { RemovedPoints } from "./RemovedPoints";
import { SettingsNotes } from "./SettingsNotes";

// The unit tests run on the clock of Tokyo (see globalSetup), which is the browser's zone here: an instant is read there.

const TWO_DAYS: RemovedBatch = {
  batch: "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
  removedAt: "2026-10-24T08:15:00Z", // 17:15 in Tokyo
  count: 37,
  from: "2026-10-12T20:00:00Z",
  to: "2026-10-13T05:00:00Z",
  localDates: ["2026-10-12", "2026-10-13"],
};
const ONE_POINT: RemovedBatch = {
  batch: "9b2e1c4a-6d3f-4a8e-b1f0-5c7d8e9f0a1b",
  removedAt: "2026-10-23T10:00:00Z",
  count: 1,
  from: "2026-09-30T10:00:00Z",
  to: "2026-09-30T10:00:00Z",
  localDates: ["2026-09-30"],
};
const MANY: RemovedBatch = {
  batch: "c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f",
  removedAt: "2026-10-22T10:00:00Z",
  count: 5200,
  from: "2026-09-01T10:00:00Z",
  to: "2026-09-03T10:00:00Z",
  localDates: ["2026-09-01", "2026-09-03"],
};

/**
 * A server that has `removed` and restores a batch when asked (it is gone from the list then), unless `restore` is changed to refuse or to fail.
 * `list` can be changed to hold the answer back or to fail.
 */
function server(removed: RemovedBatch[]) {
  const state = {
    removed,
    list: (): Response | Promise<Response> => Response.json(state.removed),
    restore: ((call: Call) => {
      const batch = call.path.split("/").pop()!;
      state.removed = state.removed.filter((candidate) => candidate.batch !== batch);
      return new Response(null, { status: 204 });
    }) as Handler,
  };
  const api = stubEdits({
    "GET /api/points/removed": () => state.list(),
    ...Object.fromEntries(
      [TWO_DAYS, ONE_POINT, MANY].map((batch) => [`DELETE /api/points/removed/${batch.batch}`, (call: Call) => state.restore(call)] as const),
    ),
  });
  return { state, api };
}

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <SettingsNotes>
          <RemovedPoints />
        </SettingsNotes>
      </QueryClientProvider>,
    ),
  };
}

const section = () => screen.getByRole("region", { name: "Removed points" });
const note = () => screen.getByRole("status").textContent ?? "";
const rowsOf = () => within(within(section()).getByRole("list", { name: "Removed points" })).getAllByRole("listitem");
const restoreButton = (name: RegExp | string) => within(section()).getByRole("button", { name });
const restoreTwoDays = () => restoreButton("Restore 37 points from 12 – 13 Oct 2026, removed Sat 24 Oct 2026 17:15");
const restoreOne = () => restoreButton("Restore 1 point from 30 Sep 2026, removed Fri 23 Oct 2026 19:00");
const restoreMany = () => restoreButton("Restore 5,200 points from 1 Sep 2026, 3 Sep 2026, removed Thu 22 Oct 2026 19:00");

describe("RemovedPoints", () => {
  test("RemovedPoints_lists_the_removals_as_the_server_has_them_newest_first_with_the_days_the_count_and_when_each_was_made", async () => {
    const { api } = server([TWO_DAYS, ONE_POINT, MANY]);

    mount();

    expect(within(section()).getByText("Loading…")).toBeInTheDocument();
    await within(section()).findByRole("list", { name: "Removed points" });
    expect(rowsOf().map((row) => [...row.querySelectorAll("span")].map((part) => part.textContent))).toEqual([
      ["12 – 13 Oct 2026", "37 points · removed Sat 24 Oct 2026 17:15"], // two adjacent days are one span
      ["30 Sep 2026", "1 point · removed Fri 23 Oct 2026 19:00"],
      ["1 Sep 2026, 3 Sep 2026", "5,200 points · removed Thu 22 Oct 2026 19:00"], // a day between is no span
    ]);
    // The name holds the text that is on the button, and says which removal it is for: the buttons of the list are not all "Restore".
    expect(restoreTwoDays()).toHaveTextContent("Restore");
    expect(restoreOne()).toBeEnabled();
    expect(restoreMany()).toBeEnabled();
    expect(api.reads("/api/points/removed")).toHaveLength(1);
  });

  test("RemovedPoints_says_none_were_removed_when_none_were", async () => {
    server([]);

    mount();

    expect(await within(section()).findByText("No removed points")).toBeInTheDocument();
    expect(within(section()).queryByRole("button")).not.toBeInTheDocument();
    expect(within(section()).queryByRole("list")).not.toBeInTheDocument();
  });

  test("RemovedPoints_shows_an_error_with_a_retry_that_asks_again_and_keeps_what_it_had_under_one", async () => {
    const { state } = server([TWO_DAYS]);
    state.list = () => new Response("{}", { status: 503 });
    const view = mount();

    const alert = await within(section()).findByRole("alert");
    expect(alert).toHaveTextContent("Couldn't load — Retry");
    expect(within(section()).getByRole("heading", { name: "Removed points" })).toBeInTheDocument(); // never blank

    state.list = () => Response.json(state.removed);
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    await within(section()).findByRole("list", { name: "Removed points" });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    state.list = () => new Response("{}", { status: 500 });
    await act(async () => {
      await view.client.refetchQueries({ queryKey: ["removed-points"] });
    });

    expect(await within(section()).findByRole("alert")).toHaveTextContent("Couldn't load — Retry");
    expect(rowsOf()).toHaveLength(1); // what was there stays under it
  });

  test("RemovedPoints_restores_a_batch_by_its_id_shows_it_is_on_its_way_takes_it_off_the_list_and_says_the_points_are_back", async () => {
    const { state, api } = server([TWO_DAYS, ONE_POINT]);
    let release: () => void = () => undefined;
    const restore = state.restore;
    state.restore = (call) =>
      new Promise<Response>((resolve) => {
        release = () => resolve(restore(call) as Response);
      });
    const { client } = mount();
    await within(section()).findByRole("list", { name: "Removed points" });
    // What the app holds of the days the points are on: restored points come back in the day, and the day is asked for again.
    client.setQueryData(["day", "2026-10-12"], { date: "2026-10-12" });
    client.setQueryData(["points", "2026-10-12"], { date: "2026-10-12" });

    fireEvent.click(restoreTwoDays());

    // On its way: the row says so, and no button of the list can be pressed (the answer would change the list under a finger).
    expect(await within(section()).findByRole("button", { name: "Restoring…" })).toBeDisabled();
    expect(restoreOne()).toBeDisabled();
    expect(api.writes()).toEqual([
      { method: "DELETE", path: `/api/points/removed/${TWO_DAYS.batch}`, search: "", contentType: "application/json", body: undefined },
    ]);

    release();

    await waitFor(() => expect(rowsOf().map((row) => row.textContent)).toEqual([expect.stringContaining("30 Sep 2026")]));
    expect(note()).toBe("Restored 37 points"); // said in a status, for the row that had the focus is gone
    expect(restoreOne()).toBeEnabled();
    expect(client.getQueryState(["day", "2026-10-12"])?.isInvalidated).toBe(true); // the day they are on shows them again
    expect(client.getQueryState(["points", "2026-10-12"])?.isInvalidated).toBe(true);
    expect(api.reads("/api/points/removed").length).toBeGreaterThanOrEqual(2); // and what is on screen was asked for again
  });

  test("RemovedPoints_says_one_point_in_the_singular_when_it_restores_one", async () => {
    server([ONE_POINT]);
    mount();
    await within(section()).findByRole("list", { name: "Removed points" });

    fireEvent.click(restoreOne());

    await waitFor(() => expect(note()).toBe("Restored 1 point"));
  });

  test("RemovedPoints_puts_the_focus_on_the_next_restore_button_the_one_before_it_for_the_last_and_the_note_when_none_is_left", async () => {
    const { state } = server([TWO_DAYS, ONE_POINT, MANY]);
    mount();
    await within(section()).findByRole("list", { name: "Removed points" });

    // A row in the middle: the next.
    fireEvent.click(restoreOne());
    await waitFor(() => expect(restoreMany()).toHaveFocus());

    // The last: the one before.
    fireEvent.click(restoreMany());
    await waitFor(() => expect(restoreTwoDays()).toHaveFocus());

    // The only one: the note that says there are none, where the list was. The list that is asked for again has not come: the row is off it at once.
    state.list = () => new Promise<Response>(() => undefined);
    fireEvent.click(restoreTwoDays());
    const none = await within(section()).findByText("No removed points");
    await waitFor(() => expect(none).toHaveFocus());
  });

  test("RemovedPoints_says_a_refused_restore_in_the_words_of_the_server_with_no_retry_and_lets_the_list_go_when_it_is_asked_for_again", async () => {
    const { state } = server([TWO_DAYS]);
    state.restore = () => refusal(404, "These points were restored already.");
    mount();
    await within(section()).findByRole("list", { name: "Removed points" });
    let answer: (response: Response) => void = () => undefined;
    state.list = () => new Promise<Response>((resolve) => (answer = resolve)); // the list that a 404 has asked for again comes when the test says

    fireEvent.click(restoreTwoDays());

    const alert = await within(section()).findByRole("alert");
    expect(alert).toHaveTextContent("Could not restore 37 points from 12 – 13 Oct 2026: These points were restored already.");
    expect(within(alert).queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
    expect(rowsOf()).toHaveLength(1); // not gone yet

    answer(Response.json([])); // restored in another window
    const none = await within(section()).findByText("No removed points");
    await waitFor(() => expect(none).toHaveFocus()); // the focus, which was on the button of the row, is on the note that took its place
  });

  test("RemovedPoints_says_in_its_own_words_that_the_removal_is_gone_when_the_server_gave_none", async () => {
    const { state } = server([TWO_DAYS]);
    state.restore = () => new Response("{}", { status: 404 });
    mount();
    await within(section()).findByRole("list", { name: "Removed points" });

    fireEvent.click(restoreTwoDays());

    expect(await within(section()).findByRole("alert")).toHaveTextContent("Could not restore 37 points from 12 – 13 Oct 2026: These points are not removed any more.");
  });

  test("RemovedPoints_offers_a_retry_for_a_restore_that_failed_and_sends_the_same_batch_again_with_the_focus_back_on_its_button", async () => {
    const { state, api } = server([TWO_DAYS, ONE_POINT]);
    const works = state.restore;
    state.restore = () => new Response("{}", { status: 502 });
    mount();
    await within(section()).findByRole("list", { name: "Removed points" });
    const button = restoreOne();
    button.focus();

    fireEvent.click(button);

    const alert = await within(section()).findByRole("alert");
    expect(alert).toHaveTextContent("Couldn't restore 1 point from 30 Sep 2026 — Retry");
    expect(rowsOf()).toHaveLength(2); // the list is all there
    await waitFor(() => expect(restoreOne()).toHaveFocus()); // the button was turned off while it was pressed: the focus is not left on the page

    state.restore = works;
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(rowsOf()).toHaveLength(1));
    expect(api.writes().map((write) => write.path)).toEqual([`/api/points/removed/${ONE_POINT.batch}`, `/api/points/removed/${ONE_POINT.batch}`]);
    expect(within(section()).queryByRole("alert")).not.toBeInTheDocument();
  });
});
