import { expect, test as base } from "@playwright/test";
import { guardApi, isDeliberateError, takeUnmockedRequests } from "./mockApi";

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost"]);

/** What the guard has found wrong with a page. */
export interface Violations {
  /** `console.error` calls and the browser's own error messages (a failed resource), and uncaught exceptions. */
  consoleErrors: string[];
  /** Requests to a host other than the preview server; refused. */
  externalRequests: string[];
  /** Requests to `/api/` that `mockApi` has no answer for, as `GET /api/places/5`. */
  unmockedApiRequests: string[];
}

export interface Guard {
  /**
   * Hands over what the guard has found so far and forgets it. Only a test of the guard itself, or one that provokes a
   * violation on purpose, has any use for it: everything left when a test ends fails the test.
   */
  take(): Violations;
}

/**
 * The `test` every spec uses. Whatever a test does, it fails if the page logged a console error or threw, made a request to
 * anywhere but the preview server, or called an `/api/` path that `mockApi` has no answer for (a spec that never calls
 * `mockApi` has none, so every API call of it fails the test; none reaches a real backend). One exception: an API reply that
 * `mockApi` was told to give an error status. The browser logs "Failed to load resource" for it, and that message, for that
 * URL only, is excused. Output of a green run is silent.
 */
export const test = base.extend<{ guard: Guard }>({
  guard: [
    async ({ page }, use) => {
      const consoleErrors: string[] = [];
      const externalRequests: string[] = [];
      page.on("console", (message) => {
        if (message.type() !== "error") return;
        const { url } = message.location();
        if (message.text().startsWith("Failed to load resource") && isDeliberateError(page, url)) return;
        consoleErrors.push(`console.error: ${message.text()}${url ? ` (${url})` : ""}`);
      });
      page.on("pageerror", (error) => consoleErrors.push(`uncaught: ${error.message}`));
      // First, so that the route of `mockApi`, which comes later, is asked before it.
      await guardApi(page);
      // No test may reach a map tile server or any other host. Whatever tries is refused here and fails the test below.
      await page.route(
        (url) => /^https?:$/.test(url.protocol) && !LOCAL_HOSTS.has(url.hostname),
        (route) => {
          externalRequests.push(route.request().url());
          return route.abort();
        },
      );

      const guard: Guard = {
        take: () => ({
          consoleErrors: consoleErrors.splice(0),
          externalRequests: externalRequests.splice(0),
          unmockedApiRequests: takeUnmockedRequests(page),
        }),
      };
      await use(guard);

      // Soft, so that a failing test says all of what was wrong: a request that was refused also shows up as a console error.
      const left = guard.take();
      expect.soft(left.externalRequests, "requests to external hosts").toEqual([]);
      expect.soft(left.unmockedApiRequests, "API requests that mockApi has no answer for").toEqual([]);
      expect.soft(left.consoleErrors, "console errors and uncaught exceptions").toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };
