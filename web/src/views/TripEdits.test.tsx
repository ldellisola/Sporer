import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import lisbonFixture from "../../e2e/fixtures/trip-2026-09-12.json";
import { useTrip } from "../api/queries";
import type { TripResponse } from "../api/types";
import { takeHeadingFocus } from "../app/headingFocus";
import { refusal, stubEdits } from "../test/stubEdits";
import { DeleteTripConfirm, EditTripForm } from "./TripEdits";

// The forms of the edits of a trip, each on its own: the panel that composes them has its own tests (TripPanel.test.tsx).

const LISBON = lisbonFixture as TripResponse; // 2026-09-12, nights up to the 15th, back on the 16th; named by the server ("Lisbon & Sintra"), not by the owner
const EDITED: TripResponse = { ...LISBON, name: "Portugal 2026", ownName: "Portugal 2026", edited: true }; // named by the owner
const DATES_EDITED: TripResponse = { ...LISBON, name: "Lisbon & Oslo", edited: true, datesEdited: true, localEndDate: "2026-09-18" }; // given other dates, and named by the server still
const BOTH_EDITED: TripResponse = { ...EDITED, datesEdited: true, localEndDate: "2026-09-18" }; // named by the owner, and given other dates
const ONGOING: TripResponse = { ...LISBON, ongoing: true, end: null, localEndDate: "2026-09-17" }; // not back yet: its end date is the day after its last night, which moves on
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
  takeHeadingFocus(); // what an earlier test asked for and did not take
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

  test("EditTripForm_opens_with_the_name_the_owner_gave_the_trip_and_says_what_an_empty_one_shows", () => {
    stubEdits({});

    mountEdit(EDITED);

    expect(nameField()).toHaveValue("Portugal 2026"); // `ownName`: the owner's, which is cleared to go back to the automatic one, whose words are not known
    expect(nameField()).toHaveAttribute("placeholder", "Automatic name");
  });

  test("EditTripForm_opens_a_trip_that_was_edited_but_not_named_with_an_empty_name_that_shows_the_automatic_one", () => {
    // The dates were edited and the name is still made up: it is the placeholder, and it is not in the field to be sent back as the owner's.
    stubEdits({});

    mountEdit(DATES_EDITED);

    expect(nameField()).toHaveValue("");
    expect(nameField()).toHaveAttribute("placeholder", "Lisbon & Oslo");
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
    // Every key has to be there, and a date that was not touched is null: it is the trip's own, which was only prefilled (see the tests of the dates).
    expect(api.writes()).toEqual([
      { method: "PUT", path: "/api/trips/2026-09-12", search: "", contentType: "application/json", body: { name: "Portugal 2026", startDate: null, endDate: null } },
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
    expect(bodyOf(api)).toEqual([{ name: null, startDate: null, endDate: null }]); // the key is there, as the server wants it
  });

  test("EditTripForm_closes_without_a_write_when_nothing_was_changed", () => {
    // An edit that says what the trip is already would be stored as an edit, and the trip would count as edited.
    for (const trip of [LISBON, EDITED, DATES_EDITED]) {
      const api = stubEdits({});
      const { onClose, unmount } = mountEdit(trip);

      fireEvent.change(nameField(), { target: { value: ` ${trip.ownName ?? ""} ` } });
      fireEvent.click(save());

      expect(onClose, trip.name).toHaveBeenCalledTimes(1);
      expect(api.writes(), trip.name).toEqual([]);
      unmount();
    }
  });

  test("EditTripForm_sends_the_owners_name_as_it_is_when_only_the_dates_change_and_null_stays_null", async () => {
    // Sending the automatic name that is shown would make it the owner's, and it would no longer follow the nights that the new dates make.
    for (const [trip, sent] of [[LISBON, null], [DATES_EDITED, null], [EDITED, "Portugal 2026"], [BOTH_EDITED, "Portugal 2026"]] as const) {
      const api = stubEdits({ [PUT]: () => Response.json({ id: "2026-09-12" }) });
      const { onClose, unmount } = mountEdit(trip);

      fireEvent.change(endField(), { target: { value: "2026-09-17" } });
      fireEvent.click(save());

      await waitFor(() => expect(onClose, trip.name).toHaveBeenCalledTimes(1));
      expect(bodyOf(api)[0], trip.name).toMatchObject({ name: sent, endDate: "2026-09-17" });
      unmount();
    }
  });

  test("EditTripForm_sends_a_date_only_when_the_owner_changed_it_or_it_was_already_an_edit", async () => {
    // What the form is filled in with is the trip as it was when it was read, and a trip that is still going on moves its end date on as nights are
    // processed: a date that was only prefilled and is sent back is stored as the owner's, and the trip would lose its latest night (P4-R41). The server takes
    // a date that is the trip's own as detected only while the trip has no date of its own. A trip whose edit has dates may have either of them as an edit,
    // and a null would take it back: its untouched dates are sent as they are, but for the end of a trip that is still going on, which cannot be an edit.
    const cases: [string, TripResponse, { start?: string; end?: string }, { startDate: string | null; endDate: string | null }][] = [
      ["no dates of its own, only the end is changed", LISBON, { end: "2026-09-17" }, { startDate: null, endDate: "2026-09-17" }],
      ["no dates of its own, only the start is changed", LISBON, { start: "2026-09-10" }, { startDate: "2026-09-10", endDate: null }],
      ["no dates of its own, both are changed", LISBON, { start: "2026-09-10", end: "2026-09-17" }, { startDate: "2026-09-10", endDate: "2026-09-17" }],
      ["dates of its own, only the end is changed", DATES_EDITED, { end: "2026-09-20" }, { startDate: "2026-09-12", endDate: "2026-09-20" }],
      ["dates of its own, only the start is changed", DATES_EDITED, { start: "2026-09-10" }, { startDate: "2026-09-10", endDate: "2026-09-18" }],
      ["going on, only the start is changed", ONGOING, { start: "2026-09-10" }, { startDate: "2026-09-10", endDate: null }],
      ["going on, the end is changed: it comes back then", ONGOING, { end: "2026-09-20" }, { startDate: null, endDate: "2026-09-20" }],
      ["going on with a start of its own, only the start is changed", { ...ONGOING, datesEdited: true }, { start: "2026-09-10" }, { startDate: "2026-09-10", endDate: null }],
    ];
    for (const [what, trip, change, sent] of cases) {
      const api = stubEdits({ [PUT]: () => Response.json({ id: "2026-09-12" }) });
      const { unmount } = mountEdit(trip);
      if (change.start !== undefined) fireEvent.change(startField(), { target: { value: change.start } });
      if (change.end !== undefined) fireEvent.change(endField(), { target: { value: change.end } });

      fireEvent.click(save());

      await waitFor(() => expect(api.writes(), what).toHaveLength(1));
      expect(bodyOf(api)[0], what).toMatchObject(sent);
      unmount();
    }
  });

  test("EditTripForm_renames_a_trip_that_is_still_going_on_without_sending_its_end_date_which_moves_on", async () => {
    // The end date of the form is of the trip when it was read; by the time Save is pressed the worker has processed another night, and the server's is later.
    // Sent back, the old one would be stored as the owner's end date: the trip would stop being ongoing and lose that night.
    for (const trip of [ONGOING, { ...ONGOING, datesEdited: true }]) {
      const api = stubEdits({ [PUT]: () => Response.json({ id: "2026-09-12" }) });
      const { onClose, unmount } = mountEdit(trip);

      fireEvent.change(nameField(), { target: { value: "Still away" } });
      fireEvent.click(save());

      await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
      expect(bodyOf(api)).toEqual([{ name: "Still away", startDate: trip.datesEdited ? "2026-09-12" : null, endDate: null }]);
      unmount();
    }
  });

  test("EditTripForm_takes_a_date_that_is_typed_back_to_the_one_it_was_for_untouched", async () => {
    const api = stubEdits({ [PUT]: () => Response.json({ id: "2026-09-12" }) });
    const { onClose } = mountEdit();

    fireEvent.change(endField(), { target: { value: "2026-09-20" } });
    fireEvent.change(endField(), { target: { value: "2026-09-16" } }); // as it was
    fireEvent.change(nameField(), { target: { value: "Portugal 2026" } });
    fireEvent.click(save());

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(bodyOf(api)).toEqual([{ name: "Portugal 2026", startDate: null, endDate: null }]);
  });

  test("EditTripForm_closes_without_a_write_when_nothing_was_changed_of_a_trip_that_is_still_going_on", () => {
    const api = stubEdits({});
    const { onClose } = mountEdit(ONGOING);

    fireEvent.click(save());

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(api.writes()).toEqual([]);
  });

  test("EditTripForm_clears_the_name_of_the_owner_to_go_back_to_the_automatic_one_and_a_name_is_given_to_a_trip_that_has_none", async () => {
    const api = stubEdits({ [PUT]: () => Response.json({ id: "2026-09-12" }) });
    const first = mountEdit(EDITED);
    fireEvent.change(nameField(), { target: { value: "" } });
    fireEvent.click(save());
    await waitFor(() => expect(first.onClose).toHaveBeenCalledTimes(1));
    first.unmount();

    const second = mountEdit(DATES_EDITED);
    fireEvent.change(nameField(), { target: { value: "Portugal 2026" } });
    fireEvent.click(save());
    await waitFor(() => expect(second.onClose).toHaveBeenCalledTimes(1));

    expect(bodyOf(api)).toEqual([
      { name: null, startDate: null, endDate: null },
      { name: "Portugal 2026", startDate: "2026-09-12", endDate: "2026-09-18" }, // its dates are an edit, which a null would take back
    ]);
  });

  test("EditTripForm_goes_to_the_trip_by_its_new_id_in_place_of_the_page_when_the_start_date_moves", async () => {
    const api = stubEdits({ [PUT]: () => Response.json({ id: "2026-09-10" }) });
    mountEdit();
    const entries = window.history.length;

    fireEvent.change(startField(), { target: { value: "2026-09-10" } });
    fireEvent.click(save());

    await waitFor(() => expect(window.location.pathname).toBe("/trip/2026-09-10"));
    expect(window.history.length).toBe(entries); // replaced: Back does not return to a trip that has no such id any more
    expect(bodyOf(api)).toEqual([{ name: null, startDate: "2026-09-10", endDate: null }]);
    expect(takeHeadingFocus()).toBe(true); // the panel of the new address is to put the focus on its heading: the one that had it is gone
  });

  test("EditTripForm_asks_for_no_focus_on_a_heading_when_the_id_is_the_same_for_the_form_closes_and_the_focus_goes_back_to_its_button", async () => {
    stubEdits({ [PUT]: () => Response.json({ id: "2026-09-12" }) });
    const { onClose } = mountEdit();

    fireEvent.change(nameField(), { target: { value: "Portugal 2026" } });
    fireEvent.click(save());

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(takeHeadingFocus()).toBe(false);
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

  test("EditTripForm_offers_to_use_the_detected_dates_only_for_a_trip_whose_edit_has_dates", () => {
    // A name is an edit too (`edited`), and a trip that has only that has no dates to go back from.
    for (const [trip, shown] of [[LISBON, false], [EDITED, false], [DATES_EDITED, true], [BOTH_EDITED, true]] as const) {
      stubEdits({});
      const { unmount } = mountEdit(trip);

      expect(screen.queryByRole("button", { name: "Use detected dates" }) !== null, trip.name).toBe(shown);
      unmount();
    }
  });

  test("EditTripForm_use_detected_dates_sends_null_for_both_dates_with_the_name_as_the_field_has_it", async () => {
    const api = stubEdits({ [PUT]: () => Response.json({ id: "2026-09-12" }) });
    const first = mountEdit(BOTH_EDITED);
    fireEvent.change(startField(), { target: { value: "2026-09-01" } }); // dates typed: not what this sends
    fireEvent.change(nameField(), { target: { value: "  Something else " } }); // a name typed: sent, trimmed

    fireEvent.click(screen.getByRole("button", { name: "Use detected dates" }));

    await waitFor(() => expect(first.onClose).toHaveBeenCalledTimes(1));
    expect(api.writes()).toEqual([
      { method: "PUT", path: "/api/trips/2026-09-12", search: "", contentType: "application/json", body: { name: "Something else", startDate: null, endDate: null } },
    ]);
    first.unmount();

    // The name as it is (the owner's, which the field has), and an empty one is null.
    const second = mountEdit(BOTH_EDITED);
    fireEvent.click(screen.getByRole("button", { name: "Use detected dates" }));
    await waitFor(() => expect(second.onClose).toHaveBeenCalledTimes(1));
    second.unmount();
    const third = mountEdit(BOTH_EDITED);
    fireEvent.change(nameField(), { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "Use detected dates" }));
    await waitFor(() => expect(third.onClose).toHaveBeenCalledTimes(1));

    expect(bodyOf(api).slice(1)).toEqual([
      { name: "Portugal 2026", startDate: null, endDate: null },
      { name: null, startDate: null, endDate: null },
    ]);
  });

  test("EditTripForm_use_detected_dates_sends_a_null_name_for_a_trip_the_owner_has_not_named_and_ignores_an_empty_date", async () => {
    const api = stubEdits({ [PUT]: () => Response.json({ id: "2026-09-12" }) });
    const { onClose } = mountEdit(DATES_EDITED);
    fireEvent.change(endField(), { target: { value: "" } }); // Save refuses an empty date; this does not send the dates

    fireEvent.click(screen.getByRole("button", { name: "Use detected dates" }));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(bodyOf(api)).toEqual([{ name: null, startDate: null, endDate: null }]);
  });

  test("EditTripForm_still_refuses_an_empty_date_on_save_for_a_trip_that_has_the_button", () => {
    const api = stubEdits({});
    mountEdit(DATES_EDITED);

    fireEvent.change(endField(), { target: { value: "" } });
    fireEvent.click(save());

    expect(screen.getByRole("alert")).toHaveTextContent("Enter an end date.");
    expect(api.writes()).toEqual([]);
  });

  test("EditTripForm_use_detected_dates_shows_it_is_on_its_way_waits_for_the_answer_and_goes_to_the_new_id_when_the_start_moves_back", async () => {
    let release: (response: Response) => void = () => undefined;
    const api = stubEdits({ [PUT]: () => new Promise<Response>((resolve) => (release = resolve)) });
    mountEdit({ ...DATES_EDITED, localStartDate: "2026-09-10" });
    const entries = window.history.length;

    fireEvent.click(screen.getByRole("button", { name: "Use detected dates" }));

    expect(await screen.findByRole("button", { name: "Using detected dates…" })).toBeDisabled();
    expect(save()).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(api.writes()).toHaveLength(1);

    release(Response.json({ id: "2026-09-12" })); // the detected start is the trip's id again: here that is the id it has, so the form closes

    await waitFor(() => expect(screen.queryByRole("button", { name: "Using detected dates…" })).not.toBeInTheDocument());
    expect(window.history.length).toBe(entries);
  });

  test("EditTripForm_use_detected_dates_goes_to_the_new_id_in_place_of_the_page_when_the_detected_start_is_another_night", async () => {
    stubEdits({ [PUT]: () => Response.json({ id: "2026-09-13" }) });
    mountEdit(DATES_EDITED);
    const entries = window.history.length;

    fireEvent.click(screen.getByRole("button", { name: "Use detected dates" }));

    await waitFor(() => expect(window.location.pathname).toBe("/trip/2026-09-13"));
    expect(window.history.length).toBe(entries);
    expect(takeHeadingFocus()).toBe(true);
  });

  test("EditTripForm_use_detected_dates_says_a_refusal_in_the_words_of_the_server_with_no_retry_and_a_failure_has_a_retry_that_sends_the_same_again", async () => {
    let answer: () => Response = () => refusal(409, "The detected dates would share a night with another trip.");
    const api = stubEdits({ [PUT]: () => answer() });
    const { onClose } = mountEdit(BOTH_EDITED);

    fireEvent.click(screen.getByRole("button", { name: "Use detected dates" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Could not save: The detected dates would share a night with another trip.");
    expect(within(alert).queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use detected dates" })).toBeEnabled(); // the form stays

    answer = () => new Response("{}", { status: 503 });
    fireEvent.click(screen.getByRole("button", { name: "Use detected dates" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Couldn't save — Retry"));

    // Retry sends what failed: the detected dates, and not what the form says now.
    fireEvent.change(endField(), { target: { value: "2026-09-30" } });
    answer = () => Response.json({ id: "2026-09-12" });
    fireEvent.click(within(screen.getByRole("alert")).getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(bodyOf(api)).toEqual([
      { name: "Portugal 2026", startDate: null, endDate: null },
      { name: "Portugal 2026", startDate: null, endDate: null },
      { name: "Portugal 2026", startDate: null, endDate: null },
    ]);
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
      { name: "Portugal 2026", startDate: null, endDate: null },
      { name: "Portugal 2026", startDate: null, endDate: null },
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

  test("EditTripForm_puts_the_focus_back_on_use_detected_dates_when_that_is_what_failed_and_nothing_has_it", async () => {
    stubEdits({ [PUT]: () => refusal(409, "No.") });
    mountEdit(DATES_EDITED);
    nameField().blur();
    expect(document.body).toHaveFocus();

    fireEvent.click(screen.getByRole("button", { name: "Use detected dates" }));

    await screen.findByRole("alert");
    expect(screen.getByRole("button", { name: "Use detected dates" })).toHaveFocus(); // the button that sent it, and not Save
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

  test("DeleteTripConfirm_deletes_the_trip_shows_it_is_on_its_way_and_goes_to_the_list_of_trips_in_place_of_the_trip", async () => {
    let release: (response: Response) => void = () => undefined;
    const api = stubEdits({ [DELETE]: () => new Promise<Response>((resolve) => (release = resolve)) });
    const { client } = mountDelete();
    const entries = window.history.length;
    client.setQueryData(["heat", "a", "b"], { cells: [] });

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    expect(await screen.findByRole("button", { name: "Deleting…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled(); // it is on its way, and Cancel would not take it back
    fireEvent.submit(question().closest("form")!);
    expect(api.writes().map((call) => `${call.method} ${call.path}`)).toEqual(["DELETE /api/trips/2026-09-12"]); // once
    expect(window.location.pathname).toBe("/trip/2026-09-12");

    release(new Response(null, { status: 204 }));

    await waitFor(() => expect(window.location.pathname).toBe("/trips"));
    expect(window.history.length).toBe(entries); // replaced: Back does not land on a trip that is gone
    expect(client.getQueryState(["heat", "a", "b"])?.isInvalidated).toBe(true);
    expect(takeHeadingFocus()).toBe(true); // the list is to put the focus on its heading: the trip that had it is gone
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
