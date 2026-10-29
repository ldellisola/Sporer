import type { Locator, Page, Request } from "@playwright/test";
import type { DayResponse, RawPoint } from "../src/api/types";
import { expect, test } from "./base";
import { fitOf, type LonLat } from "./fit";
import dayFixture from "./fixtures/day-edit.json" with { type: "json" };
import pointsFixture from "./fixtures/points-edit.json" with { type: "json" };
import { mockApi, type Overrides, type Reply } from "./mockApi";
import { PIXEL_POLL, pixelAt, sameColour, type Rgb } from "./pixel";
import { sheetAtRest } from "./sheet";
import { fixTime } from "./today";

// The browser is in Tokyo, which the day is not in. One pixel to a CSS pixel, also on the phone: nothing here is about density.
test.use({ timezoneId: "Asia/Tokyo", deviceScaleFactor: 1 });

/** Fixes the date of "today", which no date of the fixtures is. */
const fixToday = (page: Page): Promise<void> => fixTime(page, "2026-12-01T12:00:00Z");

const isWide = (page: Page): boolean => page.viewportSize()!.width >= 900;
const details = (page: Page): Locator => page.getByRole(isWide(page) ? "complementary" : "region", { name: "Details" });
const grip = (page: Page): Locator => page.getByRole("button", { name: "Resize panel" });
const map = (page: Page): Locator => page.getByRole("region", { name: "Map view" });
const bar = (page: Page): Locator => page.getByRole("group", { name: "Edit points" });
const toast = (page: Page): Locator => page.getByRole("status").filter({ hasText: /Removed|Restored|removed already/ });
const selectArea = (page: Page): Locator => map(page).getByRole("button", { name: "Select area" });

// --- The day, its points and a server that keeps what is removed ---

const DAY = dayFixture as unknown as DayResponse;
const POINTS = pointsFixture.points as RawPoint[];
const DEVICES = pointsFixture.devices;
/** The distance that the rebuilt day says: what is left of the walk after the points that were removed. */
const DISTANCE_M = DAY.summary.distanceMeters;

/**
 * The index among the day's points of the `nth` point of the walk, for the first eleven of them (the first is the third of the day's points: two are at the
 * café), which come before the five points of the GPS spike that the watch made a long way from the route (they are among the walk's after that).
 */
const WALK = (nth: number): number => nth + 2;
const SPIKE = [13, 15, 17, 19, 21];

/** What the page sends to remove the points at these indices of the day's points: their device and their exact time, as the points had them. */
const removing = (...indices: number[]) => ({ points: indices.map((i) => ({ device: DEVICES[POINTS[i]![3]]!, t: POINTS[i]![0] })) });

interface EditServer {
  overrides: Overrides;
  /** The indices of the points that are removed now. */
  gone: () => number[];
  /** How many times the page asked for the points. */
  pointReads: () => number;
  /** The batches that were restored by someone else, so that undoing one is a 404. */
  forget: (batch: string) => void;
  /** What to answer a removal with instead of removing, until it is `undefined` again. */
  refuse: (reply: Reply | undefined) => void;
  /** The first so many requests for the points are answered with a 500. */
  failPoints: (times: number) => void;
  /** Holds the next removal until `answer` is called with what it is to be answered with (a request that is on its way, to be answered later). */
  hold: () => { answer: (reply: Reply) => void };
}

/**
 * A server that has the day and its points, and keeps what is removed: a removal answers its batch, and the points that are left are the ones that
 * are asked for again; the day is pending for one answer after each write (the worker has not rebuilt it yet) and is then rebuilt, with what is left of
 * the walk as its distance. Every removal is by the exact time of each point, and one that names a point there is not is a 400.
 */
function editServer(): EditServer {
  const removed = new Map<string, number[]>();
  let batches = 0;
  let pending = 0;
  let reads = 0;
  let refusal: Reply | undefined;
  let failing = 0;
  let held: Promise<Reply> | undefined;
  const gone = (): number[] => [...removed.values()].flat();
  const day = (): DayResponse => ({
    ...DAY,
    state: pending > 0 ? "pending" : "done",
    summary: { ...DAY.summary, distanceMeters: DISTANCE_M - gone().length },
  });
  const overrides: Overrides = {
    "day/2026-10-22": (): Reply => {
      const reply = { json: day() };
      if (pending > 0) pending -= 1;
      return reply;
    },
    "day/2026-10-22/points": (): Reply => {
      reads += 1;
      if (failing > 0) {
        failing -= 1;
        return { status: 500, json: { title: "Internal Server Error" } };
      }
      const left = new Set(gone());
      return { json: { date: DAY.date, devices: DEVICES, points: POINTS.filter((_, i) => !left.has(i)) } };
    },
    "POST points/remove": (request: Request): Reply | Promise<Reply> => {
      if (held !== undefined) {
        const waiting = held;
        held = undefined;
        return waiting;
      }
      if (refusal !== undefined) return refusal;
      const { points } = request.postDataJSON() as { points: { device: string; t: number }[] };
      const indices = points.map(({ device, t }) => POINTS.findIndex((point) => point[0] === t && DEVICES[point[3]] === device));
      if (indices.includes(-1)) return { status: 400, json: { statusCode: 400, message: "One or more errors occurred!", errors: { points: ["A point is not there."] } } };
      const fresh = indices.filter((i) => !gone().includes(i));
      if (fresh.length === 0) return { json: { batch: null, count: 0 } };
      batches += 1;
      removed.set(`batch-${batches}`, fresh);
      pending = 1;
      return { json: { batch: `batch-${batches}`, count: fresh.length } };
    },
    "DELETE points/removed/*": (request: Request): Reply => {
      const batch = new URL(request.url()).pathname.split("/").pop()!;
      if (!removed.delete(batch)) return { status: 404, json: {} };
      pending = 1;
      return { status: 204 };
    },
  };
  return {
    overrides,
    gone,
    pointReads: () => reads,
    forget: (batch) => void removed.delete(batch),
    refuse: (reply) => void (refusal = reply),
    failPoints: (times) => void (failing = times),
    hold: () => {
      let answer: (reply: Reply) => void = () => undefined;
      held = new Promise<Reply>((resolve) => (answer = resolve));
      return { answer: (reply) => answer(reply) };
    },
  };
}

// --- Where things are on the screen ---

const INK: Rgb = [28, 28, 30]; // a point, in the ink of the light scheme
const RED: Rgb = [255, 59, 48]; // a selected one

/** Where a position is on the page: the camera that the map comes to rest at once it is brought to the walk (`fit.ts`). */
type Projector = (at: LonLat) => { x: number; y: number };

/**
 * Where a position is on the page once the map has been brought to the day's routes and pins (all of the walk), at the closest zoom that holds them, which
 * is 16 at the most, with the room that is left at its edges for the bar and the sheet (`fitOf`, which the map has no handle for: a test of what the map does
 * with a finger finds what it is going to touch the way the map put it there). A point is where this says, to within a pixel; whether it is drawn there
 * is read from the pixel (`PIXEL_POLL`), which is also how a test knows that the camera has come to rest.
 */
async function projector(page: Page): Promise<Projector> {
  const walk: LonLat[] = [];
  for (const segment of DAY.segments) {
    if (segment.kind === "move") walk.push(...segment.geometry);
    else if (segment.kind === "stay" && segment.place !== null) walk.push([segment.place.lon, segment.place.lat]);
  }
  return fitOf(page, walk);
}

/** Where the point at `index` of the day's points is on the page. */
const placeOf = (project: Projector, index: number): { x: number; y: number } => project([POINTS[index]![1], POINTS[index]![2]]);

/** Waits until the pixel at the point is `colour`, which is how it is known that the point is drawn, as it is to be, and the camera is at rest. */
async function expectDot(page: Page, project: Projector, index: number, colour: Rgb | "none"): Promise<void> {
  const { x, y } = placeOf(project, index);
  await expect
    .poll(async () => {
      const pixel = await pixelAt(page, x, y);
      return colour === "none" ? !sameColour(pixel, INK, 30) && !sameColour(pixel, RED, 30) : sameColour(pixel, colour, 30);
    }, PIXEL_POLL)
    .toBe(true);
}

/** A tap on the page: the finger on a phone, the mouse on a desktop. */
async function tap(page: Page, at: { x: number; y: number }): Promise<void> {
  if (isWide(page)) await page.mouse.click(at.x, at.y);
  else await page.touchscreen.tap(at.x, at.y);
}

/** One-finger drag on a phone (real touch events, through the browser's own protocol: Playwright has only taps) and a drag of the mouse on a desktop. */
async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
  if (isWide(page)) {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 8 });
    await page.mouse.up();
    return;
  }
  const session = await page.context().newCDPSession(page);
  const touch = (type: "touchStart" | "touchMove" | "touchEnd", at: { x: number; y: number }) =>
    session.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x: at.x, y: at.y }] });
  await touch("touchStart", from);
  for (let step = 1; step <= 8; step++) await touch("touchMove", { x: from.x + ((to.x - from.x) * step) / 8, y: from.y + ((to.y - from.y) * step) / 8 });
  await touch("touchEnd", to);
  await session.detach();
}

/** The rectangle round a set of points of the screen, with `margin` pixels to spare. */
function boxAround(places: { x: number; y: number }[], margin: number): { from: { x: number; y: number }; to: { x: number; y: number } } {
  const [xs, ys] = [places.map(({ x }) => x), places.map(({ y }) => y)];
  return { from: { x: Math.min(...xs) - margin, y: Math.min(...ys) - margin }, to: { x: Math.max(...xs) + margin, y: Math.max(...ys) + margin } };
}

/** Opens the day, brings it up, and turns edit mode on: returns where things are once the points are drawn. */
async function intoEditMode(page: Page, overrides: Overrides): Promise<{ project: Projector; writes: Awaited<ReturnType<typeof mockApi>>["writes"]; requests: string[] }> {
  await fixToday(page);
  const api = await mockApi(page, overrides);
  await page.goto("/day/2026-10-22");
  await expect(map(page)).toHaveAttribute("data-map-state", "ready");
  await expect(details(page).getByText("2 places")).toBeVisible();
  await sheetAtRest(page);
  await details(page).getByRole("button", { name: "Edit points" }).click();
  await expect(bar(page)).toBeVisible();
  await sheetAtRest(page);
  const project = await projector(page);
  await expectDot(page, project, WALK(3), INK); // the points are drawn, and the camera is at rest
  return { project, writes: api.writes, requests: api.requests };
}

test("edit_points_remove_two_points_by_tap_see_the_day_rebuilt_and_undo", { tag: "@smoke" }, async ({ page }) => {
  const server = editServer();
  const { project, writes } = await intoEditMode(page, server.overrides);
  const [a, b] = [WALK(3), WALK(8)];
  await expect(bar(page).getByText("0 selected")).toBeVisible();
  await expect(bar(page).getByRole("button", { name: "Remove 0 points" })).toBeDisabled();

  // A tap on a point selects it: red, and bigger; a tap on it again takes it off.
  await tap(page, placeOf(project, a));
  await expect(bar(page).getByText("1 selected")).toBeVisible();
  await expectDot(page, project, a, RED);
  await tap(page, placeOf(project, a));
  await expect(bar(page).getByText("0 selected")).toBeVisible();
  await expectDot(page, project, a, INK);
  await tap(page, placeOf(project, a));
  await tap(page, placeOf(project, b));
  await expect(bar(page).getByText("2 selected")).toBeVisible();
  await expectDot(page, project, a, RED);
  await expectDot(page, project, b, RED);
  await expectDot(page, project, WALK(5), INK); // and the points between are not

  // The bar is all there at the lowest point of the sheet: the owner taps on the map, and the buttons are where the thumb is.
  for (const name of ["Clear", "Remove 2 points", "Done"]) await expect(bar(page).getByRole("button", { name })).toBeInViewport({ ratio: 1 });
  await bar(page).getByRole("button", { name: "Remove 2 points" }).click();

  // Exactly the two points, by device and by the time as it was stored, to the microsecond.
  await expect(toast(page)).toHaveText(/Removed 2 points/);
  expect(writes).toEqual([{ method: "POST", path: "/api/points/remove", contentType: "application/json", body: removing(a, b) }]);
  expect(String((writes[0]!.body as { points: { t: number }[] }).points[0]!.t)).toMatch(/^\d{16}$/);
  await expect(bar(page).getByText("0 selected")).toBeVisible();
  await expect(bar(page)).toBeVisible(); // still in edit mode
  // The day is pending until the worker has rebuilt it, and then it is the rebuilt one.
  await expect(details(page).getByText("Updating…")).toBeVisible();
  await expect(details(page).getByText("Updating…")).toBeHidden({ timeout: 15_000 }); // asked again every 3 seconds
  await expect(details(page).getByText(`${DISTANCE_M - 2} m`, { exact: true })).toBeVisible();
  await expectDot(page, project, a, "none"); // and the points are asked for again: the two are gone from the map
  await expectDot(page, project, b, "none");
  await expectDot(page, project, WALK(5), INK);

  // Undo puts them back.
  await toast(page).getByRole("button", { name: "Undo" }).click();
  await expect(toast(page)).toHaveText(/Restored 2 points/);
  expect(writes.map((write) => `${write.method} ${write.path}`)).toEqual(["POST /api/points/remove", "DELETE /api/points/removed/batch-1"]);
  await expectDot(page, project, a, INK);
  await expectDot(page, project, b, INK);
  await expect(details(page).getByText(`${DISTANCE_M} m`, { exact: true })).toBeVisible({ timeout: 15_000 });
  expect(server.gone()).toEqual([]);
});

test("edit_points_remove_a_cluster_by_area_and_undo", async ({ page }) => {
  const server = editServer();
  const { project, writes } = await intoEditMode(page, server.overrides);
  const cluster = SPIKE.map((index) => placeOf(project, index));
  for (const index of SPIKE) await expectDot(page, project, index, INK); // a spike a long way from the route

  // Select area is the map's button, and is on until it is pressed again.
  await expect(selectArea(page)).toHaveAttribute("aria-pressed", "false");
  await selectArea(page).click();
  await expect(selectArea(page)).toHaveAttribute("aria-pressed", "true");

  // A drag draws a rectangle, and does not pan: the camera is where it was, and the points in the rectangle are selected on release.
  const { from, to } = boxAround(cluster, 24);
  await drag(page, from, to);
  await expect(bar(page).getByText("5 selected")).toBeVisible();
  for (const index of SPIKE) await expectDot(page, project, index, RED);
  await expectDot(page, project, WALK(3), INK); // the walk is not in it, and has not moved
  await expect(selectArea(page)).toHaveAttribute("aria-pressed", "true"); // still on: the next drag adds to it

  // A drag round two points of the walk adds them: seven. A tap in area mode still selects a point, for the surface has the touch.
  const walk = [placeOf(project, WALK(3)), placeOf(project, WALK(4))]; // 8 px apart: the box is 3 px wider than they are, and the next ones are outside it
  const second = boxAround(walk, 3);
  await drag(page, second.from, second.to);
  await expect(bar(page).getByText("7 selected")).toBeVisible();
  await tap(page, placeOf(project, WALK(4))); // and a tap on one of them takes it off
  await expect(bar(page).getByText("6 selected")).toBeVisible();
  await expectDot(page, project, WALK(4), INK);

  await bar(page).getByRole("button", { name: "Clear" }).click();
  await expect(bar(page).getByText("0 selected")).toBeVisible();
  await drag(page, from, to);
  await expect(bar(page).getByText("5 selected")).toBeVisible();

  // Turned off, a drag pans the map again: the spike, which is selected, goes with it (how far the map runs on after a flick is its own).
  await selectArea(page).click();
  await expect(selectArea(page)).toHaveAttribute("aria-pressed", "false");
  await drag(page, { x: cluster[0]!.x + 80, y: cluster[0]!.y }, { x: cluster[0]!.x + 140, y: cluster[0]!.y + 40 });
  await expectDot(page, project, SPIKE[0]!, "none");
  await expect(bar(page).getByText("5 selected")).toBeVisible(); // and it is selected still

  await bar(page).getByRole("button", { name: "Remove 5 points" }).click();
  await expect(toast(page)).toHaveText(/Removed 5 points/);
  expect(writes).toEqual([{ method: "POST", path: "/api/points/remove", contentType: "application/json", body: removing(...SPIKE) }]);
  expect(server.gone()).toEqual(SPIKE);
  expect(((writes[0]!.body as { points: { device: string }[] }).points).map((point) => point.device)).toEqual(["Watch", "Watch", "Watch", "Watch", "Watch"]);

  await toast(page).getByRole("button", { name: "Undo" }).click();
  await expect(toast(page)).toHaveText(/Restored 5 points/);
  expect(server.gone()).toEqual([]);
});

test("edit_points_a_shift_drag_selects_an_area_without_the_button_and_does_not_zoom_the_map", async ({ page }) => {
  const server = editServer();
  const { project } = await intoEditMode(page, server.overrides);
  const cluster = SPIKE.map((index) => placeOf(project, index));
  const { from, to } = boxAround(cluster, 24);

  await page.keyboard.down("Shift");
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.up("Shift");

  await expect(bar(page).getByText("5 selected")).toBeVisible();
  for (const index of SPIKE) await expectDot(page, project, index, RED);
  // MapLibre's own shift-drag zooms to the box: it is off, so the camera is where it was.
  await expectDot(page, project, WALK(3), INK);
  await expectDot(page, project, WALK(8), INK);

  // Nothing was selected by the click that comes with the release.
  await expect(bar(page).getByText("5 selected")).toBeVisible();
  await expect(selectArea(page)).toHaveAttribute("aria-pressed", "false");
});

test("edit_points_a_tap_in_edit_mode_opens_no_place_and_leaving_the_day_ends_edit_mode", async ({ page }) => {
  const server = editServer();
  const { project } = await intoEditMode(page, server.overrides);

  // The pin of the café, where the stay is: in edit mode a tap is for the points.
  const cafe = project([10.751, 59.9139]);
  await tap(page, cafe);
  await expect(page).toHaveURL(/\/day\/2026-10-22$/);
  await expect(bar(page).getByText("0 selected")).toBeVisible();

  await page.getByRole("button", { name: "Next day" }).click();
  await expect(page).toHaveURL(/\/day\/2026-10-23$/);
  await expect(bar(page)).toHaveCount(0);
  await expect(selectArea(page)).toHaveCount(0);

  await page.getByRole("button", { name: "Previous day" }).click();
  await expect(page).toHaveURL(/\/day\/2026-10-22$/);
  await expect(details(page).getByText("2 places")).toBeVisible();
  await expect(bar(page)).toHaveCount(0); // not in edit mode, coming back
  await expect(details(page).getByRole("button", { name: "Edit points" })).toBeVisible();
});

test("edit_points_done_ends_edit_mode_and_the_focus_goes_back_to_the_button", async ({ page }) => {
  const server = editServer();
  const { project } = await intoEditMode(page, server.overrides);
  await tap(page, placeOf(project, WALK(3)));
  await expect(bar(page).getByText("1 selected")).toBeVisible();

  await bar(page).getByRole("button", { name: "Done" }).click();

  await expect(bar(page)).toHaveCount(0);
  await expect(selectArea(page)).toHaveCount(0);
  await expect(details(page).getByRole("button", { name: "Edit points" })).toBeFocused();
  await expectDot(page, project, WALK(3), "none"); // the points are not drawn out of edit mode
});

test("edit_points_toast_is_in_view_above_the_sheet_at_every_height_of_it_and_can_be_pressed", async ({ page }) => {
  const server = editServer();
  const { project } = await intoEditMode(page, server.overrides);
  await tap(page, placeOf(project, WALK(3)));
  await bar(page).getByRole("button", { name: "Remove 1 point" }).click();
  await expect(toast(page)).toHaveText(/Removed 1 point/);

  const viewport = page.viewportSize()!;
  const snaps = isWide(page) ? ["sidebar"] : ["peek", "half", "full"];
  for (const snap of snaps) {
    if (snap === "half" || snap === "full") {
      await grip(page).click();
      await sheetAtRest(page);
    }
    // Over the map and the sheet, and above the lowest point of the sheet (96 px and what the device keeps); beside the sidebar of a wide screen.
    await expect(toast(page)).toBeInViewport({ ratio: 1 });
    const box = (await toast(page).getByRole("button", { name: "Undo" }).boundingBox())!;
    if (isWide(page)) expect(box.x, snap).toBeGreaterThanOrEqual(320); // beside the sidebar and not over it
    else expect(box.y + box.height, snap).toBeLessThanOrEqual(viewport.height - 96);
  }

  // At the highest point of the sheet it is over the sheet, and a press of it is a press of it: nothing is in the way.
  await toast(page).getByRole("button", { name: "Undo" }).click();
  await expect(toast(page)).toHaveText(/Restored 1 point/);
  expect(server.gone()).toEqual([]);
});

test("edit_points_toast_goes_by_itself_after_ten_seconds_unless_the_pointer_is_over_it", async ({ page }) => {
  test.setTimeout(60_000); // the toast is waited for: eleven seconds held, and the rest of its ten after it is let go
  const server = editServer();
  const { project } = await intoEditMode(page, server.overrides);
  await tap(page, placeOf(project, WALK(3)));
  await bar(page).getByRole("button", { name: "Remove 1 point" }).click();
  await expect(toast(page)).toHaveText(/Removed 1 point/);

  if (isWide(page)) {
    // Held by the pointer: it does not go while it is over it, which is longer than its time.
    await toast(page).getByRole("button", { name: "Undo" }).hover();
    await page.waitForTimeout(11_000);
    await expect(toast(page)).toHaveText(/Removed 1 point/);
    await page.mouse.move(700, 400);
  }
  await expect(toast(page)).toHaveCount(0, { timeout: 15_000 }); // empty again: the status is still there, and the message is gone
  await expect(page.getByRole("status").filter({ hasText: "Removed" })).toHaveCount(0);
});

test("edit_points_says_in_the_servers_words_why_a_removal_was_refused_and_that_an_undo_has_been_done_already", async ({ page }) => {
  const server = editServer();
  const { project, writes } = await intoEditMode(page, server.overrides);
  await tap(page, placeOf(project, WALK(3)));
  await expect(bar(page).getByText("1 selected")).toBeVisible();

  // A refusal is the server saying no to the request itself: its words, and no Retry, for sending it again is refused again.
  server.refuse({ status: 400, json: { statusCode: 400, message: "One or more errors occurred!", errors: { points: ["At most 50000 points can be removed at once."] } } });
  await bar(page).getByRole("button", { name: "Remove 1 point" }).click();
  const alert = bar(page).getByRole("alert");
  await expect(alert).toHaveText("Could not remove: At most 50000 points can be removed at once.");
  await expect(alert.getByRole("button")).toHaveCount(0);
  await expect(bar(page).getByRole("button", { name: "Remove 1 point" })).toBeDisabled(); // the same selection is refused again: Remove waits for it to change
  await expect(bar(page).getByRole("button", { name: "Clear" })).toBeEnabled(); // and that is the way back
  await expect(bar(page).getByRole("button", { name: "Clear" })).toBeFocused(); // which has the focus that Remove had
  await expect(bar(page).getByText("1 selected")).toBeVisible(); // the selection is as it was: the owner can take some off and try again
  await expectDot(page, project, WALK(3), RED);

  // A change of the selection takes the message away, and what is removed this time can be undone: but not twice.
  server.refuse(undefined);
  await tap(page, placeOf(project, WALK(5)));
  await expect(alert).toHaveCount(0);
  await bar(page).getByRole("button", { name: "Remove 2 points" }).click();
  await expect(toast(page)).toHaveText(/Removed 2 points/);
  server.forget("batch-1"); // it was undone from another window
  const reads = server.pointReads();
  await toast(page).getByRole("button", { name: "Undo" }).click();

  await expect(page.getByRole("alert").filter({ hasText: "Could not undo: That removal has been undone already." })).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Undo" })).toHaveCount(0); // it would be sent again and refused again: the toast has no Undo while this is there
  await expect(page.getByRole("button", { name: "Dismiss" })).toBeFocused(); // the focus was on the button that went: it is on the way out of the alert
  await expect(toast(page)).toHaveText(/Removed 2 points/); // what was done is still said
  await expect.poll(() => server.pointReads()).toBeGreaterThan(reads); // and what is on screen is asked for again
  expect(writes.map((write) => write.method)).toEqual(["POST", "POST", "DELETE"]);
  await page.getByRole("button", { name: "Dismiss" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Could not undo" })).toHaveCount(0);
  await expect(toast(page)).toHaveCount(0);
});

test("edit_points_tells_a_removal_that_the_server_refuses_after_done_in_the_toast_and_not_in_the_next_edit_mode", async ({ page }) => {
  // P4-R32: the owner presses Done while the removal is on its way, begins again, and it is refused.
  const server = editServer();
  const { project, writes } = await intoEditMode(page, server.overrides);
  const held = server.hold();
  await tap(page, placeOf(project, WALK(3)));
  await bar(page).getByRole("button", { name: "Remove 1 point" }).click();
  await expect.poll(() => writes.length).toBe(1);
  await bar(page).getByRole("button", { name: "Done" }).click();
  await details(page).getByRole("button", { name: "Edit points" }).click();
  await expect(bar(page)).toBeVisible();
  await expectDot(page, project, WALK(3), INK);

  held.answer({ status: 400, json: { statusCode: 400, message: "One or more errors occurred!", errors: { points: ["At most 50000 points can be removed at once."] } } });

  const alert = page.getByRole("alert").filter({ hasText: "Could not remove 1 point" });
  await expect(alert).toHaveText(/Could not remove 1 point: At most 50000 points can be removed at once\./);
  await expect(alert.getByRole("button", { name: "Retry" })).toHaveCount(0); // a refusal is refused again
  await expect(page.getByRole("button", { name: "Undo" })).toHaveCount(0);
  await expect(bar(page).getByRole("alert")).toHaveCount(0); // not in the bar of the edit mode that did not send it
  await expect(bar(page).getByText("0 selected")).toBeVisible();

  // The new edit mode is free of it: a tap selects, and Remove is on.
  await tap(page, placeOf(project, WALK(5)));
  await expect(bar(page).getByText("1 selected")).toBeVisible();
  await expect(bar(page).getByRole("button", { name: "Remove 1 point" })).toBeEnabled();
  await expectDot(page, project, WALK(5), RED);

  await page.getByRole("button", { name: "Dismiss" }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(server.gone()).toEqual([]);
});

test("edit_points_sends_the_points_of_a_removal_that_failed_after_done_again_on_retry_and_not_the_selection_of_the_next_edit_mode", async ({ page }) => {
  const server = editServer();
  const { project, writes } = await intoEditMode(page, server.overrides);
  const held = server.hold();
  await tap(page, placeOf(project, WALK(3)));
  await bar(page).getByRole("button", { name: "Remove 1 point" }).click();
  await expect.poll(() => writes.length).toBe(1);
  await bar(page).getByRole("button", { name: "Done" }).click();
  await details(page).getByRole("button", { name: "Edit points" }).click();
  await expectDot(page, project, WALK(3), INK);
  await tap(page, placeOf(project, WALK(5))); // the next edit mode has another point selected
  await expect(bar(page).getByText("1 selected")).toBeVisible();

  held.answer({ status: 503, json: {} }); // a failure that may pass

  const alert = page.getByRole("alert").filter({ hasText: "Couldn't remove 1 point" });
  await expect(alert).toContainText("Couldn't remove 1 point — Retry");
  await alert.getByRole("button", { name: "Retry" }).click();

  await expect(toast(page)).toHaveText(/Removed 1 point/);
  expect(writes.map((write) => write.body)).toEqual([removing(WALK(3)), removing(WALK(3))]); // the same point, and not the one that is selected now
  expect(server.gone()).toEqual([WALK(3)]);
  await expect(bar(page).getByText("1 selected")).toBeVisible(); // the selection of this edit mode is as it was
  await expectDot(page, project, WALK(5), RED);
  await expectDot(page, project, WALK(3), "none"); // and the removed point is gone from the map
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("edit_points_says_the_points_could_not_be_loaded_with_a_retry_that_draws_them", async ({ page }) => {
  const server = editServer();
  server.failPoints(2); // the first request, and the one more that the app makes by itself
  await fixToday(page);
  await mockApi(page, server.overrides);
  await page.goto("/day/2026-10-22");
  await expect(map(page)).toHaveAttribute("data-map-state", "ready");
  await expect(details(page).getByText("2 places")).toBeVisible();
  await sheetAtRest(page);

  await details(page).getByRole("button", { name: "Edit points" }).click();

  await expect(bar(page).getByRole("alert")).toContainText("Couldn't load the points");
  await expect(bar(page).getByRole("button", { name: "Done" })).toBeEnabled(); // and edit mode can be left
  await sheetAtRest(page); // where edit mode put it: the peek
  // Edit mode has lowered the sheet to its peek, which shows the row of the bar and nothing under it (and in a font that is wider than the one the
  // developer has the row may be two lines): the words, the Retry and the Done are in the row, and are on screen, or the owner sees no reason and has no way on.
  await expect(bar(page).getByRole("alert")).toBeInViewport({ ratio: 1 });
  await expect(bar(page).getByText("Couldn't load the points")).toBeInViewport({ ratio: 1 });
  await expect(bar(page).getByRole("button", { name: "Retry" })).toBeInViewport({ ratio: 1 });
  await expect(bar(page).getByRole("button", { name: "Done" })).toBeInViewport({ ratio: 1 });
  await bar(page).getByRole("button", { name: "Retry" }).click();
  await expect(bar(page).getByRole("alert")).toHaveCount(0);
  await expect(bar(page).getByText(/Tap a point/)).toBeVisible();
  const project = await projector(page);
  await expectDot(page, project, WALK(3), INK);
});
