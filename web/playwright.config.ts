import { defineConfig, devices, type PlaywrightTestConfig } from "@playwright/test";

declare const process: { env: Record<string, string | undefined> }; // this file runs in Node, whose types the app does not take

// A fixed port, so that the tests and the server agree without environment variables. Nothing else of the repository
// listens here: the API is on 5097 and the Vite dev server on 5173.
const PORT = 4173;
const ORIGIN = `http://127.0.0.1:${PORT}`;

// Playwright (1.56) lets a route, and the offline switch, reach the requests that a service worker makes itself (the page of a navigation, the files
// of the shell at install) only when this is set: its network events for workers are still marked experimental. Without it those requests go to the
// real network whatever a test says, and service-worker.spec.ts would be testing a worker that is never offline, never slow and never redirected.
// It is set here, so for the whole run: the other specs are not affected, because they block service workers (`serviceWorkers: "block"` below), so
// there is no worker target for it to apply to. It is read by the process that launches the browser, which is a test worker: a browser that
// is not launched by it (a remote one, `PW_TEST_CONNECT_WS_ENDPOINT`) needs it set on its own server. Check it again when Playwright is upgraded.
process.env["PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS"] = "1";

// The container has no GPU. SwiftShader is Chrome's software WebGL, which MapLibre needs to draw at all. These are Chromium's flags: WebKit
// refuses to launch with ones it does not know, so they are the Chromium projects' own (below) and not the whole run's.
const WEBGL_ARGS = ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"];

const PHONE_VIEWPORT = { width: 390, height: 844 };

// A WebKit project, for the owner's browser (iOS Safari), is there only when asked for: CI asks (see .github/workflows/docker-publish.yml), and a run
// on one's own machine is the Chromium projects as always, with no WebKit installed. It runs only the tests tagged `@smoke`, one or two of each flow
// (the app opens on today, the day, the month, a trip, the name of a place, Settings, the service worker's install): enough to know that the app
// works in the engine of the phone, without a second run of the whole suite on a runner that is slow already. Tests that are not tagged are
// Chromium's. Left out on purpose: the test of removing points (edit-points.spec.ts), which reads the pixels of the points right after edit mode sets
// them: headless WebKit puts the last frame of a WebGL canvas into a screenshot late (the points are in the canvas, and in the screenshot only after
// another frame is drawn), and after the points the map is idle; the trips test, whose map keeps moving, runs on WebKit too. And the two service-worker
// cases that need `page.route` to see the requests of a page that a worker controls, which Playwright on WebKit does not route. Edit mode on Safari is
// in the owner's iPhone checklist (README).
const webkit: PlaywrightTestConfig["projects"] =
  process.env["PW_WEBKIT"] === "1"
    ? [
        {
          name: "webkit",
          // The descriptor of the iPhone 14 is WebKit (iOS Safari's engine), touch and mobile, at 3 pixels to the CSS pixel, as the phone project is;
          // its viewport leaves out the browser's own bars, so the phone project's is put back, to be the same page as the phone project tests.
          use: { ...devices["iPhone 14"], browserName: "webkit", viewport: PHONE_VIEWPORT },
          grep: /@smoke/,
        },
      ]
    : [];

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
    // The service worker is for its own spec (service-worker.spec.ts), which turns it on. Everywhere else it would stand between the page and the
    // network and answer for files and pages itself, which `page.route` (what the API mocks and the guard of base.ts are made of) cannot see.
    serviceWorkers: "block",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "phone",
      use: {
        browserName: "chromium",
        launchOptions: { args: WEBGL_ARGS },
        viewport: PHONE_VIEWPORT,
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
      },
    },
    {
      name: "desktop",
      use: {
        browserName: "chromium",
        launchOptions: { args: WEBGL_ARGS },
        viewport: { width: 1280, height: 800 },
      },
    },
    ...webkit,
  ],
  webServer: {
    // The production bundle, as the API serves it, not the dev server. `vite preview` answers deep links with index.html.
    command: `npm run build && npx vite preview --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: ORIGIN,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
