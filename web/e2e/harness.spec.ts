import type { Page } from "@playwright/test";
import { expect, test } from "./base";
import { mockApi } from "./mockApi";

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
