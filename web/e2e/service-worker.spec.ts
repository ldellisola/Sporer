import type { Page, Route } from "@playwright/test";
import { expect, test } from "./base";
import { mockApi } from "./mockApi";

// The service worker's own spec: the one place of the suite where it runs (playwright.config.ts blocks it everywhere else, so that the mocks of
// the API see every request). Every test has a browser context of its own, so each begins with no worker and installs one.
//
// What the page asks is seen by `page.route`, which is what `mockApi` and the guard (base.ts) use. What the worker itself asks of the network
// (the page of a navigation, and the files of the shell at install) is not the page's request: it is seen by `context.route` only, and only
// because playwright.config.ts sets PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS (read there why).
test.use({ serviceWorkers: "allow" });

const DAY = "/day/2026-10-22";

/**
 * Opens `path` and waits for the worker to be active and in control of the page: it is registered once the page has loaded, installs (the whole
 * shell is fetched first), and takes the open page over when it activates. Nothing here waits for a time to pass, only for the worker to get there.
 */
async function openWithWorker(page: Page, path = DAY): Promise<void> {
  await page.goto(path);
  await page.waitForFunction(async () => (await navigator.serviceWorker.getRegistration())?.active?.state === "activated");
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
}

const isApi = (url: URL): boolean => url.pathname.startsWith("/api/");

const topBar = (page: Page) => page.getByRole("group", { name: "View" });

/** The Retry of the view's error: the map's note has one of its own when the map has no style to draw. */
const retry = (page: Page) => page.getByRole(page.viewportSize()!.width >= 900 ? "complementary" : "region", { name: "Details" }).getByRole("button", { name: "Retry" });

test("the_worker_is_registered_for_the_whole_origin_and_controls_the_page_after_a_reload", { tag: "@smoke" }, async ({ page }) => {
  await mockApi(page);
  await page.goto(DAY);
  const origin = new URL(page.url()).origin;

  const registration = await page.evaluate(async () => {
    const ready = await navigator.serviceWorker.ready; // resolves once a worker is active
    return { scope: ready.scope, updateViaCache: ready.updateViaCache, script: ready.active?.scriptURL };
  });
  expect(registration).toEqual({ scope: `${origin}/`, updateViaCache: "none", script: `${origin}/sw.js` });

  await page.reload();

  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller?.scriptURL ?? null)).toBe(`${origin}/sw.js`);
  await expect(topBar(page)).toBeVisible(); // and the app is as it always is
});

test("the_worker_keeps_the_files_of_the_shell_and_nothing_else", { tag: "@smoke" }, async ({ page }) => {
  const api = await mockApi(page);
  await openWithWorker(page);
  // What the page asked for before the worker was in charge was never the worker's to see: reload, so that it is asked again, with the worker between.
  await page.reload();
  await expect.poll(() => api.requests.filter((request) => request === "/api/day/2026-10-22")).toHaveLength(2);
  await expect(page.getByText("No data for this day")).toBeVisible(); // it has been given what it asked for: none of it is to be kept

  const kept = await page.evaluate(async () => {
    const caches_: Record<string, string[]> = {};
    for (const name of await caches.keys()) caches_[name] = (await (await caches.open(name)).keys()).map((request) => new URL(request.url).pathname);
    return caches_;
  });

  const names = Object.keys(kept);
  expect(names).toHaveLength(1);
  expect(names[0]).toMatch(/^sporer-shell-[0-9a-f]{16}$/);
  const paths = kept[names[0]!]!;
  expect(paths).toContain("/index.html");
  expect(paths.some((path) => /^\/assets\/index-.+\.js$/.test(path))).toBe(true);
  expect(paths).toContain("/manifest.webmanifest");
  expect(paths.filter((path) => path.startsWith("/api"))).toEqual([]); // no answer of the API, whatever the request was
  expect(paths).not.toContain("/test-style.json"); // it is for the tests
  expect(paths).not.toContain("/sw.js"); // and the worker does not keep itself
});

test("the_worker_does_not_answer_the_api_and_without_the_mock_a_request_fails_as_it_does_without_a_worker", async ({ page, guard }) => {
  const api = await mockApi(page); // the app's own requests; the path asked for below is one that this test answers itself, and takes the answer away
  let served = 0;
  const isProbe = (url: URL): boolean => url.pathname === "/api/probe";
  const probe = (route: Route) => route.fulfill({ json: { served: ++served } });
  await page.route(isProbe, probe); // after the mock's route, so asked before it
  await openWithWorker(page);
  const ask = () => page.evaluate(async () => (await fetch("/api/probe")).json() as Promise<{ served: number }>);

  // Each request reaches the route, and has an answer of its own: not the first one again (a cache), and not an answer in the worker's own words.
  expect([await ask(), await ask(), await ask()]).toEqual([{ served: 1 }, { served: 2 }, { served: 3 }]);

  await page.reload(); // controlled from its first request: what the app asks for at start is the mock's to answer as well
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);
  await expect.poll(() => api.requests.filter((request) => request === "/api/config")).toHaveLength(2);

  // The mock removed: nothing answers the path any more, so it fails as any unmocked API call does, with the 501 of the guard, though three answers of
  // 200 have been had for it since. A worker that kept the answers of the API would give one of them back.
  await page.unroute(isProbe, probe);
  const without = await page.evaluate(async () => (await fetch("/api/probe")).status);

  expect(without).toBe(501);
  const found = guard.take(); // the guard has found what it is there to find, on purpose
  expect(found.unmockedApiRequests).toEqual(["GET /api/probe"]);
  expect(found.consoleErrors).toEqual([expect.stringContaining("Failed to load resource")]); // the browser's note of the 501
  expect(found.externalRequests).toEqual([]);
});

test("with_the_network_down_a_reload_shows_the_app_with_the_error_of_the_view_and_its_retry", async ({ context, page, guard }) => {
  const api = await mockApi(page);
  const styled = page.waitForResponse((response) => new URL(response.url()).pathname === "/test-style.json");
  await openWithWorker(page);
  await expect.poll(() => api.requests).toContain("/api/day/2026-10-22");
  await styled; // the map has its style: nothing of the page is left on the way to be cut off, and logged as an error, by what follows

  // Down: the worker's own requests fail, and so do the page's (a route that gives no answer, which is what a request with no network is).
  await context.setOffline(true);
  const [worker] = context.serviceWorkers();
  expect(await worker!.evaluate(() => fetch("/manifest.webmanifest").then(() => "reachable", () => "down"))).toBe("down"); // the switch reaches the worker
  await page.route(isApi, (route) => route.abort("internetdisconnected"));
  await page.reload();

  await expect(page).toHaveURL(new RegExp(`${DAY}$`)); // not an error page of the browser, which would have the address but no app
  await expect(page).toHaveTitle("Sporer");
  await expect(topBar(page)).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("Couldn't load");
  await expect(retry(page)).toBeVisible();

  // And the way back: with the network again, Retry loads what the view had no way to.
  await context.setOffline(false);
  await page.unroute(isApi);
  await retry(page).click();
  await expect(page.getByText("No data for this day")).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);

  // The only things the page logged, all the way, are the browser's notes of the requests that had no network. (Taken last: the app asks again
  // by itself once after a failure, a second later, and that one may come after the view has shown its error.)
  const found = guard.take();
  expect(found.consoleErrors.length).toBeGreaterThan(0);
  for (const message of found.consoleErrors) expect(message).toMatch(/^console\.error: Failed to load resource: net::ERR_INTERNET_DISCONNECTED \(http:\/\/[^/]+\/api\//);
  expect(found.unmockedApiRequests).toEqual([]);
  expect(found.externalRequests).toEqual([]);
});

test("a_navigation_goes_to_the_network_first_so_a_page_that_the_server_gives_is_the_one_shown", async ({ context, page }) => {
  await mockApi(page);
  await openWithWorker(page);
  // Not a page of the app, and not the cached one: only the network has it.
  await context.route("**/from-the-network", (route) => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>The server</title><h1>From the network</h1>" }));

  await page.goto("/from-the-network");

  await expect(page.getByRole("heading", { name: "From the network" })).toBeVisible();
  await expect(page.locator("#root")).toHaveCount(0); // not the shell
});

test("a_navigation_answered_with_a_redirect_ends_where_it_leads_and_not_on_the_cached_shell", async ({ context, page }) => {
  await mockApi(page);
  await openWithWorker(page);
  // The login of whatever stands in front of the app: it redirects a page of the app to its own page, which is not the app's.
  const seen: string[] = [];
  await context.route("**/sign-in-needed", (route) => {
    seen.push("redirect");
    return route.fulfill({ status: 302, headers: { location: "/login" } });
  });
  await context.route("**/login", (route) => {
    seen.push("login");
    return route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Log in</title><h1>Log in</h1>" });
  });

  await page.goto("/sign-in-needed");

  await expect(page.getByRole("heading", { name: "Log in" })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/login");
  await expect(page.locator("#root")).toHaveCount(0); // the shell, which the worker has, was not put in its place
  expect(seen).toEqual(["redirect", "login"]);
});

test("a_navigation_that_the_network_does_not_answer_within_3_seconds_shows_the_cached_shell", async ({ context, page }) => {
  await mockApi(page);
  await openWithWorker(page);
  // A server that has taken the request and does not answer it: it is let go at the end of the test.
  let held = 0;
  let release: () => void = () => undefined;
  const released = new Promise<void>((resolve) => (release = resolve));
  await context.route("**/slow-server", async (route: Route) => {
    held += 1;
    await released;
    await route.abort();
  });

  const started = Date.now();
  await page.goto("/slow-server");
  const took = Date.now() - started;

  await expect(topBar(page)).toBeVisible(); // the app: the page came from the worker's cache, as the network has said nothing
  expect(held).toBe(1);
  expect(took).toBeGreaterThanOrEqual(2_900); // the worker gave the network its 3 seconds first
  release();
});
