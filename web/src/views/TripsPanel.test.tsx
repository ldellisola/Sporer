import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import tripsFixture from "../../e2e/fixtures/trips.json";
import type { TripListItem, TripsResponse } from "../api/types";
import { TripsPanel } from "./TripsPanel";

const TRIPS = tripsFixture as TripsResponse; // newest first: 2026-10-22 (New York, ongoing), 2026-09-12 (Lisbon & Sintra), 2026-08-01 (Copenhagen)

/** Answers `/api/trips` with `answer` (a response, or a function that gives one); returns the paths asked for. */
function stubApi(answer: TripsResponse | (() => Response | Promise<Response>)): string[] {
  const paths: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string) => {
      paths.push(path);
      return typeof answer === "function" ? answer() : Response.json(answer);
    }),
  );
  return paths;
}

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <TripsPanel />
      </QueryClientProvider>,
    ),
  };
}

const list = () => screen.findByRole("list", { name: "Trips" });
const cards = (of: HTMLElement) => within(of).getAllByRole("listitem");
/** Every piece of text a card shows (the name, the chip, the dates, the nights, the cities), as the owner reads it: the picture says none. */
const textsOf = (button: HTMLElement): string[] =>
  [...button.querySelectorAll("span")].filter((span) => span.querySelector("span") === null).map((span) => span.textContent ?? "");

beforeEach(() => {
  window.history.replaceState(null, "", "/trips");
});

describe("TripsPanel", () => {
  test("TripsPanel_lists_cards_newest_first_and_opens_a_trip", async () => {
    stubApi(TRIPS);

    mount();

    expect(screen.getByRole("heading", { name: "Trips" })).toBeInTheDocument();
    const items = cards(await list());
    expect(items).toHaveLength(3);
    // Newest first, as the API has them: each card has the name, the dates the way a week's are written, the nights and the cities.
    expect(items.map((card) => within(card).getByRole("button").getAttribute("aria-label"))).toEqual([
      "Open New York, Ongoing, 22 – 24 Oct 2026 · 2 nights, New York",
      "Open Lisbon & Sintra, 12 – 16 Sep 2026 · 4 nights, Lisbon · Sintra",
      "Open Copenhagen, 1 – 3 Aug 2026 · 2 nights, Copenhagen",
    ]);
    const lisbon = items[1]!;
    expect(within(lisbon).getByText("Lisbon & Sintra")).toBeInTheDocument();
    expect(within(lisbon).getByText("12 – 16 Sep 2026 · 4 nights")).toBeInTheDocument(); // the dates and the nights, one line
    expect(within(lisbon).getByText("Lisbon · Sintra")).toBeInTheDocument();
    // The picture of where the trip went: its line, with a dot at each place it slept (home, Lisbon, Sintra, home).
    const thumbnail = lisbon.querySelector("svg")!;
    expect(thumbnail).toHaveAttribute("viewBox", "0 0 72 48");
    expect(thumbnail.querySelector("path")).not.toBeNull();
    expect(thumbnail.querySelectorAll("circle")).toHaveLength(2);

    fireEvent.click(within(lisbon).getByRole("button"));

    expect(window.location.pathname).toBe("/trip/2026-09-12");
  });

  test("TripsPanel_gives_every_card_a_name_that_holds_the_text_it_shows", async () => {
    // Label in name: someone who says what they read ("Lisbon & Sintra", "12 – 16 Sep 2026 · 4 nights") reaches the button that has it.
    stubApi(TRIPS);
    mount();

    const buttons = cards(await list()).map((card) => within(card).getByRole("button"));

    expect(buttons).toHaveLength(3);
    for (const [index, button] of buttons.entries()) {
      const name = button.getAttribute("aria-label")!;
      const trip = TRIPS.trips[index]!;
      expect(textsOf(button).length, trip.id).toBeGreaterThanOrEqual(3); // the name, the dates and the nights, the cities (and the chip)
      expect(textsOf(button), trip.id).toContain(trip.name);
      for (const text of textsOf(button)) expect(name, `${trip.id}: ${text}`).toContain(text);
    }
  });

  test("TripsPanel_names_every_card_with_its_dates_and_nights_exactly_as_they_are_shown", async () => {
    // The line is "12 – 16 Sep 2026 · 4 nights", one string: a name that joined the two with a comma would hold neither the line nor what is read of it.
    stubApi(TRIPS);
    mount();

    const buttons = cards(await list()).map((card) => within(card).getByRole("button"));

    // The line is the first element whose whole text is the dates, a dot and the nights (however many spans it is made of).
    const lines = buttons.map((button) => [...button.querySelectorAll("span")].find((span) => /^\d.* · \d+ nights?$/.test(span.textContent ?? ""))?.textContent);
    expect(lines).toEqual(["22 – 24 Oct 2026 · 2 nights", "12 – 16 Sep 2026 · 4 nights", "1 – 3 Aug 2026 · 2 nights"]);
    for (const [index, button] of buttons.entries()) expect(button.getAttribute("aria-label"), TRIPS.trips[index]!.id).toContain(lines[index]!);
  });

  test("TripsPanel_shows_an_ongoing_trip", async () => {
    stubApi(TRIPS);
    mount();

    const [newest, ...others] = cards(await list());

    expect(within(newest!).getByText("Ongoing")).toBeInTheDocument();
    expect(within(newest!).getByRole("button", { name: /Ongoing/ })).toBeInTheDocument(); // the chip is text of the button, so its name has it
    for (const card of others) expect(within(card).queryByText("Ongoing")).not.toBeInTheDocument();
    expect(screen.getAllByText("Ongoing")).toHaveLength(1);
  });

  test("TripsPanel_writes_one_night_in_the_singular_and_leaves_out_cities_that_are_not_known", async () => {
    const lone: TripListItem = {
      ...TRIPS.trips[2]!,
      id: "2026-07-04",
      name: "Trip",
      firstNight: "2026-07-04",
      lastNight: "2026-07-04",
      nights: 1,
      localStartDate: "2026-07-04",
      localEndDate: "2026-07-05",
      cities: [],
      thumbnail: [],
    };
    stubApi({ trips: [lone] });
    mount();

    const [card] = cards(await list());

    expect(within(card!).getByText("4 – 5 Jul 2026 · 1 night")).toBeInTheDocument();
    expect(within(card!).getByRole("button")).toHaveAccessibleName("Open Trip, 4 – 5 Jul 2026 · 1 night");
    expect(card!.querySelector("svg circle")).not.toBeNull(); // a trip with no line is a dot, and still has its picture
  });
});

describe("TripsPanel states", () => {
  test("TripsPanel_empty_loading_and_error_states", async () => {
    // Loading: the heading is there, and the list is on its way.
    let release: (response: Response) => void = () => undefined;
    stubApi(() => new Promise<Response>((resolve) => (release = resolve)));
    const first = mount();
    expect(screen.getByRole("heading", { name: "Trips" })).toBeInTheDocument();
    expect(screen.getByText("Loading…")).toBeInTheDocument();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();

    // Empty: the answer that has no trips says what a trip is.
    release(Response.json({ trips: [] } satisfies TripsResponse));
    expect(await screen.findByText("No trips yet. A trip is a night spent 50 km or more from home.")).toBeInTheDocument();
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
    first.unmount();

    // Error: it says so, with the way to try again, and nothing else; Retry brings the list.
    let failing = true;
    stubApi(() => (failing ? new Response("{}", { status: 500 }) : Response.json(TRIPS)));
    mount();
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't load — Retry");
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument();

    failing = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(cards(await list())).toHaveLength(3);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  test("TripsPanel_keeps_the_list_it_has_under_an_error_with_a_retry", async () => {
    let failing = false;
    stubApi(() => (failing ? new Response("{}", { status: 500 }) : Response.json(TRIPS)));
    const { client } = mount();
    await list();

    failing = true;
    await act(async () => {
      await client.refetchQueries({ queryKey: ["trips"] });
    });

    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't load — Retry");
    expect(cards(screen.getByRole("list", { name: "Trips" }))).toHaveLength(3); // an error never leaves a blank screen

    failing = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(cards(screen.getByRole("list", { name: "Trips" }))).toHaveLength(3);
  });
});
