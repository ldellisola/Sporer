import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./base";
import { mockApi } from "./mockApi";
import { PIXEL_POLL, pixelAt, sameColour, type Rgb } from "./pixel";
import { fixTime } from "./today";
import tripsFixture from "./fixtures/trips.json" with { type: "json" };

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
  await page.goto("/trip/2026-09-12"); // the list is newest first: New York (still going), Lisbon & Sintra, Copenhagen
  await expect(map(page)).toHaveAttribute("data-map-state", "ready");
  const title = page.getByRole("heading", { level: 1 });
  const older = page.getByRole("button", { name: "Older trip" });
  const newer = page.getByRole("button", { name: "Newer trip" });
  await expect(title).toHaveText("Lisbon & Sintra");
  await expect(page.getByText("12 – 16 Sep 2026")).toBeVisible();
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
  await expect(page).toHaveURL(/\/trip\/2026-10-22$/);
  await expect(title).toHaveText("New York");
  await expect(page.getByText("22 – 24 Oct 2026")).toBeVisible(); // an ongoing trip ends the day after its last night
  await expect(newer).toBeDisabled(); // the newest trip

  await page.keyboard.press("ArrowRight"); // nowhere to go
  await expect(page).toHaveURL(/\/trip\/2026-10-22$/);
  await page.keyboard.press("ArrowLeft");
  await expect(page).toHaveURL(/\/trip\/2026-09-12$/);
  await expect(title).toHaveText("Lisbon & Sintra");
});

const grip = (page: Page): Locator => page.getByRole("button", { name: "Resize panel" });

/** On a phone the sheet starts at its peek, which shows no card: bring it up to full, where the list can be read and its cards tapped. */
async function openSheet(page: Page): Promise<void> {
  if (isWide(page)) return;
  await grip(page).click(); // half
  await grip(page).click(); // full
  await expect(details(page).getByRole("heading", { name: "Trips" })).toBeInViewport();
}

const PIN: Rgb = [0xff, 0x37, 0x5f];
const BACKGROUND: Rgb = [0xdf, 0xe6, 0xea]; // the flat style of the test (public/test-style.json)

/** The position of every city of the fixture's trips, longitude first, and the four that the tests look for. */
const CITIES = tripsFixture.trips.flatMap((trip) => trip.cities.map((city): [number, number] => [city.lon, city.lat]));
const NEW_YORK: [number, number] = [-73.986, 40.755]; // the most to the west
const LISBON: [number, number] = [-9.14, 38.72]; // where the most nights were, the biggest dot
const COPENHAGEN: [number, number] = [12.57, 55.68]; // the most to the east

/** A position as a point of the world on a map of Web Mercator, from 0 to 1 each way, y growing southward. */
const worldOf = ([lon, lat]: [number, number]) => ({
  x: (lon + 180) / 360,
  y: (1 - Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / Math.PI) / 2,
});

/**
 * The air that the fit leaves at the left and at the right of what is free while a dot has a label, so that the outermost dots' names stay on
 * the screen (`LABEL_AIR_PX` of MapView). The cities of the trips are all named, so their fit has it; the padding that the controls are set in
 * (`--map-padding-*`) has not.
 */
const LABEL_AIR = 72;

/**
 * Where on the page `at` is once the map has been brought to all of `positions`, as the map is when it is fitted: what the bar and the panel
 * leave free (it is padded for them), less `sideAir` at the left and at the right, is filled by the box of the positions on the side that it
 * is longer, and the box is in the middle of it. A map that has been fitted to dots that carry no label has no `sideAir`. This is also the
 * check that the fit leaves the room for the labels: the dots of the easternmost and the westernmost city are drawn where the air puts them.
 *
 * A map is kept inside the world, which is as high as it is wide and ends at ±85° of latitude: the middle of the map is never nearer to the
 * top or to the bottom of it than half the map's height. A box that is wide and a free width that is narrow (a phone, with the air) fit at
 * a zoom at which the world is hardly higher than the map, and then the middle of the box is not where the middle of what is free is.
 */
async function whereOnThePage(page: Page, positions: [number, number][], at: [number, number], sideAir = 0): Promise<{ x: number; y: number }> {
  const free = await map(page).evaluate((element, air) => {
    const read = (side: string) => parseFloat(element.style.getPropertyValue(`--map-padding-${side}`));
    const box = element.getBoundingClientRect();
    return {
      left: box.left + read("left") + air,
      top: box.top + read("top"),
      width: box.width - read("left") - read("right") - 2 * air,
      height: box.height - read("top") - read("bottom"),
      mapMiddle: box.top + box.height / 2,
      mapHeight: box.height,
    };
  }, sideAir);
  const world = positions.map(worldOf);
  const [west, east] = [Math.min(...world.map((p) => p.x)), Math.max(...world.map((p) => p.x))];
  const [north, south] = [Math.min(...world.map((p) => p.y)), Math.max(...world.map((p) => p.y))];
  const scale = Math.min(free.width / (east - west), free.height / (south - north)); // pixels for the width of the world
  const target = worldOf(at);
  const half = free.mapHeight / 2 / scale; // half the height of the map, as a share of the world's
  const middleOfMap = (north + south) / 2 + (free.mapMiddle - (free.top + free.height / 2)) / scale; // where the map's middle is, if it is not kept in
  const kept = Math.min(Math.max(middleOfMap, half), 1 - half);
  return {
    x: Math.round(free.left + free.width / 2 + (target.x - (west + east) / 2) * scale),
    y: Math.round(free.mapMiddle + (target.y - kept) * scale),
  };
}

/**
 * Waits until the camera has come to rest at (`x`, `y`) rather than for as long as its flight takes (600 ms of `FIT_DURATION_MS`, and the
 * frames of a busy runner): the picture round the point is the same on two reads in a row, which a map still moving does not give.
 */
async function cameraAtRest(page: Page, x: number, y: number): Promise<void> {
  let last = "";
  await expect
    .poll(async () => {
      const now = (await page.screenshot({ clip: { x: x - 24, y: y - 24, width: 48, height: 48 } })).toString("base64");
      const still = now === last;
      last = now;
      return still;
    }, PIXEL_POLL)
    .toBe(true);
}

// The test reads pixels, which is cheaper to ask for at one to a CSS pixel than at the phone's three (see PIXEL_POLL).
test.describe("the trips list", () => {
  test.use({ deviceScaleFactor: 1 });

  // Mockup: a card for each trip, newest first, with a picture of where it went; and the map shows the cities of all the trips, the biggest
  // where the most nights were, with the map brought to all of them. The cities are where the dots are only once the camera has come to
  // rest (600 ms), so what is read is polled.
  test("trips_list_shows_cards_and_the_map_of_all_trips", async ({ page }) => {
    // Three polls of PIXEL_POLL run one after the other, which is more than the 30 s that Playwright gives a test (see PIXEL_POLL).
    test.setTimeout(30_000 + 3 * PIXEL_POLL.timeout);
    await fixToday(page);
    const api = await mockApi(page);
    await page.goto("/trips");
    await expect(map(page)).toHaveAttribute("data-map-state", "ready");
    const list = details(page).getByRole("list", { name: "Trips" });
    await expect(list.getByRole("listitem")).toHaveCount(3);

    // The cards, newest first, each named by what it says: the trip, its dates and nights (one line, as it is shown) and its cities.
    expect(await list.getByRole("button").evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label")))).toEqual([
      "Open New York, Ongoing, 22 – 24 Oct 2026 · 2 nights, New York",
      "Open Lisbon & Sintra, 12 – 16 Sep 2026 · 4 nights, Lisbon · Sintra",
      "Open Copenhagen, 1 – 3 Aug 2026 · 2 nights, Copenhagen",
    ]);
    const lisbon = list.getByRole("button", { name: /^Open Lisbon & Sintra/ });
    await expect(lisbon).toContainText("Lisbon & Sintra");
    await expect(lisbon).toContainText("12 – 16 Sep 2026 · 4 nights");
    await expect(lisbon).toContainText("Lisbon · Sintra");
    await expect(details(page).getByText("Ongoing")).toHaveCount(1); // the trip that has not come home, and no other
    await expect(list.getByRole("button", { name: /^Open New York/ }).getByText("Ongoing")).toBeVisible();
    // The picture: drawn small, in the accent colour (the line is drawn by the style sheet, which would have left it black otherwise).
    const picture = lisbon.locator("svg");
    await expect(picture).toBeVisible();
    await expect(picture).toHaveAttribute("viewBox", "0 0 72 48");
    await expect(picture.locator("path")).toHaveCSS("stroke", "rgb(0, 122, 255)");
    expect(await picture.locator("circle").count()).toBe(2); // where it slept: Lisbon and Sintra, between the two times it was at home
    await expect(page.getByRole("button", { name: "Heat map" })).toHaveCount(0); // the trips have no period to show the heat of
    expect(api.requests.filter((request) => !["/api/status", "/api/config"].includes(request))).toEqual(["/api/trips"]); // one request: the cards and the map share it

    // The map: a dot for each city, where it is once the map has been brought to all of them, from New York to Copenhagen.
    const dotAt = async (at: [number, number]) => {
      const { x, y } = await whereOnThePage(page, CITIES, at, LABEL_AIR);
      return sameColour(await pixelAt(page, x, y), PIN, 30);
    };
    await expect.poll(() => dotAt(NEW_YORK), PIXEL_POLL).toBe(true);
    await expect.poll(() => dotAt(COPENHAGEN), PIXEL_POLL).toBe(true);
    await expect.poll(() => dotAt(LISBON), PIXEL_POLL).toBe(true);
    // Between New York and Lisbon there is nothing: the map shows the cities, and no line from one to the next.
    const between = await whereOnThePage(page, CITIES, [(NEW_YORK[0] + LISBON[0]) / 2, (NEW_YORK[1] + LISBON[1]) / 2], LABEL_AIR);
    expect(sameColour(await pixelAt(page, between.x, between.y), BACKGROUND)).toBe(true);

    // A card opens its trip, and Back is to the list.
    await openSheet(page);
    await lisbon.click();
    await expect(page).toHaveURL(/\/trip\/2026-09-12$/);
    await expect(page.getByRole("heading", { level: 1, name: "Lisbon & Sintra" })).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(/\/trips$/);
    await expect(list.getByRole("listitem")).toHaveCount(3);
  });

  // A city is no place: its dot is drawn and is not tapped, and the pointer over it is the ordinary one (a dot of a place would open it).
  test("trips_map_city_dots_open_nothing", async ({ page }) => {
    test.setTimeout(30_000 + 2 * PIXEL_POLL.timeout);
    await fixToday(page);
    await mockApi(page);
    await page.goto("/trips");
    await expect(map(page)).toHaveAttribute("data-map-state", "ready");
    await expect(details(page).getByRole("list", { name: "Trips" }).getByRole("listitem")).toHaveCount(3);
    const { x, y } = await whereOnThePage(page, CITIES, COPENHAGEN, LABEL_AIR); // the most to the east: well clear of the sheet, the bar and the sidebar
    await expect.poll(async () => sameColour(await pixelAt(page, x, y), PIN, 30), PIXEL_POLL).toBe(true);
    await cameraAtRest(page, x, y);

    await page.mouse.move(x - 2, y - 2);
    await page.mouse.move(x, y);
    await expect(map(page).locator("canvas.maplibregl-canvas")).not.toHaveCSS("cursor", "pointer");
    if (isWide(page)) await page.mouse.click(x, y);
    else await page.touchscreen.tap(x, y); // the finger, on a phone

    // That nothing opened is no matter of how long to wait. A tap on a place navigates in the click's own handler, so it had done so by the
    // time the click returned (the browser answers an input event once the page has handled it); a frame or two later is only to be sure
    // that nothing the page had queued is still to run, and then the address is the one it was.
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page).toHaveURL(/\/trips$/, { timeout: 1000 });
    expect(sameColour(await pixelAt(page, x, y), PIN, 30)).toBe(true); // and the dot is still there, under the finger
  });
});
