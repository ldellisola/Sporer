import type { Page } from "@playwright/test";
import { expect, test } from "./base";

// What the app does when something in front of the API (the login of a proxy) answers its requests with a redirect, as it does once the owner's
// session there has ended: it reloads the page, which the same proxy then sends to its login, and it does so once a minute at most, so that a
// login that does not take the page away cannot make it reload for ever (client.ts). A page that is redirected here is only told so by the
// requests it makes; there is no login in this suite, so the page is left where it is.
//
// Run with service workers blocked, as the rest of the suite is: the worker has no part in an API request (service-worker.spec.ts). With no worker
// controlling the page, `page.route` sees its requests on WebKit too, so the redirect test is in the smoke set (@smoke).

const isApi = (url: URL): boolean => url.pathname.startsWith("/api/");

/** The Retry of the view's error: the map's note has one of its own when the map has no style to draw. */
const retry = (page: Page) => page.getByRole(page.viewportSize()!.width >= 900 ? "complementary" : "region", { name: "Details" }).getByRole("button", { name: "Retry" });

test("an_api_answer_that_is_a_redirect_reloads_the_page_once_and_a_second_one_within_a_minute_does_not", { tag: "@smoke" }, async ({ page }) => {
  let redirected = 0;
  // Every request of the API is answered with a redirect to a file the server has (what the login would be), before the guard of the suite sees it.
  await page.route(isApi, (route) => {
    redirected += 1;
    return route.fulfill({ status: 302, headers: { location: "/test-style.json" } });
  });
  const navigations: string[] = []; // the requests of the page itself: the first load, and each reload
  page.on("request", (request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) navigations.push(request.url());
  });

  await page.goto("/day/2026-10-22");

  // The first answer that is a redirect reloads the page; the reloaded page is answered the same way, and shows the error of its view with Retry.
  await expect.poll(() => navigations).toHaveLength(2);
  await expect(page.getByRole("alert")).toContainText("Couldn't load");
  await expect(page.getByRole("alert")).toContainText("close and reopen the app to sign in"); // the one that was held back says what to do
  await expect(retry(page)).toBeVisible();
  expect(navigations).toHaveLength(2); // and that answer, the second within the minute, reloaded nothing

  // Retry asks again, is redirected again, and the page stays: the error is shown again, where it is.
  const before = redirected;
  await retry(page).click();
  await expect.poll(() => redirected).toBeGreaterThan(before);
  await expect(page.getByRole("alert")).toContainText("Couldn't load");
  await expect(retry(page)).toBeVisible();
  expect(navigations).toHaveLength(2);
  expect(new URL(page.url()).pathname).toBe("/day/2026-10-22"); // the reload was of this page, and nothing took it anywhere else
});

test("an_api_answer_that_is_a_network_failure_does_not_reload_the_page", async ({ page, guard }) => {
  await page.route(isApi, (route) => route.abort("connectionrefused"));
  const navigations: string[] = [];
  page.on("request", (request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) navigations.push(request.url());
  });

  await page.goto("/day/2026-10-22");

  await expect(page.getByRole("alert")).toContainText("Couldn't load");
  await expect(retry(page)).toBeVisible();
  expect(navigations).toHaveLength(1); // a server that cannot be reached is not a sign-out

  // The browser's notes of the refused connections are all the page logged.
  const found = guard.take();
  expect(found.consoleErrors.length).toBeGreaterThan(0);
  for (const message of found.consoleErrors) expect(message).toMatch(/^console\.error: Failed to load resource: net::ERR_CONNECTION_REFUSED \(http:\/\/[^/]+\/api\//);
});
