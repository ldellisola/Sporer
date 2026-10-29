import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { PlaceCandidate, PlaceSearchResult } from "../api/types";
import { PlacePicker } from "./PlacePicker";

const BISTRO: PlaceCandidate = { id: 7, name: "Bistro", address: "Storgata 14, Oslo", distanceM: 42.4, visits: 3 };
const UNNAMED: PlaceCandidate = { id: 8, name: null, address: null, distanceM: 1250, visits: 1 };

const CAFE: PlaceSearchResult = { id: 4, name: "Café", address: "Karl Johans gate 1, Oslo", visits: 12 };
const UNNAMED_FOUND: PlaceSearchResult = { id: 5, name: null, address: null, visits: 1 };

type Answer = (path: string) => Response | Promise<Response>;

/** Answers every request with `answer` (a list of candidates or of places found, or a function that answers); returns the paths asked for, in order. */
function stubApi(answer: PlaceCandidate[] | PlaceSearchResult[] | Answer): string[] {
  const paths: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string) => {
      paths.push(path);
      return typeof answer === "function" ? answer(path) : Response.json(answer);
    }),
  );
  return paths;
}

function mount(props: { onPick?: (candidate: PlaceCandidate) => void; onCancel?: (() => void) | null } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onPick = props.onPick ?? vi.fn();
  const onCancel = props.onCancel === null ? undefined : (props.onCancel ?? vi.fn());
  return {
    onPick,
    onCancel,
    ...render(
      <QueryClientProvider client={client}>
        <PlacePicker placeId={2} onPick={onPick} onCancel={onCancel} />
      </QueryClientProvider>,
    ),
  };
}

/** The picker with no place to start from (it searches all the places in use). */
function mountSearch(props: { onPick?: (place: PlaceSearchResult) => void; onCancel?: (() => void) | null } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onPick = props.onPick ?? vi.fn();
  const onCancel = props.onCancel === null ? undefined : (props.onCancel ?? vi.fn());
  return {
    onPick,
    onCancel,
    ...render(
      <QueryClientProvider client={client}>
        <PlacePicker onPick={onPick} onCancel={onCancel} />
      </QueryClientProvider>,
    ),
  };
}

const search = () => screen.getByRole("searchbox", { name: "Search places" });
const type = (text: string) => fireEvent.change(search(), { target: { value: text } });
/**
 * From here on the clock is a fake one, and it stands still until the test moves it: no time goes by that the test did not say. The list that the picker
 * opens on is waited for before, on the real clock, and the fake one is only for what the typing sets going (the pause, and what the answer then sets going).
 */
const freeze = () => vi.useFakeTimers();
/** Lets `ms` of the (fake) clock go by, and what is waiting for it run: the pause that was over, the request it made, and the answer's turn to be drawn. */
const wait = async (ms: number) => {
  await act(() => vi.advanceTimersByTimeAsync(ms));
  await act(() => vi.advanceTimersByTimeAsync(0)); // what the answer set going for the next tick of the clock (a query tells its watchers on one)
};

afterEach(() => {
  vi.useRealTimers();
});

describe("PlacePicker", () => {
  test("PlacePicker_lists_the_candidates_as_the_server_has_them_with_name_address_distance_and_visits", async () => {
    const paths = stubApi([BISTRO, UNNAMED]);

    mount();

    const rows = await screen.findAllByRole("listitem");
    expect(rows.map((row) => [...row.querySelectorAll("span")].map((part) => part.textContent))).toEqual([
      ["Bistro", "Storgata 14, Oslo", "42 m", "3 visits"],
      ["Unnamed place", "1.3 km", "1 visit"], // no name: as the rest of the app says it; no address: no empty line
    ]);
    expect(paths).toEqual(["/api/places/2/candidates"]); // no search text, no `q`: the nearest first
  });

  test("PlacePicker_names_each_button_by_what_the_row_says", async () => {
    stubApi([BISTRO, UNNAMED]);
    mount();

    // The name of a button holds the text that is on it (voice control says what it sees), in the order the row has it.
    expect(await screen.findByRole("button", { name: "Bistro, Storgata 14, Oslo, 42 m, 3 visits" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Unnamed place, 1.3 km, 1 visit" })).toBeInTheDocument();
  });

  test("PlacePicker_picking_a_row_hands_over_that_candidate", async () => {
    stubApi([BISTRO, UNNAMED]);
    const { onPick } = mount();

    fireEvent.click(await screen.findByRole("button", { name: /^Unnamed place/ }));

    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledWith(UNNAMED);
  });

  test("PlacePicker_says_it_is_loading_and_has_the_search_meanwhile", () => {
    stubApi(() => new Promise<Response>(() => undefined));

    mount();

    expect(screen.getByText("Loading…")).toBeInTheDocument();
    expect(search()).toBeInTheDocument();
  });

  test("PlacePicker_says_there_are_no_places_when_there_are_none", async () => {
    stubApi([]);

    mount();

    expect(await screen.findByText("No places found")).toBeInTheDocument();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });

  test("PlacePicker_has_the_field_in_focus_for_typing_at_once", () => {
    stubApi([BISTRO]);

    mount();

    expect(search()).toHaveFocus();
  });
});

describe("PlacePicker search", () => {
  test("PlacePicker_asks_once_300_ms_after_the_last_key_and_with_what_was_typed_last", async () => {
    const paths = stubApi((path) => Response.json(path.includes("q=caf") ? [BISTRO] : [UNNAMED]));
    mount();
    await screen.findByRole("button", { name: /^Unnamed place/ });
    freeze();

    type("c");
    await wait(100);
    type("ca");
    await wait(100);
    type("caf");
    await wait(299);

    expect(paths).toEqual(["/api/places/2/candidates"]); // 299 ms after the last key: nothing yet, and never for "c" or "ca"
    await wait(1);

    expect(screen.getByRole("button", { name: /^Bistro/ })).toBeInTheDocument();
    expect(paths).toEqual(["/api/places/2/candidates", "/api/places/2/candidates?q=caf"]);
  });

  test("PlacePicker_sends_the_text_trimmed_and_escaped_and_goes_back_to_the_nearest_when_it_is_emptied", async () => {
    const paths = stubApi((path) => Response.json(path.includes("q=") ? [BISTRO] : [UNNAMED]));
    mount();
    await screen.findByRole("button", { name: /^Unnamed place/ });
    freeze();

    type("  Café & Co ");
    await wait(300);
    expect(screen.getByRole("button", { name: /^Bistro/ })).toBeInTheDocument();
    expect(paths.at(-1)).toBe("/api/places/2/candidates?q=Caf%C3%A9%20%26%20Co"); // as typed, but for the spaces at the ends

    type("   "); // nothing but spaces is no search
    await wait(300);

    expect(screen.getByRole("button", { name: /^Unnamed place/ })).toBeInTheDocument();
    expect(paths.filter((path) => path.includes("q="))).toHaveLength(1); // the nearest were still fresh: no `q=` and no `q=%20`
  });

  test("PlacePicker_keeps_the_list_that_was_on_screen_and_says_it_is_busy_while_a_search_is_on_its_way", async () => {
    stubApi((path) => (path.includes("q=") ? new Promise<Response>(() => undefined) : Response.json([BISTRO])));
    mount();
    const row = await screen.findByRole("button", { name: /^Bistro/ });
    expect(row.closest("[aria-busy]")).toHaveAttribute("aria-busy", "false");
    freeze();

    type("off");
    await wait(300);

    expect(screen.getByRole("button", { name: /^Bistro/ })).toBeInTheDocument(); // not "Loading…": the list stays, and the owner can go on
    expect(screen.getByRole("button", { name: /^Bistro/ }).closest("[aria-busy]")).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
  });

  test("PlacePicker_says_when_the_search_found_nothing", async () => {
    stubApi((path) => Response.json(path.includes("q=") ? [] : [BISTRO]));
    mount();
    await screen.findByRole("button", { name: /^Bistro/ });
    freeze();

    type("zzz");
    await wait(300);

    expect(screen.getByText("No places found")).toBeInTheDocument();
  });
});

describe("PlacePicker failure", () => {
  test("PlacePicker_shows_an_error_with_a_retry_that_asks_again", async () => {
    let failing = true;
    const paths = stubApi(() => (failing ? new Response("{}", { status: 500 }) : Response.json([BISTRO])));
    mount();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Couldn't load — Retry");
    expect(search()).toBeInTheDocument(); // the field is still there

    failing = false;
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));

    expect(await screen.findByRole("button", { name: /^Bistro/ })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(paths).toEqual(["/api/places/2/candidates", "/api/places/2/candidates"]);
  });

  test("PlacePicker_keeps_the_list_under_the_error_of_a_search_that_failed", async () => {
    stubApi((path) => (path.includes("q=") ? new Response("{}", { status: 500 }) : Response.json([BISTRO])));
    mount();
    await screen.findByRole("button", { name: /^Bistro/ });
    freeze();

    type("off");
    await wait(300);

    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't load — Retry");
    expect(screen.getByRole("button", { name: /^Bistro/ })).toBeInTheDocument(); // never a blank where the list was
  });
});

describe("PlacePicker cancel", () => {
  test("PlacePicker_has_a_cancel_button_and_closes_on_escape", async () => {
    stubApi([BISTRO]);
    const { onCancel } = mount();
    await screen.findByRole("button", { name: /^Bistro/ });

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(search(), { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(2);
  });

  test("PlacePicker_has_no_cancel_and_ignores_escape_when_whoever_uses_it_gave_none_to_call", async () => {
    stubApi([BISTRO]);
    mount({ onCancel: null });
    await screen.findByRole("button", { name: /^Bistro/ });

    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
    fireEvent.keyDown(search(), { key: "Escape" }); // and nothing breaks
    expect(search()).toBeInTheDocument();
  });
});

describe("PlacePicker with no place to start from", () => {
  test("PlacePicker_without_a_place_lists_the_places_as_the_server_has_them_with_name_address_and_visits_and_no_distance", async () => {
    const paths = stubApi([CAFE, UNNAMED_FOUND]);

    mountSearch();

    const rows = await screen.findAllByRole("listitem");
    expect(rows.map((row) => [...row.querySelectorAll("span")].map((part) => part.textContent))).toEqual([
      ["Café", "Karl Johans gate 1, Oslo", "12 visits"],
      ["Unnamed place", "1 visit"], // no name: as the rest of the app says it; no address: no empty line; no distance, for there is no place to measure from
    ]);
    expect(paths).toEqual(["/api/places/search"]); // no search text, no `q`: the most visited first, as the server has them
    expect(screen.getByRole("button", { name: "Café, Karl Johans gate 1, Oslo, 12 visits" })).toBeInTheDocument(); // the name holds the text that is on it
    expect(screen.getByRole("button", { name: "Unnamed place, 1 visit" })).toBeInTheDocument();
  });

  test("PlacePicker_without_a_place_picking_a_row_hands_over_that_place", async () => {
    stubApi([CAFE, UNNAMED_FOUND]);
    const { onPick } = mountSearch();

    fireEvent.click(await screen.findByRole("button", { name: /^Unnamed place/ }));

    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledWith(UNNAMED_FOUND);
  });

  test("PlacePicker_without_a_place_asks_300_ms_after_the_last_key_with_what_was_typed_last_trimmed_and_escaped", async () => {
    const paths = stubApi((path) => Response.json(path.includes("q=") ? [CAFE] : [UNNAMED_FOUND]));
    mountSearch();
    await screen.findByRole("button", { name: /^Unnamed place/ });
    freeze();

    type("c");
    await wait(100);
    type("  Café & Co ");
    await wait(299);
    expect(paths).toEqual(["/api/places/search"]); // 299 ms after the last key: nothing yet, and never for "c"
    await wait(1);

    expect(screen.getByRole("button", { name: /^Café/ })).toBeInTheDocument();
    expect(paths).toEqual(["/api/places/search", "/api/places/search?q=Caf%C3%A9%20%26%20Co"]);

    type("   "); // nothing but spaces is no search: back to the most visited, which were still fresh
    await wait(300);

    expect(screen.getByRole("button", { name: /^Unnamed place/ })).toBeInTheDocument();
    expect(paths).toHaveLength(2);
  });

  test("PlacePicker_without_a_place_says_it_is_loading_and_when_there_are_no_places_and_when_a_search_found_none", async () => {
    stubApi(() => new Promise<Response>(() => undefined));
    const loading = mountSearch();
    expect(screen.getByText("Loading…")).toBeInTheDocument();
    expect(search()).toBeInTheDocument();
    loading.unmount();

    stubApi((path) => Response.json(path.includes("q=") ? [] : [CAFE]));
    mountSearch();
    await screen.findByRole("button", { name: /^Café/ });
    freeze();
    type("zzz");
    await wait(300);

    expect(screen.getByText("No places found")).toBeInTheDocument();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });

  test("PlacePicker_without_a_place_shows_an_error_with_a_retry_that_asks_again_and_keeps_the_field", async () => {
    let failing = true;
    const paths = stubApi(() => (failing ? new Response("{}", { status: 500 }) : Response.json([CAFE])));
    mountSearch();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Couldn't load — Retry");
    expect(search()).toBeInTheDocument();

    failing = false;
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));

    expect(await screen.findByRole("button", { name: /^Café/ })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(paths).toEqual(["/api/places/search", "/api/places/search"]);
  });

  test("PlacePicker_without_a_place_has_a_cancel_button_and_closes_on_escape_and_has_neither_with_no_cancel_to_call", async () => {
    stubApi([CAFE]);
    const { onCancel } = mountSearch();
    await screen.findByRole("button", { name: /^Café/ });

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.keyDown(search(), { key: "Escape" });

    expect(onCancel).toHaveBeenCalledTimes(2);
  });

  test("PlacePicker_without_a_place_never_asks_for_the_candidates_of_a_place", async () => {
    const paths = stubApi([CAFE]);
    mountSearch();
    await screen.findByRole("button", { name: /^Café/ });

    expect(paths.some((path) => path.includes("candidates"))).toBe(false);
  });
});
