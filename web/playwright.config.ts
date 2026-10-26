import { defineConfig } from "@playwright/test";

declare const process: { env: Record<string, string | undefined> }; // this file runs in Node, whose types the app does not take

// A fixed port, so that the tests and the server agree without environment variables. Nothing else of the repository
// listens here: the API is on 5097 and the Vite dev server on 5173.
const PORT = 4173;
const ORIGIN = `http://127.0.0.1:${PORT}`;

// The container has no GPU. SwiftShader is Chrome's software WebGL, which MapLibre needs to draw at all.
const WEBGL_ARGS = ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"];

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  fullyParallel: true,
  // Every worker has a browser of its own, and each draws the map in software on the same processors. On four of them two workers finish
  // the suite in 2.0 minutes against 2.6 for one, and the slowest test takes 10 s instead of 6 (the timeout is 30). CI is for a verdict
  // that does not depend on how busy the runner is: one worker. Where the machine is one's own, the default (half the processors) is faster.
  workers: process.env["CI"] ? 1 : undefined,
  forbidOnly: true, // a committed test.only would silently skip every other test: fail instead
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: ORIGIN,
    trace: "retain-on-failure",
    launchOptions: { args: WEBGL_ARGS },
  },
  projects: [
    {
      name: "phone",
      use: {
        browserName: "chromium",
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
      },
    },
    {
      name: "desktop",
      use: {
        browserName: "chromium",
        viewport: { width: 1280, height: 800 },
      },
    },
  ],
  webServer: {
    // The production bundle, as the API serves it, not the dev server. `vite preview` answers deep links with index.html.
    command: `npm run build && npx vite preview --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: ORIGIN,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
