import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./base";
import { mockApi } from "./mockApi";
import { fixTime } from "./today";

// The browser is in Oslo, so that "today" is a date that is the same wherever the test is run (see `fixToday`).
test.use({ timezoneId: "Europe/Oslo" });

/** Fixes today at Saturday 24 October, a date after every trip of the fixtures but the one that is still going on. */
const fixToday = (page: Page): Promise<void> => fixTime(page, "2026-10-24T08:00:00Z");

const isWide = (page: Page): boolean => page.viewportSize()!.width >= 900;
const details = (page: Page): Locator => page.getByRole(isWide(page) ? "complementary" : "region", { name: "Details" });
const map = (page: Page): Locator => page.getByRole("region", { name: "Map view" });
const tripsButton = (page: Page): Locator => page.getByRole("button", { name: "Trips" });
const views = (page: Page): Locator => page.getByRole("group", { name: "View" });

test("trips_button_opens_the_trips_list", async ({ page }) => {
  await fixToday(page);
  const api = await mockApi(page);
  await page.goto("/day/2026-10-22");
  await expect(map(page)).toHaveAttribute("data-map-state", "ready");
  await expect(page.getByRole("heading", { name: "Thursday 22 October" })).toBeVisible();
  await expect(tripsButton(page)).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByRole("button", { name: "Heat map" })).toBeVisible(); // the day has a period to show the heat of
  // The days either side were asked for as soon as this one was shown: from here on, what is asked for is what the trips ask for.
  await expect.poll(() => api.requests).toContain("/api/day/2026-10-23");
  await expect.poll(() => api.requests).toContain("/api/day/2026-10-21");
  const before = api.requests.length;

  await tripsButton(page).click();

  await expect(page).toHaveURL(/\/trips$/);
  await expect(tripsButton(page)).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("heading", { level: 1, name: "Trips" })).toBeVisible(); // the bar's title row, in place of the date
  await expect(page.getByRole("button", { name: /^(Previous|Next) / })).toHaveCount(0);
  await expect(views(page).getByRole("button", { pressed: true })).toHaveCount(0); // no view is the current one
  await expect(details(page).getByRole("heading", { name: "Trips" })).toBeVisible(); // and the panel, once the list has come
  await expect(details(page).getByText("Loading…")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Heat map" })).toHaveCount(0); // there is no period to show the heat of
  // The list and nothing made of the dates of a period: no day, no range, no heat (the status is polled whatever the view).
  expect(api.requests.slice(before).filter((request) => request !== "/api/status")).toEqual(["/api/trips"]);

  // A view chosen from here is at the day that was shown last, and has its heat button again.
  await views(page).getByRole("button", { name: "Week" }).click();

  await expect(page).toHaveURL(/\/week\/2026-10-19$/);
  await expect(page.getByRole("heading", { level: 1, name: "19 – 25 Oct 2026" })).toBeVisible();
  await expect(tripsButton(page)).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByRole("button", { name: "Heat map" })).toBeVisible();
});

test("trip_bar_names_the_trip_and_steps_to_the_older_and_newer_trip", async ({ page }) => {
  await fixToday(page);
  await mockApi(page);
  await page.goto("/trip/2026-09-12"); // the list is newest first: Madrid (still going), Lisbon & Sintra, Copenhagen
  await expect(map(page)).toHaveAttribute("data-map-state", "ready");
  const title = page.getByRole("heading", { level: 1 });
  const older = page.getByRole("button", { name: "Older trip" });
  const newer = page.getByRole("button", { name: "Newer trip" });
  await expect(title).toHaveText("Lisbon & Sintra");
  await expect(page.getByText("12 Sep – 16 Sep 2026")).toBeVisible();
  await expect(tripsButton(page)).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "Heat map" })).toHaveCount(0); // the heat of a trip is not offered yet
  await expect(older).toBeEnabled(); // once the list has come
  await expect(newer).toBeEnabled();

  await older.click(); // ‹

  await expect(page).toHaveURL(/\/trip\/2026-08-01$/);
  await expect(title).toHaveText("Copenhagen");
  await expect(older).toBeDisabled(); // the oldest trip
  await expect(newer).toBeEnabled();

  await page.keyboard.press("ArrowRight"); // the keys do what the arrows do
  await expect(page).toHaveURL(/\/trip\/2026-09-12$/);
  await page.keyboard.press("ArrowRight");
  await expect(page).toHaveURL(/\/trip\/2026-10-20$/);
  await expect(title).toHaveText("Madrid");
  await expect(page.getByText("20 Oct – 25 Oct 2026")).toBeVisible(); // an ongoing trip ends the day after its last night
  await expect(newer).toBeDisabled(); // the newest trip

  await page.keyboard.press("ArrowRight"); // nowhere to go
  await expect(page).toHaveURL(/\/trip\/2026-10-20$/);
  await page.keyboard.press("ArrowLeft");
  await expect(page).toHaveURL(/\/trip\/2026-09-12$/);
  await expect(title).toHaveText("Lisbon & Sintra");
});
