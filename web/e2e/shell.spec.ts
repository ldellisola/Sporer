import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./base";
import status from "./fixtures/status.json" with { type: "json" };
import { mockApi, type Reply } from "./mockApi";

// 22:30 UTC on the 22nd is 00:30 on the 23rd in Oslo: "today" must be the date of the browser's own zone.
test.use({ timezoneId: "Europe/Oslo" });

const SIDEBAR_WIDTH = 320;
const PEEK = 96;

const isWide = (page: Page): boolean => page.viewportSize()!.width >= 900;
const details = (page: Page): Locator => page.getByRole(isWide(page) ? "complementary" : "region", { name: "Details" });
const grip = (page: Page): Locator => page.getByRole("button", { name: "Resize panel" });

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
  await page.clock.setFixedTime(new Date("2026-10-22T22:30:00Z"));

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
 * A touch on the handle that moves `dy` pixels (up when negative) in `ms` milliseconds, played in the page in one go with the time
 * stamps given. The sheet judges speed by the stamps of the events, so the test does not depend on how fast a busy machine can
 * drive the browser, which a flick on the real mouse would.
 */
async function touchDrag(page: Page, dy: number, ms: number): Promise<void> {
  await grip(page).evaluate(
    (handle, { dy, ms }) => {
      const box = handle.getBoundingClientRect();
      const y = box.top + box.height / 2;
      const send = (type: string, at: number, t: number) => {
        const event = new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 7, isPrimary: true, pointerType: "touch", clientX: box.left + 50, clientY: at });
        Object.defineProperty(event, "timeStamp", { value: t });
        handle.dispatchEvent(event);
      };
      send("pointerdown", y, 1000);
      send("pointermove", y + dy, 1000 + ms);
      send("pointerup", y + dy, 1000 + ms);
    },
    { dy, ms },
  );
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

  // The same pull as a flick (100 px in 50 ms) goes on to the next point; a slower one (100 px in 1 s) does not.
  await touchDrag(page, -100, 1000);
  await expect.poll(() => visibleSheetHeight(page)).toBe(PEEK);
  await touchDrag(page, -100, 50);
  await expect.poll(() => visibleSheetHeight(page)).toBe(height / 2);

  // And a flick back down: 60 px leave it nearer half, and it goes on to the peek.
  await touchDrag(page, 60, 40);
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

  await page.getByLabel("To", { exact: true }).fill("2026-10-31"); // a native date field, set the way a picker does
  await expect(page).toHaveURL(/\/range\/2026-10-19\.\.2026-10-31$/);
  await page.getByLabel("To", { exact: true }).focus();
  await page.keyboard.press("ArrowLeft"); // in a field, the arrow is the field's
  await expect(page).toHaveURL(/\/range\/2026-10-19\.\.2026-10-\d\d$/);
  await expect(page.getByRole("heading", { name: /^19 Oct – \d+ Oct 2026$/ })).toBeVisible();
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
  await expect(page.getByText("3 segments")).toBeVisible();

  await page.getByRole("button", { name: "Next day" }).click(); // answered with a 500 both times: the app asks twice, then gives up
  await expect(page).toHaveURL(/\/day\/2026-10-23$/);
  await expect(page.getByRole("alert")).toContainText("Couldn't load");
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
  await expect(page.getByText("3 segments")).toBeVisible(); // the day that was shown is still there
  await expect(page.getByRole("heading", { name: "Friday 23 October" })).toBeVisible();

  failing = false;
  await page.getByRole("button", { name: "Retry" }).click();

  await expect(page.getByText("1 segment", { exact: true })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByText("3 segments")).toHaveCount(0);
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
