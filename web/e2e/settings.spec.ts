import type { Locator, Page } from "@playwright/test";
import type { HomePeriod, PlaceSearchResult, RemovedBatch, SettingsResponse } from "../src/api/types";
import { expect, test } from "./base";
import status from "./fixtures/status.json" with { type: "json" };
import { mockApi, type Reply } from "./mockApi";
import { sheetAtRest } from "./sheet";
import { fixTime } from "./today";

// The browser is in Oslo, which is on summer time until the 25th: the times of the status are read on its clock.
test.use({ timezoneId: "Europe/Oslo" });

/** Fixes today at Saturday 24 October, a date after the days and the times of these tests. */
const fixToday = (page: Page): Promise<void> => fixTime(page, "2026-10-24T08:00:00Z");

const isWide = (page: Page): boolean => page.viewportSize()!.width >= 900;
const details = (page: Page): Locator => page.getByRole(isWide(page) ? "complementary" : "region", { name: "Details" });
const grip = (page: Page): Locator => page.getByRole("button", { name: "Resize panel" });
const map = (page: Page): Locator => page.getByRole("region", { name: "Map view" });
const settingsButton = (page: Page): Locator => page.getByRole("button", { name: "Settings" });
const homeSection = (page: Page): Locator => details(page).getByRole("region", { name: "Home" });
const tripDistance = (page: Page): Locator => details(page).getByRole("region", { name: "Trips" });
const deletedTrips = (page: Page): Locator => details(page).getByRole("region", { name: "Deleted trips" });
const removedPoints = (page: Page): Locator => details(page).getByRole("region", { name: "Removed points" });
const processing = (page: Page): Locator => details(page).getByRole("region", { name: "Processing" });
const about = (page: Page): Locator => details(page).getByRole("region", { name: "About" });

/** On a phone the sheet starts at its peek: bring it up to full, where all of the panel can be read and reached. */
async function openSheet(page: Page): Promise<void> {
  if (isWide(page)) return;
  for (let i = 0; i < 2 && (await details(page).getAttribute("data-snap")) !== "full"; i++) await grip(page).click();
  await expect(details(page)).toHaveAttribute("data-snap", "full");
  await sheetAtRest(page); // and has come up, so that a button in it is where a click will find it
}

/** The status of the fixture, with a period that failed twice over and what the worker last did. */
const FAILED = {
  ...status,
  algorithmVersion: "2026-10-algo-3",
  pendingRanges: 2,
  lastRunAt: "2026-10-24T08:15:00Z", // 10:15 in Oslo
  failedRanges: [
    { from: "2026-09-12T20:00:00Z", to: "2026-09-13T20:00:00Z", attempts: 5, lastError: "a point that cannot be placed" },
    { from: "2026-10-01T02:00:00Z", to: "2026-10-01T05:00:00Z", attempts: 1, lastError: null },
  ],
};

test("gear_opens_settings_with_processing_and_about_and_leaves_the_map", async ({ page }) => {
  await fixToday(page);
  const api = await mockApi(page, { status: { ...FAILED, failedRanges: [] } });
  await page.goto("/day/2026-10-22");
  await expect(map(page)).toHaveAttribute("data-map-state", "ready");
  await expect(page.getByRole("button", { name: "Heat map" })).toBeVisible(); // the day has a period to show the heat of
  await expect(settingsButton(page)).toHaveAttribute("aria-pressed", "false");
  // The days either side were asked for as soon as this one was shown: from here on, nothing is asked for on the account of the settings.
  await expect.poll(() => api.requests).toContain("/api/day/2026-10-23");
  await expect.poll(() => api.requests).toContain("/api/day/2026-10-21");
  // The status is polled, and the home, the distance, the deleted trips and the removed points are what the settings list.
  const notSettings = (request: string): boolean => !["/api/status", "/api/homes", "/api/settings", "/api/trips/deleted", "/api/points/removed"].includes(request);
  const before = api.requests.filter(notSettings).length;

  await settingsButton(page).click();

  await expect(page).toHaveURL(/\/settings$/);
  await expect(settingsButton(page)).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "Trips" })).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible(); // the bar's title row, in place of the date
  await expect(page.getByRole("group", { name: "View" }).getByRole("button", { pressed: true })).toHaveCount(0); // no view is the current one
  await openSheet(page);

  // The sections are in the order of the plan: Home, Trips, Deleted trips, Removed points, Processing, About.
  await expect(details(page).getByRole("heading", { level: 2 })).toHaveText(["Home", "Trips", "Deleted trips", "Removed points", "Processing", "About"]);
  // Home: none is known here, and one can be set. Trips: the distance, as it is in effect.
  await expect(homeSection(page).getByText("No home yet")).toBeVisible();
  await expect(homeSection(page).getByRole("button", { name: "Set home" })).toBeVisible();
  await expect(tripDistance(page).getByRole("spinbutton", { name: "Minimum distance from home (km)" })).toHaveValue("50");
  await expect(tripDistance(page).getByRole("button", { name: "Reset to default (50 km)" })).toBeVisible();
  // Deleted trips and removed points: none here.
  await expect(deletedTrips(page).getByRole("heading", { name: "Deleted trips" })).toBeVisible();
  await expect(deletedTrips(page).getByText("No deleted trips")).toBeVisible();
  await expect(removedPoints(page).getByText("No removed points")).toBeVisible();
  // Processing: how far the backfill is, when the worker last ran, what waits.
  await expect(processing(page).getByRole("heading", { name: "Processing" })).toBeVisible();
  await expect(processing(page).locator("dl > div")).toHaveText(["Backfill 100 %", "Last processed Sat 24 Oct 2026 10:15", "Waiting to be processed 2 periods"], {
    useInnerText: true,
  });
  await expect(processing(page).getByText("Nothing has failed")).toBeVisible();
  // About: the credit with its links, and the version of the algorithm.
  await expect(about(page).getByRole("heading", { name: "About" })).toBeVisible();
  for (const [name, href] of [
    ["OpenStreetMap contributors", "https://www.openstreetmap.org/copyright"],
    ["OpenFreeMap", "https://openfreemap.org"],
    ["OpenMapTiles", "https://openmaptiles.org"],
  ] as const) {
    const link = about(page).getByRole("link", { name });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute("href", href);
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toHaveAttribute("rel", "noopener noreferrer");
  }
  await expect(about(page).locator("dl > div")).toHaveText(["Algorithm version 2026-10-algo-3"], { useInnerText: true });

  // The map is still the day's, with its heat button, and nothing was asked for on the settings' account.
  await expect(map(page)).toHaveAttribute("data-map-state", "ready");
  await expect(page.getByRole("button", { name: "Heat map" })).toBeVisible();
  expect(api.requests.filter(notSettings)).toHaveLength(before);

  // A view of time chosen from here is at the day that was shown last.
  await page.getByRole("group", { name: "View" }).getByRole("button", { name: "Week" }).click();
  await expect(page).toHaveURL(/\/week\/2026-10-19$/);
  await expect(settingsButton(page)).toHaveAttribute("aria-pressed", "false");
});

test("back_from_the_settings_is_the_day_that_was_open", async ({ page }) => {
  await fixToday(page);
  await mockApi(page);
  await page.goto("/day/2026-10-22");
  await expect(map(page)).toHaveAttribute("data-map-state", "ready");
  await settingsButton(page).click();
  await expect(page).toHaveURL(/\/settings$/);

  await page.goBack();

  await expect(page).toHaveURL(/\/day\/2026-10-22$/);
  await expect(page.getByRole("heading", { level: 1, name: "Thursday 22 October" })).toBeVisible();
  await expect(map(page)).toHaveAttribute("data-map-state", "ready");
  await expect(page.getByRole("button", { name: "Heat map" })).toBeVisible();
});

test("settings_opened_as_a_page_shows_processing_and_about_and_no_period", async ({ page }) => {
  await fixToday(page);
  const api = await mockApi(page);
  await page.goto("/settings");
  await expect(map(page)).toHaveAttribute("data-map-state", "ready");

  await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
  await expect(processing(page).getByRole("heading", { name: "Processing" })).toBeVisible();
  await expect(about(page).getByRole("heading", { name: "About" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Heat map" })).toHaveCount(0); // there is no period to show the heat of
  // No day, no range, no heat: the status and the config that every page asks for, and what the settings list.
  expect(
    api.requests.filter(
      (request) => !["/api/status", "/api/config", "/api/homes", "/api/settings", "/api/trips/deleted", "/api/points/removed"].includes(request),
    ),
  ).toEqual([]);
});

test("retry_failed_lists_the_failed_periods_and_posts_an_empty_json_object", async ({ page }) => {
  await fixToday(page);
  let failed = true;
  const api = await mockApi(page, {
    status: () => ({ json: failed ? FAILED : { ...FAILED, failedRanges: [] } }),
    "POST status/retry": () => {
      failed = false; // the worker takes them up
      return { json: { retried: 2 } };
    },
  });
  await page.goto("/settings");
  await openSheet(page);

  const periods = processing(page).getByRole("list", { name: "Failed periods" }).getByRole("listitem");
  await expect(periods).toHaveCount(2);
  await expect(periods.nth(0)).toHaveText("Sat 12 Sep 2026 22:00 – Sun 13 Sep 2026 22:00 5 attempts a point that cannot be placed", { useInnerText: true });
  await expect(periods.nth(1)).toHaveText("Thu 1 Oct 2026 04:00 – 07:00 1 attempt", { useInnerText: true });

  await processing(page).getByRole("button", { name: "Retry failed" }).click();

  // The write was a POST that said it was JSON, with an empty object for a body, and what it did is said for a while: in the note that is fixed to the
  // page (the sheet moves, and a note in it would go with it), which is the status that was there before it said so.
  await expect(page.getByRole("status").filter({ hasText: "Retrying 2 periods" })).toHaveText("Retrying 2 periods");
  await expect(processing(page).getByText("Retrying 2 periods")).toHaveCount(0);
  expect(api.writes).toEqual([{ method: "POST", path: "/api/status/retry", contentType: "application/json", body: {} }]);
  // What is on screen was asked for again: the list of failed periods is gone, and so is the button.
  await expect(processing(page).getByText("Nothing has failed")).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry failed" })).toHaveCount(0);
});

test("retry_failed_that_fails_says_so_with_a_retry_and_keeps_the_list", async ({ page }) => {
  await fixToday(page);
  let answers = 0;
  const api = await mockApi(page, {
    status: FAILED,
    "POST status/retry": () => (++answers === 1 ? { status: 500, json: { title: "Internal Server Error" } } : { json: { retried: 2 } }),
  });
  await page.goto("/settings");
  await openSheet(page);

  await processing(page).getByRole("button", { name: "Retry failed" }).click();

  const alert = processing(page).getByRole("alert");
  await expect(alert).toContainText("Couldn't retry");
  await expect(alert).toContainText("POST /api/status/retry failed with status 500");
  await expect(processing(page).getByRole("list", { name: "Failed periods" })).toBeVisible(); // the panel is never blank
  await expect(processing(page).getByRole("button", { name: "Retry failed" })).toBeEnabled();

  await alert.getByRole("button", { name: "Retry" }).click();

  await expect(page.getByRole("status").filter({ hasText: "Retrying 2 periods" })).toHaveText("Retrying 2 periods");
  await expect(alert).toHaveCount(0);
  expect(api.writes.map((write) => `${write.method} ${write.path}`)).toEqual(["POST /api/status/retry", "POST /api/status/retry"]);
});

test("settings_says_the_status_could_not_be_loaded_with_a_retry_and_keeps_the_credits", async ({ page }) => {
  await fixToday(page);
  let asked = 0;
  await mockApi(page, { status: () => (++asked <= 2 ? { status: 503, json: { title: "Service Unavailable" } } : { json: FAILED }) }); // the first is tried twice
  await page.goto("/settings");
  await openSheet(page);

  const alert = processing(page).getByRole("alert");
  await expect(alert).toContainText("Couldn't load");
  await expect(about(page).getByRole("link", { name: "OpenStreetMap contributors" })).toBeVisible();

  await alert.getByRole("button", { name: "Retry" }).click();

  await expect(processing(page).getByRole("list", { name: "Failed periods" })).toBeVisible();
  await expect(alert).toHaveCount(0);
});

// ---- what the owner changes in the settings -------------------------------------------------------------------------------

/** The status that a note over the map is: the one place that the sections of the settings say what they have done in. */
const note = (page: Page): Locator => page.getByRole("status");

const OSLO_FLAT: HomePeriod = { id: 1, placeId: 7, placeName: "Oslo flat", from: "2025-01-01", to: null, source: "detected" };
const PLACES: PlaceSearchResult[] = [
  { id: 7, name: "Oslo flat", address: "Storgata 1, Oslo", visits: 40 },
  { id: 9, name: "Lisbon flat", address: null, visits: 12 },
];

test("set_a_home_override_then_remove_it_and_the_list_follows_what_the_server_has", async ({ page }) => {
  await fixToday(page);
  // A server that keeps the periods: what was set is listed, and what was removed is not.
  let periods: HomePeriod[] = [OSLO_FLAT];
  const api = await mockApi(page, {
    homes: (): Reply => ({ json: { periods } }),
    "places/search": (request): Reply => {
      const q = new URL(request.url()).searchParams.get("q")?.toLowerCase() ?? "";
      return { json: PLACES.filter((place) => q === "" || [place.name, place.address].some((part) => part?.toLowerCase().includes(q))) };
    },
    "POST homes": (request): Reply => {
      const { placeId, from, to } = request.postDataJSON() as { placeId: number; from: string; to: string | null };
      const place = PLACES.find((candidate) => candidate.id === placeId)!;
      const period: HomePeriod = { id: 2, placeId, placeName: place.name, from, to, source: "user" };
      periods = [...periods, period].sort((a, b) => a.from.localeCompare(b.from));
      return { status: 201, json: period };
    },
    "DELETE homes/*": (): Reply => {
      periods = periods.filter((period) => period.id !== 2);
      return { status: 204 };
    },
  });
  await page.goto("/settings");
  await openSheet(page);
  const home = homeSection(page);
  await expect(home.getByRole("listitem")).toHaveText(["Oslo flat From 1 Jan 2025 Detected"], { useInnerText: true });
  await expect(home.getByRole("button", { name: /^Remove/ })).toHaveCount(0); // a detected period has no Remove

  // Set home: the picker is of all the places in use, the most visited first, with no distance; a search narrows it.
  await home.getByRole("button", { name: "Set home" }).click();
  const places = home.getByRole("list", { name: "Places" });
  await expect(places.getByRole("button")).toHaveText(["Oslo flat Storgata 1, Oslo 40 visits", "Lisbon flat 12 visits"], { useInnerText: true });
  await home.getByRole("searchbox", { name: "Search places" }).fill("lisb");
  await expect(places.getByRole("button")).toHaveText(["Lisbon flat 12 visits"], { useInnerText: true });
  await places.getByRole("button", { name: /^Lisbon flat/ }).click();

  await expect(home.getByText("Set Lisbon flat as home")).toBeFocused();
  await home.getByLabel("From", { exact: true }).fill("2026-04-01");
  await home.getByLabel("To (optional)", { exact: true }).fill("2026-08-31");
  await home.getByRole("button", { name: "Save" }).click();

  // The period is a POST of all three keys, as JSON; the list has it (set by the owner, in date order), the form is closed with the focus back on the
  // button that opened it, and what was done is said in the status.
  await expect(home.getByRole("listitem")).toHaveCount(2);
  await expect(home.getByRole("listitem").nth(1)).toHaveText("Lisbon flat 1 Apr – 31 Aug 2026 Set by you Remove", { useInnerText: true });
  await expect(home.getByLabel("From", { exact: true })).toHaveCount(0);
  await expect(home.getByRole("button", { name: "Set home" })).toBeFocused();
  await expect(note(page)).toHaveText("Home set to Lisbon flat");
  expect(api.writes).toEqual([
    { method: "POST", path: "/api/homes", contentType: "application/json", body: { placeId: 9, from: "2026-04-01", to: "2026-08-31" } },
  ]);

  // Remove takes it back: a DELETE of its id, and the list is what the server has.
  await home.getByRole("button", { name: "Remove Lisbon flat, 1 Apr – 31 Aug 2026" }).click();

  await expect(home.getByRole("listitem")).toHaveCount(1);
  await expect(home.getByText("Lisbon flat")).toHaveCount(0);
  await expect(note(page)).toHaveText("Removed the home at Lisbon flat");
  await expect(home.getByRole("button", { name: "Set home" })).toBeFocused(); // no row with a button is left
  expect(api.writes.slice(1)).toEqual([{ method: "DELETE", path: "/api/homes/2", contentType: "application/json", body: null }]);
});

test("a_home_the_server_refuses_is_told_in_its_words_with_no_retry_and_the_dates_stay_to_be_put_right", async ({ page }) => {
  await fixToday(page);
  const api = await mockApi(page, {
    homes: { periods: [OSLO_FLAT] },
    "places/search": PLACES,
    "POST homes": (): Reply => ({ status: 409, json: { statusCode: 409, message: "One or more errors occurred!", errors: { from: ["Another home you set has a night in these dates."] } } }),
  });
  await page.goto("/settings");
  await openSheet(page);
  const home = homeSection(page);
  await home.getByRole("button", { name: "Set home" }).click();
  await home.getByRole("button", { name: /^Lisbon flat/ }).click();
  await home.getByLabel("From", { exact: true }).fill("2026-04-01");

  await home.getByRole("button", { name: "Save" }).click();

  const alert = home.getByRole("alert");
  await expect(alert).toContainText("Could not save: Another home you set has a night in these dates.");
  await expect(alert.getByRole("button", { name: "Retry" })).toHaveCount(0);
  await expect(home.getByLabel("From", { exact: true })).toHaveValue("2026-04-01");
  expect(api.writes).toHaveLength(1);
});

test("change_the_trip_distance_then_reset_it_and_the_empty_list_of_trips_says_the_distance_that_is_in_effect", async ({ page }) => {
  await fixToday(page);
  // A server that keeps the distance: the settings say what is in effect, and null puts the default back.
  let distance = 50;
  const settings = (): SettingsResponse => ({ tripMinDistanceKm: distance, tripMinDistanceKmDefault: 50 });
  const api = await mockApi(page, {
    trips: { trips: [] },
    settings: (): Reply => ({ json: settings() }),
    "PUT settings": (request): Reply => {
      distance = (request.postDataJSON() as { tripMinDistanceKm: number | null }).tripMinDistanceKm ?? 50;
      return { json: settings() };
    },
  });
  await page.goto("/settings");
  await openSheet(page);
  const trips = tripDistance(page);
  const field = trips.getByRole("spinbutton", { name: "Minimum distance from home (km)" });
  await expect(field).toHaveValue("50");
  await expect(trips.getByRole("button", { name: "Save" })).toBeDisabled(); // nothing was changed

  // A distance that the server would refuse is told here, and no request is made.
  await field.fill("3");
  await trips.getByRole("button", { name: "Save" }).click();
  await expect(trips.getByRole("alert")).toHaveText("Enter a distance from 5 to 1000 km.");
  expect(api.writes).toEqual([]);

  await field.fill("80");
  await trips.getByRole("button", { name: "Save" }).click();

  await expect(note(page)).toHaveText("Trip distance set to 80 km");
  await expect(field).toHaveValue("80");
  await expect(trips.getByRole("alert")).toHaveCount(0);
  await expect(trips.getByRole("button", { name: "Save" })).toBeDisabled(); // what is in the field is what is in effect
  expect(api.writes).toEqual([{ method: "PUT", path: "/api/settings", contentType: "application/json", body: { tripMinDistanceKm: 80 } }]);

  // The list of trips, which has none, says the distance that is in effect, and not the 50 km that was the default.
  await page.getByRole("button", { name: "Trips" }).click();
  await expect(page).toHaveURL(/\/trips$/);
  await expect(details(page).getByText("No trips yet. A trip is a night spent 80 km or more from home.")).toBeVisible();
  await settingsButton(page).click();
  await openSheet(page);

  // Reset to default sends null, and the field is the default again.
  await trips.getByRole("button", { name: "Reset to default (50 km)" }).click();

  await expect(note(page)).toHaveText("Trip distance back to the default, 50 km");
  await expect(field).toHaveValue("50");
  expect(api.writes.slice(1)).toEqual([{ method: "PUT", path: "/api/settings", contentType: "application/json", body: { tripMinDistanceKm: null } }]);
});

test("restore_a_removed_batch_and_the_day_it_was_on_is_asked_for_again", async ({ page }) => {
  await fixToday(page);
  const batches: RemovedBatch[] = [
    {
      batch: "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
      removedAt: "2026-10-23T09:30:00Z", // 11:30 in Oslo
      count: 12,
      from: "2026-10-22T08:00:00Z",
      to: "2026-10-22T08:10:00Z",
      localDates: ["2026-10-22"],
    },
    {
      batch: "9b2e1c4a-6d3f-4a8e-b1f0-5c7d8e9f0a1b",
      removedAt: "2026-10-20T07:00:00Z",
      count: 1,
      from: "2026-10-19T12:00:00Z",
      to: "2026-10-19T12:00:00Z",
      localDates: ["2026-10-19"],
    },
  ];
  let removed = batches;
  const api = await mockApi(page, {
    "points/removed": (): Reply => ({ json: removed }),
    "DELETE points/removed/*": (request): Reply => {
      const batch = new URL(request.url()).pathname.split("/").pop();
      removed = removed.filter((candidate) => candidate.batch !== batch);
      return { status: 204 };
    },
  });
  await page.goto("/day/2026-10-22");
  await expect(map(page)).toHaveAttribute("data-map-state", "ready");
  await settingsButton(page).click();
  await openSheet(page);
  const section = removedPoints(page);
  const days = (): number => api.requests.filter((request) => request === "/api/day/2026-10-22").length;
  await expect(section.getByRole("listitem")).toHaveText(
    ["22 Oct 2026 12 points · removed Fri 23 Oct 2026 11:30 Restore", "19 Oct 2026 1 point · removed Tue 20 Oct 2026 09:00 Restore"],
    { useInnerText: true },
  );
  const before = days();

  await section.getByRole("button", { name: /^Restore 12 points from 22 Oct 2026/ }).click();

  // A DELETE of the batch; the row goes, the focus is on the button of the next, and what was done is said in the status.
  await expect(section.getByRole("listitem")).toHaveCount(1);
  await expect(note(page)).toHaveText("Restored 12 points");
  await expect(section.getByRole("button", { name: /^Restore 1 point from 19 Oct 2026/ })).toBeFocused();
  expect(api.writes).toEqual([
    { method: "DELETE", path: "/api/points/removed/3f2504e0-4f89-11d3-9a0c-0305e82c3301", contentType: "application/json", body: null },
  ]);

  // The day the points are on was marked as old by the write, and is asked for again when it is shown: it was fresh for half a minute before.
  await page.goBack();
  await expect(page).toHaveURL(/\/day\/2026-10-22$/);
  await expect.poll(days).toBeGreaterThan(before);
});
