import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { PlaceResponse } from "../api/types";
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
