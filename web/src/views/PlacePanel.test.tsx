import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { PlaceCandidate, PlaceResponse } from "../api/types";
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


// --- Editing: rename, merge and separate ---

interface Call {
  method: string;
  path: string;
  search: string;
  contentType: string | null;
  body: unknown;
}

type Handler = (call: Call) => Response | Promise<Response>;

/**
 * Answers each request by the handler of `"METHOD /path"` (the query is in the call): a request that has no handler is a failure of the test.
 * Returns the calls in the order they were made. `routes` can be changed to change what the next request finds.
 */
function stubEdits(routes: Record<string, Handler>) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input, "http://sporer.test");
      const method = init?.method ?? "GET";
      const call: Call = {
        method,
        path: url.pathname,
        search: url.search,
        contentType: new Headers(init?.headers).get("Content-Type"),
        body: typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : init?.body,
      };
      calls.push(call);
      const handler = routes[`${method} ${url.pathname}`];
      if (handler === undefined) throw new Error(`unexpected request ${method} ${input}`);
      return handler(call);
    }),
  );
  return {
    routes,
    calls,
    writes: () => calls.filter((call) => call.method !== "GET"),
    reads: (path: string) => calls.filter((call) => call.method === "GET" && call.path === path),
  };
}

/** The error body of the API, as FastEndpoints writes it: what is wrong, by field. */
const refusal = (status: number, message: string): Response =>
  Response.json({ statusCode: status, message: "One or more errors occurred!", errors: { place: [message] } }, { status });

const SAME_PLACE = "The place is the one it is to be merged into, or is merged into it already.";
const TOO_DEEP =
  "The place has places merged into it that are 32 merges deep already: one more would be more than the 32 that can be followed.";

const BISTRO: PlaceCandidate = { id: 7, name: "Bistro", address: "Storgata 14, Oslo", distanceM: 42.4, visits: 3 };
const NAMELESS: PlaceCandidate = { id: 8, name: null, address: null, distanceM: 1250, visits: 1 };

const rename = () => screen.getByRole("button", { name: "Rename" });
const nameField = () => screen.getByRole("textbox", { name: "Name" });
const heading = () => screen.getByRole("heading", { level: 1 });

describe("PlacePanel rename", () => {
  test("PlacePanel_rename_opens_a_field_with_the_current_name_and_cancel_and_escape_close_it", async () => {
    const api = stubEdits({ "GET /api/places/2": () => Response.json(CAFE) });
    mount();

    fireEvent.click(await screen.findByRole("button", { name: "Rename" }));

    expect(nameField()).toHaveValue("Café");
    expect(nameField()).toHaveFocus();
    expect(nameField()).toHaveAttribute("placeholder", "OpenStreetMap name"); // what an empty name shows again
    expect(nameField()).toHaveAttribute("maxlength", "100");
    expect(screen.queryByRole("button", { name: "Rename" })).not.toBeInTheDocument(); // the form is where the buttons were

    fireEvent.change(nameField(), { target: { value: "Something else" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(heading()).toHaveTextContent("Café");
    fireEvent.click(rename());
    expect(nameField()).toHaveValue("Café"); // what was typed was thrown away
    fireEvent.keyDown(nameField(), { key: "Escape" });

    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(rename()).toBeInTheDocument();
    expect(api.writes()).toEqual([]);
  });

  test("PlacePanel_rename_saves_the_trimmed_name_as_json_shows_it_pending_and_then_the_name_the_server_gave_back", async () => {
    let current = CAFE;
    let release: (response: Response) => void = () => undefined;
    const api = stubEdits({
      "GET /api/places/2": () => Response.json(current),
      "PUT /api/places/2/name": () => new Promise<Response>((resolve) => (release = resolve)),
    });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Rename" }));

    fireEvent.change(nameField(), { target: { value: "  Corner Café " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    const saving = await screen.findByRole("button", { name: "Saving…" });
    expect(saving).toBeDisabled();
    expect(api.writes()).toEqual([{ method: "PUT", path: "/api/places/2/name", search: "", contentType: "application/json", body: { name: "Corner Café" } }]);

    current = { ...CAFE, name: "Corner Café" };
    release(Response.json(current));

    // The name is the one the server answered with, at once (the place is asked for again as well).
    await waitFor(() => expect(heading()).toHaveTextContent("Corner Café"));
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(rename()).toBeInTheDocument();
    await waitFor(() => expect(api.reads("/api/places/2")).toHaveLength(2));
  });

  test("PlacePanel_rename_with_an_empty_name_sends_null_which_goes_back_to_the_name_of_OpenStreetMap", async () => {
    let current = { ...CAFE, name: "My name" };
    const api = stubEdits({
      "GET /api/places/2": () => Response.json(current),
      "PUT /api/places/2/name": () => Response.json((current = { ...CAFE, name: "Cafe (OSM)" })),
    });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Rename" }));

    fireEvent.change(nameField(), { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(heading()).toHaveTextContent("Cafe (OSM)"));
    expect(api.writes().map((call) => call.body)).toEqual([{ name: null }]); // the key is there, as the server wants it
  });

  test("PlacePanel_rename_closes_without_a_write_when_the_name_was_not_changed", async () => {
    // A place that has only the name of OpenStreetMap would be given that name as its own by a write of what it shows.
    const api = stubEdits({ "GET /api/places/2": () => Response.json(CAFE) });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Rename" }));

    fireEvent.change(nameField(), { target: { value: " Café " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(api.writes()).toEqual([]);
  });

  test("PlacePanel_rename_starts_empty_for_a_place_with_no_name_and_saving_it_empty_writes_nothing", async () => {
    const api = stubEdits({ "GET /api/places/2": () => Response.json({ ...CAFE, name: null }) });
    mount();
    await screen.findByRole("heading", { level: 1, name: "Unnamed place" });

    fireEvent.click(rename());

    expect(nameField()).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(api.writes()).toEqual([]);
  });

  test("PlacePanel_rename_is_saved_by_enter_too", async () => {
    let current = CAFE;
    const api = stubEdits({
      "GET /api/places/2": () => Response.json(current),
      "PUT /api/places/2/name": () => Response.json((current = { ...CAFE, name: "Bar" })),
    });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Rename" }));

    fireEvent.change(nameField(), { target: { value: "Bar" } });
    fireEvent.submit(nameField().closest("form")!);

    await waitFor(() => expect(heading()).toHaveTextContent("Bar"));
    expect(api.writes()).toHaveLength(1);
  });

  test("PlacePanel_rename_that_fails_says_so_with_a_retry_and_keeps_the_form_and_what_was_typed", async () => {
    let failing = true;
    let current = CAFE;
    const api = stubEdits({
      "GET /api/places/2": () => Response.json(current),
      "PUT /api/places/2/name": () => (failing ? new Response("{}", { status: 500 }) : Response.json((current = { ...CAFE, name: "Bar" }))),
    });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Rename" }));
    fireEvent.change(nameField(), { target: { value: "Bar" } });

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Couldn't rename — Retry");
    expect(alert).toHaveTextContent("PUT /api/places/2/name failed with status 500");
    expect(nameField()).toHaveValue("Bar"); // the form is still there, with what was typed
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    expect(heading()).toHaveTextContent("Café"); // and the panel is all there

    failing = false;
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(heading()).toHaveTextContent("Bar"));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(api.writes().map((call) => call.body)).toEqual([{ name: "Bar" }, { name: "Bar" }]); // the same again
  });

  test("PlacePanel_rename_says_the_place_is_gone_when_the_server_says_so", async () => {
    stubEdits({
      "GET /api/places/2": () => Response.json(CAFE),
      "PUT /api/places/2/name": () => new Response("{}", { status: 404 }),
    });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Rename" }));
    fireEvent.change(nameField(), { target: { value: "Bar" } });

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("This place no longer exists");
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
  function stubMerge(over: Record<string, Handler> = {}, candidates: PlaceCandidate[] = [BISTRO]) {
    let current: PlaceResponse = CAFE;
    return stubEdits({
      "GET /api/places/2": () => Response.json(current),
      "GET /api/places/2/candidates": () => Response.json(candidates),
      "POST /api/places/2/merge": (call) => {
        const { place, name } = call.body as { place: number; name: string | null };
        const absorbed = candidates.find((candidate) => candidate.id === place)!;
        current = { ...CAFE, name: name ?? CAFE.name, visits: CAFE.visits + absorbed.visits, totalSeconds: 9_000, merged: [{ id: place, name: absorbed.name }] };
        return Response.json(current);
      },
      ...over,
    });
  }

  const openMerge = async () => fireEvent.click(await screen.findByRole("button", { name: "Merge with…" }));
  const pick = async (name: RegExp) => fireEvent.click(await screen.findByRole("button", { name }));
  const keepNames = () => screen.getByRole("group", { name: "Name to keep" });

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

  test("PlacePanel_merge_asks_to_confirm_with_the_two_names_to_keep_one_of_and_a_cancel_that_closes_it_all", async () => {
    const api = stubMerge();
    mount();
    await openMerge();

    await pick(/^Bistro/);

    expect(screen.getByText("Merge Bistro into Café?")).toBeInTheDocument(); // B into A: the place that is open is the one that stays
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
    expect(within(keepNames()).getByRole("radio", { name: "Café" })).toBeChecked(); // this place's name, unless the owner says otherwise
    expect(within(keepNames()).getByRole("radio", { name: "Bistro" })).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Merge" })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByText("Merge Bistro into Café?")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Merge with…" })).toBeInTheDocument();
    expect(api.writes()).toEqual([]);
  });

  test("PlacePanel_merge_keeps_the_name_of_this_place_by_default_and_posts_the_other_place_and_that_name_as_json", async () => {
    let release: (response: Response) => void = () => undefined;
    const survivor = { ...CAFE, visits: 6, totalSeconds: 9_000, merged: [{ id: 7, name: "Bistro" }] };
    let merged = false;
    const api = stubMerge({
      "GET /api/places/2": () => Response.json(merged ? survivor : CAFE),
      "POST /api/places/2/merge": () => new Promise<Response>((resolve) => (release = resolve)),
    });
    mount();
    await openMerge();
    await pick(/^Bistro/);

    fireEvent.click(screen.getByRole("button", { name: "Merge" }));

    expect(await screen.findByRole("button", { name: "Merging…" })).toBeDisabled();
    expect(api.writes()).toEqual([
      { method: "POST", path: "/api/places/2/merge", search: "", contentType: "application/json", body: { place: 7, name: "Café" } },
    ]);

    merged = true;
    release(Response.json(survivor));

    // It closes; the place on screen is the survivor with the sum of both, and what was merged in is listed.
    await waitFor(() => expect(screen.queryByText("Merge Bistro into Café?")).not.toBeInTheDocument());
    expect(heading()).toHaveTextContent("Café");
    expect(stats()[1]).toEqual(["Visits", "6"]);
    expect(within(screen.getByRole("region", { name: "Merged places" })).getByText("Bistro")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Merge with…" })).toBeInTheDocument();
  });

  test("PlacePanel_merge_keeps_the_name_of_the_other_place_when_the_owner_chooses_it", async () => {
    const api = stubMerge();
    mount();
    await openMerge();
    await pick(/^Bistro/);

    fireEvent.click(within(keepNames()).getByRole("radio", { name: "Bistro" }));
    expect(within(keepNames()).getByRole("radio", { name: "Café" })).not.toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Merge" }));

    await waitFor(() => expect(heading()).toHaveTextContent("Bistro")); // the answer is the survivor, with the name that was kept
    expect(api.writes().map((call) => call.body)).toEqual([{ place: 7, name: "Bistro" }]);
  });

  test("PlacePanel_merge_sends_null_for_a_name_to_keep_when_this_place_has_none", async () => {
    // Null leaves the survivor's name as it is, which for a place with none is none: "Unnamed place" is not a name to give it.
    const api = stubMerge({ "GET /api/places/2": () => Response.json({ ...CAFE, name: null }) });
    mount();
    await openMerge();
    await pick(/^Bistro/);

    expect(screen.getByText("Merge Bistro into Unnamed place?")).toBeInTheDocument();
    expect(within(keepNames()).getByRole("radio", { name: "Unnamed place" })).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Merge" }));

    await waitFor(() => expect(api.writes()).toHaveLength(1));
    expect(api.writes()[0]?.body).toEqual({ place: 7, name: null });
  });

  test("PlacePanel_merge_cannot_keep_the_name_of_a_place_that_has_none", async () => {
    const api = stubMerge({}, [NAMELESS]);
    mount();
    await openMerge();

    await pick(/^Unnamed place/);

    expect(screen.getByText("Merge Unnamed place into Café?")).toBeInTheDocument();
    expect(within(keepNames()).getByRole("radio", { name: "Unnamed place" })).toBeDisabled(); // there is no name to keep: its radio would only say null
    expect(within(keepNames()).getByRole("radio", { name: "Café" })).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Merge" }));

    await waitFor(() => expect(api.writes()).toHaveLength(1));
    expect(api.writes()[0]?.body).toEqual({ place: 8, name: "Café" });
  });

  test("PlacePanel_merge_tells_the_two_409s_apart_and_a_missing_place_and_keeps_the_confirm_open", async () => {
    let answer: () => Response = () => refusal(409, SAME_PLACE);
    const api = stubMerge({ "POST /api/places/2/merge": () => answer() });
    mount();
    await openMerge();
    await pick(/^Bistro/);

    fireEvent.click(screen.getByRole("button", { name: "Merge" }));

    let alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Couldn't merge — Retry");
    expect(alert).toHaveTextContent("These are the same place already.");
    expect(screen.getByText("Merge Bistro into Café?")).toBeInTheDocument(); // the confirm stays, and so does the panel
    expect(heading()).toHaveTextContent("Café");

    answer = () => refusal(409, TOO_DEEP);
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Too many places are merged into one already."));
    expect(screen.getByRole("alert")).not.toHaveTextContent("same place");

    answer = () => new Response("{}", { status: 404 });
    fireEvent.click(within(screen.getByRole("alert")).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("One of the places no longer exists."));

    answer = () => new Response("<html>", { status: 502 });
    fireEvent.click(within(screen.getByRole("alert")).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("POST /api/places/2/merge failed with status 502")); // anything else: what failed

    expect(api.writes().map((call) => call.body)).toEqual([
      { place: 7, name: "Café" },
      { place: 7, name: "Café" },
      { place: 7, name: "Café" },
      { place: 7, name: "Café" },
    ]); // Retry sends the same again
  });

  test("PlacePanel_merge_that_works_after_a_retry_closes_the_confirm_and_the_error", async () => {
    let failing = true;
    stubMerge({
      "POST /api/places/2/merge": (call) => (failing ? new Response("{}", { status: 500 }) : Response.json({ ...CAFE, merged: [{ id: (call.body as { place: number }).place, name: "Bistro" }] })),
    });
    mount();
    await openMerge();
    await pick(/^Bistro/);
    fireEvent.click(screen.getByRole("button", { name: "Merge" }));
    const alert = await screen.findByRole("alert");

    failing = false;
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(screen.queryByText("Merge Bistro into Café?")).not.toBeInTheDocument());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("PlacePanel merged places", () => {
  const MERGED = { ...CAFE, merged: [{ id: 7, name: "Bistro" }, { id: 9, name: null }] };
  const merged = () => screen.getByRole("region", { name: "Merged places" });

  test("PlacePanel_lists_the_places_merged_into_it_each_with_a_separate_button_and_none_when_there_are_none", async () => {
    stubEdits({ "GET /api/places/2": () => Response.json(MERGED) });
    const { unmount } = mount();

    expect(await screen.findByRole("heading", { level: 2, name: "Merged places" })).toBeInTheDocument();
    const rows = within(merged()).getAllByRole("listitem");
    expect(rows.map((row) => row.textContent)).toEqual(["BistroSeparate", "Unnamed placeSeparate"]); // in the order the server gave: by name
    // Each button says whose it is, and holds the word that is on it.
    expect(within(merged()).getByRole("button", { name: "Separate Bistro" })).toHaveTextContent("Separate");
    expect(within(merged()).getByRole("button", { name: "Separate Unnamed place" })).toBeInTheDocument();
    unmount();

    stubEdits({ "GET /api/places/2": () => Response.json(CAFE) });
    mount();
    await screen.findByRole("heading", { level: 1 });
    expect(screen.queryByRole("heading", { level: 2, name: "Merged places" })).not.toBeInTheDocument();
  });

  test("PlacePanel_separate_deletes_the_merge_shows_it_pending_and_takes_the_place_off_the_list", async () => {
    let current = MERGED;
    let release: (response: Response) => void = () => undefined;
    const api = stubEdits({
      "GET /api/places/2": () => Response.json(current),
      "DELETE /api/places/2/merged/7": () => new Promise<Response>((resolve) => (release = resolve)),
    });
    mount();

    fireEvent.click(await screen.findByRole("button", { name: "Separate Bistro" }));

    const separating = await screen.findByRole("button", { name: "Separating…" });
    expect(separating).toBeDisabled();
    expect(within(merged()).getByRole("button", { name: "Separate Unnamed place" })).toBeDisabled(); // one at a time: the answer of one is what the list is made of
    expect(api.writes()).toEqual([{ method: "DELETE", path: "/api/places/2/merged/7", search: "", contentType: "application/json", body: undefined }]);

    current = { ...CAFE, merged: [{ id: 9, name: null }] };
    release(new Response(null, { status: 204 }));

    await waitFor(() => expect(within(merged()).getAllByRole("listitem")).toHaveLength(1));
    expect(within(merged()).queryByText("Bistro")).not.toBeInTheDocument();
    await waitFor(() => expect(api.reads("/api/places/2")).toHaveLength(2)); // the place is asked for again, as after every write
  });

  test("PlacePanel_separate_of_the_last_one_takes_the_section_away", async () => {
    let current = { ...CAFE, merged: [{ id: 7, name: "Bistro" }] };
    stubEdits({
      "GET /api/places/2": () => Response.json(current),
      "DELETE /api/places/2/merged/7": () => {
        current = { ...CAFE, merged: [] };
        return new Response(null, { status: 204 });
      },
    });
    mount();

    fireEvent.click(await screen.findByRole("button", { name: "Separate Bistro" }));

    await waitFor(() => expect(screen.queryByRole("heading", { level: 2, name: "Merged places" })).not.toBeInTheDocument());
  });

  test("PlacePanel_separate_that_fails_says_so_with_a_retry_and_keeps_the_list", async () => {
    let failing = true;
    const api = stubEdits({
      "GET /api/places/2": () => Response.json(MERGED),
      "DELETE /api/places/2/merged/7": () => (failing ? new Response("{}", { status: 500 }) : new Response(null, { status: 204 })),
    });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Separate Bistro" }));

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

  test("PlacePanel_separate_says_the_place_is_no_longer_merged_when_the_server_says_it_is_not", async () => {
    stubEdits({
      "GET /api/places/2": () => Response.json(MERGED),
      "DELETE /api/places/2/merged/7": () => new Response("{}", { status: 404 }),
    });
    mount();

    fireEvent.click(await screen.findByRole("button", { name: "Separate Bistro" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("It is not merged into this place any more.");
  });
});

describe("PlacePanel what a write answers", () => {
  /** The first request for the place gets it; every one after it waits for ever (the refetch that a write makes is slow). */
  const slowAfterTheFirst = (place: PlaceResponse): Handler => {
    let asked = 0;
    return () => (++asked === 1 ? Response.json(place) : new Promise<Response>(() => undefined));
  };

  test("PlacePanel_shows_the_name_a_rename_answered_with_without_waiting_for_the_place_to_be_asked_for_again", async () => {
    stubEdits({
      "GET /api/places/2": slowAfterTheFirst(CAFE),
      "PUT /api/places/2/name": () => Response.json({ ...CAFE, name: "Bar" }),
    });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Rename" }));
    fireEvent.change(nameField(), { target: { value: "Bar" } });

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(heading()).toHaveTextContent("Bar"));
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  test("PlacePanel_shows_the_survivor_a_merge_answered_with_without_waiting_for_the_place_to_be_asked_for_again", async () => {
    stubEdits({
      "GET /api/places/2": slowAfterTheFirst(CAFE),
      "GET /api/places/2/candidates": () => Response.json([BISTRO]),
      "POST /api/places/2/merge": () => Response.json({ ...CAFE, visits: 6, merged: [{ id: 7, name: "Bistro" }] }),
    });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Merge with…" }));
    fireEvent.click(await screen.findByRole("button", { name: /^Bistro/ }));

    fireEvent.click(screen.getByRole("button", { name: "Merge" }));

    await waitFor(() => expect(screen.getByRole("region", { name: "Merged places" })).toBeInTheDocument());
    expect(stats()[1]).toEqual(["Visits", "6"]);
  });

  test("PlacePanel_takes_the_place_that_was_separated_off_the_list_without_waiting_for_the_place_to_be_asked_for_again", async () => {
    stubEdits({
      "GET /api/places/2": slowAfterTheFirst({ ...CAFE, merged: [{ id: 7, name: "Bistro" }, { id: 9, name: "Bar" }] }),
      "DELETE /api/places/2/merged/7": () => new Response(null, { status: 204 }),
    });
    mount();

    fireEvent.click(await screen.findByRole("button", { name: "Separate Bistro" }));

    await waitFor(() => expect(screen.queryByRole("button", { name: "Separate Bistro" })).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Separate Bar" })).toBeEnabled(); // and the list is usable at once, not a second click on a row that is gone
  });
});
