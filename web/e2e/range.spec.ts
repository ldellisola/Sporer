import type { Locator, Page, Request } from "@playwright/test";
import { expect, test } from "./base";
import october from "./fixtures/range-october.json" with { type: "json" };
import { mockApi, type Reply } from "./mockApi";
import { PIXEL_POLL, pixelAt, sameColour, type Rgb } from "./pixel";
import { fixTime } from "./today";

// The browser is in Oslo, so that "today" is a date that is the same wherever the test is run (see `fixToday`).
test.use({ timezoneId: "Europe/Oslo" });

/**
 * Fixes today at Saturday 24 October, in the middle of the month of the fixture: the days of a period that are after today are not
 * listed, and no date of the fixture is to depend on the clock that the test is run on.
 */
const fixToday = (page: Page): Promise<void> => fixTime(page, "2026-10-24T08:00:00Z");

const isWide = (page: Page): boolean => page.viewportSize()!.width >= 900;
const details = (page: Page): Locator => page.getByRole(isWide(page) ? "complementary" : "region", { name: "Details" });
const grip = (page: Page): Locator => page.getByRole("button", { name: "Resize panel" });
const map = (page: Page): Locator => page.getByRole("region", { name: "Map view" });
const placeRows = (page: Page): Locator => details(page).getByRole("list", { name: "Where your time went" }).getByRole("listitem");
const dayRows = (page: Page): Locator => details(page).getByRole("list", { name: "Days" }).getByRole("listitem");

/** On a phone the sheet starts at its peek, which shows a chip or two: bring it up to full, where the lists can be read. */
async function openSheet(page: Page): Promise<void> {
  if (isWide(page)) return;
  await grip(page).click(); // half
  await grip(page).click(); // full
  await expect(details(page).getByRole("heading", { name: "Where your time went" })).toBeInViewport();
}

const empty = (from: string, to: string) => ({
  from,
  to,
  state: "done",
  summary: { places: 0, distanceMeters: 0, movingSeconds: 0, moves: 0 },
  moves: [],
  places: [],
  days: [],
});

/** What the range of 5 to 12 October holds: the first four moves of the month, three of its places and three of its days. */
const PICKED = {
  ...empty("2026-10-05", "2026-10-12"),
  summary: { places: 3, distanceMeters: 12_200, movingSeconds: 3780, moves: 4 },
  moves: october.moves.slice(0, 4),
  places: [
    { ...october.places[0]!, seconds: 360_000 }, // Home, 100 h
    { ...october.places[4]!, seconds: 5400 }, // Café, 1 h 30 m
    { ...october.places[2]!, seconds: 10_800 }, // Gym, 3 h
  ].sort((a, b) => b.seconds - a.seconds),
  days: october.days.slice(0, 3),
};

/** The Gym of the fixture (a place of the ranking, 6 visits and 20 hours) as the place view has it, for the row that opens it. */
const GYM = {
  id: 6,
  name: "Gym",
  address: "Storgata 40, Oslo",
  city: "Oslo",
  country: "Norway",
  lat: 59.89,
  lon: 10.7,
  totalSeconds: 72_000,
  visits: 6,
  firstVisit: "2026-10-05T16:00:00Z",
  lastVisit: "2026-10-22T16:00:00Z",
  recentVisits: [],
};

/** The month of the fixture, the range that is picked, and nothing for any other dates (the periods either side are asked for too). */
const RANGES: Record<string, object> = { "2026-10-01..2026-10-31": october, "2026-10-05..2026-10-12": PICKED };
const answers = {
  "places/6": GYM,
  range: (request: Request): Reply => {
    const { searchParams } = new URL(request.url());
    const [from, to] = [searchParams.get("from")!, searchParams.get("to")!];
    return { json: RANGES[`${from}..${to}`] ?? empty(from, to) };
  },
};

test("month_view_and_range_picker", async ({ page }) => {
  await fixToday(page);
  const api = await mockApi(page, answers);
  await page.goto("/day/2026-10-22");
  await expect(map(page)).toHaveAttribute("data-map-state", "ready");

  // Month keeps the day that was looked at in its month, and shows the month: its chips, and where the time went, most first.
  await page.getByRole("button", { name: "Month", exact: true }).click();
  await expect(page).toHaveURL(/\/month\/2026-10$/);
  await expect(page.getByRole("heading", { name: "October 2026", level: 1 })).toBeVisible();
  await expect(details(page).getByText("6 places", { exact: true })).toBeVisible();
  await expect(details(page).getByText("41.3 km", { exact: true })).toBeVisible();
  await expect(details(page).getByText("9 moves", { exact: true })).toBeVisible();
  await openSheet(page);
  await expect(placeRows(page)).toHaveText(
    ["Home 400h 0m", "Office 100h 0m", "Gym 20h 0m", "Parents 10h 0m", "Café 8h 0m", "Oslo 4h 0m"],
    { useInnerText: true },
  );
  // The bars are shares of the top place.
  const bars = details(page).getByRole("list", { name: "Where your time went" }).locator("[aria-hidden] > span");
  expect(await bars.evaluateAll((fills) => fills.map((fill) => (fill as HTMLElement).style.width))).toEqual([
    "100%",
    "25%",
    "5%",
    "2.5%",
    "2%",
    "1%",
  ]);
  // Every date of the month up to today, those with no movement said to have none; the days that are to come are not listed.
  await expect(dayRows(page)).toHaveCount(24);
  await expect(dayRows(page).first()).toHaveText("Thu 1 Oct No movement", { useInnerText: true });
  await expect(dayRows(page).nth(21)).toHaveText("Thu 22 Oct 6.9 km · 2 places", { useInnerText: true });
  await expect(dayRows(page).last()).toHaveText("Sat 24 Oct No movement", { useInnerText: true });
  await expect(details(page).getByRole("button", { name: "Open Sun 25 Oct" })).toHaveCount(0);

  // The months either side were asked for as soon as this one was shown, so ‹ and › find them at hand.
  await expect.poll(() => api.requests).toContain("/api/range?from=2026-09-01&to=2026-09-30");
  await expect.poll(() => api.requests).toContain("/api/range?from=2026-11-01&to=2026-11-30");

  // A day opens its day, with movement or without; Back is to the month.
  await details(page).getByRole("button", { name: "Open Fri 2 Oct" }).click();
  await expect(page).toHaveURL(/\/day\/2026-10-02$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/month\/2026-10$/);
  await details(page).getByRole("button", { name: "Open Thu 22 Oct" }).click();
  await expect(page).toHaveURL(/\/day\/2026-10-22$/);
  await expect(page.getByRole("heading", { name: "Thursday 22 October", level: 1 })).toBeVisible();
  await page.goBack();
  await details(page).getByRole("button", { name: "Open Gym" }).click();
  await expect(page).toHaveURL(/\/place\/6$/);
  await expect(details(page).getByRole("heading", { level: 1, name: "Gym" })).toBeVisible();
  await page.goBack();

  // Range: its fields start as the month, and the dates are entered with fill (the field takes a valid date after a pause).
  await page.getByRole("button", { name: "Range", exact: true }).click();
  await expect(page).toHaveURL(/\/range\/2026-10-01\.\.2026-10-31$/);
  await page.getByLabel("From", { exact: true }).fill("2026-10-05");
  await expect(page).toHaveURL(/\/range\/2026-10-05\.\.2026-10-31$/);
  await page.getByLabel("To", { exact: true }).fill("2026-10-12");
  await expect(page).toHaveURL(/\/range\/2026-10-05\.\.2026-10-12$/);
  await expect(page.getByRole("heading", { name: "5 Oct – 12 Oct 2026", level: 1 })).toBeVisible();

  // The panel is the range's: its own chips and places, and each of its eight dates.
  await expect(details(page).getByText("3 places", { exact: true })).toBeVisible();
  await expect(details(page).getByText("12.2 km", { exact: true })).toBeVisible();
  await expect(details(page).getByText("4 moves", { exact: true })).toBeVisible();
  await expect(placeRows(page)).toHaveText(["Home 100h 0m", "Gym 3h 0m", "Café 1h 30m"], { useInnerText: true });
  await expect(dayRows(page)).toHaveCount(8);
  await expect(dayRows(page).first()).toHaveText("Mon 5 Oct 4.5 km · 3 places", { useInnerText: true });
  await expect(dayRows(page).nth(1)).toHaveText("Tue 6 Oct 2.9 km · 2 places", { useInnerText: true });
  await expect(dayRows(page).nth(2)).toHaveText("Wed 7 Oct No movement", { useInnerText: true });
});

// A deep link to a range of more than 400 days, which the API refuses: the address is replaced by the range's first 400 days, and it is
// those that are asked for (no Retry would ever have loaded the long one).
test("a_range_deep_linked_longer_than_400_days_is_cut_to_its_first_400", async ({ page }) => {
  const api = await mockApi(page);

  await page.goto("/range/2025-01-01..2026-12-31");

  await expect(page).toHaveURL(/\/range\/2025-01-01\.\.2026-02-04$/);
  await expect(page.getByRole("heading", { name: "1 Jan 2025 – 4 Feb 2026", level: 1 })).toBeVisible();
  await expect(details(page).getByText("No data for this period")).toBeVisible(); // the mock's empty answer, and no error
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(api.requests).toContain("/api/range?from=2025-01-01&to=2026-02-04");
  expect(api.requests.filter((request) => request.includes("2026-12-31"))).toEqual([]);
});

const PIN: Rgb = [0xff, 0x37, 0x5f];
const BACKGROUND: Rgb = [0xdf, 0xe6, 0xea]; // the flat style of the test (public/test-style.json)

/** The middle of what the sheet and the bar leave free of the map (it is padded for them), where the map is brought to what it draws. */
const middleOfWhatIsFree = (page: Page) =>
  map(page).evaluate((element) => {
    const read = (side: string) => parseFloat(element.style.getPropertyValue(`--map-padding-${side}`));
    const box = element.getBoundingClientRect();
    return {
      x: box.left + (read("left") + (box.width - read("right"))) / 2,
      y: box.top + (read("top") + (box.height - read("bottom"))) / 2,
    };
  });

// The test reads pixels, which is cheaper to ask for at one to a CSS pixel than at the phone's three (see PIXEL_POLL).
test.describe("the map of a month", () => {
  test.use({ deviceScaleFactor: 1 });

  // Mockup 2A: a month's routes faint, a dot for each place sized by time, the map brought to all of it. The fixture is laid out round
  // Home, which is the most time spent and the middle of everything drawn, so the middle of what the sheet and the bar leave free of
  // the map lies on its dot: the dot is drawn, it is the biggest, and the camera was brought to the month.
  test("month_view_draws_a_dot_for_the_places_and_brings_the_map_to_the_month", async ({ page }) => {
    await mockApi(page, answers);
    await page.goto("/month/2026-10");
    await expect(map(page)).toHaveAttribute("data-map-state", "ready");
    await expect(details(page).getByText("6 places", { exact: true })).toBeVisible();

    const free = await middleOfWhatIsFree(page);

    // The dot is the pin's pink at 92 % over the flat background of the test style and the faint routes under it, hence the tolerance.
    await expect.poll(async () => sameColour(await pixelAt(page, Math.round(free.x), Math.round(free.y)), PIN, 30), PIXEL_POLL).toBe(true);
  });
});

/** Home as the place view has it, for the dot that opens it. */
const HOME = {
  id: 1,
  name: "Home",
  address: "Storgata 1, Oslo",
  city: "Oslo",
  country: "Norway",
  lat: 59.91,
  lon: 10.75,
  totalSeconds: 1_440_000,
  visits: 22,
  firstVisit: "2026-10-01T05:00:00Z",
  lastVisit: "2026-10-22T20:00:00Z",
  recentVisits: [],
};

// Spec 4.6: a place is reached by tapping it anywhere, the dots of the map too. The map is brought to the month in 600 ms, and a dot is
// where it is only once that is over: a click that comes too soon finds nothing there and is tried again (`toPass`), as a finger would be.
test.describe("a dot of the month", () => {
  test.use({ deviceScaleFactor: 1 });

  const FLIGHT_MS = 600; // the camera's flight to the month (FIT_DURATION_MS of MapView)

  test("month_view_tap_on_a_dot_opens_the_place", async ({ page }) => {
    await mockApi(page, { ...answers, "places/1": HOME });
    await page.goto("/month/2026-10");
    await expect(map(page)).toHaveAttribute("data-map-state", "ready");
    await expect(details(page).getByText("6 places", { exact: true })).toBeVisible();
    const free = await middleOfWhatIsFree(page);
    const [x, y] = [Math.round(free.x), Math.round(free.y)]; // Home's dot, the biggest and the middle of all that is drawn
    await expect.poll(async () => sameColour(await pixelAt(page, x, y), PIN, 30), PIXEL_POLL).toBe(true);

    await expect(async () => {
      if (isWide(page)) await page.mouse.click(x, y);
      else await page.touchscreen.tap(x, y); // the finger, on a phone
      await expect(page).toHaveURL(/\/place\/1$/, { timeout: 1000 });
    }).toPass({ timeout: 15_000 });

    await expect(details(page).getByRole("heading", { level: 1, name: "Home" })).toBeVisible();
    await expect(map(page)).toHaveAttribute("data-map-state", "ready");
  });

  // Home's dot is the biggest, 16 px of radius with its 2 px outline: a tap 22 px below its middle is beside it, not on it, and is where a
  // finger lands when it aims at the dot. It is within 12 px of the dot, and the other places are some 50 px away at the least.
  test("month_view_a_tap_a_few_pixels_beside_a_dot_still_opens_it", async ({ page }) => {
    await mockApi(page, { ...answers, "places/1": HOME });
    await page.goto("/month/2026-10");
    await expect(map(page)).toHaveAttribute("data-map-state", "ready");
    await expect(details(page).getByText("6 places", { exact: true })).toBeVisible();
    const free = await middleOfWhatIsFree(page);
    const [x, y] = [Math.round(free.x), Math.round(free.y)];
    await expect.poll(async () => sameColour(await pixelAt(page, x, y), PIN, 30), PIXEL_POLL).toBe(true);
    await expect.poll(async () => sameColour(await pixelAt(page, x, y + 22), PIN, 30), PIXEL_POLL).toBe(false); // there is no dot there: it is beside it

    await expect(async () => {
      if (isWide(page)) await page.mouse.click(x, y + 22);
      else await page.touchscreen.tap(x, y + 22);
      await expect(page).toHaveURL(/\/place\/1$/, { timeout: 1000 });
    }).toPass({ timeout: 15_000 });
  });

  test("month_view_a_pointer_over_a_dot_is_a_pointer_and_away_from_it_the_ordinary_cursor", async ({ page }) => {
    await mockApi(page, { ...answers, "places/1": HOME });
    await page.goto("/month/2026-10");
    await expect(map(page)).toHaveAttribute("data-map-state", "ready");
    await expect(details(page).getByText("6 places", { exact: true })).toBeVisible();
    const free = await middleOfWhatIsFree(page);
    const [x, y] = [Math.round(free.x), Math.round(free.y)];
    const canvas = map(page).locator("canvas.maplibregl-canvas");
    await expect.poll(async () => sameColour(await pixelAt(page, x, y), PIN, 30), PIXEL_POLL).toBe(true);

    await expect(async () => {
      await page.mouse.move(x + 2, y + 2);
      await page.mouse.move(x, y);
      await expect(canvas).toHaveCSS("cursor", "pointer", { timeout: 500 });
    }).toPass({ timeout: 15_000 });

    await page.mouse.move(x, y + 140); // plain map, well below the dot
    await expect(canvas).not.toHaveCSS("cursor", "pointer");
  });

  // A drag that ends over a dot is no tap on it: the dot goes with the map, so the pointer is over it again where the drag ends.
  test("month_view_a_drag_that_ends_on_a_dot_does_not_open_it", async ({ page }) => {
    await mockApi(page, { ...answers, "places/1": HOME });
    await page.goto("/month/2026-10");
    await expect(map(page)).toHaveAttribute("data-map-state", "ready");
    await expect(details(page).getByText("6 places", { exact: true })).toBeVisible();
    const free = await middleOfWhatIsFree(page);
    const [x, y] = [Math.round(free.x), Math.round(free.y)];
    await expect.poll(async () => sameColour(await pixelAt(page, x, y), PIN, 30), PIXEL_POLL).toBe(true);
    await page.evaluate((ms) => new Promise((resolve) => setTimeout(resolve, ms)), FLIGHT_MS + 300); // the camera has come to rest
    expect(sameColour(await pixelAt(page, x, y), PIN, 30)).toBe(true);

    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 60, y + 40, { steps: 8 });
    await page.mouse.up();

    // The dot went with the map, and is under the pointer: where a click would have found it.
    await expect.poll(async () => sameColour(await pixelAt(page, x + 60, y + 40), PIN, 30), PIXEL_POLL).toBe(true);
    await expect(page).toHaveURL(/\/month\/2026-10$/);
  });
});

/**
 * The heat of the month: 81 cells of equal time in a grid of about 100 m round Home, the middle of everything drawn. The glow of so many
 * on one another is as strong as it gets wherever there are cells, which is what makes it the same to read on a phone and on a desktop,
 * where the map is brought to the month at another zoom.
 */
const HEAT_ROUND_HOME = {
  maxSeconds: 3600,
  cells: Array.from({ length: 81 }, (_, i): [number, number, number] => [10.75 + (Math.floor(i / 9) - 4) * 0.002, 59.91 + ((i % 9) - 4) * 0.001, 3600]),
};

/** Whether a colour is the glow of the heat on the flat background: red up and blue down on the grey-blue that it is laid over. */
const glows = ([red, , blue]: Rgb): boolean => red >= 240 && blue <= 215;

// Ruling P2-R53: the ◐ button of the map. Off by default and remembered; when on it asks for the heat of the period once, draws it, and the
// routes give way to it; when off nothing is asked for at all.
test.describe("the heat of a month", () => {
  test.use({ deviceScaleFactor: 1 });

  test("heat_toggle_asks_for_the_heat_of_the_period_once_draws_it_and_is_remembered_over_a_reload", async ({ page }) => {
    // Four reads of a pixel and a reload, in turn: more than the 30 s that Playwright gives a test (see PIXEL_POLL).
    test.setTimeout(30_000 + 4 * PIXEL_POLL.timeout);
    const api = await mockApi(page, { ...answers, heat: HEAT_ROUND_HOME });
    const heatRequests = () => api.requests.filter((request) => request.startsWith("/api/heat"));
    const button = page.getByRole("button", { name: "Heat map" });
    await page.goto("/month/2026-10");
    await expect(map(page)).toHaveAttribute("data-map-state", "ready");
    await expect(details(page).getByText("6 places", { exact: true })).toBeVisible();
    await expect(button).toHaveAttribute("aria-pressed", "false"); // off by default

    // The map is where the month is (Home's dot is in the middle of what is free), and a pixel just below the dot is the plain map.
    const free = await middleOfWhatIsFree(page);
    const [x, y] = [Math.round(free.x), Math.round(free.y)];
    await expect.poll(async () => sameColour(await pixelAt(page, x, y), PIN, 30), PIXEL_POLL).toBe(true);
    const below = async () => pixelAt(page, x, y + 24);
    await expect.poll(async () => sameColour(await below(), BACKGROUND), PIXEL_POLL).toBe(true);
    // The months either side were asked for as soon as this one was shown; no heat was asked for, for any of them.
    await expect.poll(() => api.requests).toContain("/api/range?from=2026-11-01&to=2026-11-30");
    expect(heatRequests()).toEqual([]);

    await button.click();

    await expect(button).toHaveAttribute("aria-pressed", "true");
    await expect.poll(async () => glows(await below()), PIXEL_POLL).toBe(true); // the glow is where there was none
    expect(heatRequests()).toEqual(["/api/heat?from=2026-10-01&to=2026-10-31"]); // once, for the month, and not for the ones either side

    // A page loaded again has it on, and asks for the heat of the month again.
    await page.reload();
    await expect(map(page)).toHaveAttribute("data-map-state", "ready");
    await expect(button).toHaveAttribute("aria-pressed", "true");
    await expect.poll(heatRequests).toEqual(["/api/heat?from=2026-10-01&to=2026-10-31", "/api/heat?from=2026-10-01&to=2026-10-31"]);

    await button.click();

    await expect(button).toHaveAttribute("aria-pressed", "false");
    await expect.poll(async () => sameColour(await below(), BACKGROUND), PIXEL_POLL).toBe(true); // the glow goes
    expect(heatRequests()).toHaveLength(2);
  });
});
