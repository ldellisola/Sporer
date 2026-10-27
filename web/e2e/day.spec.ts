import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./base";
import newYorkDay from "./fixtures/day-new-york.json" with { type: "json" };
import osloDay from "./fixtures/day-oslo-new-york.json" with { type: "json" };
import placeCafe from "./fixtures/place-cafe.json" with { type: "json" };
import { mockApi } from "./mockApi";
import { PIXEL_POLL, pixelAt, sameColour, type Rgb } from "./pixel";
import { fixTime } from "./today";

// The browser is in Tokyo, which neither of the days is in: every time on screen must be the clock of the zone it happened in.
test.use({ timezoneId: "Asia/Tokyo" });

/** Fixes the date of "today", so that no day of the fixtures is ever the day that is still going on. */
const fixToday = (page: Page): Promise<void> => fixTime(page, "2026-12-01T12:00:00Z");

const isWide = (page: Page): boolean => page.viewportSize()!.width >= 900;
const details = (page: Page): Locator => page.getByRole(isWide(page) ? "complementary" : "region", { name: "Details" });
const grip = (page: Page): Locator => page.getByRole("button", { name: "Resize panel" });
const rows = (page: Page): Locator => details(page).getByRole("listitem");

/** How much of the bottom sheet shows: it is as tall as its largest point and moved down by the rest. */
async function visibleSheetHeight(page: Page): Promise<number> {
  const box = (await details(page).boundingBox())!;
  return page.viewportSize()!.height - box.y;
}

/** On a phone the sheet starts at its peek, which shows a chip or two: bring it up to full, where the timeline can be read. */
async function openTimeline(page: Page): Promise<void> {
  if (isWide(page)) return;
  await grip(page).click(); // half
  await grip(page).click(); // full
  await expect(rows(page).first()).toBeInViewport();
}

const DAYS = { "day/2026-10-22": osloDay, "day/2026-10-23": newYorkDay, "places/2": placeCafe }; // the place is what the name of a stop opens

test("day_view_lists_timeline_and_steps_days", async ({ page }) => {
  await fixToday(page);
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
      "Home until 08:32 11h 22m", // home has a house where the number goes (day_view_marks_home_with_a_house), and the other stops are counted from 1
      "Walk · 1.1 km 14m",
      "1 Café 08:46 – 09:10 24m",
      "Cycle · 3.4 km 13m",
      "2 Office 09:23 – 11:41 2h 18m",
      "Drive · 47.8 km 41m",
      "3 Unnamed place 12:22 – 12:50 28m",
      "Flight · 5,900 km 8h 5m",
      "No data 45m",
      "4 Hotel Midtown from 15:40 17h 20m",
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

// Plan 3: home is drawn with a house in place of its number, in the list and on the map, and the other stops are numbered without it. The day of the
// fixture starts at home (an overnight stay in Oslo) and spends the rest at the stops 1 to 4 (the last one, the hotel in New York, is not home).
test("day_view_marks_home_with_a_house", async ({ page }) => {
  await fixToday(page);
  await mockApi(page, DAYS);
  await page.goto("/day/2026-10-22");
  await expect(page.getByRole("region", { name: "Map view" })).toHaveAttribute("data-map-state", "ready");
  await openTimeline(page);

  // The row of home: a picture of a house, hidden from the reader, where a number would be, and the name of the place beside it.
  const home = rows(page).first();
  const pin = home.locator(":scope > :first-child"); // where the number of a stop is
  const house = pin.locator("svg");
  await expect(house).toHaveCount(1);
  await expect(house).toBeVisible();
  await expect(house).toHaveAttribute("aria-hidden", "true");
  await expect(house.locator("path")).toHaveAttribute("d", /^M16 4L/); // the outline of the house of the map, from the same corners
  await expect(pin).toHaveText(""); // no number, and no digit anywhere before the name
  await expect(home).toHaveText("Home until 08:32 11h 22m", { useInnerText: true });
  // It is in the white of the text of a pin (which is pink in both themes), no bigger than the pin and in the middle of it.
  await expect(house).toHaveCSS("color", "rgb(255, 255, 255)");
  // Measured in one go: the sheet of a phone may still be on its way, and two reads of it would not be of the same place.
  const fit = await pin.evaluate((circle) => {
    const [round, picture] = [circle.getBoundingClientRect(), circle.querySelector("svg")!.getBoundingClientRect()];
    return {
      smaller: picture.width < round.width && picture.height < round.height,
      offCentre: [picture.x + picture.width / 2 - (round.x + round.width / 2), picture.y + picture.height / 2 - (round.y + round.height / 2)],
    };
  });
  expect(fit.smaller).toBe(true);
  for (const off of fit.offCentre) expect(Math.abs(off!)).toBeLessThan(1);

  // The other stops are counted from 1, and none of them has a house; the house is the only picture in the list.
  await expect(rows(page).filter({ hasText: /^\d/ })).toHaveText(
    ["1 Café 08:46 – 09:10 24m", "2 Office 09:23 – 11:41 2h 18m", "3 Unnamed place 12:22 – 12:50 28m", "4 Hotel Midtown from 15:40 17h 20m"],
    { useInnerText: true },
  );
  await expect(rows(page).locator("svg")).toHaveCount(1);

  // The buttons say which is home, each with the text that is on its row (the house is a picture: home is named, and told from another home row, by the times); the name of the place still opens the place.
  expect(
    await details(page)
      .getByRole("button", { name: /^Show (stop|home)/ })
      .evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label"))),
  ).toEqual([
    "Show home, Home, until 08:32, on the map",
    "Show stop 1, Café, on the map",
    "Show stop 2, Office, on the map",
    "Show stop 3, unnamed place, on the map",
    "Show stop 4, Hotel Midtown, on the map",
  ]);
  await expect(home.getByRole("button", { name: "Show home, Home, until 08:32, on the map" })).toHaveCount(1);
  await expect(home.getByRole("button", { name: "Home", exact: true })).toBeVisible();
});

test("day_view_row_tap_leaves_the_address_and_a_place_name_opens_the_place", async ({ page }) => {
  await fixToday(page);
  await mockApi(page, DAYS);
  await page.goto("/day/2026-10-22");
  await expect(page.getByRole("region", { name: "Map view" })).toHaveAttribute("data-map-state", "ready");
  await openTimeline(page);

  // A row is a button, and pressing one is not a move to another address: the day stays. (That the map is taken to the segment is
  // day_view_row_tap_takes_the_map_to_the_stop_and_brings_a_full_sheet_down_to_half's, which looks at the map.)
  await details(page).getByRole("button", { name: "Show stop 1, Café, on the map" }).click();
  await details(page).getByRole("button", { name: "Show Cycle · 3.4 km at 09:10 on the map" }).click();
  await expect(page).toHaveURL(/\/day\/2026-10-22$/);

  // Reachable and operable from the keyboard.
  await details(page).getByRole("button", { name: "Show stop 2, Office, on the map" }).focus();
  await expect(details(page).getByRole("button", { name: "Show stop 2, Office, on the map" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/day\/2026-10-22$/);

  // The name of a place opens the place, and does not do what the row does besides.
  await details(page).getByRole("button", { name: "Café", exact: true }).click();
  await expect(page).toHaveURL(/\/place\/2$/);
  await expect(details(page).getByRole("heading", { level: 1, name: "Café" })).toBeVisible(); // and the place is what is shown
});

test("day_view_says_when_a_day_is_empty_and_when_it_is_being_updated", async ({ page }) => {
  await fixToday(page);
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

const PIN: Rgb = [0xff, 0x37, 0x5f];
const WHITE: Rgb = [0xff, 0xff, 0xff];

// The test reads a pixel, which is cheaper to ask for at one to a CSS pixel than at the phone's three (see PIXEL_POLL).
test.describe("the map after a row tap", () => {
  test.use({ deviceScaleFactor: 1 });

  // Ruling P2-R39 and the tap itself: the map is taken to the stop (its pin comes to the middle of the part of the map that nothing
  // covers), and a sheet that was over the map at full comes down to half so that it can be seen.
  test("day_view_row_tap_takes_the_map_to_the_stop_and_brings_a_full_sheet_down_to_half", async ({ page }) => {
    await mockApi(page, DAYS);
    await page.goto("/day/2026-10-22");
    const map = page.getByRole("region", { name: "Map view" });
    await expect(map).toHaveAttribute("data-map-state", "ready");
    await openTimeline(page);
    const { height } = page.viewportSize()!;
    if (!isWide(page)) await expect.poll(() => visibleSheetHeight(page)).toBe(height - 120); // full

    await details(page).getByRole("button", { name: "Show stop 1, Café, on the map" }).click();

    if (isWide(page)) {
      await expect(grip(page)).toHaveCount(0); // a sidebar is not over the map, and there is nothing to lower
    } else {
      await expect.poll(() => visibleSheetHeight(page)).toBe(height / 2);
    }
    // The middle of what is free, as the map was padded for it. The pin has a radius of 12 px (and a 3 px outline over its edge), so a
    // pixel 8 px to the left of its middle is in it and clear of the number in the middle.
    const free = await map.evaluate((element) => {
      const read = (side: string) => parseFloat(element.style.getPropertyValue(`--map-padding-${side}`));
      const box = element.getBoundingClientRect();
      return {
        x: box.left + (read("left") + (box.width - read("right"))) / 2,
        y: box.top + (read("top") + (box.height - read("bottom"))) / 2,
      };
    });
    await expect.poll(async () => sameColour(await pixelAt(page, Math.round(free.x) - 8, Math.round(free.y)), PIN, 8), PIXEL_POLL).toBe(true);
  });

  // Home is a house on its pin, where the number would be (white, over the pink of the pin: its door is a notch, which shows the pink through), and
  // a tap on it opens the place as a tap on any pin does. The row of home brings the map to it, which puts the pin in the middle of what is free.
  test("day_view_draws_home_on_the_map_as_a_house_and_a_tap_on_it_opens_the_place", async ({ page }) => {
    await mockApi(page, { ...DAYS, "places/1": { ...placeCafe, id: 1, name: "Home" } });
    await page.goto("/day/2026-10-22");
    const map = page.getByRole("region", { name: "Map view" });
    await expect(map).toHaveAttribute("data-map-state", "ready");
    await openTimeline(page);
    const { height } = page.viewportSize()!;

    await details(page).getByRole("button", { name: "Show home, Home, until 08:32, on the map" }).click();

    if (!isWide(page)) await expect.poll(() => visibleSheetHeight(page)).toBe(height / 2);
    const free = await map.evaluate((element) => {
      const read = (side: string) => parseFloat(element.style.getPropertyValue(`--map-padding-${side}`));
      const box = element.getBoundingClientRect();
      return {
        x: box.left + (read("left") + (box.width - read("right"))) / 2,
        y: box.top + (read("top") + (box.height - read("bottom"))) / 2,
      };
    });
    const [x, y] = [Math.round(free.x), Math.round(free.y)];
    // The house is 16 px across at one pixel to a CSS pixel (the 32 of its image at twice the density): the middle of it is the walls, white, and the
    // door, 3 px wide and as many high, is a little below the middle; a pixel 8 px to the left is the pin's own.
    const isHouse = async (): Promise<boolean> =>
      sameColour(await pixelAt(page, x, y), WHITE, 12) &&
      sameColour(await pixelAt(page, x, y + 3), PIN, 30) &&
      sameColour(await pixelAt(page, x - 8, y), PIN, 8);
    await expect.poll(isHouse, PIXEL_POLL).toBe(true);

    if (isWide(page)) await page.mouse.click(free.x, free.y);
    else await page.touchscreen.tap(free.x, free.y); // the finger, on a phone
    await expect(page).toHaveURL(/\/place\/1$/);
    await expect(details(page).getByRole("heading", { level: 1, name: "Home" })).toBeVisible();
  });
});
