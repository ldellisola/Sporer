import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./base";
import newYorkDay from "./fixtures/day-new-york.json" with { type: "json" };
import osloDay from "./fixtures/day-oslo-new-york.json" with { type: "json" };
import cafe from "./fixtures/place-cafe.json" with { type: "json" };
import { mockApi } from "./mockApi";
import { PIXEL_POLL, pixelAt, sameColour, type Rgb } from "./pixel";
import { sheetAtRest } from "./sheet";
import { fixTime } from "./today";

// The browser is in Tokyo, which the place is not in: every date and time on screen must be the clock of the zone it happened in. And one
// pixel to a CSS pixel, also on the phone: nothing here is about density, and a canvas of the phone's three costs software WebGL up to
// nine times as much a frame (see PIXEL_POLL).
test.use({ timezoneId: "Asia/Tokyo", deviceScaleFactor: 1 });

/** Fixes the date of "today" (the 1st of December in Tokyo, where the browser is), which no date of the fixtures is. */
const fixToday = (page: Page): Promise<void> => fixTime(page, "2026-12-01T12:00:00Z");

const isWide = (page: Page): boolean => page.viewportSize()!.width >= 900;
const details = (page: Page): Locator => page.getByRole(isWide(page) ? "complementary" : "region", { name: "Details" });
const grip = (page: Page): Locator => page.getByRole("button", { name: "Resize panel" });
const map = (page: Page): Locator => page.getByRole("region", { name: "Map view" });
const back = (page: Page): Locator => details(page).getByRole("button", { name: "Back" });
const visits = (page: Page): Locator => details(page).getByRole("list", { name: "Recent visits" }).getByRole("listitem");

/** On a phone the sheet starts at its peek: bring it up to full, where all of the panel can be read and reached. */
async function openSheet(page: Page): Promise<void> {
  if (isWide(page)) return;
  for (let i = 0; i < 2 && (await details(page).getAttribute("data-snap")) !== "full"; i++) await grip(page).click();
  await expect(details(page)).toHaveAttribute("data-snap", "full");
  await sheetAtRest(page); // and has come up, so that a row in it is where a click will find it
}

const API = {
  "day/2026-10-22": osloDay,
  "day/2026-10-23": newYorkDay,
  "places/2": cafe,
};

/** What the panel says of the Café of the fixture, which is all of the place view that is not the map. */
async function expectTheCafe(page: Page): Promise<void> {
  await expect(details(page).getByRole("heading", { level: 1, name: "Café" })).toBeVisible();
  await expect(details(page).getByText("Storgata 12, Oslo, Norway")).toBeVisible();
  await expect(details(page).locator("dl > div")).toHaveText(
    ["Total time 2h 24m", "Visits 3", "First visit Tue 29 Sep 2026", "Last visit Thu 22 Oct 2026"],
    { useInnerText: true },
  );
  // Newest first, on the clock of Oslo (UTC+2 until the 25th of October): 06:46 UTC is 08:46 there, and the first of the visits began on
  // the evening of the 29th there, which is already the 30th in Tokyo.
  await expect(visits(page)).toHaveText(
    ["Thu 22 Oct 2026 08:46 – 09:10 24m", "Thu 15 Oct 2026 17:30 – 18:45 1h 15m", "Tue 29 Sep 2026 23:30 – 00:15 45m"],
    { useInnerText: true },
  );
}

test("place_from_day_and_back", async ({ page }) => {
  await fixToday(page);
  await mockApi(page, API);
  await page.goto("/day/2026-10-22");
  await expect(map(page)).toHaveAttribute("data-map-state", "ready");
  await openSheet(page);

  // The name of a place in the timeline opens the place.
  await details(page).getByRole("button", { name: "Café", exact: true }).click();

  await expect(page).toHaveURL(/\/place\/2$/);
  await expectTheCafe(page);
  await expect(page.getByRole("button", { name: "Heat map" })).toHaveCount(0); // a place has no period to show the heat of

  // The back control returns to the day it came from, which is on screen as it was (and the day's timeline is its rows again).
  await back(page).click();

  await expect(page).toHaveURL(/\/day\/2026-10-22$/);
  await expect(page.getByRole("heading", { name: "Thursday 22 October" })).toBeVisible();
  await expect(details(page).getByRole("listitem")).toHaveCount(10);
  await expect(details(page).getByRole("button", { name: "Back" })).toHaveCount(0);
});

test("place_visit_tap_opens_the_day_it_began_on_and_back_comes_back_to_the_place", async ({ page }) => {
  await fixToday(page);
  await mockApi(page, API);
  await page.goto("/place/2");
  await expect(map(page)).toHaveAttribute("data-map-state", "ready");
  await openSheet(page);
  await expectTheCafe(page);

  // The date of the visit where it was, and not the date of it where the browser is (the 30th).
  await details(page).getByRole("button", { name: /Tue 29 Sep 2026/ }).click();

  await expect(page).toHaveURL(/\/day\/2026-09-29$/);
  await expect(page.getByRole("heading", { name: "Tuesday 29 September" })).toBeVisible();

  // The browser's own Back from the day goes to the place: the visit tap was a step of the app's.
  await page.goBack();

  await expect(page).toHaveURL(/\/place\/2$/);
  await expectTheCafe(page);
});

test("place_back_goes_to_today_when_the_page_was_opened_on_the_place", async ({ page }) => {
  await fixToday(page);
  await mockApi(page, API);

  // A deep link: nothing of the app's is behind this page.
  await page.goto("/place/2");
  await expect(map(page)).toHaveAttribute("data-map-state", "ready");
  await expectTheCafe(page);
  await back(page).click();

  await expect(page).toHaveURL(/\/day\/2026-12-01$/);
  await expect(page.getByRole("heading", { name: "Tuesday 1 December" })).toBeVisible();
  await expect(details(page).getByRole("button", { name: "Back" })).toHaveCount(0);
});

test("place_back_still_goes_back_to_the_day_after_the_page_is_reloaded_on_the_place", async ({ page }) => {
  await fixToday(page);
  await mockApi(page, API);
  await page.goto("/day/2026-10-22");
  await openSheet(page);
  await details(page).getByRole("button", { name: "Café", exact: true }).click();
  await expect(page).toHaveURL(/\/place\/2$/);

  // The entry that the app made keeps the mark of it through a reload, and the day is still behind it: back is the day, not today.
  await page.reload();
  await expectTheCafe(page);
  await back(page).click();

  await expect(page).toHaveURL(/\/day\/2026-10-22$/);
  await expect(page.getByRole("heading", { name: "Thursday 22 October" })).toBeVisible();
});

test("place_that_no_longer_exists_says_so_and_has_no_retry", async ({ page }) => {
  await fixToday(page);
  const api = await mockApi(page, { ...API, "places/9": () => ({ status: 404, json: { title: "Not Found" } }) });

  await page.goto("/place/9");

  await expect(details(page).getByText("This place no longer exists")).toBeVisible();
  await expect(details(page).getByRole("button", { name: "Retry" })).toHaveCount(0);
  await expect(details(page).getByRole("heading", { level: 1 })).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(api.requests.filter((request) => request === "/api/places/9")).toHaveLength(1); // asked once: a 404 is not asked for again
  await back(page).click();
  await expect(page).toHaveURL(/\/day\/2026-12-01$/);
});

test("place_that_fails_to_load_shows_an_error_with_a_retry_that_asks_again", async ({ page }) => {
  await fixToday(page);
  let failing = true;
  await mockApi(page, { ...API, "places/2": () => (failing ? { status: 500, json: {} } : { json: cafe }) });

  await page.goto("/place/2");

  await expect(details(page).getByRole("alert")).toContainText("Couldn't load");
  await expect(details(page).getByText("This place no longer exists")).toHaveCount(0);
  failing = false;
  await details(page).getByRole("button", { name: "Retry" }).click();
  await expectTheCafe(page);
});

const PIN: Rgb = [0xff, 0x37, 0x5f];

// Ruling P2-R56: the map flies to the one pin of the place, which comes to the middle of the part of the map that nothing covers.
test("place_view_brings_the_map_to_the_pin_of_the_place", async ({ page }) => {
  test.setTimeout(30_000 + PIXEL_POLL.timeout); // a read of a pixel may take as long as the poll gives it (see PIXEL_POLL)
  await mockApi(page, API);
  await page.goto("/place/2");
  await expect(map(page)).toHaveAttribute("data-map-state", "ready");
  await expectTheCafe(page);

  // The middle of what is free, as the map was padded for it (see day.spec.ts). The pin is 12 px in radius and has no number: its
  // middle is pink.
  const free = await map(page).evaluate((element) => {
    const read = (side: string) => parseFloat(element.style.getPropertyValue(`--map-padding-${side}`));
    const box = element.getBoundingClientRect();
    return {
      x: box.left + (read("left") + (box.width - read("right"))) / 2,
      y: box.top + (read("top") + (box.height - read("bottom"))) / 2,
    };
  });
  await expect.poll(async () => sameColour(await pixelAt(page, Math.round(free.x), Math.round(free.y)), PIN, 8), PIXEL_POLL).toBe(true);
});
