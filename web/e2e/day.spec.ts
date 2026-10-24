import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./base";
import newYorkDay from "./fixtures/day-new-york.json" with { type: "json" };
import osloDay from "./fixtures/day-oslo-new-york.json" with { type: "json" };
import { mockApi } from "./mockApi";

// The browser is in Tokyo, which neither of the days is in: every time on screen must be the clock of the zone it happened in. The
// date of "today" is fixed as well, so that no day of the fixtures is ever the day that is still going on.
test.use({ timezoneId: "Asia/Tokyo" });

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-12-01T12:00:00Z"));
});

const isWide = (page: Page): boolean => page.viewportSize()!.width >= 900;
const details = (page: Page): Locator => page.getByRole(isWide(page) ? "complementary" : "region", { name: "Details" });
const grip = (page: Page): Locator => page.getByRole("button", { name: "Resize panel" });
const rows = (page: Page): Locator => details(page).getByRole("listitem");

/** On a phone the sheet starts at its peek, which shows a chip or two: bring it up to full, where the timeline can be read. */
async function openTimeline(page: Page): Promise<void> {
  if (isWide(page)) return;
  await grip(page).click(); // half
  await grip(page).click(); // full
  await expect(rows(page).first()).toBeInViewport();
}

const DAYS = { "day/2026-10-22": osloDay, "day/2026-10-23": newYorkDay };

test("day_view_lists_timeline_and_steps_days", async ({ page }) => {
  const api = await mockApi(page, DAYS);
  await page.goto("/day/2026-10-22");
  await expect(page.getByRole("region", { name: "Map view" })).toHaveAttribute("data-map-state", "ready");
  await openTimeline(page);

  // The summary as chips, and the day's rows in order, on the clocks of Oslo and New York.
  await expect(details(page).getByText("5 places")).toBeVisible();
  await expect(details(page).getByText("5,952 km")).toBeVisible();
  await expect(details(page).getByText("9h 13m moving")).toBeVisible();
  await expect(rows(page)).toHaveText(
    [
      "1 Home until 08:32 11h 22m",
      "Walk · 1.1 km 14m",
      "2 Café 08:46 – 09:10 24m",
      "Cycle · 3.4 km 13m",
      "3 Office 09:23 – 11:41 2h 18m",
      "Drive · 47.8 km 41m",
      "4 Unnamed place 12:22 – 12:50 28m",
      "Flight · 5,900 km 8h 5m",
      "No data 45m",
      "5 Hotel Midtown from 15:40 17h 20m",
    ],
    { useInnerText: true },
  );
  await expect(rows(page).first()).toBeInViewport();
  await expect(rows(page).last()).toBeInViewport();

  // The days either side were asked for as soon as this one was shown, so › finds the next one at hand.
  await expect.poll(() => api.requests).toContain("/api/day/2026-10-23");
  await expect.poll(() => api.requests).toContain("/api/day/2026-10-21");

  await page.getByRole("button", { name: "Next day" }).click();

  await expect(page).toHaveURL(/\/day\/2026-10-23$/);
  await expect(page.getByRole("heading", { name: "Friday 23 October" })).toBeVisible();
  await expect(details(page).getByText("3 places")).toBeVisible();
  await expect(details(page).getByText("2.7 km")).toBeVisible();
  await expect(rows(page)).toHaveText(
    [
      "1 Hotel Midtown until 09:00 17h 20m",
      "Walk · 900 m 12m",
      "2 Coffee Shop 09:12 – 10:05 53m",
      "Walk · 1.8 km 25m",
      "3 Museum 10:30 – 14:00 3h 30m",
    ],
    { useInnerText: true },
  );
  expect(api.requests.filter((request) => request === "/api/day/2026-10-23")).toHaveLength(1); // the prefetch was the only request for it

  await page.getByRole("button", { name: "Previous day" }).click();
  await expect(page).toHaveURL(/\/day\/2026-10-22$/);
  await expect(rows(page)).toHaveCount(10);
});

test("day_view_row_tap_leaves_the_address_and_a_place_name_opens_the_place", async ({ page }) => {
  await mockApi(page, DAYS);
  await page.goto("/day/2026-10-22");
  await expect(page.getByRole("region", { name: "Map view" })).toHaveAttribute("data-map-state", "ready");
  await openTimeline(page);

  // A row is a button that takes the map to its segment; the map moves, and the address stays.
  await details(page).getByRole("button", { name: "Show Café on the map" }).click();
  await details(page).getByRole("button", { name: "Show the cycle on the map" }).click();
  await expect(page).toHaveURL(/\/day\/2026-10-22$/);

  // Reachable and operable from the keyboard.
  await details(page).getByRole("button", { name: "Show Office on the map" }).focus();
  await expect(details(page).getByRole("button", { name: "Show Office on the map" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/day\/2026-10-22$/);

  // The name of a place opens the place, and does not do what the row does besides.
  await details(page).getByRole("button", { name: "Café", exact: true }).click();
  await expect(page).toHaveURL(/\/place\/2$/);
});

test("day_view_says_when_a_day_is_empty_and_when_it_is_being_updated", async ({ page }) => {
  await mockApi(page, {
    "day/2026-10-22": { ...osloDay, state: "pending" },
    "day/2026-10-21": { ...osloDay, date: "2026-10-21", state: "done", summary: { places: 0, distanceMeters: 0, movingSeconds: 0 }, segments: [] },
  });
  await page.goto("/day/2026-10-22");
  await openTimeline(page);

  await expect(details(page).getByText("Updating…")).toBeVisible();
  await expect(rows(page)).toHaveCount(10);

  await page.getByRole("button", { name: "Previous day" }).click();

  await expect(details(page).getByText("No data for this day")).toBeVisible();
  await expect(details(page).getByText("Updating…")).toHaveCount(0);
  await expect(rows(page)).toHaveCount(0);
});
