import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { DayResponse, DaySegment, LonLat, MoveSegment, PlaceRef, StaySegment } from "../api/types";
import { dayGeoJson, placePoint } from "../map/layers";
import flightDay from "../../e2e/fixtures/day-oslo-new-york.json";
import { DayPanel } from "./DayPanel";

// The day of the fixture: from Oslo (on UTC+2 that day) to New York (UTC-4), the way the API would send it.
const FLIGHT_DAY = flightDay as DayResponse;

type Answer = (path: string) => Response | Promise<Response>;

/** Answers `/api/day/{date}` from `days` (a day, or a function that answers); returns the paths asked for. */
function stubApi(days: Record<string, DayResponse | Answer>): string[] {
  const paths: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string) => {
      paths.push(path);
      const answer = days[path.split("/").pop()!];
      if (answer === undefined) return new Response("{}", { status: 404 });
      return typeof answer === "function" ? answer(path) : Response.json(answer);
    }),
  );
  return paths;
}

function mount(date: string) {
  const onFocus = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ui = (shown: string) => (
    <QueryClientProvider client={client}>
      <DayPanel date={shown} onFocus={onFocus} />
    </QueryClientProvider>
  );
  const view = render(ui(date));
  return { onFocus, client, show: (next: string) => view.rerender(ui(next)) };
}

const rows = () => within(screen.getByRole("list")).getAllByRole("listitem");

/** The text of each part of a row, left to right, as `["1", "Home", "until 08:32", "11h 22m"]`. */
const parts = (row: HTMLElement): string[] =>
  [...row.querySelectorAll("span, button")].map((part) => part.textContent ?? "").filter((text) => text !== "");

// --- Building days ---

const WHEN = { start: "2026-10-22T08:00:00Z", end: "2026-10-22T09:00:00Z", startTimeZone: "Europe/Oslo", endTimeZone: "Europe/Oslo" };

const place = (id: number, name: string | null, lon: number, lat: number): PlaceRef => ({ id, name, city: null, country: null, lat, lon });
const HOME = place(1, "Home", 10.0, 59.0);
const CAFE = place(2, "Café", 10.1, 59.1);

function stay(id: number, at: PlaceRef | null, when: Partial<StaySegment> = {}): StaySegment {
  return { id, kind: "stay", ...WHEN, place: at, ...when };
}

function move(id: number, mode: MoveSegment["mode"], geometry: LonLat[], when: Partial<MoveSegment> = {}): MoveSegment {
  return { id, kind: "move", ...WHEN, mode, distanceMeters: 1000, geometry, ...when };
}

function day(segments: DaySegment[], over: Partial<DayResponse> = {}): DayResponse {
  const places = new Set(segments.flatMap((segment) => (segment.kind === "stay" && segment.place !== null ? [segment.place.id] : [])));
  return {
    date: "2026-10-22",
    timeZone: "Europe/Oslo",
    state: "done",
    summary: { places: places.size, distanceMeters: 0, movingSeconds: 0 },
    segments,
    ...over,
  };
}

beforeEach(() => {
  window.history.replaceState(null, "", "/day/2026-10-22");
});

afterEach(() => {
  vi.useRealTimers();
});

describe("DayPanel", () => {
  test("DayPanel_renders_rows_in_order_with_zone_times", async () => {
    stubApi({ "2026-10-22": FLIGHT_DAY });

    mount("2026-10-22");

    // The summary the API gives, as chips.
    expect(await screen.findByText("5 places")).toBeInTheDocument();
    expect(screen.getByText("5,952 km")).toBeInTheDocument();
    expect(screen.getByText("9h 13m moving")).toBeInTheDocument();
    expect(screen.queryByText("Updating…")).not.toBeInTheDocument();

    // Stays and moves in the order of the day, every time on the clock of the zone it happened in: Oslo is UTC+2 that day and
    // New York UTC-4, and the machine this runs on is neither. The unnamed place has a number, and the gap none.
    expect(rows().map(parts)).toEqual([
      ["1", "Home", "until 08:32", "11h 22m"], // it began the evening before
      ["Walk · 1.1 km", "14m"],
      ["2", "Café", "08:46 – 09:10", "24m"],
      ["Cycle · 3.4 km", "13m"],
      ["3", "Office", "09:23 – 11:41", "2h 18m"],
      ["Drive · 47.8 km", "41m"],
      ["4", "Unnamed place", "12:22 – 12:50", "28m"],
      ["Flight · 5,900 km", "8h 5m"],
      ["No data", "45m"],
      ["5", "Hotel Midtown", "from 15:40", "17h 20m"], // 19:40Z in New York, and it runs on into the next day
    ]);
  });

  test("DayPanel_draws_each_move_with_a_bar_in_the_colour_of_its_mode", async () => {
    const extra = move(120, null, [[10, 59], [10.1, 59.1]], { start: "2026-10-23T13:00:00Z", end: "2026-10-23T13:10:00Z" });
    stubApi({ "2026-10-22": { ...FLIGHT_DAY, segments: [...FLIGHT_DAY.segments, extra] } });
    mount("2026-10-22");
    await screen.findByText("5 places");

    const moves = rows().filter((row) => row.querySelector(".bar") !== null);

    // A move whose mode the server could not tell is a "Move", in grey.
    expect(moves.map((row) => parts(row)[0])).toEqual(["Walk · 1.1 km", "Cycle · 3.4 km", "Drive · 47.8 km", "Flight · 5,900 km", "Move · 1.0 km"]);
    const colours = ["#34C759", "#30B0C7", "#007AFF", "#FF9500", "#8E8E93"]; // the colours of the routes on the map
    moves.forEach((row, i) => expect(row.querySelector(".bar")).toHaveStyle({ backgroundColor: colours[i]! }));
  });

  test("DayPanel_shows_segments_and_updating_note_while_pending", async () => {
    stubApi({ "2026-10-22": { ...FLIGHT_DAY, state: "pending" } });

    mount("2026-10-22");

    expect(await screen.findByText("Updating…")).toBeInTheDocument();
    expect(rows()).toHaveLength(10); // what there is of the day is shown, with the note
    expect(screen.getByText("5 places")).toBeInTheDocument();
  });

  test("DayPanel_empty_day_message", async () => {
    stubApi({ "2026-10-22": day([]) });

    mount("2026-10-22");

    expect(await screen.findByText("No data for this day")).toBeInTheDocument();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
    expect(screen.queryByText(/places?$/)).not.toBeInTheDocument(); // chips that say 0 of everything would be noise
    expect(screen.queryByText("Updating…")).not.toBeInTheDocument();
  });

  test("DayPanel_empty_day_that_is_still_being_processed_says_so", async () => {
    stubApi({ "2026-10-22": day([], { state: "pending" }) });

    mount("2026-10-22");

    expect(await screen.findByText("No data for this day")).toBeInTheDocument();
    expect(screen.getByText("Updating…")).toBeInTheDocument();
  });

  test("DayPanel_says_loading_until_the_first_day_arrives", async () => {
    let release: (response: Response) => void = () => undefined;
    stubApi({ "2026-10-22": () => new Promise<Response>((resolve) => (release = resolve)) });

    mount("2026-10-22");
    expect(screen.getByText("Loading…")).toBeInTheDocument();
    expect(screen.queryByText("No data for this day")).not.toBeInTheDocument();

    release(Response.json(FLIGHT_DAY));

    expect(await screen.findByText("5 places")).toBeInTheDocument();
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
  });

  test("DayPanel_shows_an_error_with_a_retry_and_no_rows_when_the_first_day_fails", async () => {
    let failing = true;
    stubApi({ "2026-10-22": () => (failing ? new Response("{}", { status: 500 }) : Response.json(day([stay(1, HOME)]))) });

    mount("2026-10-22");

    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't load — Retry");
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument();

    failing = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByRole("list")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  test("DayPanel_keeps_the_previous_day_shown_and_marked_busy_while_the_next_loads", async () => {
    let release: (response: Response) => void = () => undefined;
    stubApi({
      "2026-10-22": FLIGHT_DAY,
      "2026-10-23": () => new Promise<Response>((resolve) => (release = resolve)),
    });
    const { show } = mount("2026-10-22");
    await screen.findByText("5 places");
    expect(document.querySelector("[aria-busy]")).toHaveAttribute("aria-busy", "false");

    show("2026-10-23");

    expect(screen.getByText("5 places")).toBeInTheDocument(); // the day that was shown stays
    expect(document.querySelector("[aria-busy]")).toHaveAttribute("aria-busy", "true"); // and says it is not the one asked for
    expect(screen.queryByText("No data for this day")).not.toBeInTheDocument();

    release(Response.json(day([stay(1, HOME)], { date: "2026-10-23" })));

    expect(await screen.findByText("1 place")).toBeInTheDocument();
    expect(document.querySelector("[aria-busy]")).toHaveAttribute("aria-busy", "false");
  });

  test("DayPanel_does_not_call_an_empty_day_of_another_date_the_empty_day_it_is_waiting_for", async () => {
    let release: (response: Response) => void = () => undefined;
    stubApi({
      "2026-10-22": day([]),
      "2026-10-23": () => new Promise<Response>((resolve) => (release = resolve)),
    });
    const { show } = mount("2026-10-22");
    await screen.findByText("No data for this day");

    show("2026-10-23"); // the 22nd is empty, which says nothing of the 23rd

    expect(screen.queryByText("No data for this day")).not.toBeInTheDocument();
    release(Response.json(day([stay(1, HOME)], { date: "2026-10-23" })));
    expect(await screen.findByText("1 place")).toBeInTheDocument();
  });

  test("DayPanel_says_1_place_and_not_1_places", async () => {
    stubApi({ "2026-10-22": day([stay(1, HOME)], { summary: { places: 1, distanceMeters: 850, movingSeconds: 45 } }) });

    mount("2026-10-22");

    expect(await screen.findByText("1 place")).toBeInTheDocument();
    expect(screen.getByText("850 m")).toBeInTheDocument();
    expect(screen.getByText("45s moving")).toBeInTheDocument();
  });
});

describe("DayPanel numbers", () => {
  test("DayPanel_rows_say_what_the_pins_say", async () => {
    // Home three times with a café between, and a stay at no place: the map has one pin for home and one for the café.
    const shown = day([stay(1, HOME), stay(3, CAFE), stay(4, null), stay(5, HOME), stay(6, CAFE), stay(7, HOME)]);
    stubApi({ "2026-10-22": shown });

    mount("2026-10-22");
    await screen.findByRole("list");

    // The numbers on the rows, gathered by the place they are at...
    const byName = new Map<string, string[]>();
    for (const row of rows()) {
      const [first, name] = parts(row);
      if (first !== undefined && /^\d+$/.test(first) && name !== undefined) byName.set(name, [...(byName.get(name) ?? []), first]);
    }
    // ...are the labels of the pins that the map is given for the same day.
    const labels = new Map(dayGeoJson(shown).stops.features.map((feature) => [feature.properties.name, feature.properties.label]));
    expect(labels).toEqual(new Map([["Home", "1 · 3 · 5"], ["Café", "2 · 4"]])); // the stay at no place (the 3rd of 6) took no number
    expect(new Map([...byName].map(([name, numbers]) => [name, numbers.join(" · ")]))).toEqual(labels);
  });

  test("DayPanel_gives_a_stay_at_no_place_no_number_and_no_buttons", async () => {
    stubApi({ "2026-10-22": day([stay(1, null), stay(2, HOME)]) });

    mount("2026-10-22");
    await screen.findByRole("list");

    const [nowhere, home] = rows();
    expect(parts(nowhere!)).toEqual(["Unnamed place", "10:00 – 11:00", "1h 0m"]);
    expect(within(nowhere!).queryByRole("button")).not.toBeInTheDocument(); // there is nowhere on the map to take the map to
    expect(parts(home!)).toEqual(["1", "Home", "10:00 – 11:00", "1h 0m"]); // the first number is the first pin's
  });
});

describe("DayPanel times", () => {
  // 2026-10-22 in Oslo (UTC+2) runs from 2026-10-21T22:00Z up to 2026-10-22T22:00Z.
  const OSLO = { startTimeZone: "Europe/Oslo", endTimeZone: "Europe/Oslo" };
  const show = async (segments: DaySegment[], over: Partial<DayResponse> = {}) => {
    stubApi({ "2026-10-22": day(segments, over) });
    mount("2026-10-22");
    await screen.findByRole("list");
  };

  test("DayPanel_says_until_for_a_stay_that_began_before_the_day_and_gives_both_times_otherwise", async () => {
    await show([
      stay(1, HOME, { ...OSLO, start: "2026-10-21T21:59:00Z", end: "2026-10-22T06:00:00Z" }), // began at 23:59 on the 21st
      move(2, "walk", [[10, 59], [10.1, 59.1]], { ...OSLO, start: "2026-10-22T06:00:00Z", end: "2026-10-22T06:10:00Z" }),
      stay(3, CAFE, { ...OSLO, start: "2026-10-22T06:10:00Z", end: "2026-10-22T21:59:00Z" }), // ends at 23:59 on the 22nd
    ]);

    expect(rows().map((row) => parts(row)[2])).toEqual(["until 08:00", undefined, "08:10 – 23:59"]);
  });

  test("DayPanel_a_stay_that_began_at_midnight_began_on_the_day", async () => {
    await show([stay(1, HOME, { ...OSLO, start: "2026-10-21T22:00:00Z", end: "2026-10-22T21:59:00Z" })]); // from 00:00 on the 22nd

    expect(parts(rows()[0]!)).toEqual(["1", "Home", "00:00 – 23:59", "23h 59m"]);
  });

  test("DayPanel_says_from_for_a_stay_that_runs_past_the_day_and_one_that_ends_at_midnight_does", async () => {
    await show([
      stay(1, HOME, { ...OSLO, start: "2026-10-22T06:00:00Z", end: "2026-10-22T10:00:00Z" }),
      stay(2, CAFE, { ...OSLO, start: "2026-10-22T10:00:00Z", end: "2026-10-22T22:00:00Z" }), // ends at 00:00 on the 23rd
    ]);

    expect(rows().map((row) => parts(row)[2])).toEqual(["08:00 – 12:00", "from 12:00"]);
  });

  test("DayPanel_says_all_day_for_a_stay_that_began_before_the_day_and_runs_past_it", async () => {
    await show([stay(1, HOME, { ...OSLO, start: "2026-10-20T10:00:00Z", end: "2026-10-24T10:00:00Z" })]);

    expect(parts(rows()[0]!)).toEqual(["1", "Home", "All day", "96h 0m"]);
  });

  test("DayPanel_reads_each_end_of_a_stay_in_the_zone_it_is_in", async () => {
    // A stay that ends in another zone than it began in (the clocks of the stay are two: the segment says both).
    await show([stay(1, HOME, { start: "2026-10-22T06:00:00Z", end: "2026-10-22T10:00:00Z", startTimeZone: "Europe/Oslo", endTimeZone: "America/New_York" })]);

    expect(parts(rows()[0]!)[2]).toBe("08:00 – 06:00");
  });

  test("DayPanel_says_from_for_the_last_stay_of_today_which_is_where_the_owner_still_is", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-22T14:00:00Z")); // 16:00 in Oslo on the 22nd: the day is today
    await show([
      stay(1, HOME, { ...OSLO, start: "2026-10-22T06:00:00Z", end: "2026-10-22T07:00:00Z" }),
      move(2, "drive", [[10, 59], [10.1, 59.1]], { ...OSLO, start: "2026-10-22T07:00:00Z", end: "2026-10-22T07:20:00Z" }),
      stay(3, CAFE, { ...OSLO, start: "2026-10-22T07:20:00Z", end: "2026-10-22T13:55:00Z" }),
    ]);

    // The first stay is over; the last has no end that is known yet.
    expect(rows().map((row) => parts(row)[2])).toEqual(["08:00 – 09:00", undefined, "from 09:20"]);
  });

  test("DayPanel_ongoing_is_the_last_stay_of_today_and_nothing_else", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-22T14:00:00Z"));
    stubApi({
      "2026-10-21": day([stay(1, HOME, { ...OSLO, start: "2026-10-21T06:00:00Z", end: "2026-10-21T07:00:00Z" })], {
        date: "2026-10-21",
        summary: { places: 1, distanceMeters: 0, movingSeconds: 0 },
      }),
      "2026-10-22": day(
        [
          stay(1, HOME, { ...OSLO, start: "2026-10-22T06:00:00Z", end: "2026-10-22T07:00:00Z" }),
          move(2, "walk", [[10, 59], [10.1, 59.1]], { ...OSLO, start: "2026-10-22T07:00:00Z", end: "2026-10-22T07:20:00Z" }),
        ],
        { summary: { places: 2, distanceMeters: 0, movingSeconds: 0 } },
      ),
    });
    const view = mount("2026-10-22");
    await screen.findByText("2 places");
    expect(parts(rows()[0]!)[2]).toBe("08:00 – 09:00"); // today goes on with a move: the stay before it is over

    view.show("2026-10-21");
    await screen.findByText("1 place");
    expect(parts(rows()[0]!)[2]).toBe("08:00 – 09:00"); // yesterday's last stay is over, as it is for any day that is not today
  });
});

describe("DayPanel taps", () => {
  const FLIGHT_STAY_CAFE = FLIGHT_DAY.segments[2] as StaySegment;
  const FLIGHT_WALK = FLIGHT_DAY.segments[1] as MoveSegment;

  test("DayPanel_row_tap_requests_fit_and_place_tap_navigates", async () => {
    stubApi({ "2026-10-22": FLIGHT_DAY });
    const { onFocus } = mount("2026-10-22");
    await screen.findByRole("list");

    // A stay: the map is taken to its place.
    fireEvent.click(screen.getByRole("button", { name: "Show Café on the map" }));
    expect(onFocus).toHaveBeenCalledTimes(1);
    expect(onFocus).toHaveBeenLastCalledWith([placePoint(FLIGHT_STAY_CAFE.place!)]);
    expect(onFocus.mock.lastCall![0]).toEqual([
      { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [10.764, 59.914] } },
    ]);

    // A move: the map is taken to its route, the line the map draws for it.
    fireEvent.click(screen.getByRole("button", { name: "Show the walk on the map" }));
    expect(onFocus).toHaveBeenCalledTimes(2);
    expect(onFocus.mock.lastCall![0]).toEqual([
      { type: "Feature", properties: { id: FLIGHT_WALK.id, mode: "walk" }, geometry: { type: "LineString", coordinates: FLIGHT_WALK.geometry } },
    ]);

    // The name of a place opens the place, and the row behind it is not tapped with it.
    fireEvent.click(screen.getByRole("button", { name: "Café" }));
    expect(window.location.pathname).toBe("/place/2");
    expect(onFocus).toHaveBeenCalledTimes(2);
  });

  test("DayPanel_asks_again_for_the_same_row_with_a_new_array_each_time", async () => {
    stubApi({ "2026-10-22": FLIGHT_DAY });
    const { onFocus } = mount("2026-10-22");
    await screen.findByRole("list");

    fireEvent.click(screen.getByRole("button", { name: "Show Office on the map" }));
    fireEvent.click(screen.getByRole("button", { name: "Show Office on the map" }));

    expect(onFocus).toHaveBeenCalledTimes(2);
    expect(onFocus.mock.calls[1]![0]).toEqual(onFocus.mock.calls[0]![0]);
    expect(onFocus.mock.calls[1]![0]).not.toBe(onFocus.mock.calls[0]![0]); // so that the map, which moves for a new array, moves again
  });

  test("DayPanel_rows_and_names_are_buttons_the_keyboard_reaches_and_the_name_is_not_inside_the_row_button", async () => {
    stubApi({ "2026-10-22": FLIGHT_DAY });
    mount("2026-10-22");
    await screen.findByRole("list");

    const row = screen.getByRole("button", { name: "Show Café on the map" });
    const name = screen.getByRole("button", { name: "Café" });

    expect(row.tagName).toBe("BUTTON");
    expect(row).toHaveAttribute("type", "button");
    expect(name.tagName).toBe("BUTTON");
    expect(row).not.toContainElement(name); // a button in a button is not HTML, and a tap on one would be a tap on both
    expect(name).not.toContainElement(row);
    expect(row.closest("li")).toBe(name.closest("li")); // but they are one row
    // Every stay with a place and every move with a line has one; a gap has none.
    expect(screen.getAllByRole("button", { name: /^Show .* on the map$/ })).toHaveLength(9); // 5 stays and 4 moves, in 10 rows
    expect(within(rows()[8]!).queryByRole("button")).not.toBeInTheDocument();
  });

  test("DayPanel_names_a_place_that_has_no_name_in_its_button_too", async () => {
    stubApi({ "2026-10-22": FLIGHT_DAY });
    mount("2026-10-22");
    await screen.findByRole("list");

    fireEvent.click(screen.getByRole("button", { name: "Unnamed place" })); // it is a place, and its page has its position

    expect(window.location.pathname).toBe("/place/4");
  });

  test("DayPanel_gives_a_move_without_a_line_no_button", async () => {
    stubApi({ "2026-10-22": day([stay(1, HOME), move(2, "walk", [[10, 59]]), stay(3, CAFE)]) });
    mount("2026-10-22");
    await screen.findByRole("list");

    expect(within(rows()[1]!).queryByRole("button")).not.toBeInTheDocument(); // one point is not a line, and the map draws none
    expect(parts(rows()[1]!)[0]).toBe("Walk · 1.0 km");
  });
});
