import { expect, test as base } from "@playwright/test";
import { unmockedRequests } from "./mockApi";

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost"]);

/**
 * The `test` every spec uses. For each test it fails the run if the page logged a console error or threw, made a request to
 * anywhere but the preview server, or called an API path that `mockApi` has no answer for. Output of a green run is silent.
 */
export const test = base.extend<{ guards: void }>({
  guards: [
    async ({ page }, use) => {
      const problems: string[] = [];
      const external: string[] = [];
      page.on("console", (message) => {
        if (message.type() === "error") problems.push(`console.error: ${message.text()}`);
      });
      page.on("pageerror", (error) => problems.push(`uncaught: ${error.message}`));
      // No test may reach a map tile server or any other host. Whatever tries is refused here and fails the test below.
      await page.route(
        (url) => /^https?:$/.test(url.protocol) && !LOCAL_HOSTS.has(url.hostname),
        (route) => {
          external.push(route.request().url());
          return route.abort();
        },
      );

      await use();

      // Soft, so that a failing test says all of what was wrong: a request that was refused also shows up as a console error.
      expect.soft(external, "requests to external hosts").toEqual([]);
      expect.soft(unmockedRequests(page), "API requests that mockApi has no answer for").toEqual([]);
      expect.soft(problems, "console errors and uncaught exceptions").toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };
