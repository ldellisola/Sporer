import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./base";
import status from "./fixtures/status.json" with { type: "json" };
import { mockApi, type Reply } from "./mockApi";
import { fixTime } from "./today";

// 22:30 UTC on the 22nd is 00:30 on the 23rd in Oslo: "today" must be the date of the browser's own zone.
test.use({ timezoneId: "Europe/Oslo" });

const SIDEBAR_WIDTH = 320;
const PEEK = 96;

const isWide = (page: Page): boolean => page.viewportSize()!.width >= 900;
const details = (page: Page): Locator => page.getByRole(isWide(page) ? "complementary" : "region", { name: "Details" });
const grip = (page: Page): Locator => page.getByRole("button", { name: "Resize panel" });
/** The "No data" rows of a day's timeline (a gap each); the message of a day with nothing at all says more than that. */
const noData = (page: Page): Locator => page.getByText("No data", { exact: true });

/** How much of the bottom sheet shows: it is as tall as its largest point and moved down by the rest. */
async function visibleSheetHeight(page: Page): Promise<number> {
  const box = (await details(page).boundingBox())!;
  return page.viewportSize()!.height - box.y;
}

function dayWith(date: string, segments: number): Reply {
  const gap = { kind: "gap", start: `${date}T08:00:00Z`, end: `${date}T09:00:00Z`, startTimeZone: "Europe/Oslo", endTimeZone: "Europe/Oslo", from: null, to: null };
  return {
    json: {
      date,
      timeZone: "Europe/Oslo",
      state: "done",
      summary: { places: 0, distanceMeters: 0, movingSeconds: 0 },
      segments: Array.from({ length: segments }, (_, id) => ({ id, ...gap })),
    },
  };
}

test("app_loads_and_redirects_to_today", async ({ page }) => {
  const api = await mockApi(page);
  await fixTime(page, "2026-10-22T22:30:00Z");

  await page.goto("/");

  await expect(page).toHaveURL(/\/day\/2026-10-23$/);
  await expect(page.getByRole("heading", { name: "Friday 23 October" })).toBeVisible();
  await expect.poll(() => api.requests).toContain("/api/day/2026-10-23"); // the request is the page's to make, a moment after it shows the day
});

test("phone_uses_bottom_sheet_desktop_uses_sidebar", async ({ page }) => {
  await mockApi(page);
  await page.goto("/day/2026-10-22");
  const { width, height } = page.viewportSize()!;
  const bar = (await page.getByRole("group", { name: "View" }).boundingBox())!;
  await expect(details(page)).toBeVisible();

  if (isWide(page)) {
    // A fixed panel of 320 px down the left edge, the top bar floating over the map beside it, and no handle to pull.
    await expect(page.getByRole("region", { name: "Details" })).toHaveCount(0);
    await expect(grip(page)).toHaveCount(0);
    expect(await details(page).boundingBox()).toEqual({ x: 0, y: 0, width: SIDEBAR_WIDTH, height });
    expect(bar.x).toBeGreaterThanOrEqual(SIDEBAR_WIDTH);
    return;
  }

  // The sheet at its peek, over the whole width at the bottom, with the handle; no sidebar.
  await expect(page.getByRole("complementary")).toHaveCount(0);
  await expect(grip(page)).toBeVisible();
  const sheet = (await details(page).boundingBox())!;
  expect(sheet.x).toBe(0);
  expect(sheet.width).toBe(width);
  expect(await visibleSheetHeight(page)).toBe(PEEK);
  expect(bar.y + bar.height).toBeLessThan(height - PEEK); // the bar is at the top, clear of the sheet

  // The handle steps through the points: half of the viewport, the viewport less 120 px, and round again.
  await grip(page).click();
  await expect.poll(() => visibleSheetHeight(page)).toBe(height / 2);
  await grip(page).click();
  await expect.poll(() => visibleSheetHeight(page)).toBe(height - 120);
  await grip(page).click();
  await expect.poll(() => visibleSheetHeight(page)).toBe(PEEK);
});

/**
 * A touch on the handle that moves `dy` pixels (up when negative) in `ms` milliseconds, played in the page with the time stamps
 * given: down, move, and (once `whileHeld` has looked at the sheet with the finger still down) up. The sheet judges speed by the
 * stamps of the events, so the test does not depend on how fast a busy machine can drive the browser, which a flick on the real
 * mouse would.
 */
async function touchDrag(page: Page, dy: number, ms: number, whileHeld: () => Promise<void>): Promise<void> {
  const box = (await grip(page).boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  const send = (type: string, at: number, t: number) =>
    grip(page).evaluate(
      (handle, event) => {
        const pointer = new PointerEvent(event.type, { bubbles: true, cancelable: true, pointerId: 7, isPrimary: true, pointerType: "touch", clientX: event.x, clientY: event.y });
        Object.defineProperty(pointer, "timeStamp", { value: event.t });
        handle.dispatchEvent(pointer);
      },
      { type, x, y: at, t },
    );
  await send("pointerdown", y, 1000);
  await send("pointermove", y + dy, 1000 + ms);
  await whileHeld(); // the events were handled: the sheet is where the finger took it
  await send("pointerup", y + dy, 1000 + ms);
}

test("bottom_sheet_follows_a_drag_nearest_point_slow_next_point_flicked", async ({ page }) => {
  await mockApi(page);
  await page.goto("/day/2026-10-22");
  if (isWide(page)) {
    await expect(grip(page)).toHaveCount(0); // a desktop has no sheet to drag (the other test says so, too)
    return;
  }
  const { height } = page.viewportSize()!;
  const handle = (await grip(page).boundingBox())!;
  const x = handle.x + handle.width / 2;
  const y = handle.y + handle.height / 2;

  // The real mouse, pulled up 100 px in one jump (the pointer is on the map, not on the sheet, in the next event) and held there
  // for a moment before it lets go: the sheet follows it, and as it is nearer its peek (196 of 96 / 422 / 724) it goes back there.
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y - 100);
  await expect.poll(() => visibleSheetHeight(page)).toBe(PEEK + 100);
  await page.waitForTimeout(250); // no motion at the end of the drag: no flick
  await page.mouse.up();
  await expect.poll(() => visibleSheetHeight(page)).toBe(PEEK);

  // The same pull as a flick (100 px in 50 ms) goes on to the next point; a slower one (100 px in 1 s) does not. With the finger
  // down the sheet is where it took it, which shows that the events were handled and the sheet did not simply stay at its peek.
  const held = (expected: number) => async () => {
    await expect.poll(() => visibleSheetHeight(page)).toBe(expected);
  };
  await touchDrag(page, -100, 1000, held(PEEK + 100));
  await expect.poll(() => visibleSheetHeight(page)).toBe(PEEK);
  await touchDrag(page, -100, 50, held(PEEK + 100));
  await expect.poll(() => visibleSheetHeight(page)).toBe(height / 2);

  // And a flick back down: 60 px leave it nearer half, and it goes on to the peek.
  await touchDrag(page, 60, 40, held(height / 2 - 60));
  await expect.poll(() => visibleSheetHeight(page)).toBe(PEEK);
});

test("arrow_buttons_and_keys_step_the_period", async ({ page }) => {
  await mockApi(page);
  await page.goto("/day/2026-10-22");
  const heading = page.getByRole("heading", { name: "Thursday 22 October" });
  await expect(heading).toBeVisible();

  await page.getByRole("button", { name: "Next day" }).click();
  await expect(page).toHaveURL(/\/day\/2026-10-23$/);
  await expect(page.getByRole("heading", { name: "Friday 23 October" })).toBeVisible();

  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await expect(page).toHaveURL(/\/day\/2026-10-21$/);

  await page.getByRole("button", { name: "Week", exact: true }).click();
  await expect(page).toHaveURL(/\/week\/2026-10-19$/);
  await page.getByRole("button", { name: "Range", exact: true }).click();
  await expect(page).toHaveURL(/\/range\/2026-10-19\.\.2026-10-25$/);
  await expect(page.getByLabel("From", { exact: true })).toHaveValue("2026-10-19");
  await expect(page.getByLabel("To", { exact: true })).toHaveValue("2026-10-25");

  // A native date field set the way a picker does, in one go, and left with the focus in it: no blur and no Enter, and it is taken
  // after a short pause (it would be taken at once on either).
  await page.getByLabel("To", { exact: true }).fill("2026-10-31");
  await expect(page).toHaveURL(/\/range\/2026-10-19\.\.2026-10-31$/);
  await page.getByLabel("To", { exact: true }).focus();
  await page.keyboard.press("ArrowLeft"); // in a field, the arrow is the field's
  await expect(page).toHaveURL(/\/range\/2026-10-19\.\.2026-10-31$/);
  await expect(page.getByRole("heading", { name: "19 Oct – 31 Oct 2026" })).toBeVisible();
});

// Rulings P2-R29 and P2-R33: the browser reports every part of a date as it is typed (the 2 of 28 makes the 2nd), and each is a date.
// One that crosses the other end of the range is held; one that is fine is taken after a pause, with the focus still in the field.
test("range_fields_take_a_date_typed_part_by_part_as_one_change", async ({ page }) => {
  await mockApi(page);
  await page.goto("/range/2026-10-19..2026-10-25");
  const from = page.getByLabel("From", { exact: true });
  const to = page.getByLabel("To", { exact: true });
  await expect(to).toHaveValue("2026-10-25");
  const entries = await page.evaluate(() => window.history.length);

  await to.focus(); // the month part of the field
  await page.keyboard.press("ArrowRight"); // the day part
  await page.keyboard.type("28"); // 2026-10-02 after the 2 (before From: held), 2026-10-28 after the 8

  await expect(to).toHaveValue("2026-10-28");
  await expect(page).toHaveURL(/\/range\/2026-10-19\.\.2026-10-28$/); // taken after the pause, with no blur and no Enter
  await expect(to).toBeFocused();
  await expect(from).toHaveValue("2026-10-19"); // From was not dragged along by the 2nd
  await expect(page.getByRole("heading", { name: "19 Oct – 28 Oct 2026" })).toBeVisible();
  expect(await page.evaluate(() => window.history.length)).toBe(entries + 1); // one entry for the one change

  await to.blur(); // left again as it was, the field changes nothing
  expect(await page.evaluate(() => window.history.length)).toBe(entries + 1);
});

test("range_fields_take_an_invalid_date_when_they_are_left_and_Enter_takes_a_valid_one_at_once", async ({ page }) => {
  await mockApi(page);
  await page.goto("/range/2026-10-19..2026-10-25");
  const from = page.getByLabel("From", { exact: true });
  const to = page.getByLabel("To", { exact: true });
  const entries = await page.evaluate(() => window.history.length);

  await to.focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.type("2"); // 2026-10-02: before From, so held however long it stays
  await page.waitForTimeout(900); // longer than the pause
  await expect(page).toHaveURL(/\/range\/2026-10-19\.\.2026-10-25$/);
  await to.blur(); // left like that: From is dragged along
  await expect(page).toHaveURL(/\/range\/2026-10-02\.\.2026-10-02$/);
  await expect(from).toHaveValue("2026-10-02");

  await to.fill("2026-10-09");
  await to.press("Enter"); // Enter does not wait for the pause
  await expect(page).toHaveURL(/\/range\/2026-10-02\.\.2026-10-09$/);
  expect(await page.evaluate(() => window.history.length)).toBe(entries + 2);
});

test("status_banner_shows_progress_below_the_bar_and_not_over_the_map_buttons", async ({ page }) => {
  await mockApi(page, { status: { ...status, backfill: { ...status.backfill, percent: 42.7 } } });
  await page.goto("/day/2026-10-22");

  const banner = page.getByRole("status");
  await expect(banner).toHaveText("Processing your history… 42 %");
  const bar = (await page.getByRole("group", { name: "View" }).boundingBox())!;
  const box = (await banner.boundingBox())!;
  const recenter = (await page.getByRole("button", { name: "Recenter map" }).boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(bar.y + bar.height);
  expect(box.x + box.width).toBeLessThanOrEqual(recenter.x); // the note and the map's buttons share the top without touching
});

// Review Focus 3: a day that cannot be had gives an error with Retry, and the day that was on screen stays under it.
test("error_then_retry_recovers", async ({ page }) => {
  let failing = true;
  await mockApi(page, {
    "day/*": (request) => {
      const date = new URL(request.url()).pathname.split("/").pop()!;
      if (date === "2026-10-22") return dayWith(date, 3);
      return failing ? { status: 500, json: { title: "Internal Server Error" } } : dayWith(date, 1);
    },
  });
  await page.goto("/day/2026-10-22");
  await expect(noData(page)).toHaveCount(3); // the three gaps of the day

  await page.getByRole("button", { name: "Next day" }).click(); // answered with a 500 both times: the app asks twice, then gives up
  await expect(page).toHaveURL(/\/day\/2026-10-23$/);
  await expect(page.getByRole("alert")).toContainText("Couldn't load");
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
  await expect(noData(page)).toHaveCount(3); // the day that was shown is still there
  await expect(page.getByRole("heading", { name: "Friday 23 October" })).toBeVisible();

  failing = false;
  await page.getByRole("button", { name: "Retry" }).click();

  await expect(noData(page)).toHaveCount(1);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

// Ruling P2-R25: the credit is the one thing on the map that must never be covered.
test("attribution_stays_visible_and_uncovered_by_the_panel", async ({ page }) => {
  await mockApi(page);
  await page.goto("/day/2026-10-22");
  await expect(page.getByRole("region", { name: "Map view" })).toHaveAttribute("data-map-state", "ready");
  const link = page.getByRole("link", { name: "OpenStreetMap" });
  await expect(link).toBeVisible();

  /** Whether what the user would touch at the middle of the link is the link: nothing lies over it. */
  const uncovered = () =>
    link.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return hit === element || element.contains(hit);
    });
  expect(await uncovered()).toBe(true);

  const credit = (await link.boundingBox())!;
  const panel = (await details(page).boundingBox())!;
  if (isWide(page)) {
    expect(credit.x).toBeGreaterThanOrEqual(panel.x + panel.width); // to the right of the sidebar
    return;
  }
  expect(credit.y + credit.height).toBeLessThanOrEqual(panel.y); // above the sheet at its peek...

  await grip(page).click(); // ...and above it when it has come up to half the screen: the map's padding follows the sheet
  await expect.poll(() => visibleSheetHeight(page)).toBe(page.viewportSize()!.height / 2);
  await expect(link).toBeVisible();
  await expect.poll(uncovered).toBe(true);
  const raised = (await link.boundingBox())!;
  expect(raised.y + raised.height).toBeLessThanOrEqual((await details(page).boundingBox())!.y);
});

// Ruling P2-R30: at full the sheet covers the map. The map keeps the padding of half, so that it has room to fit things into, and
// its credit and buttons stay clear of the bar.
test("sheet_at_full_leaves_the_map_a_padding_that_fits_and_the_credit_clear_of_the_bar", async ({ page }) => {
  await mockApi(page);
  await page.goto("/day/2026-10-22");
  const map = page.getByRole("region", { name: "Map view" });
  await expect(map).toHaveAttribute("data-map-state", "ready");
  const { height } = page.viewportSize()!;
  if (!isWide(page)) {
    await grip(page).click();
    await grip(page).click();
    await expect.poll(() => visibleSheetHeight(page)).toBe(height - 120); // full
    await expect.poll(() => map.evaluate((element) => element.style.getPropertyValue("--map-padding-bottom"))).toBe(`${height / 2 + 16}px`);
  }

  const padding = await map.evaluate((element) => ({
    top: parseFloat(element.style.getPropertyValue("--map-padding-top")),
    bottom: parseFloat(element.style.getPropertyValue("--map-padding-bottom")),
  }));
  const area = (await map.boundingBox())!;
  expect(padding.top + padding.bottom).toBeLessThan(area.height); // there is room left to fit a day into

  const bar = (await page.locator("header").boundingBox())!;
  const credit = (await page.getByRole("link", { name: "OpenStreetMap" }).boundingBox())!;
  const recenter = (await page.getByRole("button", { name: "Recenter map" }).boundingBox())!;
  expect(credit.y).toBeGreaterThanOrEqual(bar.y + bar.height); // the credit is not under the bar...
  expect(recenter.y).toBeGreaterThanOrEqual(bar.y + bar.height); // ...nor are the map's buttons
});
