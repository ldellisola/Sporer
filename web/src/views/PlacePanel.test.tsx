import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { PlaceCandidate, PlaceResponse } from "../api/types";
import { refusal, stubEdits, type Handler } from "../test/stubEdits";
import cafe from "../../e2e/fixtures/place-cafe.json";
import { navigate } from "../app/router";
import { PlacePanel } from "./PlacePanel";

// The Café of the fixture: three visits, the first of which began at 23:30 on the 29th of September in Oslo, which is the 30th in Tokyo,
// where these tests run (see globalSetup). Every date and time on screen must be the clock of Oslo.
const CAFE = cafe as PlaceResponse;

type Answer = (path: string) => Response | Promise<Response>;

/** Answers `/api/places/{id}` from `places` (a place, or a function that answers); anything else is a 404. Returns the paths asked for. */
function stubApi(places: Record<number, PlaceResponse | Answer>): string[] {
  const paths: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string) => {
      paths.push(path);
      const answer = places[Number(path.split("/").pop())];
      if (answer === undefined) return new Response("{}", { status: 404 });
      return typeof answer === "function" ? answer(path) : Response.json(answer);
    }),
  );
  return paths;
}

function mount(id = 2) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <PlacePanel id={id} />
    </QueryClientProvider>,
  );
  return { client, ...view };
}

const visits = () => within(screen.getByRole("list", { name: "Recent visits" })).getAllByRole("listitem");
const back = () => screen.getByRole("button", { name: "Back" });

/** What the stats say, as `["Total time", "2h 24m"]` for each of them: the term and what it is. */
const stats = (): string[][] =>
  [...document.querySelectorAll("dt")].map((term) => [term.textContent ?? "", term.nextElementSibling?.textContent ?? ""]);

beforeEach(() => {
  window.history.replaceState(null, "", "/place/2");
});

afterEach(() => {
  vi.useRealTimers();
});

describe("PlacePanel", () => {
  test("PlacePanel_shows_totals_and_visits", async () => {
    const paths = stubApi({ 2: CAFE });

    mount();

    expect(await screen.findByRole("heading", { level: 1, name: "Café" })).toBeInTheDocument();
    expect(screen.getByText("Storgata 12, Oslo, Norway")).toBeInTheDocument(); // the address names the city, and the country follows
    expect(stats()).toEqual([
      ["Total time", "2h 24m"],
      ["Visits", "3"],
      ["First visit", "Tue 29 Sep 2026"], // the 29th in Oslo, where it began; Tokyo is already on the 30th
      ["Last visit", "Thu 22 Oct 2026"],
    ]);
    expect(screen.getByRole("heading", { level: 2, name: "Recent visits" })).toBeInTheDocument();
    // Newest first, as the API has them: the date of each, its two times on the clock of its zone, and how long it was.
    expect(visits().map((row) => [...row.querySelectorAll("span")].map((part) => part.textContent))).toEqual([
      ["Thu 22 Oct 2026", "08:46 – 09:10", "24m"],
      ["Thu 15 Oct 2026", "17:30 – 18:45", "1h 15m"],
      ["Tue 29 Sep 2026", "23:30 – 00:15", "45m"], // over midnight: a time is a time of the clock, the length says how long
    ]);
    expect(paths).toEqual(["/api/places/2"]);
  });

  test("PlacePanel_names_each_visit_by_what_it_says", async () => {
    stubApi({ 2: CAFE });
    mount();
    await screen.findByRole("heading", { level: 1 });

    // A button is named by the text that is on it (voice control says what it sees), and no two have the same name.
    expect(screen.getByRole("button", { name: "Open Thu 22 Oct 2026, 08:46 – 09:10, 24m" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open Thu 15 Oct 2026, 17:30 – 18:45, 1h 15m" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open Tue 29 Sep 2026, 23:30 – 00:15, 45m" })).toBeInTheDocument();
  });

  test("PlacePanel_visit_tap_navigates_to_day", async () => {
    stubApi({ 2: CAFE });
    mount();
    await screen.findByRole("heading", { level: 1 });

    fireEvent.click(screen.getByRole("button", { name: /Tue 29 Sep 2026/ }));

    // The date of the visit where it was (the 29th), which is not the date of it on the clock of this machine (the 30th).
    expect(window.location.pathname).toBe("/day/2026-09-29");
  });

  test("PlacePanel_not_found_message", async () => {
    stubApi({}); // a 404

    mount(9);

    expect(await screen.findByText("This place no longer exists")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument(); // asking again cannot help
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 1 })).not.toBeInTheDocument();
    expect(back()).toBeInTheDocument(); // there is still the way out
  });

  test("PlacePanel_takes_a_404_that_comes_on_a_refetch_for_what_it_is", async () => {
    // Merged away since it was looked at: what the panel showed is of a place that is not there now, and is not kept under the message.
    const answers: Record<number, PlaceResponse | Answer> = { 2: CAFE };
    stubApi(answers);
    const { client } = mount();
    await screen.findByRole("heading", { level: 1, name: "Café" });

    answers[2] = () => new Response("{}", { status: 404 });
    await act(async () => {
      await client.refetchQueries({ queryKey: ["place", 2] });
    });

    expect(await screen.findByText("This place no longer exists")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 1 })).not.toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Recent visits" })).not.toBeInTheDocument();
  });

  test("PlacePanel_says_it_is_loading_and_has_the_way_back_meanwhile", () => {
    stubApi({ 2: () => new Promise<Response>(() => undefined) });

    mount();

    expect(screen.getByText("Loading…")).toBeInTheDocument();
    expect(back()).toBeInTheDocument();
  });

  test("PlacePanel_shows_an_error_with_a_retry_that_asks_again", async () => {
    let failing = true;
    const paths = stubApi({ 2: () => (failing ? new Response("{}", { status: 500 }) : Response.json(CAFE)) });

    mount();

    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't load — Retry");
    expect(screen.queryByText("This place no longer exists")).not.toBeInTheDocument(); // a failure is not a 404
    expect(back()).toBeInTheDocument();

    failing = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByRole("heading", { level: 1, name: "Café" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(paths).toEqual(["/api/places/2", "/api/places/2"]);
  });

  test("PlacePanel_keeps_the_place_under_an_error_of_a_refetch", async () => {
    const answers: Record<number, PlaceResponse | Answer> = { 2: CAFE };
    stubApi(answers);
    const { client } = mount();
    await screen.findByRole("heading", { level: 1, name: "Café" });

    answers[2] = () => new Response("{}", { status: 500 });
    await act(async () => {
      await client.refetchQueries({ queryKey: ["place", 2] });
    });

    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't load — Retry");
    expect(screen.getByRole("heading", { level: 1, name: "Café" })).toBeInTheDocument(); // it stays, under the error and its Retry
    expect(visits()).toHaveLength(3);
  });

  test("PlacePanel_calls_a_place_with_no_name_unnamed_and_says_where_it_is_as_far_as_it_knows", async () => {
    const unnamed: PlaceResponse = { ...CAFE, name: null, address: null, city: "Oslo", country: "Norway" };
    stubApi({ 2: unnamed });
    const { unmount } = mount();

    expect(await screen.findByRole("heading", { level: 1, name: "Unnamed place" })).toBeInTheDocument();
    expect(screen.getByText("Oslo, Norway")).toBeInTheDocument(); // no address: the city and the country
    unmount();

    stubApi({ 2: { ...unnamed, city: null, country: null } });
    const none = mount();
    expect(await screen.findByRole("heading", { level: 1, name: "Unnamed place" })).toBeInTheDocument();
    expect(none.container.querySelector("p")).toBeNull(); // nothing is said of where it is when nothing is known
  });

  test("PlacePanel_falls_back_to_the_city_for_an_address_that_is_empty_as_for_one_that_is_missing", async () => {
    stubApi({ 2: { ...CAFE, address: "", city: "Oslo", country: "Norway" } });

    mount();

    expect(await screen.findByText("Oslo, Norway")).toBeInTheDocument();
  });

  test("PlacePanel_counts_one_visit_as_one", async () => {
    stubApi({ 2: { ...CAFE, visits: 1, totalSeconds: 1440, recentVisits: [CAFE.recentVisits[0]!] } });

    mount();

    await screen.findByRole("heading", { level: 1, name: "Café" });
    expect(stats()[1]).toEqual(["Visits", "1"]);
    expect(visits()).toHaveLength(1);
  });

  test("PlacePanel_tells_the_dates_of_the_first_and_last_visit_in_UTC_when_no_visit_is_there_to_take_the_zone_from", async () => {
    stubApi({ 2: { ...CAFE, recentVisits: [] } });

    mount();

    await screen.findByRole("heading", { level: 1, name: "Café" });
    expect(screen.queryByRole("heading", { level: 2, name: "Recent visits" })).not.toBeInTheDocument();
    expect(stats().slice(2)).toEqual([
      ["First visit", "Tue 29 Sep 2026"], // 21:30 UTC on the 29th: no zone of the place is known, and the clock of this machine (Tokyo) is not it
      ["Last visit", "Thu 22 Oct 2026"],
    ]);
  });
});

describe("PlacePanel back", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 9, 24, 12, 0, 0)); // noon on the 24th in whatever zone the test runs in
  });

  test("PlacePanel_back_goes_back_in_history_when_the_place_was_reached_in_the_app", async () => {
    stubApi({ 2: CAFE });
    window.history.replaceState(null, "", "/day/2026-10-22");
    act(() => navigate({ view: "place", id: 2 })); // as a tap on the name of a place does
    const goBack = vi.spyOn(window.history, "back").mockImplementation(() => undefined);
    mount();
    await screen.findByRole("heading", { level: 1 });

    fireEvent.click(back());

    expect(goBack).toHaveBeenCalledTimes(1);
  });

  test("PlacePanel_back_goes_to_today_when_the_place_was_opened_as_a_page", async () => {
    stubApi({ 2: CAFE });
    const goBack = vi.spyOn(window.history, "back").mockImplementation(() => undefined);
    mount(); // a deep link, a fresh tab, as the beforeEach has it: no entry of the app's making
    await screen.findByRole("heading", { level: 1 });

    fireEvent.click(back());

    expect(goBack).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe("/day/2026-10-24");
  });

  test("PlacePanel_back_is_there_for_a_place_that_is_gone_too", async () => {
    stubApi({});
    const goBack = vi.spyOn(window.history, "back").mockImplementation(() => undefined);
    mount(9);
    await waitFor(() => expect(screen.getByText("This place no longer exists")).toBeInTheDocument());

    fireEvent.click(back());

    expect(goBack).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe("/day/2026-10-24");
  });
});

// --- Editing: the forms are PlaceEdits' own (PlaceEdits.test.tsx); here, that the panel gives them the place that is on screen ---

const BISTRO: PlaceCandidate = { id: 7, name: "Bistro", address: "Storgata 14, Oslo", distanceM: 42.4, visits: 3 };

const rename = () => screen.getByRole("button", { name: "Rename" });
const nameField = () => screen.getByRole("textbox", { name: "Name" });
const heading = () => screen.getByRole("heading", { level: 1 });

/** The first request for the place gets it; every one after it waits for ever (the refetch that a write makes is slow). */
const slowAfterTheFirst = (place: PlaceResponse): Handler => {
  let asked = 0;
  return () => (++asked === 1 ? Response.json(place) : new Promise<Response>(() => undefined));
};

describe("PlacePanel rename", () => {
  test("PlacePanel_rename_opens_the_form_in_place_of_the_buttons_and_cancel_and_escape_bring_them_back", async () => {
    const api = stubEdits({ "GET /api/places/2": () => Response.json(CAFE) });
    mount();

    fireEvent.click(await screen.findByRole("button", { name: "Rename" }));

    expect(nameField()).toHaveValue("Café");
    expect(screen.queryByRole("button", { name: "Rename" })).not.toBeInTheDocument(); // the form is where the buttons were
    expect(screen.queryByRole("button", { name: "Merge with…" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(heading()).toHaveTextContent("Café");
    fireEvent.click(rename());
    fireEvent.keyDown(nameField(), { key: "Escape" });

    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(rename()).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Merge with…" })).toBeInTheDocument();
    expect(api.writes()).toEqual([]);
  });

  test("PlacePanel_shows_the_name_a_rename_answered_with_without_waiting_for_the_place_to_be_asked_for_again", async () => {
    const api = stubEdits({
      "GET /api/places/2": slowAfterTheFirst(CAFE),
      "PUT /api/places/2/name": () => Response.json({ ...CAFE, name: "Bar" }),
    });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Rename" }));
    fireEvent.change(nameField(), { target: { value: "Bar" } });

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(heading()).toHaveTextContent("Bar"));
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(api.writes().map((call) => call.body)).toEqual([{ name: "Bar" }]);
  });

  test("PlacePanel_writes_to_the_place_that_is_shown_when_the_address_asked_for_one_that_was_merged", async () => {
    // /place/5 is served as the place it was merged into: the place on screen has the id 2, and that is the one that is renamed.
    let current = CAFE;
    const api = stubEdits({
      "GET /api/places/5": () => Response.json(current),
      "PUT /api/places/2/name": () => Response.json((current = { ...CAFE, name: "Bar" })),
    });
    mount(5);
    fireEvent.click(await screen.findByRole("button", { name: "Rename" }));
    fireEvent.change(nameField(), { target: { value: "Bar" } });

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(heading()).toHaveTextContent("Bar")); // and the query of the address has it
    expect(api.writes().map((call) => call.path)).toEqual(["/api/places/2/name"]);
  });

  test("PlacePanel_has_no_edit_controls_while_there_is_no_place_to_edit", async () => {
    stubEdits({ "GET /api/places/9": () => new Response("{}", { status: 404 }) });
    mount(9);

    await screen.findByText("This place no longer exists");

    expect(screen.queryByRole("button", { name: "Rename" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Merge with…" })).not.toBeInTheDocument();
  });
});

describe("PlacePanel merge", () => {
  /** A place that merges: the candidates, and what a merge of the place 7 into it does to it. */
  function stubMerge(over: Record<string, Handler> = {}) {
    let current: PlaceResponse = CAFE;
    return stubEdits({
      "GET /api/places/2": () => Response.json(current),
      "GET /api/places/2/candidates": () => Response.json([BISTRO]),
      "POST /api/places/2/merge": (call) => {
        const { name } = call.body as { name: string | null };
        current = { ...CAFE, name: name ?? CAFE.name, visits: CAFE.visits + BISTRO.visits, totalSeconds: 9_000, merged: [{ id: BISTRO.id, name: BISTRO.name }] };
        return Response.json(current);
      },
      ...over,
    });
  }

  const openMerge = async () => fireEvent.click(await screen.findByRole("button", { name: "Merge with…" }));
  const pick = async (name: RegExp) => fireEvent.click(await screen.findByRole("button", { name }));

  test("PlacePanel_merge_with_opens_the_picker_over_the_candidates_of_the_place_and_cancel_closes_it", async () => {
    const api = stubMerge();
    mount();

    await openMerge();

    expect(await screen.findByRole("button", { name: /^Bistro/ })).toBeInTheDocument();
    expect(screen.getByRole("searchbox", { name: "Search places" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Merge with…" })).not.toBeInTheDocument();
    expect(api.reads("/api/places/2/candidates")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Merge with…" })).toBeInTheDocument();
    expect(api.writes()).toEqual([]);
  });

  test("PlacePanel_merge_asks_the_candidates_of_the_place_that_is_shown_when_the_address_asked_for_one_that_was_merged", async () => {
    const api = stubEdits({
      "GET /api/places/5": () => Response.json(CAFE),
      "GET /api/places/2/candidates": () => Response.json([BISTRO]),
    });
    mount(5);

    await openMerge();

    expect(await screen.findByRole("button", { name: /^Bistro/ })).toBeInTheDocument();
    expect(api.reads("/api/places/2/candidates")).toHaveLength(1);
  });

  test("PlacePanel_merge_asks_to_confirm_the_place_that_was_picked_into_this_one_and_a_cancel_closes_it_all", async () => {
    const api = stubMerge();
    mount();
    await openMerge();

    await pick(/^Bistro/);

    expect(screen.getByText("Merge Bistro into Café?")).toBeInTheDocument(); // B into A: the place that is open is the one that stays
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByText("Merge Bistro into Café?")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Merge with…" })).toBeInTheDocument();
    expect(api.writes()).toEqual([]);
  });

  test("PlacePanel_merge_closes_and_shows_the_survivor_with_what_was_merged_in_without_waiting_for_the_place_to_be_asked_for_again", async () => {
    const api = stubEdits({
      "GET /api/places/2": slowAfterTheFirst(CAFE),
      "GET /api/places/2/candidates": () => Response.json([BISTRO]),
      "POST /api/places/2/merge": () => Response.json({ ...CAFE, visits: 6, totalSeconds: 9_000, merged: [{ id: 7, name: "Bistro" }] }),
    });
    mount();
    await openMerge();
    await pick(/^Bistro/);

    fireEvent.click(screen.getByRole("button", { name: "Merge" }));

    await waitFor(() => expect(screen.queryByText("Merge Bistro into Café?")).not.toBeInTheDocument());
    expect(heading()).toHaveTextContent("Café");
    expect(stats()[1]).toEqual(["Visits", "6"]); // the sum of both
    expect(within(screen.getByRole("region", { name: "Merged places" })).getByText("Bistro")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Merge with…" })).toBeInTheDocument();
    expect(api.writes().map((call) => call.body)).toEqual([{ place: 7, name: "Café" }]);
  });
});

describe("PlacePanel merged places", () => {
  const MERGED = { ...CAFE, merged: [{ id: 7, name: "Bistro" }, { id: 9, name: null }] };

  test("PlacePanel_lists_the_places_merged_into_it_above_the_visits_and_has_no_section_when_there_are_none", async () => {
    stubEdits({ "GET /api/places/2": () => Response.json(MERGED) });
    const { unmount } = mount();

    expect(await screen.findByRole("heading", { level: 2, name: "Merged places" })).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual(["Merged places", "Recent visits"]);
    unmount();

    stubEdits({ "GET /api/places/2": () => Response.json(CAFE) });
    mount();
    await screen.findByRole("heading", { level: 1 });
    expect(screen.queryByRole("heading", { level: 2, name: "Merged places" })).not.toBeInTheDocument();
  });

  test("PlacePanel_separate_takes_the_place_off_the_list_without_waiting_for_the_place_to_be_asked_for_again_and_the_last_takes_the_section", async () => {
    const api = stubEdits({
      "GET /api/places/2": slowAfterTheFirst({ ...CAFE, merged: [{ id: 7, name: "Bistro" }, { id: 9, name: "Bar" }] }),
      "DELETE /api/places/2/merged/7": () => new Response(null, { status: 204 }),
      "DELETE /api/places/2/merged/9": () => new Response(null, { status: 204 }),
    });
    mount();

    fireEvent.click(await screen.findByRole("button", { name: "Separate Bistro" }));

    await waitFor(() => expect(screen.queryByRole("button", { name: "Separate Bistro" })).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Separate Bar" })); // the list is usable at once, not a second click on a row that is gone

    await waitFor(() => expect(screen.queryByRole("heading", { level: 2, name: "Merged places" })).not.toBeInTheDocument());
    expect(api.writes().map((call) => call.path)).toEqual(["/api/places/2/merged/7", "/api/places/2/merged/9"]);
  });
});

describe("PlacePanel focus", () => {
  const mergeButton = () => screen.getByRole("button", { name: "Merge with…" });

  test("PlacePanel_puts_the_focus_back_on_rename_when_the_form_is_closed_by_cancel_by_escape_and_by_save", async () => {
    let current = CAFE;
    stubEdits({
      "GET /api/places/2": () => Response.json(current),
      "PUT /api/places/2/name": () => Response.json((current = { ...CAFE, name: "Bar" })),
    });
    mount();
    expect(await screen.findByRole("heading", { level: 1 })).not.toHaveFocus(); // nothing takes the focus as the panel opens
    expect(document.body).toHaveFocus();

    fireEvent.click(rename());
    expect(nameField()).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(rename()).toHaveFocus(); // the focus was in the form, which is gone

    fireEvent.click(rename());
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(rename()).toHaveFocus();

    fireEvent.click(rename());
    fireEvent.change(nameField(), { target: { value: "Bar" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(heading()).toHaveTextContent("Bar"));
    expect(rename()).toHaveFocus();
  });

  test("PlacePanel_puts_the_focus_back_on_merge_with_when_the_picker_or_the_confirm_is_closed_or_the_merge_is_made", async () => {
    let merged = false;
    stubEdits({
      "GET /api/places/2": () => Response.json(merged ? { ...CAFE, merged: [{ id: 7, name: "Bistro" }] } : CAFE),
      "GET /api/places/2/candidates": () => Response.json([BISTRO]),
      "POST /api/places/2/merge": () => {
        merged = true;
        return Response.json({ ...CAFE, merged: [{ id: 7, name: "Bistro" }] });
      },
    });
    mount();

    fireEvent.click(await screen.findByRole("button", { name: "Merge with…" }));
    expect(screen.getByRole("searchbox", { name: "Search places" })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(mergeButton()).toHaveFocus();

    fireEvent.click(mergeButton());
    fireEvent.click(await screen.findByRole("button", { name: /^Bistro/ }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(mergeButton()).toHaveFocus();

    fireEvent.click(mergeButton());
    fireEvent.click(await screen.findByRole("button", { name: /^Bistro/ }));
    fireEvent.click(screen.getByRole("button", { name: "Merge" }));
    await waitFor(() => expect(screen.queryByText("Merge Bistro into Café?")).not.toBeInTheDocument());
    expect(mergeButton()).toHaveFocus();
  });

  test("PlacePanel_takes_the_focus_to_the_confirm_when_a_row_is_picked_so_that_escape_closes_it_in_a_browser", async () => {
    const api = stubEdits({
      "GET /api/places/2": () => Response.json(CAFE),
      "GET /api/places/2/candidates": () => Response.json([BISTRO]),
    });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Merge with…" }));

    fireEvent.click(await screen.findByRole("button", { name: /^Bistro/ })); // the row that was pressed is gone, and with it the focus

    const confirm = screen.getByRole("button", { name: "Merge" }).closest("form")!;
    expect(confirm).toContainElement(document.activeElement as HTMLElement);
    fireEvent.keyDown(document.activeElement!, { key: "Escape" }); // the key goes to what has the focus, as the browser sends it

    expect(screen.queryByText("Merge Bistro into Café?")).not.toBeInTheDocument();
    expect(mergeButton()).toHaveFocus();
    expect(api.writes()).toEqual([]);
  });

  test("PlacePanel_goes_back_to_the_picker_from_a_merge_that_the_server_refused", async () => {
    const api = stubEdits({
      "GET /api/places/2": () => Response.json(CAFE),
      "GET /api/places/2/candidates": () => Response.json([BISTRO]),
      "POST /api/places/2/merge": () => refusal(409, "No."),
    });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Merge with…" }));
    fireEvent.click(await screen.findByRole("button", { name: /^Bistro/ }));
    fireEvent.click(screen.getByRole("button", { name: "Merge" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not merge: No.");

    fireEvent.click(screen.getByRole("button", { name: "Choose another place" }));

    expect(screen.getByRole("searchbox", { name: "Search places" })).toHaveFocus();
    expect(await screen.findByRole("button", { name: /^Bistro/ })).toBeInTheDocument();
    expect(screen.queryByText("Merge Bistro into Café?")).not.toBeInTheDocument();
    expect(api.writes()).toHaveLength(1);
  });

  test("PlacePanel_has_the_place_asked_for_again_when_a_write_to_it_is_answered_with_a_404_and_says_it_is_gone", async () => {
    let gone = false;
    stubEdits({
      "GET /api/places/2": () => (gone ? new Response("{}", { status: 404 }) : Response.json(CAFE)),
      "PUT /api/places/2/name": () => {
        gone = true;
        return new Response("{}", { status: 404 });
      },
    });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Rename" }));
    fireEvent.change(nameField(), { target: { value: "Bar" } });

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    // The panel is the one of a place that is gone, with no form and no Retry.
    expect(await screen.findByText("This place no longer exists")).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
  });

  test("PlacePanel_puts_the_focus_on_the_next_merged_place_after_a_separate_and_on_the_name_when_the_section_goes", async () => {
    let current: PlaceResponse = { ...CAFE, merged: [{ id: 7, name: "Bistro" }, { id: 9, name: "Bar" }] };
    stubEdits({
      "GET /api/places/2": () => Response.json(current),
      "DELETE /api/places/2/merged/7": () => {
        current = { ...CAFE, merged: [{ id: 9, name: "Bar" }] };
        return new Response(null, { status: 204 });
      },
      "DELETE /api/places/2/merged/9": () => {
        current = { ...CAFE, merged: [] };
        return new Response(null, { status: 204 });
      },
    });
    mount();

    fireEvent.click(await screen.findByRole("button", { name: "Separate Bistro" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Separate Bar" })).toHaveFocus());

    fireEvent.click(screen.getByRole("button", { name: "Separate Bar" }));
    await waitFor(() => expect(screen.queryByRole("heading", { level: 2, name: "Merged places" })).not.toBeInTheDocument());
    expect(heading()).toHaveFocus(); // the section is gone with its last row: the name of the place
  });
});
