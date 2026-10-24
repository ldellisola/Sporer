import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { RangeDay, RangePlace, RangeResponse } from "../api/types";
import october from "../../e2e/fixtures/range-october.json";
import { RangePanel } from "./RangePanel";

const OCTOBER = october as RangeResponse; // 2026-10-01 to 2026-10-31: 6 places, 9 moves, 8 days

type Answer = (path: string) => Response | Promise<Response>;

/** The key a request is answered by: the dates it asks for, `2026-10-19..2026-10-25`. */
const keyOf = (path: string): string => {
  const { searchParams } = new URL(path, "http://localhost");
  return `${searchParams.get("from")}..${searchParams.get("to")}`;
};

/** Answers `/api/range` from `ranges` (a response, or a function that answers) by the dates asked for; returns the paths asked for. */
function stubApi(ranges: Record<string, RangeResponse | Answer>): string[] {
  const paths: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string) => {
      paths.push(path);
      const answer = ranges[keyOf(path)];
      if (answer === undefined) return new Response("{}", { status: 404 });
      return typeof answer === "function" ? answer(path) : Response.json(answer);
    }),
  );
  return paths;
}

function mount(from: string, to: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ui = (a: string, b: string) => (
    <QueryClientProvider client={client}>
      <RangePanel from={a} to={b} />
    </QueryClientProvider>
  );
  const view = render(ui(from, to));
  return { client, unmount: view.unmount, show: (a: string, b: string) => view.rerender(ui(a, b)) };
}

const placesList = () => screen.getByRole("list", { name: "Where your time went" });
const daysList = () => screen.getByRole("list", { name: "Days" });
const items = (list: HTMLElement) => within(list).getAllByRole("listitem");

/** The part of a place's row that is filled as far as the time spent: the bar's track is hidden from a screen reader, and so is it. */
const fillOf = (row: HTMLElement): HTMLElement | null => row.querySelector("[aria-hidden] > span");

/** The text of each part of a row, left to right, as `["Home", "400h 0m"]`; the bar of a place has none. */
const parts = (row: HTMLElement): string[] =>
  [...row.querySelectorAll("span")].map((part) => part.textContent ?? "").filter((text) => text !== "");

// --- Building periods ---

const place = (id: number, name: string | null, seconds: number, over: Partial<RangePlace> = {}): RangePlace => ({
  id,
  name,
  city: null,
  country: null,
  lat: 59.9 + id / 100,
  lon: 10.7 + id / 100,
  seconds,
  visits: 1,
  ...over,
});

const dayEntry = (date: string, distanceMeters: number, places: number): RangeDay => ({ date, distanceMeters, movingSeconds: 600, places });

function period(from: string, to: string, over: Partial<RangeResponse> = {}): RangeResponse {
  const places = over.places ?? [];
  return {
    from,
    to,
    state: "done",
    summary: { places: places.length, distanceMeters: 0, movingSeconds: 0, moves: 0 },
    moves: [],
    places,
    days: [],
    ...over,
  };
}

const HOUR = 3600;
const HOME = place(1, "Home", 40 * HOUR);
const OFFICE = place(3, "Office", 10 * HOUR);
const GYM = place(6, "Gym", 2 * HOUR);
const CAFE = place(2, "Café", HOUR);

/** The week of 19 to 25 October: Monday to Sunday, with movement on four days and none on the other three. */
const WEEK = period("2026-10-19", "2026-10-25", {
  summary: { places: 3, distanceMeters: 13_200, movingSeconds: 2820, moves: 4 },
  places: [OFFICE, HOME, GYM], // not in the order of the time spent: the panel ranks them itself
  moves: [1, 2, 3, 4].map((id) => ({ id, mode: "walk", start: "2026-10-19T06:30:00Z", end: "2026-10-19T06:44:00Z", geometry: [[10.7, 59.9], [10.8, 59.95]] })),
  days: [dayEntry("2026-10-19", 1100, 2), dayEntry("2026-10-20", 3400, 3), dayEntry("2026-10-22", 6900, 2), dayEntry("2026-10-24", 1800, 1)],
});

/** Noon on a day, in whatever zone the test runs in: what "today" is to the panel, which lists no day after it. */
const setToday = (year: number, month: number, day: number): void => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(year, month - 1, day, 12, 0, 0));
};

beforeEach(() => {
  window.history.replaceState(null, "", "/week/2026-10-19");
  setToday(2026, 12, 1); // after every period of these tests, so that every date of each is a date that has been
});

afterEach(() => {
  vi.useRealTimers();
});

describe("RangePanel", () => {
  test("RangePanel_ranks_places_and_lists_days", async () => {
    stubApi({ "2026-10-19..2026-10-25": WEEK });

    mount("2026-10-19", "2026-10-25");

    // The summary of the period, as chips: its places, its distance, and its moves.
    expect(await screen.findByText("3 places")).toBeInTheDocument();
    expect(screen.getByText("13.2 km")).toBeInTheDocument();
    expect(screen.getByText("4 moves")).toBeInTheDocument();
    expect(screen.queryByText("Updating…")).not.toBeInTheDocument();

    // Where the time went: the most time first, and each with how long (the whole of it, as `formatDuration` writes it).
    expect(screen.getByRole("heading", { name: "Where your time went" })).toBeInTheDocument();
    expect(items(placesList()).map(parts)).toEqual([
      ["Home", "40h 0m"],
      ["Office", "10h 0m"],
      ["Gym", "2h 0m"],
    ]);

    // The days: every date of a week, in order, each with its weekday; the days with movement say how far and at how many places.
    expect(screen.getByRole("heading", { name: "Days" })).toBeInTheDocument();
    expect(items(daysList()).map(parts)).toEqual([
      ["Mon 19 Oct", "1.1 km · 2 places"],
      ["Tue 20 Oct", "3.4 km · 3 places"],
      ["Wed 21 Oct", "No movement"],
      ["Thu 22 Oct", "6.9 km · 2 places"],
      ["Fri 23 Oct", "No movement"],
      ["Sat 24 Oct", "1.8 km · 1 place"],
      ["Sun 25 Oct", "No movement"],
    ]);
  });

  test("RangePanel_draws_each_bar_as_a_share_of_the_top_place", async () => {
    stubApi({ "2026-10-19..2026-10-25": period("2026-10-19", "2026-10-25", { places: [GYM, HOME, CAFE, OFFICE] }) });
    mount("2026-10-19", "2026-10-25");
    await screen.findByRole("list", { name: "Where your time went" });

    const bars = items(placesList()).map(fillOf);

    // 40 h is the top: its bar is full, and the others are what they are of it: 10 of 40, 2 of 40, 1 of 40. The bars are not read out: the time is.
    expect(bars.map((bar) => bar?.style.width)).toEqual(["100%", "25%", "5%", "2.5%"]);
  });

  test("RangePanel_draws_an_empty_bar_and_not_NaN_when_no_place_has_any_time", async () => {
    stubApi({ "2026-10-19..2026-10-25": period("2026-10-19", "2026-10-25", { places: [place(1, "Home", 0)] }) });
    mount("2026-10-19", "2026-10-25");
    await screen.findByRole("list", { name: "Where your time went" });

    expect(fillOf(items(placesList())[0]!)?.style.width).toBe("0%"); // the server lists no place without time; a bar still never says NaN%
  });

  test("RangePanel_says_1_place_and_1_move_and_not_1_places", async () => {
    stubApi({
      "2026-10-19..2026-10-25": period("2026-10-19", "2026-10-25", {
        summary: { places: 1, distanceMeters: 850, movingSeconds: 45, moves: 1 },
        places: [HOME],
        days: [dayEntry("2026-10-19", 850, 1)],
      }),
    });

    mount("2026-10-19", "2026-10-25");

    expect(await screen.findByText("1 place")).toBeInTheDocument();
    expect(screen.getByText("850 m")).toBeInTheDocument();
    expect(screen.getByText("1 move")).toBeInTheDocument();
  });

  test("RangePanel_names_a_place_by_its_name_else_its_city_else_says_it_is_unnamed", async () => {
    stubApi({
      "2026-10-19..2026-10-25": period("2026-10-19", "2026-10-25", {
        places: [place(1, "Home", 3 * HOUR), place(2, null, 2 * HOUR, { city: "Lisbon" }), place(3, null, HOUR)],
      }),
    });

    mount("2026-10-19", "2026-10-25");
    await screen.findByRole("list", { name: "Where your time went" });

    // The names the map labels the dots with (`rangeGeoJson`: the name, else the city).
    expect(items(placesList()).map((row) => parts(row)[0])).toEqual(["Home", "Lisbon", "Unnamed place"]);
  });

  test("RangePanel_gives_a_period_with_no_days_listed_no_list_of_them", async () => {
    stubApi({ "2026-01-01..2026-12-31": period("2026-01-01", "2026-12-31", { places: [HOME] }) });

    mount("2026-01-01", "2026-12-31");
    await screen.findByRole("list", { name: "Where your time went" });

    expect(screen.queryByRole("heading", { name: "Days" })).not.toBeInTheDocument(); // a year lists the days that have some
    expect(screen.queryByRole("list", { name: "Days" })).not.toBeInTheDocument();
  });

  test("RangePanel_gives_a_period_with_moves_and_no_places_no_ranking", async () => {
    stubApi({ "2026-10-19..2026-10-25": { ...WEEK, places: [] } });

    mount("2026-10-19", "2026-10-25");
    await screen.findByRole("list", { name: "Days" });

    expect(screen.queryByRole("heading", { name: "Where your time went" })).not.toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Where your time went" })).not.toBeInTheDocument();
  });
});

describe("RangePanel days", () => {
  test("RangePanel_lists_every_date_of_a_month_as_the_month_has_them", async () => {
    stubApi({
      "2026-10-01..2026-10-31": OCTOBER,
      "2026-02-01..2026-02-28": period("2026-02-01", "2026-02-28", { places: [HOME], days: [dayEntry("2026-02-10", 500, 1)] }),
    });
    const { show } = mount("2026-10-01", "2026-10-31");

    await screen.findByRole("list", { name: "Days" });
    expect(items(daysList())).toHaveLength(31); // eight with movement and the rest said to have none
    expect(items(daysList()).filter((row) => parts(row)[1] === "No movement")).toHaveLength(23);
    expect(parts(items(daysList())[0]!)).toEqual(["Thu 1 Oct", "No movement"]);
    expect(parts(items(daysList())[30]!)).toEqual(["Sat 31 Oct", "No movement"]);

    show("2026-02-01", "2026-02-28");
    expect(await screen.findByText("1 place")).toBeInTheDocument();
    expect(items(daysList())).toHaveLength(28);
  });

  test("RangePanel_lists_only_the_days_there_are_for_a_year", async () => {
    stubApi({
      "2026-01-01..2026-12-31": period("2026-01-01", "2026-12-31", {
        places: [HOME],
        days: [dayEntry("2026-03-02", 1500, 2), dayEntry("2026-10-22", 6900, 2), dayEntry("2026-12-31", 700, 1)],
      }),
    });

    mount("2026-01-01", "2026-12-31");
    await screen.findByRole("list", { name: "Days" });

    // A year of 365 dates is not listed in full: only the days that the API has, which are the days with movement.
    expect(items(daysList()).map(parts)).toEqual([
      ["Mon 2 Mar", "1.5 km · 2 places"],
      ["Thu 22 Oct", "6.9 km · 2 places"],
      ["Thu 31 Dec", "700 m · 1 place"],
    ]);
  });

  test("RangePanel_lists_every_date_of_a_range_of_31_days_or_less_and_only_the_days_there_are_beyond", async () => {
    stubApi({
      "2026-10-05..2026-11-04": period("2026-10-05", "2026-11-04", { places: [HOME], days: [dayEntry("2026-10-12", 4800, 2)] }), // 31 days
      "2026-10-05..2026-11-05": period("2026-10-05", "2026-11-05", { places: [HOME], days: [dayEntry("2026-10-12", 4800, 2)] }), // 32
    });
    const { show } = mount("2026-10-05", "2026-11-04");

    await screen.findByRole("list", { name: "Days" });
    expect(items(daysList())).toHaveLength(31);

    show("2026-10-05", "2026-11-05");
    await waitFor(() => expect(items(daysList())).toHaveLength(1)); // 32 dates: only the days that there are
    expect(items(daysList()).map(parts)).toEqual([["Mon 12 Oct", "4.8 km · 2 places"]]);
  });

  test("RangePanel_day_tap_navigates_to_day", async () => {
    stubApi({ "2026-10-19..2026-10-25": WEEK });
    mount("2026-10-19", "2026-10-25");
    await screen.findByRole("list", { name: "Days" });

    fireEvent.click(screen.getByRole("button", { name: "Open Thu 22 Oct" }));

    expect(window.location.pathname).toBe("/day/2026-10-22");
  });

  test("RangePanel_a_day_with_no_movement_still_opens_its_day", async () => {
    stubApi({ "2026-10-19..2026-10-25": WEEK });
    mount("2026-10-19", "2026-10-25");
    await screen.findByRole("list", { name: "Days" });

    fireEvent.click(screen.getByRole("button", { name: "Open Wed 21 Oct" })); // it has no entry in the API's days

    expect(window.location.pathname).toBe("/day/2026-10-21");
  });

  test("RangePanel_day_rows_are_buttons_with_a_name_of_their_own", async () => {
    stubApi({ "2026-10-19..2026-10-25": WEEK });
    mount("2026-10-19", "2026-10-25");
    await screen.findByRole("list", { name: "Days" });

    const buttons = within(daysList()).getAllByRole("button");

    // The name is "Open" and the text of the row that says which day it is: what is said of a button is what is on it.
    expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual([
      "Open Mon 19 Oct",
      "Open Tue 20 Oct",
      "Open Wed 21 Oct",
      "Open Thu 22 Oct",
      "Open Fri 23 Oct",
      "Open Sat 24 Oct",
      "Open Sun 25 Oct",
    ]);
    for (const button of buttons) {
      expect(button).toHaveAttribute("type", "button");
      expect(button.closest("li")).not.toBeNull(); // one to a row, with the row's text in it
    }
  });
});

describe("RangePanel places", () => {
  test("RangePanel_place_tap_navigates_to_the_place", async () => {
    stubApi({ "2026-10-19..2026-10-25": WEEK });
    mount("2026-10-19", "2026-10-25");
    await screen.findByRole("list", { name: "Where your time went" });

    fireEvent.click(screen.getByRole("button", { name: "Open Office" }));

    expect(window.location.pathname).toBe("/place/3");
  });

  test("RangePanel_gives_every_place_button_a_name_of_its_own", async () => {
    // Two places called the same (a café of the same chain) and two that have no name: the buttons must still tell them apart.
    stubApi({
      "2026-10-19..2026-10-25": period("2026-10-19", "2026-10-25", {
        places: [place(1, "Home", 9 * HOUR), place(2, "Café", 4 * HOUR), place(3, null, 3 * HOUR), place(4, "Café", 2 * HOUR), place(5, null, HOUR)],
      }),
    });
    mount("2026-10-19", "2026-10-25");
    await screen.findByRole("list", { name: "Where your time went" });

    const names = within(placesList()).getAllByRole("button").map((button) => button.getAttribute("aria-label"));

    // A name that is only once in the list is the name; one that is more than once also says where it stands.
    expect(names).toEqual([
      "Open Home",
      "Open Café, number 2",
      "Open Unnamed place, number 3",
      "Open Café, number 4",
      "Open Unnamed place, number 5",
    ]);
    expect(new Set(names).size).toBe(names.length);
    fireEvent.click(screen.getByRole("button", { name: "Open Café, number 4" }));
    expect(window.location.pathname).toBe("/place/4");
  });

  test("RangePanel_place_rows_are_buttons_the_keyboard_reaches", async () => {
    stubApi({ "2026-10-19..2026-10-25": WEEK });
    mount("2026-10-19", "2026-10-25");
    await screen.findByRole("list", { name: "Where your time went" });

    const row = screen.getByRole("button", { name: "Open Home" });

    expect(row.tagName).toBe("BUTTON");
    expect(row).toHaveAttribute("type", "button");
    expect(row.closest("li")).toHaveTextContent(/Home.*40h 0m/); // the row's text is in it
    row.focus();
    expect(row).toHaveFocus();
  });
});

describe("RangePanel states", () => {
  test("RangePanel_shows_updating_note_while_pending", async () => {
    stubApi({ "2026-10-19..2026-10-25": { ...WEEK, state: "pending" } });

    mount("2026-10-19", "2026-10-25");

    expect(await screen.findByText("Updating…")).toBeInTheDocument();
    expect(items(placesList())).toHaveLength(3); // what there is of the period is shown, with the note
    expect(items(daysList())).toHaveLength(7);
    expect(screen.getByText("3 places")).toBeInTheDocument();
  });

  test("RangePanel_empty_period_says_so_and_has_no_chips_or_lists", async () => {
    stubApi({ "2026-10-19..2026-10-25": period("2026-10-19", "2026-10-25") });

    mount("2026-10-19", "2026-10-25");

    expect(await screen.findByText("No data for this period")).toBeInTheDocument();
    expect(screen.queryByRole("list")).not.toBeInTheDocument(); // not seven days of "No movement"
    expect(screen.queryByRole("heading")).not.toBeInTheDocument();
    expect(screen.queryByText(/places?$/)).not.toBeInTheDocument(); // chips that say 0 of everything would be noise
    expect(screen.queryByText("Updating…")).not.toBeInTheDocument();
  });

  test("RangePanel_empty_period_that_is_still_being_processed_says_so", async () => {
    stubApi({ "2026-10-19..2026-10-25": period("2026-10-19", "2026-10-25", { state: "pending" }) });

    mount("2026-10-19", "2026-10-25");

    expect(await screen.findByText("No data for this period")).toBeInTheDocument();
    expect(screen.getByText("Updating…")).toBeInTheDocument();
  });

  test("RangePanel_says_loading_until_the_first_period_arrives", async () => {
    let release: (response: Response) => void = () => undefined;
    stubApi({ "2026-10-19..2026-10-25": () => new Promise<Response>((resolve) => (release = resolve)) });

    mount("2026-10-19", "2026-10-25");
    expect(screen.getByText("Loading…")).toBeInTheDocument();
    expect(screen.queryByText("No data for this period")).not.toBeInTheDocument();

    release(Response.json(WEEK));

    expect(await screen.findByText("3 places")).toBeInTheDocument();
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
  });

  test("RangePanel_shows_an_error_with_a_retry_and_nothing_else_when_the_first_period_fails", async () => {
    let failing = true;
    stubApi({ "2026-10-19..2026-10-25": () => (failing ? new Response("{}", { status: 500 }) : Response.json(WEEK)) });

    mount("2026-10-19", "2026-10-25");

    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't load — Retry");
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument();

    failing = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByRole("list", { name: "Days" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  test("RangePanel_keeps_the_previous_period_shown_and_marked_busy_while_the_next_loads", async () => {
    let release: (response: Response) => void = () => undefined;
    stubApi({
      "2026-10-19..2026-10-25": WEEK,
      "2026-10-26..2026-11-01": () => new Promise<Response>((resolve) => (release = resolve)),
    });
    const { show } = mount("2026-10-19", "2026-10-25");
    await screen.findByText("3 places");
    expect(document.querySelector("[aria-busy]")).toHaveAttribute("aria-busy", "false");

    show("2026-10-26", "2026-11-01");

    expect(screen.getByText("3 places")).toBeInTheDocument(); // the period that was shown stays, with its own days
    expect(parts(items(daysList())[0]!)[0]).toBe("Mon 19 Oct");
    expect(document.querySelector("[aria-busy]")).toHaveAttribute("aria-busy", "true"); // and says it is not the one asked for
    expect(screen.queryByText("No data for this period")).not.toBeInTheDocument();

    release(Response.json(period("2026-10-26", "2026-11-01", { summary: { places: 1, distanceMeters: 0, movingSeconds: 0, moves: 0 }, places: [HOME] })));

    expect(await screen.findByText("1 place")).toBeInTheDocument();
    expect(parts(items(daysList())[0]!)[0]).toBe("Mon 26 Oct");
    expect(document.querySelector("[aria-busy]")).toHaveAttribute("aria-busy", "false");
  });

  test("RangePanel_keeps_the_previous_period_under_an_error_and_is_not_busy_where_nothing_is_on_its_way", async () => {
    let failing = true;
    stubApi({
      "2026-10-19..2026-10-25": WEEK,
      "2026-10-26..2026-11-01": () =>
        failing ? new Response("{}", { status: 500 }) : Response.json(period("2026-10-26", "2026-11-01", { places: [HOME, CAFE] })),
    });
    const { show } = mount("2026-10-19", "2026-10-25");
    await screen.findByText("3 places");

    show("2026-10-26", "2026-11-01");

    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't load — Retry");
    expect(screen.getByText("3 places")).toBeInTheDocument(); // an error never leaves a blank screen
    expect(document.querySelector("[aria-busy]")).toHaveAttribute("aria-busy", "false");

    failing = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByText("2 places")).toBeInTheDocument();
  });

  test("RangePanel_does_not_call_an_empty_period_of_other_dates_the_empty_period_it_is_waiting_for", async () => {
    let release: (response: Response) => void = () => undefined;
    stubApi({
      "2026-10-19..2026-10-25": period("2026-10-19", "2026-10-25"),
      "2026-10-26..2026-11-01": () => new Promise<Response>((resolve) => (release = resolve)),
    });
    const { show } = mount("2026-10-19", "2026-10-25");
    await screen.findByText("No data for this period");

    show("2026-10-26", "2026-11-01"); // the week before is empty, which says nothing of this one

    expect(screen.queryByText("No data for this period")).not.toBeInTheDocument();
    expect(screen.getByText("Loading…")).toBeInTheDocument();
    release(Response.json(WEEK));
    expect(await screen.findByText("3 places")).toBeInTheDocument();
  });
});

describe("RangePanel names", () => {
  test("RangePanel_gives_every_button_a_name_that_holds_the_text_it_shows_to_say_what_it_is", async () => {
    // Label in name: someone who says what they read ("Thu 22 Oct", "Home") reaches the button that has it.
    stubApi({
      "2026-10-19..2026-10-25": period("2026-10-19", "2026-10-25", {
        places: [place(1, "Home", 9 * HOUR), place(2, null, 2 * HOUR, { city: "Lisbon" }), place(3, null, HOUR)],
        days: [dayEntry("2026-10-19", 1100, 2)],
      }),
    });
    mount("2026-10-19", "2026-10-25");
    await screen.findByRole("list", { name: "Days" });

    const buttons = screen.getAllByRole("button");

    expect(buttons).toHaveLength(10); // 3 places and 7 days
    for (const button of buttons) {
      const [shown] = parts(button.closest("li")!); // what the row calls itself: the place, the day
      expect(button.getAttribute("aria-label")!.toLowerCase()).toContain(shown!.toLowerCase());
    }
  });
});

describe("RangePanel future", () => {
  /** The days of the week before the one that is going on, with movement on two of them. */
  const entries = [dayEntry("2026-10-19", 1100, 2), dayEntry("2026-10-20", 3400, 3)];
  const WEEK_SO_FAR = period("2026-10-19", "2026-10-25", { places: [HOME], days: entries });
  const dates = () => items(daysList()).map((row) => parts(row)[0]);

  test("RangePanel_lists_no_date_after_today_for_the_week_that_is_going_on", async () => {
    setToday(2026, 10, 21); // a Wednesday
    stubApi({ "2026-10-19..2026-10-25": WEEK_SO_FAR });

    mount("2026-10-19", "2026-10-25");
    await screen.findByRole("list", { name: "Days" });

    // Today is listed (the day is still going on), and Thursday on is not a day without movement: it has not been.
    expect(items(daysList()).map(parts)).toEqual([
      ["Mon 19 Oct", "1.1 km · 2 places"],
      ["Tue 20 Oct", "3.4 km · 3 places"],
      ["Wed 21 Oct", "No movement"],
    ]);
  });

  test("RangePanel_lists_no_date_after_today_for_the_month_that_is_going_on", async () => {
    setToday(2026, 10, 21);
    stubApi({ "2026-10-01..2026-10-31": period("2026-10-01", "2026-10-31", { places: [HOME], days: entries }) });

    mount("2026-10-01", "2026-10-31");
    await screen.findByRole("list", { name: "Days" });

    expect(items(daysList())).toHaveLength(21); // the 1st to the 21st
    expect(dates()[0]).toBe("Thu 1 Oct");
    expect(dates()[20]).toBe("Wed 21 Oct");
  });

  test("RangePanel_lists_no_date_after_today_for_a_range_of_up_to_31_dates_that_runs_past_it", async () => {
    setToday(2026, 10, 21);
    stubApi({ "2026-10-18..2026-11-10": period("2026-10-18", "2026-11-10", { places: [HOME], days: entries }) }); // 24 dates

    mount("2026-10-18", "2026-11-10");
    await screen.findByRole("list", { name: "Days" });

    expect(dates()).toEqual(["Sun 18 Oct", "Mon 19 Oct", "Tue 20 Oct", "Wed 21 Oct"]);
  });

  test("RangePanel_lists_the_days_there_are_for_the_year_that_is_going_on_and_goes_by_the_date_of_today", async () => {
    setToday(2026, 10, 21);
    stubApi({
      "2026-01-01..2026-12-31": period("2026-01-01", "2026-12-31", {
        places: [HOME],
        days: [dayEntry("2026-03-02", 1500, 2), dayEntry("2026-10-21", 700, 1)],
      }),
    });

    mount("2026-01-01", "2026-12-31");
    await screen.findByRole("list", { name: "Days" });

    expect(dates()).toEqual(["Mon 2 Mar", "Wed 21 Oct"]); // no date is made up for a year, so there is none to leave out
  });

  test("RangePanel_lists_a_day_after_today_that_the_API_has_something_on", async () => {
    // Today is read on the clock of this browser and a day of the timeline on the clock of the zone it was in: a day of a trip
    // to the other side of the date line can be tomorrow here. It has movement, so it is no day without any.
    setToday(2026, 10, 21);
    stubApi({
      "2026-10-19..2026-10-25": period("2026-10-19", "2026-10-25", { places: [HOME], days: [...entries, dayEntry("2026-10-23", 800, 1)] }),
    });

    mount("2026-10-19", "2026-10-25");
    await screen.findByRole("list", { name: "Days" });

    expect(dates()).toEqual(["Mon 19 Oct", "Tue 20 Oct", "Wed 21 Oct", "Fri 23 Oct"]); // and not the Thursday, which no one has been through
  });

  test("RangePanel_lists_every_date_of_a_week_that_ended_yesterday_and_today_is_the_last_of_the_one_that_ends_today", async () => {
    stubApi({ "2026-10-19..2026-10-25": WEEK_SO_FAR });
    setToday(2026, 10, 26); // the Monday after
    const { unmount } = mount("2026-10-19", "2026-10-25");
    await screen.findByRole("list", { name: "Days" });
    expect(items(daysList())).toHaveLength(7);
    unmount();

    setToday(2026, 10, 25); // the Sunday itself: the week is not over, and its last day is listed
    mount("2026-10-19", "2026-10-25");
    await screen.findByRole("list", { name: "Days" });
    expect(items(daysList())).toHaveLength(7);
  });

  test("RangePanel_lists_every_date_of_a_week_across_a_year_end", async () => {
    stubApi({
      "2025-12-29..2026-01-04": period("2025-12-29", "2026-01-04", { places: [HOME], days: [dayEntry("2025-12-31", 900, 1), dayEntry("2026-01-02", 1200, 2)] }),
    });

    mount("2025-12-29", "2026-01-04");
    await screen.findByRole("list", { name: "Days" });

    expect(items(daysList()).map(parts)).toEqual([
      ["Mon 29 Dec", "No movement"],
      ["Tue 30 Dec", "No movement"],
      ["Wed 31 Dec", "900 m · 1 place"],
      ["Thu 1 Jan", "No movement"],
      ["Fri 2 Jan", "1.2 km · 2 places"],
      ["Sat 3 Jan", "No movement"],
      ["Sun 4 Jan", "No movement"],
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Open Thu 1 Jan" }));
    expect(window.location.pathname).toBe("/day/2026-01-01"); // the days are of two years, and each opens its own
  });
});

describe("RangePanel top places", () => {
  /** `count` places, the top one at 100 hours and each of the others 3 hours less than the one before it (so there are no ties). */
  const ranking = (count: number): RangePlace[] => Array.from({ length: count }, (_, i) => place(i + 1, `Place ${i + 1}`, (100 - 3 * i) * HOUR));
  const buttonNames = () => within(placesList()).getAllByRole("button").map((button) => button.getAttribute("aria-label"));
  const showAll = (n: number) => screen.queryByRole("button", { name: `Show all ${n} places` });

  test("RangePanel_lists_the_ten_places_with_the_most_time_and_offers_the_rest", async () => {
    stubApi({ "2026-10-19..2026-10-25": period("2026-10-19", "2026-10-25", { places: ranking(11) }) });

    mount("2026-10-19", "2026-10-25");
    await screen.findByRole("list", { name: "Where your time went" });

    expect(items(placesList()).map((row) => parts(row)[0])).toEqual(Array.from({ length: 10 }, (_, i) => `Place ${i + 1}`)); // the 11th is not shown
    expect(showAll(11)).toBeInTheDocument();
    expect(showAll(11)!.tagName).toBe("BUTTON");
    expect(items(placesList()).map((row) => row.querySelector("[aria-hidden] > span"))).toHaveLength(10);
  });

  test("RangePanel_lists_all_of_ten_places_and_offers_no_more", async () => {
    stubApi({ "2026-10-19..2026-10-25": period("2026-10-19", "2026-10-25", { places: ranking(10) }) });

    mount("2026-10-19", "2026-10-25");
    await screen.findByRole("list", { name: "Where your time went" });

    expect(items(placesList())).toHaveLength(10);
    expect(screen.queryByRole("button", { name: /^Show all/ })).not.toBeInTheDocument();
  });

  test("RangePanel_shows_all_the_places_in_place_when_asked_with_the_bars_still_shares_of_the_top_one", async () => {
    stubApi({ "2026-10-19..2026-10-25": period("2026-10-19", "2026-10-25", { places: ranking(11) }) });
    mount("2026-10-19", "2026-10-25");
    await screen.findByRole("list", { name: "Where your time went" });

    fireEvent.click(showAll(11)!);

    expect(items(placesList())).toHaveLength(11);
    expect(buttonNames().at(-1)).toBe("Open Place 11");
    expect(showAll(11)).not.toBeInTheDocument(); // there is no more to show
    const widths = items(placesList()).map((row) => fillOf(row)!.style.width);
    expect(widths[0]).toBe("100%");
    expect(parseFloat(widths[10]!)).toBeCloseTo(70, 5); // the 11th has 70 of the top's 100 hours
    expect(window.location.pathname).toBe("/week/2026-10-19"); // it is not a move to anywhere
  });

  test("RangePanel_keeps_the_focus_in_the_list_when_the_rest_is_shown", async () => {
    // The button that was pressed goes with the click: the focus goes to the first place that was not there.
    stubApi({ "2026-10-19..2026-10-25": period("2026-10-19", "2026-10-25", { places: ranking(12) }) });
    mount("2026-10-19", "2026-10-25");
    await screen.findByRole("list", { name: "Where your time went" });
    showAll(12)!.focus();

    fireEvent.click(showAll(12)!);

    expect(screen.getByRole("button", { name: "Open Place 11" })).toHaveFocus();
  });

  test("RangePanel_stays_expanded_while_the_period_is_the_same_and_starts_closed_for_another", async () => {
    const A = period("2026-10-19", "2026-10-25", { places: ranking(11) });
    const B = period("2026-10-26", "2026-11-01", { places: ranking(12) });
    const answers: Record<string, RangeResponse> = { "2026-10-19..2026-10-25": A, "2026-10-26..2026-11-01": B };
    stubApi(answers);
    const { show, client } = mount("2026-10-19", "2026-10-25");
    await screen.findByRole("list", { name: "Where your time went" });
    fireEvent.click(showAll(11)!);
    expect(items(placesList())).toHaveLength(11);

    answers["2026-10-19..2026-10-25"] = { ...A, state: "done", places: ranking(11).slice().reverse() }; // a poll: the same period, as it is now
    await act(async () => {
      await client.refetchQueries({ queryKey: ["range", "2026-10-19", "2026-10-25"] });
    });
    expect(items(placesList())).toHaveLength(11); // stays as it was opened

    show("2026-10-26", "2026-11-01"); // the next period
    expect(await screen.findByRole("button", { name: "Show all 12 places" })).toBeInTheDocument();
    expect(items(placesList())).toHaveLength(10);

    fireEvent.click(showAll(12)!);
    show("2026-10-19", "2026-10-25"); // and back: closed again, it is another showing of the period
    await waitFor(() => expect(showAll(11)).toBeInTheDocument());
    expect(items(placesList())).toHaveLength(10);
  });
});
