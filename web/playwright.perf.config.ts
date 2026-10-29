import { defineConfig } from "@playwright/test";
import e2e from "./playwright.config";

// The web performance run (`npm run perf`), kept apart from the e2e suite (`npm run e2e`, CI): it throttles the processor and the
// network, it takes minutes, and what it produces is numbers to read, not a verdict. The browser and the phone are the e2e suite's own, so
// that the device is the one that suite tests. A port of its own, but not to run the two at once: each builds the app into the same web
// root (see vite.config.ts), which it first empties. The `use` it takes from the e2e suite blocks service workers; the scenario of the
// installed app allows them for itself (web-timing.spec.ts).
const PORT = 4174;
const ORIGIN = `http://127.0.0.1:${PORT}`;

const phone = e2e.projects?.find((project) => project.name === "phone");
if (phone === undefined) throw new Error("playwright.config.ts has no phone project.");

export default defineConfig({
  testDir: "./perf",
  testMatch: "**/*.spec.ts",
  // One test at a time: a second browser would take processors from the first, and the numbers are for one phone's worth of page.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 120_000,
  reporter: [["list"]],
  use: { ...e2e.use, baseURL: ORIGIN, trace: "off" },
  projects: [{ ...phone }],
  webServer: {
    // The production bundle, and the API's answers that `npm run perf:record` recorded, served as the API serves them (perf/serve.mjs): over real HTTP,
    // so that the network the run emulates is what they go through, which a mocked answer would not be. `vite preview` has no API behind it, and no
    // Brotli, which the API sends.
    command: `npm run build && node perf/serve.mjs --port ${PORT}`,
    url: ORIGIN,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
