import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, test, vi } from "vitest";
import cafe from "../../e2e/fixtures/place-cafe.json";
import { usePlace } from "../api/queries";
import type { PlaceCandidate, PlaceResponse } from "../api/types";
import { refusal, stubEdits, type Handler } from "../test/stubEdits";
import { EditActions, MergeConfirm, MergedPlaces, RenameForm } from "./PlaceEdits";

// The forms of the edits, each on its own: the panel that composes them has its own tests (PlacePanel.test.tsx).

const CAFE = cafe as PlaceResponse;
const KEY = ["place", 2] as const;
const BISTRO: PlaceCandidate = { id: 7, name: "Bistro", address: "Storgata 14, Oslo", distanceM: 42.4, visits: 3 };
const NAMELESS: PlaceCandidate = { id: 8, name: null, address: null, distanceM: 1250, visits: 1 };

const SAME_PLACE = "The place is the one it is to be merged into, or is merged into it already.";
const TOO_DEEP =
  "The place has places merged into it that are 32 merges deep already: one more would be more than the 32 that can be followed.";

/** Mounts `ui` with a client that holds `place` as the query of the place, as the panel has it. */
function mount(ui: ReactElement, place: PlaceResponse = CAFE) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(KEY, place);
  return { client, ...render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>) };
}

describe("EditActions", () => {
  test("EditActions_has_a_button_for_each_form_and_says_which_was_pressed", () => {
    const onRename = vi.fn();
    const onMerge = vi.fn();
    render(<EditActions onRename={onRename} onMerge={onMerge} />);

    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    expect([onRename.mock.calls.length, onMerge.mock.calls.length]).toEqual([1, 0]);
    fireEvent.click(screen.getByRole("button", { name: "Merge with…" }));
    expect([onRename.mock.calls.length, onMerge.mock.calls.length]).toEqual([1, 1]);
  });
});

describe("RenameForm", () => {
  const nameField = () => screen.getByRole("textbox", { name: "Name" });

  function mountRename(place: PlaceResponse = CAFE) {
    const onClose = vi.fn();
    return { onClose, ...mount(<RenameForm place={place} placeKey={KEY} onClose={onClose} />, place) };
  }

  test("RenameForm_opens_with_the_current_name_selected_and_says_what_an_empty_name_shows", () => {
    stubEdits({});

    mountRename();

    expect(nameField()).toHaveValue("Café");
    expect(nameField()).toHaveFocus();
    expect(nameField()).toHaveAttribute("placeholder", "OpenStreetMap name"); // what an empty name shows again
    expect(nameField()).toHaveAttribute("maxlength", "100");
  });

  test("RenameForm_cancel_and_escape_close_it_and_write_nothing", () => {
    const api = stubEdits({});
    const { onClose } = mountRename();
    fireEvent.change(nameField(), { target: { value: "Something else" } });

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(nameField(), { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(2);
    expect(api.writes()).toEqual([]);
  });

  test("RenameForm_saves_the_trimmed_name_as_json_shows_it_pending_and_puts_the_answer_in_the_query_of_the_place", async () => {
    let release: (response: Response) => void = () => undefined;
    const api = stubEdits({ "PUT /api/places/2/name": () => new Promise<Response>((resolve) => (release = resolve)) });
    const { client, onClose } = mountRename();
    client.setQueryData(["heat", "a", "b"], { cells: [] });

    fireEvent.change(nameField(), { target: { value: "  Corner Café " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByRole("button", { name: "Saving…" })).toBeDisabled();
    expect(api.writes()).toEqual([{ method: "PUT", path: "/api/places/2/name", search: "", contentType: "application/json", body: { name: "Corner Café" } }]);
    expect(onClose).not.toHaveBeenCalled();

    const answer = { ...CAFE, name: "Corner Café" };
    release(Response.json(answer));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(client.getQueryData(KEY)).toEqual(answer); // the name is the new one as the form closes, not a request later
    expect(client.getQueryState(["heat", "a", "b"])?.isInvalidated).toBe(true); // and everything else is asked for again
  });

  test("RenameForm_with_an_empty_name_sends_null_which_goes_back_to_the_name_of_OpenStreetMap", async () => {
    const api = stubEdits({ "PUT /api/places/2/name": () => Response.json({ ...CAFE, name: "Cafe (OSM)" }) });
    const { onClose } = mountRename({ ...CAFE, name: "My name" });

    fireEvent.change(nameField(), { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(api.writes().map((call) => call.body)).toEqual([{ name: null }]); // the key is there, as the server wants it
  });

  test("RenameForm_closes_without_a_write_when_the_name_was_not_changed", () => {
    // A place that has only the name of OpenStreetMap would be given that name as its own by a write of what it shows.
    const api = stubEdits({});
    const { onClose } = mountRename();

    fireEvent.change(nameField(), { target: { value: " Café " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(api.writes()).toEqual([]);
  });

  test("RenameForm_starts_empty_for_a_place_with_no_name_and_saving_it_empty_writes_nothing", () => {
    const api = stubEdits({});
    const { onClose } = mountRename({ ...CAFE, name: null });

    expect(nameField()).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(api.writes()).toEqual([]);
  });

  test("RenameForm_is_saved_by_enter_too", async () => {
    const api = stubEdits({ "PUT /api/places/2/name": () => Response.json({ ...CAFE, name: "Bar" }) });
    const { onClose } = mountRename();

    fireEvent.change(nameField(), { target: { value: "Bar" } });
    fireEvent.submit(nameField().closest("form")!);

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(api.writes()).toHaveLength(1);
  });

  test("RenameForm_that_fails_says_so_with_a_retry_and_keeps_the_form_and_what_was_typed", async () => {
    let failing = true;
    const api = stubEdits({ "PUT /api/places/2/name": () => (failing ? new Response("{}", { status: 500 }) : Response.json({ ...CAFE, name: "Bar" })) });
    const { onClose } = mountRename();
    fireEvent.change(nameField(), { target: { value: "Bar" } });

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Couldn't rename — Retry");
    expect(alert).toHaveTextContent("PUT /api/places/2/name failed with status 500");
    expect(nameField()).toHaveValue("Bar"); // the form is still there, with what was typed
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    expect(onClose).not.toHaveBeenCalled();

    failing = false;
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(api.writes().map((call) => call.body)).toEqual([{ name: "Bar" }, { name: "Bar" }]); // the same again
  });

  test("RenameForm_says_the_place_is_gone_when_the_server_says_so", async () => {
    stubEdits({ "PUT /api/places/2/name": () => new Response("{}", { status: 404 }) });
    mountRename();
    fireEvent.change(nameField(), { target: { value: "Bar" } });

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("This place no longer exists");
  });
});

describe("MergeConfirm", () => {
  const keepNames = () => screen.getByRole("group", { name: "Name to keep" });

  function mountConfirm(other: PlaceCandidate = BISTRO, place: PlaceResponse = CAFE) {
    const onClose = vi.fn();
    return { onClose, ...mount(<MergeConfirm place={place} placeKey={KEY} other={other} onClose={onClose} />, place) };
  }

  const SURVIVOR = { ...CAFE, visits: 6, totalSeconds: 9_000, merged: [{ id: 7, name: "Bistro" }] };

  test("MergeConfirm_asks_to_merge_the_other_place_into_this_one_with_this_ones_name_chosen_to_keep", () => {
    stubEdits({});

    mountConfirm();

    expect(screen.getByText("Merge Bistro into Café?")).toBeInTheDocument(); // B into A: the place that is open is the one that stays
    expect(within(keepNames()).getByRole("radio", { name: "Café" })).toBeChecked();
    expect(within(keepNames()).getByRole("radio", { name: "Bistro" })).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Merge" })).toBeEnabled();
  });

  test("MergeConfirm_cancel_and_escape_close_it_and_write_nothing", () => {
    const api = stubEdits({});
    const { onClose } = mountConfirm();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.keyDown(keepNames(), { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(2);
    expect(api.writes()).toEqual([]);
  });

  test("MergeConfirm_keeps_the_name_of_this_place_by_default_and_posts_the_other_place_and_that_name_as_json", async () => {
    let release: (response: Response) => void = () => undefined;
    const api = stubEdits({ "POST /api/places/2/merge": () => new Promise<Response>((resolve) => (release = resolve)) });
    const { client, onClose } = mountConfirm();

    fireEvent.click(screen.getByRole("button", { name: "Merge" }));

    expect(await screen.findByRole("button", { name: "Merging…" })).toBeDisabled();
    expect(api.writes()).toEqual([
      { method: "POST", path: "/api/places/2/merge", search: "", contentType: "application/json", body: { place: 7, name: "Café" } },
    ]);
    expect(onClose).not.toHaveBeenCalled();

    release(Response.json(SURVIVOR));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(client.getQueryData(KEY)).toEqual(SURVIVOR); // the survivor, as the answer has it, is what the place query holds
  });

  test("MergeConfirm_keeps_the_name_of_the_other_place_when_the_owner_chooses_it", async () => {
    const api = stubEdits({ "POST /api/places/2/merge": () => Response.json({ ...SURVIVOR, name: "Bistro" }) });
    const { onClose } = mountConfirm();

    fireEvent.click(within(keepNames()).getByRole("radio", { name: "Bistro" }));
    expect(within(keepNames()).getByRole("radio", { name: "Café" })).not.toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Merge" }));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(api.writes().map((call) => call.body)).toEqual([{ place: 7, name: "Bistro" }]);
  });

  test("MergeConfirm_sends_null_for_a_name_to_keep_when_this_place_has_none", async () => {
    // Null leaves the survivor's name as it is, which for a place with none is none: "Unnamed place" is not a name to give it.
    const api = stubEdits({ "POST /api/places/2/merge": () => Response.json(SURVIVOR) });
    mountConfirm(BISTRO, { ...CAFE, name: null });

    expect(screen.getByText("Merge Bistro into Unnamed place?")).toBeInTheDocument();
    expect(within(keepNames()).getByRole("radio", { name: "Unnamed place" })).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Merge" }));

    await waitFor(() => expect(api.writes()).toHaveLength(1));
    expect(api.writes()[0]?.body).toEqual({ place: 7, name: null });
  });

  test("MergeConfirm_cannot_keep_the_name_of_a_place_that_has_none", async () => {
    const api = stubEdits({ "POST /api/places/2/merge": () => Response.json(SURVIVOR) });
    mountConfirm(NAMELESS);

    expect(screen.getByText("Merge Unnamed place into Café?")).toBeInTheDocument();
    expect(within(keepNames()).getByRole("radio", { name: "Unnamed place" })).toBeDisabled(); // there is no name to keep: its radio would only say null
    expect(within(keepNames()).getByRole("radio", { name: "Café" })).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Merge" }));

    await waitFor(() => expect(api.writes()).toHaveLength(1));
    expect(api.writes()[0]?.body).toEqual({ place: 8, name: "Café" });
  });

  test("MergeConfirm_says_a_409_in_the_words_of_the_server_and_a_missing_place_and_keeps_the_confirm_open", async () => {
    // The form never reads the server's words to decide what to say (P4-R26): a 409 is shown with whatever message the server gave.
    let answer: () => Response = () => refusal(409, SAME_PLACE);
    const api = stubEdits({ "POST /api/places/2/merge": () => answer() });
    const { onClose } = mountConfirm();

    fireEvent.click(screen.getByRole("button", { name: "Merge" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Couldn't merge — Retry");
    expect(alert).toHaveTextContent(`Could not merge: ${SAME_PLACE}`);
    expect(screen.getByText("Merge Bistro into Café?")).toBeInTheDocument(); // the confirm stays
    expect(onClose).not.toHaveBeenCalled();

    answer = () => refusal(409, TOO_DEEP);
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(`Could not merge: ${TOO_DEEP}`));
    expect(screen.getByRole("alert")).not.toHaveTextContent(SAME_PLACE);

    answer = () => refusal(409, "Whatever the server says next.");
    fireEvent.click(within(screen.getByRole("alert")).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Could not merge: Whatever the server says next."));

    answer = () => new Response("<html>", { status: 409 }); // a 409 with no message to show
    fireEvent.click(within(screen.getByRole("alert")).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Could not merge: the server refused it."));
    expect(screen.getByRole("alert")).not.toHaveTextContent("Whatever");

    answer = () => new Response("{}", { status: 404 });
    fireEvent.click(within(screen.getByRole("alert")).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("One of the places no longer exists."));

    answer = () => new Response("<html>", { status: 502 });
    fireEvent.click(within(screen.getByRole("alert")).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("POST /api/places/2/merge failed with status 502")); // anything else: what failed

    expect(api.writes().map((call) => call.body)).toEqual(Array.from({ length: 6 }, () => ({ place: 7, name: "Café" }))); // Retry sends the same again
  });

  test("MergeConfirm_that_works_after_a_retry_closes_it_and_the_error", async () => {
    let failing = true;
    stubEdits({ "POST /api/places/2/merge": () => (failing ? new Response("{}", { status: 500 }) : Response.json(SURVIVOR)) });
    const { onClose } = mountConfirm();
    fireEvent.click(screen.getByRole("button", { name: "Merge" }));
    const alert = await screen.findByRole("alert");

    failing = false;
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("MergedPlaces", () => {
  const MERGED = { ...CAFE, merged: [{ id: 7, name: "Bistro" }, { id: 9, name: null }] };
  const merged = () => screen.getByRole("region", { name: "Merged places" });

  /** The section as the panel has it: over the place that its query holds, which is what a write of the section changes. */
  function Section() {
    const place = usePlace(2).data;
    return place === undefined ? null : <MergedPlaces place={place} placeKey={KEY} />;
  }

  function mountSection(routes: Record<string, Handler>, place: PlaceResponse = MERGED) {
    const api = stubEdits({ "GET /api/places/2": () => Response.json(place), ...routes });
    return { api, ...mount(<Section />, place) };
  }

  test("MergedPlaces_lists_the_places_merged_in_each_with_a_separate_button_that_says_whose_it_is", () => {
    mountSection({});

    const rows = within(merged()).getAllByRole("listitem");
    expect(rows.map((row) => row.textContent)).toEqual(["BistroSeparate", "Unnamed placeSeparate"]); // in the order the server gave: by name
    // Each button says whose it is, and holds the word that is on it.
    expect(within(merged()).getByRole("button", { name: "Separate Bistro" })).toHaveTextContent("Separate");
    expect(within(merged()).getByRole("button", { name: "Separate Unnamed place" })).toBeInTheDocument();
  });

  test("MergedPlaces_separate_deletes_the_merge_shows_it_pending_and_takes_the_place_off_the_list", async () => {
    let release: (response: Response) => void = () => undefined;
    let current = MERGED; // what the server has: the place is asked for again after the write, and must not bring the list back
    const api = mountSection({
      "GET /api/places/2": () => Response.json(current),
      "DELETE /api/places/2/merged/7": () => new Promise<Response>((resolve) => (release = resolve)),
    }).api;

    fireEvent.click(screen.getByRole("button", { name: "Separate Bistro" }));

    expect(await screen.findByRole("button", { name: "Separating…" })).toBeDisabled();
    expect(within(merged()).getByRole("button", { name: "Separate Unnamed place" })).toBeDisabled(); // one at a time: the answer of one is what the list is made of
    expect(api.writes()).toEqual([{ method: "DELETE", path: "/api/places/2/merged/7", search: "", contentType: "application/json", body: undefined }]);

    current = { ...CAFE, merged: [{ id: 9, name: null }] };
    release(new Response(null, { status: 204 }));

    await waitFor(() => expect(within(merged()).getAllByRole("listitem")).toHaveLength(1));
    expect(within(merged()).queryByText("Bistro")).not.toBeInTheDocument();
    expect(within(merged()).getByRole("button", { name: "Separate Unnamed place" })).toBeEnabled();
  });

  test("MergedPlaces_takes_the_separated_place_off_the_list_without_waiting_for_the_place_to_be_asked_for_again", async () => {
    // The refetch that the write makes never comes: what the list shows is what the write left in the query.
    mountSection({ "GET /api/places/2": () => new Promise<Response>(() => undefined), "DELETE /api/places/2/merged/7": () => new Response(null, { status: 204 }) });

    fireEvent.click(screen.getByRole("button", { name: "Separate Bistro" }));

    await waitFor(() => expect(screen.queryByRole("button", { name: "Separate Bistro" })).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Separate Unnamed place" })).toBeEnabled(); // and the list is usable at once, not a second click on a row that is gone
  });

  test("MergedPlaces_separate_that_fails_says_so_with_a_retry_and_keeps_the_list", async () => {
    let failing = true;
    const { api } = mountSection({ "DELETE /api/places/2/merged/7": () => (failing ? new Response("{}", { status: 500 }) : new Response(null, { status: 204 })) });
    fireEvent.click(screen.getByRole("button", { name: "Separate Bistro" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Couldn't separate — Retry");
    expect(alert).toHaveTextContent("DELETE /api/places/2/merged/7 failed with status 500");
    expect(within(merged()).getAllByRole("listitem")).toHaveLength(2); // the list is all there, and the buttons work again
    expect(within(merged()).getByRole("button", { name: "Separate Bistro" })).toBeEnabled();

    failing = false;
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(api.writes().map((call) => call.path)).toEqual(["/api/places/2/merged/7", "/api/places/2/merged/7"]); // the same again
  });

  test("MergedPlaces_separate_says_the_place_is_no_longer_merged_when_the_server_says_it_is_not", async () => {
    mountSection({ "DELETE /api/places/2/merged/7": () => new Response("{}", { status: 404 }) });

    fireEvent.click(screen.getByRole("button", { name: "Separate Bistro" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("It is not merged into this place any more.");
  });
});
