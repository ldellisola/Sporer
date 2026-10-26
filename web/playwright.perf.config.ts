import { defineConfig } from "@playwright/test";
import e2e from "./playwright.config";

// The web performance run (`npm run perf`), kept apart from the e2e suite (`npm run e2e`, CI): it throttles the processor, it
// takes minutes, and what it produces is numbers to read, not a verdict. The browser and the phone are the e2e suite's own, so that
// the device is the one that suite tests. A port of its own, so that the two can run at once.
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
    // The production bundle, as the API serves it. `vite preview` answers deep links with index.html and has no API behind it:
    // the specs answer `/api/` themselves, from what `npm run perf:record` recorded.
    command: `npm run build && npx vite preview --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: ORIGIN,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
