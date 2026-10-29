import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./base";
import { LABEL_AIR, whereOnThePage } from "./fit";
import { mockApi } from "./mockApi";
import { inkIn, PIXEL_POLL, pixelAt, sameColour, type Rgb } from "./pixel";
import { sheetAtRest } from "./sheet";
import { fixTime } from "./today";
import lisbonTrip from "./fixtures/trip-2026-09-12.json" with { type: "json" };
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

test("trips_button_opens_the_trips_list", { tag: "@smoke" }, async ({ page }) => {
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
  await expect(page.getByRole("button", { name: "Heat map" })).toBeVisible(); // a trip has a period to show the heat of, its own dates
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
  await sheetAtRest(page);
  await expect(details(page).getByRole("heading", { name: "Trips" })).toBeInViewport();
}

/**
 * On a phone the sheet starts at its peek, which shows no card: bring it up to half, where the list can be read and its cards tapped and the map
 * above it is still in view (at full the sheet covers it, and the dots that the map draws there are under it, though the fit is made for half).
 */
async function halfSheet(page: Page): Promise<void> {
  if (isWide(page)) return;
  await grip(page).click();
  await sheetAtRest(page);
  await expect(details(page).getByRole("list", { name: "Trips" })).toBeInViewport({ ratio: 1 });
}

// P3-R21: the shell never scrolls, whatever is focused or clicked in the sheet that moves over it. The sheet is as tall as its highest point and moved
// down by what is not shown, so that a card of the list can be well below the screen while the sheet is at its peek, and focusing it asks the browser
// to bring it into view: a shell that is `overflow: hidden` is scrolled by that (nothing can scroll it by hand, and code can), and the map, the bar and
// the padding the map is given are then not where they were measured. `overflow: clip` has nothing to scroll. On a desktop the sidebar is fixed and
// there is nothing to see, which is no reason not to look.
test("focusing_a_card_in_the_sheet_never_scrolls_the_shell", async ({ page }) => {
  await fixToday(page);
  await mockApi(page);
  await page.goto("/trips");
  await expect(map(page)).toHaveAttribute("data-map-state", "ready");
  const cards = details(page).getByRole("list", { name: "Trips" }).getByRole("button");
  await expect(cards).toHaveCount(3);
  const scrolledBy = () => page.locator("main[data-layout]").evaluate((shell) => [shell.scrollTop, shell.scrollLeft]);

  await cards.last().focus(); // on a phone: below the edge of the screen, with the sheet at its peek
  expect(await scrolledBy()).toEqual([0, 0]);

  if (!isWide(page)) await grip(page).click(); // and on its way up, which is when a card was clicked and the shell scrolled
  await cards.nth(1).focus();
  expect(await scrolledBy()).toEqual([0, 0]);
  await sheetAtRest(page);
  await cards.first().focus();
  expect(await scrolledBy()).toEqual([0, 0]);
  await expect(page.locator("main[data-layout]")).toHaveCSS("overflow", "clip"); // what makes it so
});

const PIN: Rgb = [0xff, 0x37, 0x5f];
const BACKGROUND: Rgb = [0xdf, 0xe6, 0xea]; // the flat style of the test (public/test-style.json)

/** The position of every city of the fixture's trips, longitude first, and the four that the tests look for. */
const CITIES = tripsFixture.trips.flatMap((trip) => trip.cities.map((city): [number, number] => [city.lon, city.lat]));
const NEW_YORK: [number, number] = [-73.986, 40.755]; // the most to the west
const LISBON: [number, number] = [-9.14, 38.72]; // where the most nights were, the biggest dot
const COPENHAGEN: [number, number] = [12.57, 55.68]; // the most to the east

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
    // Four polls of PIXEL_POLL run one after the other, which is more than the 30 s that Playwright gives a test (see PIXEL_POLL).
    test.setTimeout(30_000 + 4 * PIXEL_POLL.timeout);
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
    // The label of the easternmost city is drawn whole (P3-R20): it points toward the inside of the drawing, so its text is on the left of its dot, and
    // none of it is cut off by the edge of the screen. MapLibre does not move a label that has been put beyond the edge of the window back inside it,
    // which is what the label of Copenhagen was, at the right of its dot at the edge of the fit: its ink is around the dot, and the last columns of the
    // screen have none.
    const east = await whereOnThePage(page, CITIES, COPENHAGEN, LABEL_AIR);
    const { width } = page.viewportSize()!;
    const labelDrawnWhole = async (): Promise<boolean> => {
      const left = east.x - 100;
      const right = Math.min(width, east.x + 60);
      const around = await inkIn(page, { x: left, y: east.y - 32, width: right - left, height: 64 });
      const atTheEdge = await inkIn(page, { x: width - 4, y: east.y - 32, width: 4, height: 64 });
      return around > 100 && atTheEdge === 0;
    };
    await expect.poll(labelDrawnWhole, PIXEL_POLL).toBe(true);
    // Between New York and Lisbon there is nothing: the map shows the cities, and no line from one to the next. A name may be written across some of the
    // way (a label is put beside its dot, toward the inside of the drawing, which is toward the other city), but a line would be across all of it.
    let background = 0;
    for (const share of [0.2, 0.3, 0.4, 0.5, 0.6, 0.7]) {
      const at: [number, number] = [NEW_YORK[0] + (LISBON[0] - NEW_YORK[0]) * share, NEW_YORK[1] + (LISBON[1] - NEW_YORK[1]) * share];
      const { x, y } = await whereOnThePage(page, CITIES, at, LABEL_AIR);
      if (sameColour(await pixelAt(page, x, y), BACKGROUND)) background += 1;
    }
    expect(background).toBeGreaterThanOrEqual(3);

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

/** Every position the Lisbon trip draws, longitude first: the points of its moves and its cities, which is what the map is brought to. */
const LISBON_TRIP: [number, number][] = [
  ...lisbonTrip.moves.flatMap((move) => move.geometry.map(([lon, lat]): [number, number] => [lon!, lat!])),
  ...lisbonTrip.cities.map((city): [number, number] => [city.lon, city.lat]),
];

// Spec 9, opening a trip: the card opens the trip, the map is brought to all of it and the sheet lists its days, a day opens the Day view, and the
// arrows step to the trips either side. The heat of a trip is the heat of its dates, and of no other trip.
test.describe("a trip", () => {
  test.use({ deviceScaleFactor: 1 });

  test("opening_a_trip_from_the_list_shows_its_days_and_steps_to_the_next_trip", { tag: "@smoke" }, async ({ page }) => {
    // Four polls of PIXEL_POLL run one after the other (Lisbon's dot, Lisbon's dot again, Copenhagen's, and the background where Lisbon was), which is more
    // than the 30 s that Playwright gives a test (see PIXEL_POLL).
    test.setTimeout(30_000 + 4 * PIXEL_POLL.timeout);
    await fixToday(page);
    const api = await mockApi(page);
    await page.goto("/trips");
    await expect(map(page)).toHaveAttribute("data-map-state", "ready");
    const list = details(page).getByRole("list", { name: "Trips" });
    await expect(list.getByRole("listitem")).toHaveCount(3);

    await halfSheet(page);
    await list.getByRole("button", { name: /^Open Lisbon & Sintra/ }).click();

    // The bar names the trip, and the panel has its figures and its days, one row for each.
    await expect(page).toHaveURL(/\/trip\/2026-09-12$/);
    await expect(page.getByRole("heading", { level: 1, name: "Lisbon & Sintra" })).toBeVisible();
    for (const chip of ["2 flights", "2 cities", "9 places", "169 km on the ground"]) await expect(details(page).getByText(chip, { exact: true })).toBeVisible();
    await expect(details(page).getByText("Ongoing")).toHaveCount(0); // it came home
    const days = details(page).getByRole("list", { name: "Day by day" });
    await expect(days.getByRole("listitem")).toHaveCount(5);
    expect(await days.getByRole("button").evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label")))).toEqual([
      "Open Sat 12 Sep, Oslo → Lisbon, Oslo Airport, Lisbon Airport, 55.7 km, 1 flight",
      "Open Sun 13 Sep, Lisbon, Alfama Viewpoint, Time Out Market, 6.8 km",
      "Open Mon 14 Sep, Lisbon, Belém Tower, LX Factory, Pastéis de Belém, 9.1 km",
      "Open Tue 15 Sep, Lisbon → Sintra, Pena Palace, Quinta da Regaleira, 38.5 km",
      "Open Wed 16 Sep, Sintra → Oslo, Lisbon Airport, Oslo Airport, 59.2 km, 1 flight",
    ]);
    const monday = days.getByRole("button", { name: /^Open Mon 14 Sep/ });
    await expect(monday).toContainText("Belém Tower, LX Factory, Pastéis de Belém");
    await expect(days.getByRole("button", { name: /^Open Sat 12 Sep/ }).locator('[aria-hidden="true"]')).toHaveText("✈"); // a flight: the plane, which is no text
    await expect(monday.locator('[aria-hidden="true"]')).toHaveCount(0); // and a day with none has no plane

    // The map is brought to the whole trip, Oslo to Lisbon, which is where Lisbon's dot (the biggest: 3 of the 4 nights) is drawn.
    await expect(page.getByRole("button", { name: "Heat map" })).toBeVisible();
    const lisbonAt = async () => {
      const { x, y } = await whereOnThePage(page, LISBON_TRIP, [-9.14, 38.72], LABEL_AIR);
      return sameColour(await pixelAt(page, x, y), PIN, 30);
    };
    await expect.poll(lisbonAt, PIXEL_POLL).toBe(true);

    // A day opens the Day view, and back is to the trip, which is brought to again.
    await monday.click();
    await expect(page).toHaveURL(/\/day\/2026-09-14$/);
    await expect(page.getByRole("heading", { level: 1, name: "Monday 14 September" })).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(/\/trip\/2026-09-12$/);
    await expect(days.getByRole("listitem")).toHaveCount(5);
    await expect.poll(lisbonAt, PIXEL_POLL).toBe(true);

    // ‹ steps to the next trip, the older one: its own name, its own figures (the mock has no day for it), and its one city is what the map shows,
    // at the middle of what is free; nothing of the trip that was left.
    await page.getByRole("button", { name: "Older trip" }).click();
    await expect(page).toHaveURL(/\/trip\/2026-08-01$/);
    await expect(page.getByRole("heading", { level: 1, name: "Copenhagen" })).toBeVisible();
    await expect(details(page).getByText("No days to show for this trip")).toBeVisible();
    await expect(details(page).getByText("1 city", { exact: true })).toBeVisible();
    await expect(details(page).getByText("2 flights")).toHaveCount(0); // none of the trip that was left
    await expect(days).toHaveCount(0);
    const copenhagen = await whereOnThePage(page, [COPENHAGEN], COPENHAGEN, LABEL_AIR);
    await expect.poll(async () => sameColour(await pixelAt(page, copenhagen.x, copenhagen.y), PIN, 30), PIXEL_POLL).toBe(true);
    const lisbon = await whereOnThePage(page, LISBON_TRIP, [-9.14, 38.72], LABEL_AIR);
    await expect.poll(async () => sameColour(await pixelAt(page, lisbon.x, lisbon.y), BACKGROUND), PIXEL_POLL).toBe(true); // Lisbon's dot is far away now

    // The heat is off, and a trip is no range: no heat and no range was asked for on the way (the day that was opened is asked for, as it is).
    expect(api.requests.filter((request) => /^\/api\/(range|heat)/.test(request))).toEqual([]);
  });

  test("trip_heat_is_the_heat_of_the_trips_own_dates_and_of_no_other_trip", async ({ page }) => {
    await fixToday(page);
    const api = await mockApi(page);
    await page.goto("/trip/2026-09-12");
    await expect(map(page)).toHaveAttribute("data-map-state", "ready");
    const heat = page.getByRole("button", { name: "Heat map" });
    await expect(heat).toHaveAttribute("aria-pressed", "false");
    await expect(details(page).getByRole("list", { name: "Day by day" })).toBeVisible();
    expect(api.requests.filter((request) => request.startsWith("/api/heat"))).toEqual([]); // off: not asked for

    await heat.click();

    await expect(heat).toHaveAttribute("aria-pressed", "true");
    await expect.poll(() => api.requests.filter((request) => request.startsWith("/api/heat"))).toEqual(["/api/heat?from=2026-09-12&to=2026-09-16"]); // localStartDate to localEndDate

    // The heat stays on for the trip stepped to, and is the heat of that trip's dates: the glow of the one left is not asked for again.
    await page.getByRole("button", { name: "Older trip" }).click();
    await expect(page).toHaveURL(/\/trip\/2026-08-01$/);
    await expect(page.getByRole("heading", { level: 1, name: "Copenhagen" })).toBeVisible();
    await expect(heat).toHaveAttribute("aria-pressed", "true");
    await expect.poll(() => api.requests.filter((request) => request.startsWith("/api/heat"))).toEqual([
      "/api/heat?from=2026-09-12&to=2026-09-16",
      "/api/heat?from=2026-08-01&to=2026-08-03",
    ]);
    await expect(page.getByRole("alert")).toHaveCount(0); // no "Couldn't load the heat map"
  });
});
