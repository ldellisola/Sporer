import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./base";
import status from "./fixtures/status.json" with { type: "json" };
import { mockApi } from "./mockApi";
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
const deletedTrips = (page: Page): Locator => details(page).getByRole("region", { name: "Deleted trips" });
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
  const notSettings = (request: string): boolean => request !== "/api/status" && request !== "/api/trips/deleted"; // the status is polled, and the deleted trips are what the settings list
  const before = api.requests.filter(notSettings).length;

  await settingsButton(page).click();

  await expect(page).toHaveURL(/\/settings$/);
  await expect(settingsButton(page)).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "Trips" })).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible(); // the bar's title row, in place of the date
  await expect(page.getByRole("group", { name: "View" }).getByRole("button", { pressed: true })).toHaveCount(0); // no view is the current one
  await openSheet(page);

  // Deleted trips come first, as the plan has the sections: none are deleted here.
  await expect(deletedTrips(page).getByRole("heading", { name: "Deleted trips" })).toBeVisible();
  await expect(deletedTrips(page).getByText("No deleted trips")).toBeVisible();
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
  // No day, no range, no heat: the status and the config that every page asks for, and the deleted trips that the settings list.
  expect(api.requests.filter((request) => !["/api/status", "/api/config", "/api/trips/deleted"].includes(request))).toEqual([]);
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
