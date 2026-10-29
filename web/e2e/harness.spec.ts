import type { Page } from "@playwright/test";
import { expect, test } from "./base";
import { mockApi } from "./mockApi";
import { fixTime } from "./today";

// These tests are of the harness itself (base.ts and mockApi.ts): what it lets through, and what it still reports. A test
// that provokes a violation on purpose hands it over with `guard.take()` and checks it; anything it leaves fails the test.

// The page is on a plain file, so that the app does not make requests of its own while a test counts them.
const BLANK = "/test-style.json";

/** Runs `action` in the page and returns once the page has logged an error to the console, which is how the browser reports a failed request. */
async function untilConsoleError(page: Page, action: () => Promise<unknown>): Promise<void> {
  const logged = page.waitForEvent("console", (message) => message.type() === "error");
  await action();
  await logged;
}

test("deliberate_error_reply_passes_and_the_page_recovers", async ({ page, guard }) => {
  // The app asks for the days next to the one it shows as well, so this test counts the requests for the one date it is about.
  const DATE_PATH = "/api/day/2026-10-22";
  let asked = 0;
  const api = await mockApi(page, {
    // The first answer for that date is a 500, as in a test of the error state; the app asks once more by itself and gets a day.
    "day/*": (request) => {
      const { pathname } = new URL(request.url());
      if (pathname === DATE_PATH) {
        asked += 1;
        if (asked === 1) return { status: 500, json: { title: "Internal Server Error" } };
      }
      const date = pathname.split("/").pop();
      return { json: { date, timeZone: "Europe/Oslo", state: "done", summary: {}, segments: [] } };
    },
  });
  const failed = page.waitForEvent("console", (message) => message.type() === "error");

  await page.goto("/day/2026-10-22");

  const message = await failed; // the browser did report the 500...
  expect(message.text()).toContain("Failed to load resource");
  expect(message.text()).toContain("500");
  await expect(page.getByText("No data for this day")).toBeVisible(); // ...the app recovered...
  expect(api.requests.filter((request) => request === DATE_PATH)).toHaveLength(2);
  expect(guard.take()).toEqual({ consoleErrors: [], externalRequests: [], unmockedApiRequests: [] }); // ...and the guard let it pass
});

test("deliberate_error_status_of_a_handler_passes_for_any_path", async ({ page, guard }) => {
  await mockApi(page, { "places/9": () => ({ status: 404, json: { title: "Not Found" } }) });
  await page.goto(BLANK);

  await untilConsoleError(page, () => page.evaluate(() => fetch("/api/places/9")));

  expect(guard.take()).toEqual({ consoleErrors: [], externalRequests: [], unmockedApiRequests: [] });
});

test("deliberate_error_excuses_only_its_own_url", async ({ page, guard }) => {
  await mockApi(page, { "places/9": () => ({ status: 404 }) });
  await page.route("**/gone.json", (route) => route.fulfill({ status: 404 })); // not an API reply of the mock
  await page.goto(BLANK);

  await untilConsoleError(page, () => page.evaluate(() => fetch("/api/places/9")));
  await untilConsoleError(page, () => page.evaluate(() => fetch("/gone.json")));

  const found = guard.take();
  expect(found.consoleErrors).toHaveLength(1);
  expect(found.consoleErrors[0]).toContain("Failed to load resource");
  expect(found.consoleErrors[0]).toContain("/gone.json");
  expect(found.unmockedApiRequests).toEqual([]);
});

test("unmocked_api_call_is_still_reported", async ({ page, guard }) => {
  await mockApi(page);
  await page.goto(BLANK);

  await untilConsoleError(page, () => page.evaluate(() => fetch("/api/places/5")));

  const found = guard.take();
  expect(found.unmockedApiRequests).toEqual(["GET /api/places/5"]);
  expect(found.consoleErrors).toHaveLength(1); // the 501 is no deliberate error, so its console error counts too
  expect(found.consoleErrors[0]).toContain("501");
  expect(found.externalRequests).toEqual([]);
});

test("write_is_answered_by_the_override_of_its_method_and_recorded_with_what_it_said_it_sent", async ({ page, guard }) => {
  const api = await mockApi(page, {
    "POST status/retry": { retried: 2 },
    "PUT trips/*": (request) => ({ json: { seen: request.method() } }),
    "DELETE homes/3": () => ({ status: 204 }),
  });
  await page.goto(BLANK);

  const answers = await page.evaluate(async () => {
    const json = { "Content-Type": "application/json" };
    const post = await fetch("/api/status/retry", { method: "POST", headers: json, body: "{}" });
    const put = await fetch("/api/trips/2026-09-12", { method: "PUT", headers: json, body: JSON.stringify({ name: "Lisbon" }) });
    const del = await fetch("/api/homes/3", { method: "DELETE", headers: json });
    return { post: [post.status, await post.json()], put: [put.status, await put.json()], del: [del.status, await del.text()] };
  });

  expect(answers).toEqual({ post: [200, { retried: 2 }], put: [200, { seen: "PUT" }], del: [204, ""] });
  expect(api.writes).toEqual([
    { method: "POST", path: "/api/status/retry", contentType: "application/json", body: {} },
    { method: "PUT", path: "/api/trips/2026-09-12", contentType: "application/json", body: { name: "Lisbon" } },
    { method: "DELETE", path: "/api/homes/3", contentType: "application/json", body: null },
  ]);
  expect(guard.take()).toEqual({ consoleErrors: [], externalRequests: [], unmockedApiRequests: [] });
});

test("read_is_answered_by_an_override_written_with_its_method_too_and_the_bare_path_wins", async ({ page, guard }) => {
  await mockApi(page, {
    "GET status": { from: "GET status" },
    "GET places/*": { from: "GET places/*" },
    "places/2": { from: "bare places/2" },
  });
  await page.goto(BLANK);

  const answers = await page.evaluate(async () => {
    const read = async (path: string) => (await (await fetch(path)).json()) as unknown;
    return [await read("/api/status"), await read("/api/places/3"), await read("/api/places/2")];
  });

  expect(answers).toEqual([{ from: "GET status" }, { from: "GET places/*" }, { from: "bare places/2" }]);
  expect(guard.take()).toEqual({ consoleErrors: [], externalRequests: [], unmockedApiRequests: [] });
});

test("read_override_with_the_exact_path_wins_over_a_wildcard_in_either_spelling", async ({ page, guard }) => {
  await mockApi(page, {
    "places/*": { from: "places/*" },
    "GET places/*": { from: "GET places/*" },
    "GET places/2": { from: "GET places/2" }, // exact, though a bare wildcard is there
    "places/3": { from: "places/3" },
    "GET day/*": { from: "GET day/*" },
    "day/2026-10-22": { from: "day/2026-10-22" }, // exact bare, over the wildcard that has the method
  });
  await page.goto(BLANK);

  const answers = await page.evaluate(async () => {
    const read = async (path: string) => (await (await fetch(path)).json()) as unknown;
    return [await read("/api/places/2"), await read("/api/places/3"), await read("/api/places/4"), await read("/api/day/2026-10-22"), await read("/api/day/2026-10-23")];
  });

  expect(answers).toEqual([
    { from: "GET places/2" },
    { from: "places/3" },
    { from: "places/*" }, // both are wildcards: the bare one wins
    { from: "day/2026-10-22" },
    { from: "GET day/*" },
  ]);
  expect(guard.take()).toEqual({ consoleErrors: [], externalRequests: [], unmockedApiRequests: [] });
});

test("write_with_no_override_of_its_method_is_reported_even_where_a_read_of_the_path_is_mocked", async ({ page, guard }) => {
  const api = await mockApi(page, { "status/retry": { retried: 9 } }); // a GET override: it answers no POST
  await page.goto(BLANK);

  await untilConsoleError(page, () => page.evaluate(() => fetch("/api/status/retry", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })));

  expect(guard.take().unmockedApiRequests).toEqual(["POST /api/status/retry"]);
  expect(api.writes).toHaveLength(1); // and it was recorded all the same
});

test("api_call_in_a_spec_without_mockApi_is_refused_and_reported", async ({ page, guard }) => {
  // No mockApi here: whatever listens on the API's port on this machine must not be reached.
  await page.goto(BLANK);

  await untilConsoleError(page, () => page.evaluate(() => fetch("/api/status")));

  expect(guard.take().unmockedApiRequests).toEqual(["GET /api/status"]);
});

test("console_error_exception_and_external_request_are_still_reported", async ({ page, guard }) => {
  await mockApi(page);
  await page.goto(BLANK);

  await untilConsoleError(page, () => page.evaluate(() => console.error("boom")));
  const crashed = page.waitForEvent("pageerror");
  await page.evaluate(() => setTimeout(() => { throw new Error("kaput"); }, 0));
  await crashed;
  await untilConsoleError(page, () => page.evaluate(() => fetch("https://tiles.example.com/0/0/0.pbf").catch(() => undefined)));

  const found = guard.take();
  expect(found.externalRequests).toEqual(["https://tiles.example.com/0/0/0.pbf"]);
  expect(found.consoleErrors.some((line) => line.startsWith("console.error: boom"))).toBe(true);
  expect(found.consoleErrors).toContain("uncaught: kaput");
  expect(found.consoleErrors.some((line) => line.includes("Failed to load resource"))).toBe(true);
  expect(found.unmockedApiRequests).toEqual([]);
});

// Of fixTime (today.ts): the page's date and nothing else. A page whose animation frames or timers were faked (page.clock) makes the map
// draw a hundred frames a second, and software WebGL cannot keep up with that.
test("fixTime_fixes_the_date_of_the_page_and_leaves_its_timers_and_frames_alone", async ({ page }) => {
  await fixTime(page, "2026-10-22T22:30:00Z");
  await page.goto(BLANK);

  const seen = await page.evaluate(async () => {
    const before = performance.now();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await new Promise((resolve) => requestAnimationFrame(resolve));
    return {
      now: new Date().toISOString(),
      timestamp: Date.now(),
      called: Date() === new Date("2026-10-22T22:30:00Z").toString(), // the string of that moment, not of the machine's: a date that is asked for is as it was
      given: new Date("2020-02-29T12:00:00Z").toISOString(),
      zero: new Date(0).getTime(),
      parsed: Date.parse("2001-01-01T00:00:00Z"),
      utc: Date.UTC(2000, 0, 1),
      isDate: new Date() instanceof Date,
      elapsed: performance.now() - before,
      native: [performance.now, setTimeout, requestAnimationFrame].every((fn) => /\[native code\]/.test(fn.toString())),
    };
  });

  expect(seen.now).toBe("2026-10-22T22:30:00.000Z");
  expect(seen.timestamp).toBe(Date.parse("2026-10-22T22:30:00Z"));
  expect(seen.called).toBe(true);
  expect(seen.given).toBe("2020-02-29T12:00:00.000Z"); // a date that is asked for is as it was
  expect(seen.zero).toBe(0);
  expect(seen.parsed).toBe(978_307_200_000);
  expect(seen.utc).toBe(946_684_800_000);
  expect(seen.isDate).toBe(true);
  expect(seen.elapsed).toBeGreaterThanOrEqual(45); // the timers run on the browser's own time, and the date stood still all the while
  expect(seen.native).toBe(true);
});
