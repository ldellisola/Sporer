import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import lisbonFixture from "../../e2e/fixtures/trip-2026-09-12.json";
import type { TripDay, TripResponse } from "../api/types";
import { TripPanel } from "./TripPanel";

const LISBON = lisbonFixture as TripResponse; // 2026-09-12: 2 flights, 2 cities, 9 places, 169 km on the ground, five days

type Answer = TripResponse | (() => Response | Promise<Response>);

/** Answers `/api/trips/{id}` from `trips` (a trip, or a function that answers); anything else is a 404. Returns the paths asked for. */
function stubApi(trips: Record<string, Answer>): string[] {
  const paths: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string) => {
      paths.push(path);
      const answer = trips[path.split("/").pop()!];
      if (answer === undefined) return new Response("{}", { status: 404 });
      return typeof answer === "function" ? answer() : Response.json(answer);
    }),
  );
  return paths;
}

const client = (): QueryClient => new QueryClient({ defaultOptions: { queries: { retry: false } } });
const panel = (queries: QueryClient, id: string): ReactElement => (
  <QueryClientProvider client={queries}>
    <TripPanel id={id} />
  </QueryClientProvider>
);

function mount(id = "2026-09-12") {
  const queries = client();
  const view = render(panel(queries, id));
  return { client: queries, show: (next: string) => view.rerender(panel(queries, next)), ...view };
}

const days = () => within(screen.getByRole("list", { name: "Day by day" })).getAllByRole("listitem");
const dayButton = (item: HTMLElement) => within(item).getByRole("button");

/** What a row of the days shows as text, a piece at a time: the glyph that stands for a word is hidden from the reader and so is not text of the row. */
const textsOf = (button: HTMLElement): string[] =>
  [...button.querySelectorAll("span")]
    .filter((span) => span.querySelector("span") === null && span.closest('[aria-hidden="true"]') === null)
    .map((span) => span.textContent ?? "");

beforeEach(() => {
  window.history.replaceState(null, "", "/trip/2026-09-12");
});

describe("TripPanel", () => {
  test("TripPanel_shows_stats_and_days_and_opens_a_day", async () => {
    const paths = stubApi({ "2026-09-12": LISBON });

    mount();

    // The figures of the trip, as chips: its flights, its cities, its places and the distance on the ground (a flight is not on it).
    expect(await screen.findByText("2 flights")).toBeInTheDocument();
    expect(screen.getByText("2 cities")).toBeInTheDocument();
    expect(screen.getByText("9 places")).toBeInTheDocument();
    expect(screen.getByText("169 km on the ground")).toBeInTheDocument();
    expect(screen.queryByText("Ongoing")).not.toBeInTheDocument(); // it came home
    // A row for each day, in the order the API has them: the day, where it was spent, a few places, and the distance on the ground.
    expect(screen.getByRole("heading", { level: 2, name: "Day by day" })).toBeInTheDocument();
    const rows = days();
    expect(rows).toHaveLength(5);
    expect(rows.map((row) => textsOf(dayButton(row)))).toEqual([
      ["Sat 12 Sep", "Oslo → Lisbon", "Oslo Airport, Lisbon Airport", "55.7 km", "1"],
      ["Sun 13 Sep", "Lisbon", "Alfama Viewpoint, Time Out Market", "6.8 km"],
      ["Mon 14 Sep", "Lisbon", "Belém Tower, LX Factory, Pastéis de Belém", "9.1 km"],
      ["Tue 15 Sep", "Lisbon → Sintra", "Pena Palace, Quinta da Regaleira", "38.5 km"],
      ["Wed 16 Sep", "Sintra → Oslo", "Lisbon Airport, Oslo Airport", "59.2 km", "1"],
    ]);
    expect(paths).toEqual(["/api/trips/2026-09-12"]);

    fireEvent.click(dayButton(rows[1]!)); // a day opens as the Day view

    expect(window.location.pathname).toBe("/day/2026-09-13");
  });

  test("TripPanel_names_each_day_by_what_it_shows_and_says_the_flights_in_words", async () => {
    // Label in name: someone who says what they read ("Lisbon → Sintra", "38.5 km") reaches the row that has it; the plane is a picture,
    // and what it stands for is said in words.
    stubApi({ "2026-09-12": LISBON });
    mount();
    await screen.findByRole("list", { name: "Day by day" });

    const buttons = days().map(dayButton);

    expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual([
      "Open Sat 12 Sep, Oslo → Lisbon, Oslo Airport, Lisbon Airport, 55.7 km, 1 flight",
      "Open Sun 13 Sep, Lisbon, Alfama Viewpoint, Time Out Market, 6.8 km",
      "Open Mon 14 Sep, Lisbon, Belém Tower, LX Factory, Pastéis de Belém, 9.1 km",
      "Open Tue 15 Sep, Lisbon → Sintra, Pena Palace, Quinta da Regaleira, 38.5 km",
      "Open Wed 16 Sep, Sintra → Oslo, Lisbon Airport, Oslo Airport, 59.2 km, 1 flight",
    ]);
    for (const button of buttons) {
      const name = button.getAttribute("aria-label")!;
      expect(textsOf(button).length).toBeGreaterThanOrEqual(4);
      for (const text of textsOf(button)) expect(name, text).toContain(text);
    }
    // The glyph is hidden from the reader (the name says "1 flight"), and says what it is to the pointer.
    const plane = buttons[0]!.querySelector('[aria-hidden="true"]')!;
    expect(plane).toHaveTextContent("✈");
    expect(buttons[0]!.querySelectorAll('[aria-hidden="true"]')).toHaveLength(1);
    expect(buttons[1]!.querySelector('[aria-hidden="true"]')).toBeNull(); // no flight, no plane
    expect(screen.getAllByTitle("1 flight")).toHaveLength(2);
  });

  test("TripPanel_says_two_flights_in_the_plural_and_shows_highlights_only_when_there_are_some", async () => {
    const quiet: TripDay[] = [
      { date: "2026-09-12", description: "Lisbon", highlights: [], groundDistanceMeters: 0, flights: 2 },
      { date: "2026-09-13", description: "Lisbon", highlights: ["Alfama Viewpoint"], groundDistanceMeters: 850, flights: 0 },
    ];
    stubApi({ "2026-09-12": { ...LISBON, days: quiet } });
    mount();
    await screen.findByRole("list", { name: "Day by day" });

    const [first, second] = days().map(dayButton);

    expect(textsOf(first!)).toEqual(["Sat 12 Sep", "Lisbon", "0 m", "2"]); // no line for the places there are none of
    expect(first).toHaveAccessibleName("Open Sat 12 Sep, Lisbon, 0 m, 2 flights"); // and no empty piece in the name
    expect(textsOf(second!)).toEqual(["Sun 13 Sep", "Lisbon", "Alfama Viewpoint", "850 m"]);
    expect(second).toHaveAccessibleName("Open Sun 13 Sep, Lisbon, Alfama Viewpoint, 850 m");
  });

  test("TripPanel_shows_that_a_trip_is_ongoing_and_says_one_flight_or_city_in_the_singular", async () => {
    const ongoing: TripResponse = {
      ...LISBON,
      ongoing: true,
      end: null,
      localEndDate: "2026-09-17",
      stats: { flights: 1, cities: 1, places: 1, groundDistanceMeters: 850 },
    };
    stubApi({ "2026-09-12": ongoing });

    mount();

    expect(await screen.findByText("Ongoing")).toBeInTheDocument();
    expect(screen.getByText("1 flight")).toBeInTheDocument();
    expect(screen.getByText("1 city")).toBeInTheDocument();
    expect(screen.getByText("1 place")).toBeInTheDocument();
    expect(screen.getByText("850 m on the ground")).toBeInTheDocument();
  });

  test("TripPanel_says_a_trip_with_no_day_has_none_to_show", async () => {
    stubApi({ "2026-09-12": { ...LISBON, days: [], moves: [], stats: { flights: 0, cities: 0, places: 0, groundDistanceMeters: 0 } } });

    mount();

    expect(await screen.findByText("No days to show for this trip")).toBeInTheDocument();
    expect(screen.getByText("0 flights")).toBeInTheDocument(); // the figures are there, as for any trip
    expect(screen.getByText("0 cities")).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Day by day" })).not.toBeInTheDocument();
  });
});

describe("TripPanel a trip that is gone", () => {
  test("TripPanel_trip_that_no_longer_exists", async () => {
    const paths = stubApi({}); // a 404

    mount("2026-01-01");

    expect(await screen.findByText("This trip no longer exists")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument(); // asking again cannot help
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Day by day" })).not.toBeInTheDocument();
    expect(paths).toEqual(["/api/trips/2026-01-01"]);

    fireEvent.click(screen.getByRole("button", { name: "See all trips" })); // the way out is the list

    expect(window.location.pathname).toBe("/trips");
  });

  test("TripPanel_takes_a_404_that_comes_on_a_refetch_for_what_it_is", async () => {
    // Deleted or merged away since it was looked at: what the panel showed is of a trip that is not there now, and is not kept under the message.
    const answers: Record<string, Answer> = { "2026-09-12": LISBON };
    stubApi(answers);
    const { client: queries } = mount();
    await screen.findByRole("list", { name: "Day by day" });

    answers["2026-09-12"] = () => new Response("{}", { status: 404 });
    await act(async () => {
      await queries.refetchQueries({ queryKey: ["trip", "2026-09-12"] });
    });

    expect(await screen.findByText("This trip no longer exists")).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Day by day" })).not.toBeInTheDocument();
    expect(screen.queryByText("2 flights")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "See all trips" })).toBeInTheDocument();
  });
});

describe("TripPanel states", () => {
  test("TripPanel_says_it_is_loading", () => {
    stubApi({ "2026-09-12": () => new Promise<Response>(() => undefined) });

    mount();

    expect(screen.getByText("Loading…")).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Day by day" })).not.toBeInTheDocument();
    expect(screen.queryByText("This trip no longer exists")).not.toBeInTheDocument();
  });

  test("TripPanel_shows_an_error_with_a_retry_that_asks_again", async () => {
    let failing = true;
    const paths = stubApi({ "2026-09-12": () => (failing ? new Response("{}", { status: 500 }) : Response.json(LISBON)) });

    mount();

    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't load — Retry");
    expect(screen.queryByText("This trip no longer exists")).not.toBeInTheDocument(); // a failure is not a 404
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Day by day" })).not.toBeInTheDocument();

    failing = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByRole("list", { name: "Day by day" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(paths).toEqual(["/api/trips/2026-09-12", "/api/trips/2026-09-12"]);
  });

  test("TripPanel_keeps_the_trip_under_an_error_of_a_refetch_and_its_retry", async () => {
    const answers: Record<string, Answer> = { "2026-09-12": LISBON };
    stubApi(answers);
    const { client: queries } = mount();
    await screen.findByRole("list", { name: "Day by day" });

    answers["2026-09-12"] = () => new Response("{}", { status: 500 });
    await act(async () => {
      await queries.refetchQueries({ queryKey: ["trip", "2026-09-12"] });
    });

    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't load — Retry");
    expect(days()).toHaveLength(5); // an error never leaves a blank screen
    expect(screen.getByText("2 flights")).toBeInTheDocument();

    answers["2026-09-12"] = LISBON;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(days()).toHaveLength(5);
  });

  test("TripPanel_shows_nothing_of_another_trip_under_the_one_that_loads", async () => {
    // Another trip's days under this trip's name would be wrong, not just old: what is kept for an error is kept for the trip it is of.
    const never = () => new Promise<Response>(() => undefined);
    stubApi({ "2026-09-12": LISBON, "2026-08-01": never });
    const { show } = mount("2026-09-12");
    await screen.findByRole("list", { name: "Day by day" });

    show("2026-08-01"); // stepped to the older trip, which has not come

    expect(screen.getByText("Loading…")).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Day by day" })).not.toBeInTheDocument();
    expect(screen.queryByText("2 flights")).not.toBeInTheDocument();
  });
});
