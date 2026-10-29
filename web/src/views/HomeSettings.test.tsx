import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import type { HomePeriod, PlaceSearchResult } from "../api/types";
import { refusal, stubEdits, type Call, type Handler } from "../test/stubEdits";
import { HomeSettings } from "./HomeSettings";
import { SettingsNotes } from "./SettingsNotes";

const OSLO: HomePeriod = { id: 1, placeId: 7, placeName: "Oslo flat", from: "2025-01-01", to: "2026-03-31", source: "detected" };
const LISBON: HomePeriod = { id: 2, placeId: 9, placeName: "Lisbon flat", from: "2026-04-01", to: "2026-08-31", source: "user" };
const OPEN: HomePeriod = { id: 3, placeId: 7, placeName: null, from: "2026-09-01", to: null, source: "user" };
const ELSEWHERE: HomePeriod = { id: 4, placeId: 11, placeName: "Porto flat", from: "2026-10-01", to: "2026-10-31", source: "user" };

const FLAT_OSLO: PlaceSearchResult = { id: 7, name: "Oslo flat", address: "Storgata 1, Oslo", visits: 40 };
const FLAT_LISBON: PlaceSearchResult = { id: 9, name: "Lisbon flat", address: null, visits: 12 };
const NAMELESS: PlaceSearchResult = { id: 12, name: null, address: null, visits: 1 };

/**
 * A server that keeps the home periods: `GET /api/homes` lists them in date order, `POST /api/homes` adds the owner's (`add` can be changed to refuse or to
 * fail), `DELETE /api/homes/{id}` takes one off (`remove`), and `GET /api/places/search` finds `places` by name or address. `list` can be changed to hold the
 * answer back or to fail.
 */
function server(periods: HomePeriod[], places: PlaceSearchResult[] = [FLAT_OSLO, FLAT_LISBON, NAMELESS]) {
  const state = {
    periods,
    places,
    list: (): Response | Promise<Response> => Response.json({ periods: state.periods }),
    add: ((call: Call) => {
      const body = call.body as { placeId: number; from: string; to: string | null };
      const place = state.places.find((candidate) => candidate.id === body.placeId);
      const period: HomePeriod = { id: 20, placeId: body.placeId, placeName: place?.name ?? null, from: body.from, to: body.to, source: "user" };
      state.periods = [...state.periods, period].sort((a, b) => a.from.localeCompare(b.from));
      return Response.json(period, { status: 201 });
    }) as Handler,
    remove: ((call: Call) => {
      const id = Number(call.path.split("/").pop());
      state.periods = state.periods.filter((period) => period.id !== id);
      return new Response(null, { status: 204 });
    }) as Handler,
  };
  const api = stubEdits({
    "GET /api/homes": () => state.list(),
    "POST /api/homes": (call) => state.add(call),
    "GET /api/places/search": (call) => {
      const q = new URLSearchParams(call.search).get("q")?.toLowerCase() ?? "";
      return Response.json(state.places.filter((place) => q === "" || [place.name, place.address].some((part) => part?.toLowerCase().includes(q))));
    },
    ...Object.fromEntries([1, 2, 3, 4, 20].map((id) => [`DELETE /api/homes/${id}`, (call: Call) => state.remove(call)] as const)),
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
          <HomeSettings />
        </SettingsNotes>
      </QueryClientProvider>,
    ),
  };
}

const section = () => screen.getByRole("region", { name: "Home" });
const note = () => screen.getByRole("status").textContent ?? "";
const list = () => within(section()).findByRole("list", { name: "Home periods" });
const rowsOf = () => within(within(section()).getByRole("list", { name: "Home periods" })).getAllByRole("listitem");
const textsOf = (row: HTMLElement) => [...row.querySelectorAll("span")].map((part) => part.textContent);
const setHome = () => within(section()).getByRole("button", { name: "Set home" });
const removeButton = (name: RegExp | string) => within(section()).getByRole("button", { name });
const removeLisbon = () => removeButton("Remove Lisbon flat, 1 Apr – 31 Aug 2026");
const removeOpen = () => removeButton("Remove Unnamed place, From 1 Sep 2026");
const removePorto = () => removeButton("Remove Porto flat, 1 – 31 Oct 2026");
const from = () => within(section()).getByLabelText("From");
const to = () => within(section()).getByLabelText("To (optional)");
const saveButton = () => within(section()).getByRole("button", { name: /^Sav/ });
const type = (field: HTMLElement, value: string) => fireEvent.change(field, { target: { value } });

/** Opens the form and picks the place of `name` from the list (the buttons are named by what the row says: the name first). */
async function pick(name: RegExp | string) {
  fireEvent.click(setHome());
  fireEvent.click(await within(section()).findByRole("button", { name }));
  await within(section()).findByRole("button", { name: "Choose another place" });
}

describe("HomeSettings list", () => {
  test("HomeSettings_lists_the_periods_in_the_order_the_server_has_them_with_the_place_the_dates_and_where_each_came_from", async () => {
    const { api } = server([OSLO, LISBON, OPEN]);

    mount();

    expect(within(section()).getByText("Loading…")).toBeInTheDocument();
    await list();
    expect(rowsOf().map(textsOf)).toEqual([
      ["Oslo flat", "1 Jan 2025 – 31 Mar 2026", "Detected"],
      ["Lisbon flat", "1 Apr – 31 Aug 2026", "Set by you"],
      ["Unnamed place", "From 1 Sep 2026", "Set by you"], // no name: as the rest of the app says it; no end: it goes on
    ]);
    expect(api.reads("/api/homes")).toHaveLength(1);
  });

  test("HomeSettings_has_a_remove_button_for_the_periods_the_owner_set_and_none_for_those_that_were_detected", async () => {
    server([OSLO, LISBON, OPEN]);
    mount();
    await list();

    const buttons = rowsOf().map((row) => within(row).queryByRole("button")?.getAttribute("aria-label") ?? null);

    // A detected period would be found again by the next refresh, so it has none. The name holds the text that is on the button and says which period it is for.
    expect(buttons).toEqual([null, "Remove Lisbon flat, 1 Apr – 31 Aug 2026", "Remove Unnamed place, From 1 Sep 2026"]);
    expect(removeLisbon()).toHaveTextContent("Remove");
  });

  test("HomeSettings_says_there_is_no_home_when_there_is_none_and_still_offers_to_set_one", async () => {
    server([]);

    mount();

    expect(await within(section()).findByText("No home yet")).toBeInTheDocument();
    expect(within(section()).queryByRole("list")).not.toBeInTheDocument();
    expect(setHome()).toBeEnabled();
  });

  test("HomeSettings_shows_an_error_with_a_retry_that_asks_again_and_keeps_what_it_had_under_one", async () => {
    const { state } = server([OSLO]);
    state.list = () => new Response("{}", { status: 503 });
    const view = mount();

    const alert = await within(section()).findByRole("alert");
    expect(alert).toHaveTextContent("Couldn't load — Retry");
    expect(within(section()).getByRole("heading", { name: "Home" })).toBeInTheDocument(); // never blank
    expect(setHome()).toBeEnabled(); // a home can be set whether the list came or not

    state.list = () => Response.json({ periods: state.periods });
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    await list();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    state.list = () => new Response("{}", { status: 500 });
    await act(async () => {
      await view.client.refetchQueries({ queryKey: ["homes"] });
    });

    expect(await within(section()).findByRole("alert")).toHaveTextContent("Couldn't load — Retry");
    expect(rowsOf()).toHaveLength(1); // what was there stays under it
  });
});

describe("HomeSettings remove", () => {
  test("HomeSettings_removes_a_period_by_its_id_shows_it_is_on_its_way_takes_it_off_the_list_and_says_so", async () => {
    const { state, api } = server([OSLO, LISBON, OPEN]);
    let release: () => void = () => undefined;
    const remove = state.remove;
    state.remove = (call) =>
      new Promise<Response>((resolve) => {
        release = () => resolve(remove(call) as Response);
      });
    mount();
    await list();

    fireEvent.click(removeLisbon());

    // On its way: the row says so, and no button of the list can be pressed (the answer would change the list under a finger).
    expect(await within(section()).findByRole("button", { name: "Removing…" })).toBeDisabled();
    expect(removeOpen()).toBeDisabled();
    expect(api.writes()).toEqual([{ method: "DELETE", path: "/api/homes/2", search: "", contentType: "application/json", body: undefined }]);

    release();

    await waitFor(() => expect(rowsOf().map(textsOf)).toEqual([["Oslo flat", "1 Jan 2025 – 31 Mar 2026", "Detected"], ["Unnamed place", "From 1 Sep 2026", "Set by you"]]));
    expect(note()).toBe("Removed the home at Lisbon flat");
    expect(removeOpen()).toBeEnabled();
    expect(api.reads("/api/homes").length).toBeGreaterThanOrEqual(2); // what is on screen was asked for again: what detection found for those dates is the home again
  });

  test("HomeSettings_puts_the_focus_on_the_next_remove_button_that_there_is_the_one_before_it_for_the_last_and_set_home_when_none_is_left", async () => {
    const { state } = server([OSLO, LISBON, OPEN, ELSEWHERE]);
    mount();
    await list();

    // A row in the middle: the next one that has a button.
    fireEvent.click(removeOpen());
    await waitFor(() => expect(removePorto()).toHaveFocus());

    // The last: the one before it that has one (Oslo's has none, and is not in the way).
    fireEvent.click(removePorto());
    await waitFor(() => expect(removeLisbon()).toHaveFocus());

    // The only one: the button that sets a home, where the list of what can be removed was. The list that is asked for again has not come.
    state.list = () => new Promise<Response>(() => undefined);
    fireEvent.click(removeLisbon());
    await waitFor(() => expect(setHome()).toHaveFocus());
  });

  test("HomeSettings_says_a_refused_remove_in_the_words_of_the_server_with_no_retry_and_names_the_period", async () => {
    const { state } = server([OSLO, LISBON]);
    state.remove = () => refusal(409, "This home was found from where you slept.");
    mount();
    await list();

    fireEvent.click(removeLisbon());

    const alert = await within(section()).findByRole("alert");
    expect(alert).toHaveTextContent("Could not remove Lisbon flat, 1 Apr – 31 Aug 2026: This home was found from where you slept.");
    expect(within(alert).queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
    expect(rowsOf()).toHaveLength(2); // the list is all there
  });

  test("HomeSettings_lets_the_row_of_a_remove_that_found_no_period_go_with_the_list_that_is_asked_for_again_and_moves_the_focus_as_for_any_row", async () => {
    const { state } = server([LISBON, OPEN]);
    state.remove = () => new Response("{}", { status: 404 });
    mount();
    await list();
    removeLisbon().focus();

    state.periods = [OPEN]; // removed in another window
    fireEvent.click(removeLisbon());

    const alert = await within(section()).findByRole("alert");
    expect(alert).toHaveTextContent("Could not remove Lisbon flat, 1 Apr – 31 Aug 2026: That home is not there any more.");
    expect(within(alert).queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
    await waitFor(() => expect(within(section()).queryByText("Lisbon flat")).not.toBeInTheDocument());
    await waitFor(() => expect(removeOpen()).toHaveFocus());
  });

  test("HomeSettings_offers_a_retry_for_a_remove_that_failed_and_sends_the_same_period_again_with_the_focus_back_on_its_button", async () => {
    const { state, api } = server([LISBON, OPEN]);
    const works = state.remove;
    state.remove = () => new Response("{}", { status: 502 });
    mount();
    await list();
    const button = removeLisbon();
    button.focus();

    fireEvent.click(button);

    const alert = await within(section()).findByRole("alert");
    expect(alert).toHaveTextContent("Couldn't remove Lisbon flat, 1 Apr – 31 Aug 2026 — Retry");
    expect(rowsOf()).toHaveLength(2);
    await waitFor(() => expect(removeLisbon()).toHaveFocus()); // the button was turned off while it was pressed: the focus is not left on the page

    state.remove = works;
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(rowsOf()).toHaveLength(1));
    expect(api.writes().map((write) => write.path)).toEqual(["/api/homes/2", "/api/homes/2"]);
    expect(within(section()).queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("HomeSettings set home", () => {
  test("HomeSettings_opens_a_form_with_a_picker_of_all_the_places_in_use_and_closes_it_with_cancel_and_escape_and_the_focus_goes_back", async () => {
    const { api } = server([OSLO]);
    mount();
    await list();
    expect(setHome()).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(setHome());

    expect(setHome()).toHaveAttribute("aria-expanded", "true");
    const picker = await within(section()).findByRole("list", { name: "Places" });
    expect(within(picker).getAllByRole("button").map((button) => button.getAttribute("aria-label"))).toEqual([
      "Oslo flat, Storgata 1, Oslo, 40 visits", // no distance: there is no place to measure from
      "Lisbon flat, 12 visits",
      "Unnamed place, 1 visit",
    ]);
    expect(within(section()).getByRole("searchbox", { name: "Search places" })).toHaveFocus();
    expect(api.reads("/api/places/search")).toHaveLength(1);

    fireEvent.click(within(section()).getByRole("button", { name: "Cancel" }));
    expect(within(section()).queryByRole("searchbox")).not.toBeInTheDocument();
    expect(setHome()).toHaveFocus(); // the focus was in the form, which is gone
    expect(setHome()).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(setHome());
    fireEvent.keyDown(await within(section()).findByRole("searchbox", { name: "Search places" }), { key: "Escape" });
    expect(within(section()).queryByRole("searchbox")).not.toBeInTheDocument();
    expect(setHome()).toHaveFocus();
    expect(api.writes()).toEqual([]);
  });

  test("HomeSettings_pressing_set_home_again_while_the_form_is_open_closes_it", async () => {
    server([]);
    mount();
    await within(section()).findByText("No home yet");
    fireEvent.click(setHome());
    await within(section()).findByRole("searchbox", { name: "Search places" });

    fireEvent.click(setHome());

    expect(within(section()).queryByRole("searchbox")).not.toBeInTheDocument();
    expect(setHome()).toHaveAttribute("aria-expanded", "false");
  });

  test("HomeSettings_asks_which_place_with_the_dates_after_a_pick_names_it_and_can_go_back_to_the_picker", async () => {
    server([OSLO]);
    mount();
    await list();

    await pick(/^Lisbon flat/);

    const question = within(section()).getByText("Set Lisbon flat as home");
    expect(question).toHaveFocus(); // it is read, and Escape is Cancel at once
    // What saving does to what detection found is said before it is done (P4-R44): the server replaces it silently.
    expect(within(section()).getByText("A home you set replaces what was detected for those dates.")).toBeInTheDocument();
    expect(from()).toHaveValue("");
    expect(to()).toHaveValue("");
    for (const field of [from(), to()]) {
      expect(field).toHaveAttribute("type", "date");
      expect(field).toHaveAttribute("min", "1970-01-01");
      expect(field).toHaveAttribute("max", "2099-12-31");
    }
    expect(within(section()).queryByRole("searchbox")).not.toBeInTheDocument();

    fireEvent.click(within(section()).getByRole("button", { name: "Choose another place" }));

    expect(await within(section()).findByRole("searchbox", { name: "Search places" })).toBeInTheDocument();
    fireEvent.click(await within(section()).findByRole("button", { name: /^Unnamed place/ }));
    expect(await within(section()).findByText("Set Unnamed place as home")).toBeInTheDocument();
  });

  test("HomeSettings_sends_all_three_keys_with_null_for_a_home_that_goes_on_shows_it_is_saving_and_adds_the_period_to_the_list", async () => {
    const { state, api } = server([OSLO]);
    let release: () => void = () => undefined;
    const add = state.add;
    state.add = (call) =>
      new Promise<Response>((resolve) => {
        release = () => resolve(add(call) as Response);
      });
    mount();
    await list();
    await pick(/^Lisbon flat/);

    type(from(), "2026-04-01");
    fireEvent.click(saveButton());

    expect(await within(section()).findByRole("button", { name: "Saving…" })).toBeDisabled();
    expect(api.writes()).toEqual([
      { method: "POST", path: "/api/homes", search: "", contentType: "application/json", body: { placeId: 9, from: "2026-04-01", to: null } },
    ]);
    expect(within(section()).getByRole("button", { name: "Cancel" })).toBeDisabled(); // it cannot be taken back, and a form that is gone cannot show its failure
    fireEvent.keyDown(from(), { key: "Escape" });
    expect(from()).toBeInTheDocument();

    release();

    await waitFor(() => expect(note()).toBe("Home set to Lisbon flat"));
    expect(within(section()).queryByLabelText("From")).not.toBeInTheDocument(); // the form is closed
    expect(setHome()).toHaveFocus();
    expect(rowsOf().map(textsOf)).toEqual([
      ["Oslo flat", "1 Jan 2025 – 31 Mar 2026", "Detected"],
      ["Lisbon flat", "From 1 Apr 2026", "Set by you"],
    ]);
  });

  test("HomeSettings_sends_the_end_date_when_there_is_one_and_takes_the_same_day_for_one_night", async () => {
    const { api } = server([OSLO]);
    mount();
    await list();
    await pick(/^Oslo flat/);

    type(from(), "2026-05-05");
    type(to(), "2026-05-05");
    fireEvent.click(saveButton());

    await waitFor(() => expect(note()).toBe("Home set to Oslo flat"));
    expect(api.writes().map((write) => write.body)).toEqual([{ placeId: 7, from: "2026-05-05", to: "2026-05-05" }]);
  });

  test("HomeSettings_says_what_is_wrong_with_the_dates_with_the_focus_on_the_field_to_put_right_and_asks_nothing_of_the_server", async () => {
    const { api } = server([OSLO]);
    mount();
    await list();
    await pick(/^Lisbon flat/);

    fireEvent.click(saveButton());
    expect(await within(section()).findByRole("alert")).toHaveTextContent("Enter a start date.");
    expect(from()).toHaveFocus();
    expect(from()).toHaveAttribute("aria-invalid", "true");

    type(from(), "2026-06-10");
    expect(within(section()).queryByRole("alert")).not.toBeInTheDocument(); // what it said was of the dates that were
    type(to(), "2026-06-09");
    fireEvent.click(saveButton());
    expect(await within(section()).findByRole("alert")).toHaveTextContent("The end date must not be before the start date.");
    expect(to()).toHaveFocus();
    expect(to()).toHaveAttribute("aria-invalid", "true");

    expect(api.writes()).toEqual([]);
  });

  test("HomeSettings_says_a_refusal_in_the_words_of_the_server_with_no_retry_and_keeps_the_form_as_it_was_to_be_put_right", async () => {
    const { state, api } = server([OSLO, LISBON]);
    state.add = () => refusal(409, "Another home you set has a night in these dates.");
    mount();
    await list();
    await pick(/^Oslo flat/);
    type(from(), "2026-06-01");
    type(to(), "2026-06-30");

    fireEvent.click(saveButton());

    const alert = await within(section()).findByRole("alert");
    expect(alert).toHaveTextContent("Could not save: Another home you set has a night in these dates.");
    expect(within(alert).queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
    expect(from()).toHaveValue("2026-06-01");
    expect(to()).toHaveValue("2026-06-30");
    expect(saveButton()).toBeEnabled();

    // A 404 is the place: it is no more, and the way on is another one.
    state.add = () => new Response("{}", { status: 404 });
    fireEvent.click(saveButton());
    await waitFor(() => expect(within(section()).getByRole("alert")).toHaveTextContent("Could not save: That place no longer exists."));
    expect(within(section()).getByRole("button", { name: "Choose another place" })).toBeEnabled();
    expect(api.writes()).toHaveLength(2);
  });

  test("HomeSettings_forgets_a_refusal_when_another_place_is_chosen_and_shows_and_announces_nothing_of_it_for_the_next_place", async () => {
    const { state, api } = server([OSLO]);
    state.add = () => new Response("{}", { status: 404 });
    mount();
    await list();
    await pick(/^Lisbon flat/);
    type(from(), "2026-04-01");
    fireEvent.click(saveButton());
    expect(await within(section()).findByRole("alert")).toHaveTextContent("Could not save: That place no longer exists.");
    expect(note()).toBe("");

    fireEvent.click(within(section()).getByRole("button", { name: "Choose another place" }));
    fireEvent.click(await within(section()).findByRole("button", { name: /^Oslo flat/ }));

    // The form for the next place is a new one: what the last place was refused with is not said of it, and a live region that is made with a message
    // is announced, so it must not be there.
    expect(await within(section()).findByText("Set Oslo flat as home")).toHaveFocus();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(note()).toBe("");
    expect(saveButton()).toBeEnabled();
    expect(from()).toHaveValue("");
    expect(api.writes()).toHaveLength(1); // nothing was sent for the next place
  });

  test("HomeSettings_offers_a_retry_for_a_failure_that_may_pass_and_sends_the_same_home_again", async () => {
    const { state, api } = server([OSLO]);
    const works = state.add;
    state.add = () => new Response("{}", { status: 503 });
    mount();
    await list();
    await pick(/^Lisbon flat/);
    type(from(), "2026-04-01");
    type(to(), "2026-08-31");
    saveButton().focus();

    fireEvent.click(saveButton());

    const alert = await within(section()).findByRole("alert");
    expect(alert).toHaveTextContent("Couldn't save — Retry");
    expect(from()).toHaveValue("2026-04-01");
    await waitFor(() => expect(saveButton()).toHaveFocus()); // the button was turned off while it was pressed

    state.add = works;
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(note()).toBe("Home set to Lisbon flat"));
    expect(api.writes().map((write) => write.body)).toEqual([
      { placeId: 9, from: "2026-04-01", to: "2026-08-31" },
      { placeId: 9, from: "2026-04-01", to: "2026-08-31" },
    ]);
  });

  test("HomeSettings_puts_the_focus_on_set_home_when_the_last_period_is_removed_while_the_form_is_open", async () => {
    server([LISBON]);
    mount();
    await list();
    fireEvent.click(setHome());
    await within(section()).findByRole("searchbox", { name: "Search places" });

    removeLisbon().focus(); // a click moves the focus to a button, in most browsers
    fireEvent.click(removeLisbon());

    await within(section()).findByText("No home yet"); // the list is gone with its last row
    await waitFor(() => expect(setHome()).toHaveFocus());
    expect(within(section()).getByRole("searchbox", { name: "Search places" })).toBeInTheDocument(); // and the form is as it was
  });
});
