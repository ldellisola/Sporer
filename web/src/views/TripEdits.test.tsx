import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import lisbonFixture from "../../e2e/fixtures/trip-2026-09-12.json";
import type { TripResponse } from "../api/types";
import { useTrip } from "../api/queries";
import { refusal, stubEdits } from "../test/stubEdits";
import { DeleteTripConfirm, EditTripForm, TripEditActions } from "./TripEdits";

// The forms of the edits of a trip, each on its own: the panel that composes them has its own tests (TripPanel.test.tsx).

const LISBON = lisbonFixture as TripResponse; // 2026-09-12, nights up to the 15th, back on the 16th; named by the server ("Lisbon & Sintra"), not by the owner
const EDITED: TripResponse = { ...LISBON, name: "Portugal 2026", edited: true };
const PUT = "PUT /api/trips/2026-09-12";
const DELETE = "DELETE /api/trips/2026-09-12";

function newClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

/** The trip as the panel asks for it, which is what a write that finds it gone has asked for again. */
function OnScreen({ id }: { id: string }) {
  useTrip(id);
  return null;
}

function mount(ui: ReactElement, client: QueryClient = newClient()) {
  return { client, ...render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>) };
}

beforeEach(() => {
  window.history.replaceState(null, "", "/trip/2026-09-12");
});

describe("TripEditActions", () => {
  test("TripEditActions_has_a_button_for_each_form_and_says_which_was_pressed", () => {
    const onEdit = vi.fn();
    const onDelete = vi.fn();
    render(<TripEditActions onEdit={onEdit} onDelete={onDelete} />);

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect([onEdit.mock.calls.length, onDelete.mock.calls.length]).toEqual([1, 0]);
    fireEvent.click(screen.getByRole("button", { name: "Delete trip" }));
    expect([onEdit.mock.calls.length, onDelete.mock.calls.length]).toEqual([1, 1]);
  });

  test("TripEditActions_puts_the_focus_on_the_button_that_opened_the_form_that_was_closed_and_nowhere_when_it_is_not_told", () => {
    const { unmount } = render(<TripEditActions onEdit={() => undefined} onDelete={() => undefined} />);
    expect(document.body).toHaveFocus(); // as the panel opens: nothing was pressed
    unmount();

    const edit = render(<TripEditActions onEdit={() => undefined} onDelete={() => undefined} focus="edit" />);
    expect(screen.getByRole("button", { name: "Edit" })).toHaveFocus();
    edit.unmount();

    render(<TripEditActions onEdit={() => undefined} onDelete={() => undefined} focus="delete" />);
    expect(screen.getByRole("button", { name: "Delete trip" })).toHaveFocus();
  });
});

describe("EditTripForm", () => {
  const nameField = () => screen.getByRole("textbox", { name: "Name" });
  const startField = () => screen.getByLabelText("Start date");
  const endField = () => screen.getByLabelText("End date");
  const save = () => screen.getByRole("button", { name: /^Sav/ });

  function mountEdit(trip: TripResponse = LISBON) {
    const onClose = vi.fn();
    return { onClose, ...mount(<EditTripForm trip={trip} onClose={onClose} />) };
  }

  /** The body of the only write that was made. */
  const bodyOf = (api: ReturnType<typeof stubEdits>) => api.writes().map((call) => call.body);

  test("EditTripForm_opens_with_an_empty_name_that_shows_the_automatic_one_and_the_dates_of_the_trip", () => {
    stubEdits({});

    mountEdit();

    expect(nameField()).toHaveValue(""); // the trip has no name of its own: the field is for one, and the one it has is what it shows empty
    expect(nameField()).toHaveAttribute("placeholder", "Lisbon & Sintra");
    expect(nameField()).toHaveFocus();
    expect(nameField()).toHaveAttribute("maxlength", "100");
    expect(startField()).toHaveValue("2026-09-12");
    expect(startField()).toHaveAttribute("type", "date");
    expect(endField()).toHaveValue("2026-09-16");
    expect(endField()).toHaveAttribute("type", "date");
    for (const field of [startField(), endField()]) {
      expect(field).toHaveAttribute("min", "1970-01-01"); // what the server takes
      expect(field).toHaveAttribute("max", "2099-12-31");
    }
  });

  test("EditTripForm_opens_with_the_name_of_a_trip_that_has_been_edited_and_says_what_an_empty_one_shows", () => {
    // The trip says whether it was edited, not whether the name is the owner's: the name it shows is kept, and cleared to go back to the automatic one.
    stubEdits({});

    mountEdit(EDITED);

    expect(nameField()).toHaveValue("Portugal 2026");
    expect(nameField()).toHaveAttribute("placeholder", "Automatic name");
  });

  test("EditTripForm_cancel_and_escape_close_it_and_write_nothing", () => {
    const api = stubEdits({});
    const { onClose } = mountEdit();
    fireEvent.change(nameField(), { target: { value: "Something else" } });

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(nameField(), { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(2);
    expect(api.writes()).toEqual([]);
  });

  test("EditTripForm_saves_the_trimmed_name_with_all_three_keys_as_json_and_shows_it_is_on_its_way", async () => {
    let release: (response: Response) => void = () => undefined;
    const api = stubEdits({ [PUT]: () => new Promise<Response>((resolve) => (release = resolve)) });
    const { client, onClose } = mountEdit();
    client.setQueryData(["heat", "a", "b"], { cells: [] });

    fireEvent.change(nameField(), { target: { value: "  Portugal 2026 " } });
    fireEvent.click(save());

    expect(await screen.findByRole("button", { name: "Saving…" })).toBeDisabled();
    // The dates are sent as they are: the server takes a date that is the trip's own as "as detected", and every key has to be there.
    expect(api.writes()).toEqual([
      { method: "PUT", path: "/api/trips/2026-09-12", search: "", contentType: "application/json", body: { name: "Portugal 2026", startDate: "2026-09-12", endDate: "2026-09-16" } },
    ]);
    expect(onClose).not.toHaveBeenCalled();

    // It is on its way, and what Cancel and Escape would do is not to take it back: they wait.
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    fireEvent.keyDown(nameField(), { key: "Escape" });
    fireEvent.submit(nameField().closest("form")!);
    expect(onClose).not.toHaveBeenCalled();
    expect(api.writes()).toHaveLength(1); // and it is not sent twice

    release(Response.json({ id: "2026-09-12" }));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(window.location.pathname).toBe("/trip/2026-09-12"); // the id is the same: nowhere to go
    expect(client.getQueryState(["heat", "a", "b"])?.isInvalidated).toBe(true); // and everything is asked for again
  });

  test("EditTripForm_sends_null_for_an_empty_name_which_goes_back_to_the_automatic_one", async () => {
    const api = stubEdits({ [PUT]: () => Response.json({ id: "2026-09-12" }) });
    const { onClose } = mountEdit(EDITED);

    fireEvent.change(nameField(), { target: { value: "   " } });
    fireEvent.click(save());

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(bodyOf(api)).toEqual([{ name: null, startDate: "2026-09-12", endDate: "2026-09-16" }]); // the key is there, as the server wants it
  });

  test("EditTripForm_closes_without_a_write_when_nothing_was_changed", () => {
    // An edit that says what the trip is already would be stored as an edit, and the trip would count as edited.
    for (const trip of [LISBON, EDITED]) {
      const api = stubEdits({});
      const { onClose, unmount } = mountEdit(trip);

      fireEvent.change(nameField(), { target: { value: ` ${trip.edited ? trip.name : ""} ` } });
      fireEvent.click(save());

      expect(onClose, trip.name).toHaveBeenCalledTimes(1);
      expect(api.writes(), trip.name).toEqual([]);
      unmount();
    }
  });

  test("EditTripForm_leaves_the_name_of_a_trip_that_has_none_to_the_server_when_only_the_dates_change", async () => {
    // Sending the automatic name that the form shows would make it the owner's, and it would no longer follow the nights that the new dates make.
    const api = stubEdits({ [PUT]: () => Response.json({ id: "2026-09-12" }) });
    const { onClose } = mountEdit();

    fireEvent.change(endField(), { target: { value: "2026-09-17" } });
    fireEvent.click(save());

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(bodyOf(api)).toEqual([{ name: null, startDate: "2026-09-12", endDate: "2026-09-17" }]);
  });

  test("EditTripForm_keeps_the_name_of_a_trip_that_was_edited_when_only_the_dates_change", async () => {
    const api = stubEdits({ [PUT]: () => Response.json({ id: "2026-09-12" }) });
    const { onClose } = mountEdit(EDITED);

    fireEvent.change(endField(), { target: { value: "2026-09-17" } });
    fireEvent.click(save());

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(bodyOf(api)).toEqual([{ name: "Portugal 2026", startDate: "2026-09-12", endDate: "2026-09-17" }]); // a name that is cleared is the way back, and this one was not
  });

  test("EditTripForm_goes_to_the_trip_by_its_new_id_in_place_of_the_page_when_the_start_date_moves", async () => {
    const api = stubEdits({ [PUT]: () => Response.json({ id: "2026-09-10" }) });
    mountEdit();
    const entries = window.history.length;

    fireEvent.change(startField(), { target: { value: "2026-09-10" } });
    fireEvent.click(save());

    await waitFor(() => expect(window.location.pathname).toBe("/trip/2026-09-10"));
    expect(window.history.length).toBe(entries); // replaced: Back does not return to a trip that has no such id any more
    expect(bodyOf(api)).toEqual([{ name: null, startDate: "2026-09-10", endDate: "2026-09-16" }]);
  });

  test("EditTripForm_says_a_start_date_that_is_not_before_the_end_date_and_sends_nothing", () => {
    const api = stubEdits({});
    const { onClose } = mountEdit();

    fireEvent.change(startField(), { target: { value: "2026-09-16" } }); // the end date: the nights are from the start to the night before the end
    fireEvent.click(save());

    expect(screen.getByRole("alert")).toHaveTextContent("The start date must be before the end date.");
    expect(endField()).toHaveAttribute("aria-invalid", "true");
    expect(endField()).toHaveAccessibleDescription("The start date must be before the end date.");
    expect(endField()).toHaveFocus(); // where the owner goes to put it right
    expect(api.writes()).toEqual([]);
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.change(startField(), { target: { value: "2026-09-18" } }); // after it
    fireEvent.click(save());
    expect(screen.getByRole("alert")).toHaveTextContent("The start date must be before the end date.");
    expect(api.writes()).toEqual([]);

    fireEvent.change(startField(), { target: { value: "2026-09-15" } }); // what was said is not true of what is there now
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(endField()).not.toHaveAttribute("aria-invalid");
  });

  test("EditTripForm_tells_one_thing_at_a_time_a_date_that_is_wrong_takes_the_refusal_of_the_server_away", async () => {
    const api = stubEdits({ [PUT]: () => refusal(409, "Another trip has one of the nights.") });
    mountEdit();
    fireEvent.change(endField(), { target: { value: "2026-10-25" } });
    fireEvent.click(save());
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not save: Another trip has one of the nights.");

    fireEvent.change(endField(), { target: { value: "2026-09-12" } });
    fireEvent.click(save());

    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.getByRole("alert")).toHaveTextContent("The start date must be before the end date.");
    expect(api.writes()).toHaveLength(1);
  });

  test("EditTripForm_asks_for_a_date_that_is_empty_and_sends_nothing", () => {
    const api = stubEdits({});
    mountEdit();

    fireEvent.change(startField(), { target: { value: "" } });
    fireEvent.click(save());
    expect(screen.getByRole("alert")).toHaveTextContent("Enter a start date.");
    expect(startField()).toHaveAttribute("aria-invalid", "true");
    expect(startField()).toHaveFocus();

    fireEvent.change(startField(), { target: { value: "2026-09-12" } });
    fireEvent.change(endField(), { target: { value: "" } });
    fireEvent.click(save());
    expect(screen.getByRole("alert")).toHaveTextContent("Enter an end date.");
    expect(endField()).toHaveFocus();
    expect(api.writes()).toEqual([]);
  });

  test("EditTripForm_says_a_400_in_the_words_of_the_server_with_no_retry_and_keeps_the_form_to_put_it_right", async () => {
    const api = stubEdits({ [PUT]: () => refusal(400, "The name can be at most 100 characters.") });
    const { onClose } = mountEdit();
    fireEvent.change(nameField(), { target: { value: "x".repeat(60) + "🙂".repeat(30) } }); // 90 characters to a field that counts what is read; 120 to the server

    fireEvent.click(save());

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Could not save: The name can be at most 100 characters.");
    expect(within(alert).queryByRole("button", { name: "Retry" })).not.toBeInTheDocument(); // sent again it is refused again
    expect(onClose).not.toHaveBeenCalled();
    expect(nameField()).toHaveValue("x".repeat(60) + "🙂".repeat(30));
    expect(save()).toBeEnabled(); // what is wrong is in the form, which can be changed and sent again

    fireEvent.change(nameField(), { target: { value: "Short" } });
    fireEvent.click(save());
    await waitFor(() => expect(api.writes()).toHaveLength(2));
  });

  test("EditTripForm_says_a_409_in_the_words_of_the_server_and_a_line_of_its_own_when_it_has_none_with_no_retry", async () => {
    const overlap = "The trip would have nights from 2026-09-12 to 2026-10-24, and another trip has one of them.";
    let answer: () => Response = () => refusal(409, overlap);
    stubEdits({ [PUT]: () => answer() });
    const { onClose } = mountEdit();
    fireEvent.change(endField(), { target: { value: "2026-10-25" } });

    fireEvent.click(save());

    expect(await screen.findByRole("alert")).toHaveTextContent(`Could not save: ${overlap}`);
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(endField()).toHaveValue("2026-10-25");

    answer = () => new Response("{}", { status: 409 });
    fireEvent.click(save());

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Could not save: Overlaps another trip."));
  });

  test("EditTripForm_says_a_404_with_no_retry_and_has_the_trip_that_is_on_screen_asked_for_again", async () => {
    const api = stubEdits({
      [PUT]: () => new Response("{}", { status: 404 }),
      "GET /api/trips/2026-09-12": () => new Response("{}", { status: 404 }),
    });
    mount(
      <>
        <OnScreen id="2026-09-12" />
        <EditTripForm trip={LISBON} onClose={() => undefined} />
      </>,
    );
    await waitFor(() => expect(api.reads("/api/trips/2026-09-12")).toHaveLength(1)); // as the panel has it
    fireEvent.change(nameField(), { target: { value: "Portugal 2026" } });

    fireEvent.click(save());

    expect(await screen.findByRole("alert")).toHaveTextContent("Could not save: This trip no longer exists.");
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
    await waitFor(() => expect(api.reads("/api/trips/2026-09-12")).toHaveLength(2)); // what is on screen was drawn before the trip went
  });

  test("EditTripForm_offers_a_retry_for_a_failure_that_may_pass_and_sends_the_same_edit_again", async () => {
    let failing = true;
    const api = stubEdits({ [PUT]: () => (failing ? new Response("{}", { status: 503 }) : Response.json({ id: "2026-09-12" })) });
    const { onClose } = mountEdit();
    fireEvent.change(nameField(), { target: { value: "Portugal 2026" } });
    fireEvent.click(save());

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Couldn't save — Retry");
    failing = false;
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(bodyOf(api)).toEqual([
      { name: "Portugal 2026", startDate: "2026-09-12", endDate: "2026-09-16" },
      { name: "Portugal 2026", startDate: "2026-09-12", endDate: "2026-09-16" },
    ]);
  });

  test("EditTripForm_puts_the_focus_back_on_save_after_a_failure_when_nothing_has_it", async () => {
    // A tap on a button does not focus it in Safari, and a button that is turned off while it is pressed may take the focus with it: the page has it.
    stubEdits({ [PUT]: () => refusal(400, "No.") });
    mountEdit();
    fireEvent.change(nameField(), { target: { value: "Portugal 2026" } });
    nameField().blur();
    expect(document.body).toHaveFocus();
    fireEvent.click(save());

    await screen.findByRole("alert");

    expect(save()).toHaveFocus();
  });

  test("EditTripForm_leaves_the_focus_where_the_owner_put_it_when_a_save_fails", async () => {
    stubEdits({ [PUT]: () => refusal(400, "No.") });
    mountEdit();
    fireEvent.change(nameField(), { target: { value: "Portugal 2026" } });
    fireEvent.click(save());
    endField().focus();

    await screen.findByRole("alert");

    expect(endField()).toHaveFocus();
  });
});

describe("DeleteTripConfirm", () => {
  const question = () => screen.getByText("Delete this trip? It stays deleted when your data is reprocessed. You can restore it in Settings.");

  function mountDelete() {
    const onClose = vi.fn();
    return { onClose, ...mount(<DeleteTripConfirm trip={LISBON} onClose={onClose} />) };
  }

  test("DeleteTripConfirm_asks_with_the_words_that_say_what_it_does_and_takes_the_focus_so_that_escape_is_cancel_at_once", () => {
    stubEdits({});

    const { onClose } = mountDelete();

    expect(question()).toHaveFocus(); // on the question, which is read, and not on a button: Enter held down on the one that opened it would delete
    fireEvent.keyDown(question(), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Delete" })).toBeEnabled();
  });

  test("DeleteTripConfirm_cancel_closes_it_and_writes_nothing", () => {
    const api = stubEdits({});
    const { onClose } = mountDelete();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(api.writes()).toEqual([]);
  });

  test("DeleteTripConfirm_deletes_the_trip_shows_it_is_on_its_way_and_goes_to_the_list_of_trips", async () => {
    let release: (response: Response) => void = () => undefined;
    const api = stubEdits({ [DELETE]: () => new Promise<Response>((resolve) => (release = resolve)) });
    const { client } = mountDelete();
    client.setQueryData(["heat", "a", "b"], { cells: [] });

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    expect(await screen.findByRole("button", { name: "Deleting…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled(); // it is on its way, and Cancel would not take it back
    fireEvent.submit(question().closest("form")!);
    expect(api.writes().map((call) => `${call.method} ${call.path}`)).toEqual(["DELETE /api/trips/2026-09-12"]); // once
    expect(window.location.pathname).toBe("/trip/2026-09-12");

    release(new Response(null, { status: 204 }));

    await waitFor(() => expect(window.location.pathname).toBe("/trips"));
    expect(client.getQueryState(["heat", "a", "b"])?.isInvalidated).toBe(true);
  });

  test("DeleteTripConfirm_says_a_404_with_no_retry_turns_delete_off_and_puts_the_focus_on_cancel", async () => {
    // Sent again it is refused again, and there is nothing in the question to change: the way on is Cancel.
    const api = stubEdits({ [DELETE]: () => new Response("{}", { status: 404 }) });
    mountDelete();
    screen.getByRole("button", { name: "Delete" }).focus();

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Could not delete: This trip no longer exists.");
    expect(within(alert).queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    expect(window.location.pathname).toBe("/trip/2026-09-12");
    expect(api.writes()).toHaveLength(1);
  });

  test("DeleteTripConfirm_offers_a_retry_for_a_failure_that_may_pass", async () => {
    let failing = true;
    const api = stubEdits({ [DELETE]: () => (failing ? new Response("{}", { status: 502 }) : new Response(null, { status: 204 })) });
    mountDelete();
    question().blur(); // a tap on a button does not focus it in Safari: the page has the focus

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Couldn't delete — Retry");
    expect(screen.getByRole("button", { name: "Delete" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Delete" })).toHaveFocus(); // where the owner presses it again, or goes to the Retry that is next to it
    failing = false;
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(window.location.pathname).toBe("/trips"));
    expect(api.writes()).toHaveLength(2);
  });
});
