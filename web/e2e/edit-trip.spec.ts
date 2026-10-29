import type { Locator, Page, Request } from "@playwright/test";
import type { DeletedTrip, TripListItem, TripResponse } from "../src/api/types";
import { expect, test } from "./base";
import lisbonTrip from "./fixtures/trip-2026-09-12.json" with { type: "json" };
import tripsFixture from "./fixtures/trips.json" with { type: "json" };
import { mockApi, type Overrides, type Reply } from "./mockApi";
import { sheetAtRest } from "./sheet";
import { fixTime } from "./today";

// The browser is in Oslo, so that "today" is a date that is the same wherever the test is run (see `fixToday`).
test.use({ timezoneId: "Europe/Oslo" });

/** Fixes today at Saturday 24 October, a date after every trip of the fixtures but the one that is still going on. */
const fixToday = (page: Page): Promise<void> => fixTime(page, "2026-10-24T08:00:00Z");

const isWide = (page: Page): boolean => page.viewportSize()!.width >= 900;
const details = (page: Page): Locator => page.getByRole(isWide(page) ? "complementary" : "region", { name: "Details" });
const grip = (page: Page): Locator => page.getByRole("button", { name: "Resize panel" });
const map = (page: Page): Locator => page.getByRole("region", { name: "Map view" });
const title = (page: Page): Locator => page.getByRole("heading", { level: 1 });

/** On a phone the sheet starts at its peek: bring it up to full, where all of the panel can be read and reached. */
async function openSheet(page: Page): Promise<void> {
  if (isWide(page)) return;
  for (let i = 0; i < 2 && (await details(page).getAttribute("data-snap")) !== "full"; i++) await grip(page).click();
  await expect(details(page)).toHaveAttribute("data-snap", "full");
  await sheetAtRest(page); // and has come up, so that a button in it is where a click will find it
}

/** What the server remembers of a trip: what the list serves, and the id that detection gave it, which is the key that restores it. */
interface Stored extends TripListItem {
  key: string;
  /** What the trip is called when the owner has not named it, and the dates it was detected with. */
  automatic: string;
  detected: { start: string; end: string };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `yyyy-MM-dd` and a number of days on: dates, as the server counts them, with no time of day to get in the way. */
function addDays(date: string, days: number): string {
  const moved = new Date(`${date}T00:00:00Z`);
  moved.setUTCDate(moved.getUTCDate() + days);
  return moved.toISOString().slice(0, 10);
}

/** "12 – 16 Sep 2026" for two dates of one month, as the server writes the label of a trip that was deleted (and the web writes a trip's dates). */
function span(from: string, to: string): string {
  const [year, month, first] = from.split("-").map(Number) as [number, number, number];
  const last = Number(to.slice(8));
  return `${first} – ${last} ${MONTHS[month - 1]} ${year}`;
}

/**
 * A server that keeps what was written to it, so that the trips list, the trip and the settings read it back as the real one would: the three
 * trips of the fixture, of which the Lisbon one has its days and moves. A trip that the owner re-dates has a new id (its first night), one that is
 * named has the name, and one that is deleted is on the list of the deleted, from where it comes back as it was. The nights of a trip are from its
 * start date to the night before its end date, and a trip may not share a night with another (409), as the real one says.
 */
function tripServer() {
  let trips: Stored[] = tripsFixture.trips.map((trip) => ({
    ...(trip as TripListItem),
    key: trip.id,
    automatic: trip.name,
    detected: { start: trip.localStartDate, end: trip.localEndDate },
  }));
  let deleted: (DeletedTrip & { trip: Stored })[] = [];

  const newestFirst = (list: Stored[]): Stored[] => [...list].sort((a, b) => b.id.localeCompare(a.id));
  const listed = ({ key: _key, automatic: _automatic, detected: _detected, ...item }: Stored): TripListItem => item;
  const idOf = (request: Request): string => new URL(request.url()).pathname.split("/").pop() ?? "";

  const errors = (field: string, message: string) => ({ statusCode: 400, message: "One or more errors occurred!", errors: { [field]: [message] } });
  const inRange = (date: string): boolean => date >= "1970-01-01" && date <= "2099-12-31";

  const overrides: Overrides = {
    trips: (): Reply => ({ json: { trips: newestFirst(trips).map(listed) } }),
    "trips/*": (request): Reply => {
      const trip = trips.find((candidate) => candidate.id === idOf(request));
      if (trip === undefined) return { status: 404, json: { title: "Not Found" } };
      const { thumbnail: _thumbnail, ...summary } = listed(trip);
      const page: TripResponse =
        trip.key === lisbonTrip.id
          ? ({ ...lisbonTrip, ...summary } as TripResponse)
          : { ...summary, stats: { flights: 0, cities: trip.cities.length, places: 0, groundDistanceMeters: 0 }, moves: [], days: [] };
      return { json: page };
    },
    "PUT trips/*": (request): Reply => {
      const trip = trips.find((candidate) => candidate.id === idOf(request));
      if (trip === undefined) return { status: 404, json: {} };
      const body = request.postDataJSON() as { name: string | null; startDate: string | null; endDate: string | null };
      const start = body.startDate ?? trip.detected.start;
      const end = body.endDate ?? trip.detected.end;
      if (!inRange(start)) return { status: 400, json: errors("startDate", "The start date must be from 1970-01-01 to 2099-12-31.") };
      if (!inRange(end)) return { status: 400, json: errors("endDate", "The end date must be from 1970-01-01 to 2099-12-31.") };
      if (start >= end) return { status: 400, json: errors("endDate", "The start date must be before the end date.") };
      const last = addDays(end, -1);
      const others = trips.filter((candidate) => candidate !== trip);
      if (others.some((other) => other.firstNight <= last && start <= other.lastNight)) {
        return { status: 409, json: errors("endDate", `The trip would have nights from ${start} to ${last}, and another trip has one of them.`) };
      }
      const name = body.name?.trim() ? body.name.trim() : null;
      Object.assign(trip, {
        id: start,
        name: name ?? trip.automatic,
        firstNight: start,
        lastNight: last,
        nights: (Date.parse(end) - Date.parse(start)) / 86_400_000,
        localStartDate: start,
        localEndDate: end,
        edited: name !== null || start !== trip.detected.start || end !== trip.detected.end,
      });
      return { json: { id: trip.id } };
    },
    "DELETE trips/*": (request): Reply => {
      const trip = trips.find((candidate) => candidate.id === idOf(request));
      if (trip === undefined) return { status: 404, json: {} };
      trips = trips.filter((candidate) => candidate !== trip);
      const label = `${trip.name} · ${span(trip.localStartDate, trip.localEndDate)}`;
      deleted = [{ key: trip.key, label, deletedAt: "2026-10-24T08:15:00Z", trip }, ...deleted];
      return { status: 204 };
    },
    "trips/deleted": (): Reply => ({ json: deleted.map(({ trip: _trip, ...entry }) => entry) }),
  };
  // A path has no wildcard in the middle (see mockApi): each trip of the fixture is restored by its own key.
  for (const { id } of tripsFixture.trips) {
    overrides[`POST trips/deleted/${id}/restore`] = (): Reply => {
      const found = deleted.find((entry) => entry.key === id);
      if (found === undefined) return { status: 404, json: {} };
      deleted = deleted.filter((entry) => entry !== found);
      trips = [...trips, found.trip];
      return { status: 204 };
    };
  }
  return overrides;
}

const LISBON = "Lisbon & Sintra";
const edit = (page: Page): Locator => details(page).getByRole("button", { name: "Edit", exact: true });
const nameField = (page: Page): Locator => details(page).getByRole("textbox", { name: "Name" });
const startField = (page: Page): Locator => details(page).getByLabel("Start date");
const endField = (page: Page): Locator => details(page).getByLabel("End date");
const save = (page: Page): Locator => details(page).getByRole("button", { name: "Save", exact: true });
const cards = (page: Page): Locator => details(page).getByRole("list", { name: "Trips" }).getByRole("button");

/** Opens the trip of the 12th of September, with the sheet up (on a phone) and the trip shown. */
async function openLisbon(page: Page, api: Overrides): Promise<Awaited<ReturnType<typeof mockApi>>> {
  await fixToday(page);
  const mocked = await mockApi(page, api);
  await page.goto("/trip/2026-09-12");
  await expect(map(page)).toHaveAttribute("data-map-state", "ready");
  await expect(title(page)).toHaveText(LISBON);
  await openSheet(page);
  await expect(edit(page)).toBeVisible();
  return mocked;
}

test("rename_a_trip_and_the_bar_the_list_and_the_trip_show_the_name_and_clearing_it_goes_back_to_the_automatic_one", async ({ page }) => {
  const api = await openLisbon(page, tripServer());

  await edit(page).click();

  // A trip the owner has not edited has no name of its own: the field is empty and shows the automatic one. The dates are the trip's.
  await expect(nameField(page)).toBeFocused();
  await expect(nameField(page)).toHaveValue("");
  await expect(nameField(page)).toHaveAttribute("placeholder", LISBON);
  await expect(startField(page)).toHaveValue("2026-09-12");
  await expect(endField(page)).toHaveValue("2026-09-16");
  await nameField(page).fill("  Portugal 2026 ");
  await save(page).click();

  await expect(title(page)).toHaveText("Portugal 2026");
  await expect(nameField(page)).toHaveCount(0);
  await expect(edit(page)).toBeFocused(); // the focus was in the form, which is gone
  expect(api.writes).toEqual([
    { method: "PUT", path: "/api/trips/2026-09-12", contentType: "application/json", body: { name: "Portugal 2026", startDate: "2026-09-12", endDate: "2026-09-16" } },
  ]);
  await expect(page).toHaveURL(/\/trip\/2026-09-12$/); // the id is the same: nowhere to go

  // The list has the name too (it was asked for again, and the trip is the same trip).
  await page.getByRole("button", { name: "Trips" }).click();
  await sheetAtRest(page);
  await expect(cards(page)).toHaveCount(3);
  await expect(cards(page).filter({ hasText: "Portugal 2026" })).toHaveCount(1);
  await expect(cards(page).filter({ hasText: LISBON })).toHaveCount(0);

  // The name is the field's now, and clearing it is the way back to the automatic one.
  await cards(page).filter({ hasText: "Portugal 2026" }).click();
  await expect(page).toHaveURL(/\/trip\/2026-09-12$/);
  await sheetAtRest(page);
  await edit(page).click();
  await expect(nameField(page)).toHaveValue("Portugal 2026");
  await expect(nameField(page)).toHaveAttribute("placeholder", "Automatic name");
  await nameField(page).fill("");
  await save(page).click();

  await expect(title(page)).toHaveText(LISBON);
  expect(api.writes.map((write) => write.body)).toEqual([
    { name: "Portugal 2026", startDate: "2026-09-12", endDate: "2026-09-16" },
    { name: null, startDate: "2026-09-12", endDate: "2026-09-16" },
  ]);
});

test("re_dating_a_trip_goes_to_the_trip_by_its_new_id_in_place_of_the_page_so_that_back_is_the_list", async ({ page }) => {
  await fixToday(page);
  const api = await mockApi(page, tripServer());
  await page.goto("/trips");
  await expect(map(page)).toHaveAttribute("data-map-state", "ready");
  await openSheet(page);
  await cards(page).filter({ hasText: LISBON }).click();
  await expect(page).toHaveURL(/\/trip\/2026-09-12$/);
  await expect(title(page)).toHaveText(LISBON);
  await sheetAtRest(page);

  await edit(page).click();
  await startField(page).fill("2026-09-10"); // two days before, which the trip's nights now include
  await endField(page).fill("2026-09-18");
  await save(page).click();

  // The id of a trip is its first night: it is another address now, and the page that had the old one is replaced by it.
  await expect(page).toHaveURL(/\/trip\/2026-09-10$/);
  await expect(title(page)).toHaveText(LISBON);
  await expect(page.getByText("10 – 18 Sep 2026")).toBeVisible();
  await expect(details(page).getByRole("list", { name: "Day by day" })).toBeVisible(); // the trip is there, under the new id
  await expect(details(page).getByText("This trip no longer exists")).toHaveCount(0);
  expect(api.writes.map((write) => write.body)).toEqual([{ name: null, startDate: "2026-09-10", endDate: "2026-09-18" }]);

  await page.goBack(); // not to /trip/2026-09-12, which is no trip now

  await expect(page).toHaveURL(/\/trips$/);
  await sheetAtRest(page);
  await expect(cards(page).filter({ hasText: "10 – 18 Sep 2026 · 8 nights" })).toHaveCount(1);
  await expect(cards(page)).toHaveCount(3);
});

test("a_trip_that_would_share_a_night_with_another_is_refused_in_the_words_of_the_server_with_no_retry_and_the_form_stays", async ({ page }) => {
  const api = await openLisbon(page, tripServer());
  await edit(page).click();
  await endField(page).fill("2026-10-25"); // the New York trip has the nights of the 22nd and the 23rd of October

  await save(page).click();

  const alert = details(page).getByRole("alert");
  await expect(alert).toHaveText("Could not save: The trip would have nights from 2026-09-12 to 2026-10-24, and another trip has one of them.");
  await expect(alert.getByRole("button")).toHaveCount(0); // sent again it is refused again
  await expect(endField(page)).toHaveValue("2026-10-25"); // the form is as it was, to be put right
  await expect(save(page)).toBeEnabled();
  await expect(details(page).getByRole("list", { name: "Day by day" })).toBeVisible(); // and the trip is under it

  await endField(page).fill("2026-09-20");
  await save(page).click();

  await expect(nameField(page)).toHaveCount(0);
  await expect(page.getByText("12 – 20 Sep 2026")).toBeVisible();
  expect(api.writes).toHaveLength(2);
});

test("dates_that_the_form_can_tell_are_wrong_are_not_sent_and_the_server_says_the_rest", async ({ page }) => {
  const api = await openLisbon(page, tripServer());
  await edit(page).click();

  await startField(page).fill("2026-09-16"); // the day the owner is back: the nights are from the start to the night before the end
  await save(page).click();

  await expect(details(page).getByRole("alert")).toHaveText("The start date must be before the end date.");
  await expect(endField(page)).toBeFocused();
  await expect(endField(page)).toHaveAttribute("aria-invalid", "true");
  expect(api.writes).toEqual([]);

  await startField(page).fill("2026-09-12"); // what it said is not true now
  await expect(details(page).getByRole("alert")).toHaveCount(0);
  await endField(page).fill("2100-01-01"); // a date that is a date, which only the server knows is too late
  await save(page).click();

  await expect(details(page).getByRole("alert")).toHaveText("Could not save: The end date must be from 1970-01-01 to 2099-12-31.");
  await expect(details(page).getByRole("alert").getByRole("button")).toHaveCount(0);
  expect(api.writes).toHaveLength(1);
});

test("cancel_and_escape_close_the_form_and_the_question_and_write_nothing_with_the_focus_back_on_the_button", async ({ page }) => {
  const api = await openLisbon(page, tripServer());

  await edit(page).click();
  await nameField(page).fill("Something else");
  await details(page).getByRole("button", { name: "Cancel" }).click();
  await expect(nameField(page)).toHaveCount(0);
  await expect(edit(page)).toBeFocused();

  await edit(page).click();
  await page.keyboard.press("Escape");
  await expect(nameField(page)).toHaveCount(0);
  await expect(edit(page)).toBeFocused();

  const deleteTrip = details(page).getByRole("button", { name: "Delete trip" });
  await deleteTrip.click();
  await expect(details(page).getByText("Delete this trip? It stays deleted when your data is reprocessed. You can restore it in Settings.")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(details(page).getByRole("button", { name: "Delete", exact: true })).toHaveCount(0);
  await expect(deleteTrip).toBeFocused();

  await expect(title(page)).toHaveText(LISBON);
  expect(api.writes).toEqual([]);
});

test("delete_a_trip_after_asking_goes_to_the_list_and_settings_has_it_to_restore", async ({ page }) => {
  const api = await openLisbon(page, tripServer());

  await details(page).getByRole("button", { name: "Delete trip" }).click();
  await expect(details(page).getByText("Delete this trip? It stays deleted when your data is reprocessed. You can restore it in Settings.")).toBeVisible();
  await details(page).getByRole("button", { name: "Delete", exact: true }).click();

  await expect(page).toHaveURL(/\/trips$/);
  await sheetAtRest(page);
  await expect(cards(page)).toHaveCount(2);
  await expect(cards(page).filter({ hasText: LISBON })).toHaveCount(0);
  expect(api.writes).toEqual([{ method: "DELETE", path: "/api/trips/2026-09-12", contentType: "application/json", body: null }]);

  // Settings has it among the deleted trips, by the name and the dates it was shown under.
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await sheetAtRest(page);
  const deleted = details(page).getByRole("region", { name: "Deleted trips" });
  await expect(deleted.getByRole("list", { name: "Deleted trips" }).getByRole("listitem")).toHaveText([`${LISBON} · 12 – 16 Sep 2026 Restore`], { useInnerText: true });

  await deleted.getByRole("button", { name: `Restore ${LISBON} · 12 – 16 Sep 2026` }).click();

  await expect(deleted.getByText("No deleted trips")).toBeVisible();
  await expect(deleted.getByText("No deleted trips")).toBeFocused(); // the button that was pressed is gone with the row
  await expect(page.getByRole("status").filter({ hasText: "Restored" })).toHaveText(`Restored ${LISBON} · 12 – 16 Sep 2026`);
  expect(api.writes.slice(1)).toEqual([{ method: "POST", path: "/api/trips/deleted/2026-09-12/restore", contentType: "application/json", body: {} }]);

  // And the trip is a trip again, with its days.
  await page.getByRole("button", { name: "Trips" }).click();
  await sheetAtRest(page);
  await expect(cards(page)).toHaveCount(3);
  await cards(page).filter({ hasText: LISBON }).click();
  await expect(page).toHaveURL(/\/trip\/2026-09-12$/);
  await expect(details(page).getByRole("list", { name: "Day by day" })).toBeVisible();
});

test("a_re_dated_trip_that_is_deleted_comes_back_with_the_dates_the_owner_gave_it", async ({ page }) => {
  await openLisbon(page, tripServer());
  await edit(page).click();
  await startField(page).fill("2026-09-11");
  await save(page).click();
  await expect(page).toHaveURL(/\/trip\/2026-09-11$/);
  await sheetAtRest(page);

  await details(page).getByRole("button", { name: "Delete trip" }).click();
  await details(page).getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page).toHaveURL(/\/trips$/);
  await page.getByRole("button", { name: "Settings" }).click();
  await sheetAtRest(page);
  const deleted = details(page).getByRole("region", { name: "Deleted trips" });
  await expect(deleted.getByText(`${LISBON} · 11 – 16 Sep 2026`)).toBeVisible(); // the name it was shown under when it was deleted
  await deleted.getByRole("button", { name: /^Restore / }).click();
  await expect(deleted.getByText("No deleted trips")).toBeVisible();

  await page.getByRole("button", { name: "Trips" }).click();
  await sheetAtRest(page);
  await expect(cards(page).filter({ hasText: "11 – 16 Sep 2026 · 5 nights" })).toHaveCount(1);
});
