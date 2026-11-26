import type { Locator, Page, Request } from "@playwright/test";
import type { DayResponse } from "../src/api/types";
import { expect, test } from "./base";
import transitDay from "./fixtures/day-oslo-transit.json" with { type: "json" };
import { mockApi, moveModeServer, type Reply } from "./mockApi";
import { colourIn, PIXEL_POLL, type Rgb } from "./pixel";
import { sheetAtRest } from "./sheet";
import { fixTime } from "./today";

// The mode of a move: the bus and the train of a day in Oslo, the mode menu that sets one by hand and takes it back, and the colours they are drawn in.
// The day of the fixture: home, a bus at 08:30, the bakery, a train at 09:10, the office, and at 16:30 a move of a mode this app does not know (a
// "ferry", as a server newer than the app might send), then Hovedøya.

// The browser is in Tokyo, which the day is not in: every time on screen is Oslo's. One pixel to a CSS pixel, also on the phone: nothing here is about density.
test.use({ timezoneId: "Asia/Tokyo", deviceScaleFactor: 1 });

const DAY = transitDay as unknown as DayResponse; // its third move has a mode that is no `Mode`, on purpose

/** Fixes the date of "today", which the day of the fixture is not. */
const fixToday = (page: Page): Promise<void> => fixTime(page, "2026-12-01T12:00:00Z");

const isWide = (page: Page): boolean => page.viewportSize()!.width >= 900;
const details = (page: Page): Locator => page.getByRole(isWide(page) ? "complementary" : "region", { name: "Details" });
const map = (page: Page): Locator => page.getByRole("region", { name: "Map view" });
const grip = (page: Page): Locator => page.getByRole("button", { name: "Resize panel" });
const rows = (page: Page): Locator => details(page).getByRole("listitem");
const busRow = (page: Page): Locator => rows(page).nth(1);
const menu = (page: Page): Locator => details(page).getByRole("menu");

/** On a phone the sheet starts at its peek: bring it up to full, where the whole of the day can be read and reached. */
async function openSheet(page: Page): Promise<void> {
  if (isWide(page)) return;
  for (let i = 0; i < 2 && (await details(page).getAttribute("data-snap")) !== "full"; i++) await grip(page).click();
  await expect(details(page)).toHaveAttribute("data-snap", "full");
  await sheetAtRest(page);
}

/** Opens the day of the fixture, with the sheet of a phone up. */
async function openTheDay(page: Page): Promise<void> {
  await page.goto("/day/2026-11-02");
  await expect(map(page)).toHaveAttribute("data-map-state", "ready");
  await openSheet(page);
}

test("mode_menu_sets_the_mode_of_a_move_and_as_detected_takes_it_back", { tag: "@smoke" }, async ({ page }) => {
  await fixToday(page);
  const server = moveModeServer(DAY);
  const api = await mockApi(page, server.overrides);
  await openTheDay(page);

  // The bus and the train, with their words; the mode this app does not know is a "Move".
  await expect(rows(page)).toHaveText(
    [
      "Home until 08:30 11h 30m",
      "Bus · 2.6 km 18m",
      "1 Bakery 08:48 – 09:10 22m",
      "Train · 3.3 km 12m",
      "2 Office 09:22 – 16:30 7h 8m",
      "Move · 1.7 km 15m",
      "3 Hovedøya 16:45 – 18:00 1h 15m",
    ],
    { useInnerText: true },
  );

  // The word of the mode is the button of the menu, which opens under the row with the six modes and the bus checked.
  const button = busRow(page).getByRole("button", { name: "Bus, mode of the move at 08:30" });
  await expect(button).toHaveText("Bus");
  await button.click();
  await expect(busRow(page).getByRole("menu", { name: "Bus, mode of the move at 08:30" })).toBeVisible(); // under its row
  await expect(menu(page).getByRole("menuitemradio")).toHaveText(["Walk", "Cycle", "Drive", "Bus", "Train", "Flight"]);
  await expect(menu(page).getByRole("menuitemradio", { name: "Bus" })).toHaveAttribute("aria-checked", "true");
  await expect(menu(page).getByRole("menuitemradio", { checked: true })).toHaveCount(1);
  await expect(menu(page).getByRole("menuitem", { name: "As detected" })).toHaveCount(0); // the mode is the one detected
  // On a phone as on a wide screen, the menu is within the panel: no choice is off its side (they wrap), and each is a target for a finger.
  const panel = (await details(page).boundingBox())!;
  for (const item of await menu(page).getByRole("menuitemradio").all()) {
    const box = (await item.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(panel.x);
    expect(box.x + box.width).toBeLessThanOrEqual(panel.x + panel.width);
    expect(box.height).toBeGreaterThanOrEqual(36);
  }
  expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(24);

  await menu(page).getByRole("menuitemradio", { name: "Train" }).click();

  // Saved, and the day says so: the row is the train's, and says the owner set it.
  await expect(menu(page)).toHaveCount(0);
  await expect(busRow(page)).toHaveText("Train · 2.6 km · set by you 18m", { useInnerText: true });
  await expect(busRow(page).getByRole("button", { name: "Train, mode of the move at 08:30, set by you" })).toBeFocused();
  await expect(busRow(page).getByRole("button", { name: "Show Train · 2.6 km · set by you at 08:30 on the map" })).toHaveCount(1);
  expect(api.writes).toEqual([{ method: "PUT", path: "/api/moves/202/mode", contentType: "application/json", body: { mode: "train" } }]);
  expect([...server.edits().values()]).toEqual(["train"]);

  // As detected, at the bottom of the menu now, takes it back. The server leaves the stored move as it was until it has rebuilt the stretch, and the day
  // is pending until then: the row says the train the owner set meanwhile.
  await busRow(page).getByRole("button", { name: "Train, mode of the move at 08:30, set by you" }).click();
  await expect(menu(page).getByRole("menuitemradio", { name: "Train" })).toHaveAttribute("aria-checked", "true");
  await menu(page).getByRole("menuitem", { name: "As detected" }).click();

  await expect.poll(() => api.writes.at(-1)).toEqual({ method: "DELETE", path: "/api/moves/202/mode", contentType: "application/json", body: null });
  expect(server.edits().size).toBe(0);
  // The day asked for again after the write, and answered as the server has it before the rebuild (requests are in order: the last of the move's path is the DELETE).
  const dayAfterTheWrite = (): number =>
    api.requests.slice(api.requests.lastIndexOf("/api/moves/202/mode") + 1).filter((request) => request === "/api/day/2026-11-02").length;
  await expect.poll(dayAfterTheWrite).toBeGreaterThan(0);
  await expect(busRow(page).getByRole("button", { name: "Train, mode of the move at 08:30, set by you" })).not.toHaveAttribute("aria-disabled");
  await expect(details(page).getByText("Updating…")).toBeVisible();
  await expect(busRow(page)).toHaveText("Train · 2.6 km · set by you 18m", { useInnerText: true });

  // The worker rebuilds it with the bus it detected: the bus again, as the day is asked for again, every 3 seconds while it is pending after the change.
  server.rebuild();
  await expect(busRow(page)).toHaveText("Bus · 2.6 km 18m", { useInnerText: true, timeout: 15_000 });
  await expect(details(page).getByText("Updating…")).toHaveCount(0);
  await expect(busRow(page).getByRole("button", { name: "Bus, mode of the move at 08:30" })).toBeFocused();
});

test("mode_menu_is_worked_from_the_keyboard_and_a_failure_is_said_in_the_row_with_a_retry", async ({ page }) => {
  await fixToday(page);
  const server = moveModeServer(DAY);
  let answers = 0;
  const put = server.overrides["PUT moves/204/mode"] as (request: Request) => Reply;
  const api = await mockApi(page, {
    ...server.overrides,
    "PUT moves/204/mode": (request): Reply => (++answers === 1 ? { status: 500, json: { title: "Internal Server Error" } } : put(request)),
  });
  await openTheDay(page);
  const trainRow = rows(page).nth(3);

  // ↓ on the button opens the menu on the mode that is checked; the arrows go from mode to mode, and Enter chooses.
  await trainRow.getByRole("button", { name: "Train, mode of the move at 09:10" }).focus();
  await page.keyboard.press("ArrowDown");
  await expect(menu(page).getByRole("menuitemradio", { name: "Train" })).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(menu(page).getByRole("menuitemradio", { name: "Bus" })).toBeFocused();
  await page.keyboard.press("ArrowRight"); // the menu's, and not a step to the next day
  await expect(menu(page).getByRole("menuitemradio", { name: "Train" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu(page)).toHaveCount(0);
  await expect(trainRow.getByRole("button", { name: "Train, mode of the move at 09:10" })).toBeFocused();
  await expect(page).toHaveURL(/\/day\/2026-11-02$/);

  await page.keyboard.press("Enter");
  await expect(menu(page).getByRole("menuitemradio", { name: "Train" })).toBeFocused();
  await page.keyboard.press("d"); // a letter: the mode that begins with it
  await expect(menu(page).getByRole("menuitemradio", { name: "Drive" })).toBeFocused();
  await page.keyboard.press("Enter");

  // The server failed: the row says so, with a Retry that sends it again.
  const alert = trainRow.getByRole("alert");
  await expect(alert).toContainText("Couldn't set the mode to Drive");
  await expect(alert).toContainText("PUT /api/moves/204/mode failed with status 500");
  await expect(trainRow).toContainText("Train · 3.3 km");

  await alert.getByRole("button", { name: "Retry" }).click();

  await expect(trainRow.getByRole("button", { name: "Drive, mode of the move at 09:10, set by you" })).toBeVisible();
  await expect(alert).toHaveCount(0);
  expect(api.writes.map((write) => write.body)).toEqual([{ mode: "drive" }, { mode: "drive" }]);
});

test("mode_menu_of_a_move_that_was_rebuilt_meanwhile_reloads_the_day_and_says_so", async ({ page }) => {
  await fixToday(page);
  const server = moveModeServer(DAY);
  const api = await mockApi(page, server.overrides);
  await openTheDay(page);
  server.rebuild(); // the server rebuilt the day since it was shown: the ids the page has are no more

  await busRow(page).getByRole("button", { name: "Bus, mode of the move at 08:30" }).click();
  await menu(page).getByRole("menuitemradio", { name: "Train" }).click();

  const alert = details(page).getByRole("alert");
  await expect(alert).toHaveText("Could not set the mode to Train: The move had been rebuilt meanwhile, and the day is reloaded.");
  await expect(alert.getByRole("button", { name: "Retry" })).toHaveCount(0);
  // The day was asked for again, with the ids it has now: a choice made on it goes through.
  await expect.poll(() => api.requests.filter((request) => request === "/api/day/2026-11-02").length).toBeGreaterThan(1);
  await busRow(page).getByRole("button", { name: "Bus, mode of the move at 08:30" }).click();
  await menu(page).getByRole("menuitemradio", { name: "Train" }).click();
  await expect(busRow(page)).toHaveText("Train · 2.6 km · set by you 18m", { useInnerText: true });
  await expect(alert).toHaveCount(0);
  expect(api.writes.map((write) => write.path)).toEqual(["/api/moves/202/mode", "/api/moves/302/mode"]);
});

test.describe("the colours of the modes", () => {
  const TRAIN: Rgb = [0xaf, 0x52, 0xde];
  const BUS: Rgb = [0x9a, 0x7d, 0x59];
  const UNKNOWN: Rgb = [0x8e, 0x8e, 0x93];

  /** How many pixels of the map are `colour`: a route of a day is 4 pixels wide, over a white casing, and is drawn in its colour at full strength. */
  const drawnIn = async (page: Page, colour: Rgb): Promise<number> => colourIn(page, (await map(page).boundingBox())!, colour, 6);

  test("a_day_draws_a_train_in_purple_a_bus_in_brown_and_a_mode_it_does_not_know_in_grey", async ({ page }) => {
    test.setTimeout(30_000 + 2 * PIXEL_POLL.timeout);
    await fixToday(page);
    const server = moveModeServer(DAY);
    await mockApi(page, server.overrides);
    await page.goto("/day/2026-11-02");
    await expect(map(page)).toHaveAttribute("data-map-state", "ready");

    // The map is brought to the day, which the sheet of a phone at its peek leaves in view.
    await expect.poll(async () => (await drawnIn(page, TRAIN)) > 100, PIXEL_POLL).toBe(true);
    expect(await drawnIn(page, BUS)).toBeGreaterThan(100);
    expect(await drawnIn(page, UNKNOWN)).toBeGreaterThan(100);

    // The bus set to a train by hand is drawn as one: no brown is left.
    await openSheet(page);
    await busRow(page).getByRole("button", { name: "Bus, mode of the move at 08:30" }).click();
    await menu(page).getByRole("menuitemradio", { name: "Train" }).click();
    await expect(busRow(page)).toContainText("set by you");
    if (!isWide(page)) {
      for (let i = 0; i < 3 && (await details(page).getAttribute("data-snap")) !== "peek"; i++) await grip(page).click(); // the sheet down: at full it covers the map
      await sheetAtRest(page);
    }
    await expect.poll(() => drawnIn(page, BUS), PIXEL_POLL).toBeLessThan(5);
  });
});
