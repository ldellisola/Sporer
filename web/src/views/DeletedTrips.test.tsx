import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import type { DeletedTrip } from "../api/types";
import { DeletedTrips } from "./DeletedTrips";
import { SettingsNotes } from "./SettingsNotes";

interface Call {
  path: string;
  method: string;
  contentType: string | null;
  body: unknown;
}

/**
 * Answers `GET /api/trips/deleted` with whatever `deleted` is (a test changes it to change what the next request finds, and a function can hold the
 * answer back) and `POST /api/trips/deleted/{key}/restore` with `restore`, which is given the key; returns the calls that were made and the knobs.
 */
function stubApi() {
  const state = {
    deleted: [] as DeletedTrip[] | Response | (() => Promise<Response>),
    restore: (_key: string): Response | Promise<Response> => new Response(null, { status: 204 }),
  };
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      calls.push({
        path,
        method: init?.method ?? "GET",
        contentType: headers.get("Content-Type"),
        body: typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : init?.body,
      });
      if (path === "/api/trips/deleted") {
        if (typeof state.deleted === "function") return state.deleted();
        return state.deleted instanceof Response ? state.deleted.clone() : Response.json(state.deleted);
      }
      const restoring = /^\/api\/trips\/deleted\/([^/]+)\/restore$/.exec(path);
      if (restoring !== null) return state.restore(decodeURIComponent(restoring[1]!));
      throw new Error(`unexpected request ${path}`);
    }),
  );
  return { state, calls, restores: () => calls.filter((call) => call.path.endsWith("/restore")) };
}

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <SettingsNotes>
          <DeletedTrips />
        </SettingsNotes>
      </QueryClientProvider>,
    ),
  };
}

/** What the note over the map says: the settings have one status for all their sections, which is empty until something is said in it. */
const note = (): string => screen.getByRole("status").textContent ?? "";
const refused = () => new Response("{}", { status: 404 });
const deletedSection = () => screen.getByRole("region", { name: "Deleted trips" });

describe("DeletedTrips", () => {
  const LISBON: DeletedTrip = { key: "2026-09-12", label: "Lisbon · 12 – 16 Sep 2026", deletedAt: "2026-10-24T08:15:00Z" };
  const COPENHAGEN: DeletedTrip = { key: "2026-08-01", label: "Copenhagen · 1 – 3 Aug 2026", deletedAt: "2026-10-23T10:00:00Z" };
  const PORTO: DeletedTrip = { key: "2026-05-02", label: "Porto · 2 – 4 May 2026", deletedAt: "2026-10-22T10:00:00Z" };
  const rowsOf = () => within(within(deletedSection()).getByRole("list", { name: "Deleted trips" })).getAllByRole("listitem");
  const restoreButton = (label: string) => within(deletedSection()).getByRole("button", { name: `Restore ${label}` });

  test("DeletedTrips_lists_the_deleted_trips_by_their_labels_newest_first_each_with_a_restore_button_named_by_it", async () => {
    const api = stubApi();
    api.state.deleted = [LISBON, COPENHAGEN];

    mount();

    await within(deletedSection()).findByRole("list", { name: "Deleted trips" });
    expect(rowsOf().map((row) => row.textContent)).toEqual(["Lisbon · 12 – 16 Sep 2026Restore", "Copenhagen · 1 – 3 Aug 2026Restore"]);
    // The name holds the text that is on the button, and says which trip it is for: the buttons of the list are not all "Restore".
    expect(restoreButton(LISBON.label)).toHaveTextContent("Restore");
    expect(restoreButton(COPENHAGEN.label)).toBeEnabled();
    expect(api.calls.filter((call) => call.path === "/api/trips/deleted")).toHaveLength(1);
  });

  test("DeletedTrips_says_none_are_deleted_when_none_are_and_says_it_is_loading_before_that", async () => {
    stubApi();

    mount();

    expect(within(deletedSection()).getByText("Loading…")).toBeInTheDocument();
    expect(await within(deletedSection()).findByText("No deleted trips")).toBeInTheDocument();
    expect(within(deletedSection()).queryByRole("button")).not.toBeInTheDocument();
    expect(within(deletedSection()).queryByRole("list")).not.toBeInTheDocument();
  });

  test("DeletedTrips_shows_an_error_when_the_deleted_trips_cannot_be_had_with_a_retry_that_asks_again_and_the_rest_of_the_panel", async () => {
    const api = stubApi();
    api.state.deleted = new Response("{}", { status: 503 });
    mount();

    const alert = await within(deletedSection()).findByRole("alert");
    expect(alert).toHaveTextContent("Couldn't load — Retry");

    api.state.deleted = [LISBON];
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));

    expect(await within(deletedSection()).findByRole("button", { name: `Restore ${LISBON.label}` })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  test("DeletedTrips_keeps_the_deleted_trips_it_had_under_an_error_when_they_are_asked_for_again", async () => {
    const api = stubApi();
    api.state.deleted = [LISBON];
    const view = mount();
    await within(deletedSection()).findByText(LISBON.label);

    api.state.deleted = new Response("{}", { status: 500 });
    await act(async () => {
      await view.client.refetchQueries({ queryKey: ["deleted-trips"] });
    });

    expect(await within(deletedSection()).findByRole("alert")).toHaveTextContent("Couldn't load — Retry");
    expect(within(deletedSection()).getByText(LISBON.label)).toBeInTheDocument(); // what was there stays under it
  });

  test("DeletedTrips_restores_a_trip_by_its_key_shows_it_is_on_its_way_and_takes_it_off_the_list_and_says_it_is_back", async () => {
    const api = stubApi();
    api.state.deleted = [LISBON, COPENHAGEN];
    let answer: (response: Response) => void = () => undefined;
    api.state.restore = () => new Promise<Response>((resolve) => (answer = resolve));
    mount();
    await within(deletedSection()).findByText(LISBON.label);

    fireEvent.click(restoreButton(LISBON.label));

    // On its way: the row says so, and no button of the list can be pressed (the answer would change the list under a finger).
    expect(await within(deletedSection()).findByRole("button", { name: "Restoring…" })).toBeDisabled();
    expect(restoreButton(COPENHAGEN.label)).toBeDisabled();
    expect(api.restores()).toEqual([{ path: "/api/trips/deleted/2026-09-12/restore", method: "POST", contentType: "application/json", body: {} }]);

    api.state.deleted = [COPENHAGEN]; // by the time it is asked again
    await act(async () => answer(new Response(null, { status: 204 })));

    await waitFor(() => expect(rowsOf().map((row) => row.textContent)).toEqual(["Copenhagen · 1 – 3 Aug 2026Restore"]));
    expect(note()).toBe("Restored Lisbon · 12 – 16 Sep 2026"); // said in a status, for the row that had the focus is gone
    expect(restoreButton(COPENHAGEN.label)).toBeEnabled();
    expect(api.calls.filter((call) => call.path === "/api/trips/deleted").length).toBeGreaterThanOrEqual(2); // and what is on screen was asked for again
  });

  test("DeletedTrips_puts_the_focus_on_the_next_restore_button_the_one_before_it_for_the_last_and_the_note_when_none_is_left", async () => {
    const api = stubApi();
    api.state.deleted = [LISBON, COPENHAGEN, PORTO];
    mount();
    await within(deletedSection()).findByText(LISBON.label);

    // A row in the middle: the next.
    api.state.deleted = [LISBON, PORTO];
    fireEvent.click(restoreButton(COPENHAGEN.label));
    await waitFor(() => expect(restoreButton(PORTO.label)).toHaveFocus());

    // The last: the one before.
    api.state.deleted = [LISBON];
    fireEvent.click(restoreButton(PORTO.label));
    await waitFor(() => expect(restoreButton(LISBON.label)).toHaveFocus());

    // The only one: the note that says there is none, where the list was. The list that is asked for again has not come: the row is off it at once.
    api.state.deleted = () => new Promise<Response>(() => undefined);
    fireEvent.click(restoreButton(LISBON.label));
    const none = await within(deletedSection()).findByText("No deleted trips");
    await waitFor(() => expect(none).toHaveFocus());
  });

  test("DeletedTrips_says_a_refused_restore_in_the_words_of_the_server_with_no_retry_and_names_the_trip", async () => {
    const api = stubApi();
    api.state.deleted = [LISBON];
    api.state.restore = () => new Response("{}", { status: 404 });
    mount();
    await within(deletedSection()).findByText(LISBON.label);
    let answer: (response: Response) => void = () => undefined;
    api.state.deleted = () => new Promise<Response>((resolve) => (answer = resolve)); // the list that a 404 has asked for again comes when the test says

    fireEvent.click(restoreButton(LISBON.label));

    const alert = await within(deletedSection()).findByRole("alert");
    expect(alert).toHaveTextContent("Could not restore Lisbon · 12 – 16 Sep 2026: That trip is not deleted any more.");
    expect(within(alert).queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
    expect(rowsOf()).toHaveLength(1); // not gone yet: the focus has nowhere to go from

    answer(Response.json([])); // restored in another window
    const none = await within(deletedSection()).findByText("No deleted trips"); // the row went with the list that was asked for again
    await waitFor(() => expect(none).toHaveFocus()); // and the focus, which was on its button, is on the note that took its place
    expect(api.restores()).toHaveLength(1);
  });

  test("DeletedTrips_puts_the_focus_on_the_next_restore_button_when_the_row_of_a_refused_restore_goes_with_the_list_that_is_asked_for_again", async () => {
    const api = stubApi();
    api.state.deleted = [LISBON, COPENHAGEN, PORTO];
    api.state.restore = () => new Response("{}", { status: 404 });
    mount();
    await within(deletedSection()).findByText(LISBON.label);
    restoreButton(COPENHAGEN.label).focus();

    api.state.deleted = [LISBON, PORTO]; // restored in another window
    fireEvent.click(restoreButton(COPENHAGEN.label));

    await within(deletedSection()).findByRole("alert");
    await waitFor(() => expect(within(deletedSection()).queryByText(COPENHAGEN.label)).not.toBeInTheDocument());
    await waitFor(() => expect(restoreButton(PORTO.label)).toHaveFocus());
  });

  test("DeletedTrips_leaves_the_focus_where_the_owner_has_put_it_when_the_row_of_a_refused_restore_goes", async () => {
    const api = stubApi();
    api.state.deleted = [LISBON, COPENHAGEN];
    api.state.restore = () => new Response("{}", { status: 404 });
    mount();
    await within(deletedSection()).findByText(LISBON.label);
    const outside = document.body.appendChild(document.createElement("button"));

    api.state.deleted = [LISBON];
    fireEvent.click(restoreButton(COPENHAGEN.label));
    outside.focus(); // the owner has gone elsewhere
    await waitFor(() => expect(within(deletedSection()).queryByText(COPENHAGEN.label)).not.toBeInTheDocument());

    expect(outside).toHaveFocus();
    outside.remove();
  });

  test("DeletedTrips_does_not_move_the_focus_later_for_a_refused_restore_whose_row_stayed_when_the_row_goes_with_another_list", async () => {
    const api = stubApi();
    api.state.deleted = [LISBON, COPENHAGEN];
    api.state.restore = () => refused();
    const { client } = mount();
    await within(deletedSection()).findByText(LISBON.label);
    (document.activeElement as HTMLElement | null)?.blur();
    fireEvent.click(restoreButton(LISBON.label));
    await within(deletedSection()).findByRole("alert");
    await waitFor(() => expect(client.isFetching()).toBe(0)); // the list that the 404 asked for has come, with the row still on it: the row stays

    api.state.deleted = [COPENHAGEN]; // and it goes some time later, for another reason
    await act(async () => {
      await client.refetchQueries({ queryKey: ["deleted-trips"] });
    });

    await waitFor(() => expect(within(deletedSection()).queryByText(LISBON.label)).not.toBeInTheDocument());
    expect(document.body).toHaveFocus(); // what was to be done about that row was dropped, and the focus does not jump
  });

  test("DeletedTrips_does_not_move_the_focus_for_a_refused_restore_whose_row_stays", async () => {
    const api = stubApi();
    api.state.deleted = [LISBON, COPENHAGEN];
    api.state.restore = () => refused();
    mount();
    await within(deletedSection()).findByText(LISBON.label);
    (document.activeElement as HTMLElement | null)?.blur();

    fireEvent.click(restoreButton(LISBON.label));
    await within(deletedSection()).findByRole("alert");

    expect(rowsOf()).toHaveLength(2); // the list that was asked for again still has it
    expect(restoreButton(COPENHAGEN.label)).not.toHaveFocus(); // nothing has gone, so there is nowhere to move the focus from
  });

  test("DeletedTrips_offers_a_retry_for_a_restore_that_failed_and_sends_the_same_trip_again", async () => {
    const api = stubApi();
    api.state.deleted = [LISBON, COPENHAGEN];
    api.state.restore = () => new Response("{}", { status: 502 });
    mount();
    await within(deletedSection()).findByText(LISBON.label);
    restoreButton(COPENHAGEN.label).focus();

    fireEvent.click(restoreButton(COPENHAGEN.label));

    const alert = await within(deletedSection()).findByRole("alert");
    expect(alert).toHaveTextContent("Couldn't restore Copenhagen · 1 – 3 Aug 2026 — Retry");
    expect(rowsOf()).toHaveLength(2); // the list is all there
    expect(restoreButton(COPENHAGEN.label)).toBeEnabled();

    api.state.restore = () => new Response(null, { status: 204 });
    api.state.deleted = [LISBON];
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(rowsOf()).toHaveLength(1));
    expect(api.restores().map((call) => call.path)).toEqual(["/api/trips/deleted/2026-08-01/restore", "/api/trips/deleted/2026-08-01/restore"]);
    expect(within(deletedSection()).queryByRole("alert")).not.toBeInTheDocument();
  });

  test("DeletedTrips_puts_the_focus_back_on_the_restore_button_that_failed_when_nothing_has_it", async () => {
    // A button that is turned off while it is pressed may take the focus with it (and a tap does not focus it in Safari).
    const api = stubApi();
    api.state.deleted = [LISBON];
    api.state.restore = () => new Response("{}", { status: 503 });
    mount();
    await within(deletedSection()).findByText(LISBON.label);
    (document.activeElement as HTMLElement | null)?.blur();

    fireEvent.click(restoreButton(LISBON.label));

    await within(deletedSection()).findByRole("alert");
    await waitFor(() => expect(restoreButton(LISBON.label)).toHaveFocus());
  });
});
