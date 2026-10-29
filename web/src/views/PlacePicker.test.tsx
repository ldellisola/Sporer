import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { PlaceCandidate } from "../api/types";
import { PlacePicker } from "./PlacePicker";

const BISTRO: PlaceCandidate = { id: 7, name: "Bistro", address: "Storgata 14, Oslo", distanceM: 42.4, visits: 3 };
const UNNAMED: PlaceCandidate = { id: 8, name: null, address: null, distanceM: 1250, visits: 1 };

type Answer = (path: string) => Response | Promise<Response>;

/** Answers every request with `answer` (a list of candidates, or a function that answers); returns the paths asked for, in order. */
function stubApi(answer: PlaceCandidate[] | Answer): string[] {
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

const search = () => screen.getByRole("searchbox", { name: "Search places" });
const type = (text: string) => fireEvent.change(search(), { target: { value: text } });
/** Lets `ms` of the (fake) clock go by, and what is waiting for it run. */
const wait = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

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
    vi.useFakeTimers({ shouldAdvanceTime: true }); // the clock runs, so that what waits for a request is found, and can be jumped over
    const paths = stubApi((path) => Response.json(path.includes("q=caf") ? [BISTRO] : [UNNAMED]));
    mount();
    await screen.findByRole("button", { name: /^Unnamed place/ });

    type("c");
    await wait(100);
    type("ca");
    await wait(100);
    type("caf");
    await wait(299);

    expect(paths).toEqual(["/api/places/2/candidates"]); // 299 ms after the last key: nothing yet, and never for "c" or "ca"
    await wait(1);

    expect(await screen.findByRole("button", { name: /^Bistro/ })).toBeInTheDocument();
    expect(paths).toEqual(["/api/places/2/candidates", "/api/places/2/candidates?q=caf"]);
  });

  test("PlacePicker_sends_the_text_trimmed_and_escaped_and_goes_back_to_the_nearest_when_it_is_emptied", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const paths = stubApi((path) => Response.json(path.includes("q=") ? [BISTRO] : [UNNAMED]));
    mount();
    await screen.findByRole("button", { name: /^Unnamed place/ });

    type("  Café & Co ");
    await wait(300);
    await screen.findByRole("button", { name: /^Bistro/ });
    expect(paths.at(-1)).toBe("/api/places/2/candidates?q=Caf%C3%A9%20%26%20Co"); // as typed, but for the spaces at the ends

    type("   "); // nothing but spaces is no search
    await wait(300);

    expect(await screen.findByRole("button", { name: /^Unnamed place/ })).toBeInTheDocument();
    expect(paths.filter((path) => path.includes("q="))).toHaveLength(1); // the nearest were still fresh: no `q=` and no `q=%20`
  });

  test("PlacePicker_keeps_the_list_that_was_on_screen_and_says_it_is_busy_while_a_search_is_on_its_way", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    stubApi((path) => (path.includes("q=") ? new Promise<Response>(() => undefined) : Response.json([BISTRO])));
    mount();
    const row = await screen.findByRole("button", { name: /^Bistro/ });
    expect(row.closest("[aria-busy]")).toHaveAttribute("aria-busy", "false");

    type("off");
    await wait(300);

    expect(screen.getByRole("button", { name: /^Bistro/ })).toBeInTheDocument(); // not "Loading…": the list stays, and the owner can go on
    expect(screen.getByRole("button", { name: /^Bistro/ }).closest("[aria-busy]")).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
  });

  test("PlacePicker_says_when_the_search_found_nothing", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    stubApi((path) => Response.json(path.includes("q=") ? [] : [BISTRO]));
    mount();
    await screen.findByRole("button", { name: /^Bistro/ });

    type("zzz");
    await wait(300);

    expect(await screen.findByText("No places found")).toBeInTheDocument();
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
    vi.useFakeTimers({ shouldAdvanceTime: true });
    stubApi((path) => (path.includes("q=") ? new Response("{}", { status: 500 }) : Response.json([BISTRO])));
    mount();
    await screen.findByRole("button", { name: /^Bistro/ });

    type("off");
    await wait(300);

    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't load — Retry");
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
