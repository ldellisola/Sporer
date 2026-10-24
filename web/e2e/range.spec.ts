import type { Locator, Page, Request } from "@playwright/test";
import { expect, test } from "./base";
import october from "./fixtures/range-october.json" with { type: "json" };
import { mockApi, type Reply } from "./mockApi";
import { pixelAt, sameColour, type Rgb } from "./pixel";

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

/** The month of the fixture, the range that is picked, and nothing for any other dates (the periods either side are asked for too). */
const RANGES: Record<string, object> = { "2026-10-01..2026-10-31": october, "2026-10-05..2026-10-12": PICKED };
const answers = {
  range: (request: Request): Reply => {
    const { searchParams } = new URL(request.url());
    const [from, to] = [searchParams.get("from")!, searchParams.get("to")!];
    return { json: RANGES[`${from}..${to}`] ?? empty(from, to) };
  },
};

test("month_view_and_range_picker", async ({ page }) => {
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
  // Every date of the month, those with no movement said to have none.
  await expect(dayRows(page)).toHaveCount(31);
  await expect(dayRows(page).first()).toHaveText("Thu 1 Oct No movement", { useInnerText: true });
  await expect(dayRows(page).nth(21)).toHaveText("Thu 22 Oct 6.9 km · 2 places", { useInnerText: true });

  // The months either side were asked for as soon as this one was shown, so ‹ and › find them at hand.
  await expect.poll(() => api.requests).toContain("/api/range?from=2026-09-01&to=2026-09-30");
  await expect.poll(() => api.requests).toContain("/api/range?from=2026-11-01&to=2026-11-30");

  // A day opens its day, with movement or without; Back is to the month.
  await details(page).getByRole("button", { name: "Open Friday 2 October" }).click();
  await expect(page).toHaveURL(/\/day\/2026-10-02$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/month\/2026-10$/);
  await details(page).getByRole("button", { name: "Open Thursday 22 October" }).click();
  await expect(page).toHaveURL(/\/day\/2026-10-22$/);
  await expect(page.getByRole("heading", { name: "Thursday 22 October", level: 1 })).toBeVisible();
  await page.goBack();
  await details(page).getByRole("button", { name: "Open Gym" }).click();
  await expect(page).toHaveURL(/\/place\/6$/);
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

const PIN: Rgb = [0xff, 0x37, 0x5f];

// Mockup 2A: a month's routes faint, a dot for each place sized by time, the map brought to all of it. The fixture is laid out round
// Home, which is the most time spent and the middle of everything drawn, so the middle of what the sheet and the bar leave free of the
// map lies on its dot: the dot is drawn, it is the biggest, and the camera was brought to the month.
test("month_view_draws_a_dot_for_the_places_and_brings_the_map_to_the_month", async ({ page }) => {
  await mockApi(page, answers);
  await page.goto("/month/2026-10");
  await expect(map(page)).toHaveAttribute("data-map-state", "ready");
  await expect(details(page).getByText("6 places", { exact: true })).toBeVisible();

  const free = await map(page).evaluate((element) => {
    const read = (side: string) => parseFloat(element.style.getPropertyValue(`--map-padding-${side}`));
    const box = element.getBoundingClientRect();
    return {
      x: box.left + (read("left") + (box.width - read("right"))) / 2,
      y: box.top + (read("top") + (box.height - read("bottom"))) / 2,
    };
  });

  // The dot is the pin's pink at 92 % over the flat background of the test style and the faint routes under it, hence the tolerance.
  await expect.poll(async () => sameColour(await pixelAt(page, Math.round(free.x), Math.round(free.y)), PIN, 30)).toBe(true);
});
