import { defineConfig, devices, type PlaywrightTestConfig } from "@playwright/test";

declare const process: { env: Record<string, string | undefined> }; // this file runs in Node, whose types the app does not take

// A fixed port, so that the tests and the server agree without environment variables. Nothing else of the repository
// listens here: the API is on 5097 and the Vite dev server on 5173.
const PORT = 4173;
const ORIGIN = `http://127.0.0.1:${PORT}`;

// The container has no GPU. SwiftShader is Chrome's software WebGL, which MapLibre needs to draw at all. These are Chromium's flags: WebKit
// refuses to launch with ones it does not know, so they are the Chromium projects' own (below) and not the whole run's.
const WEBGL_ARGS = ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"];

// For a machine whose Chromium is not the one that this version of Playwright installs (a container with an older build, and no way to
// download one): PW_CHROMIUM_PATH is the path of a Chromium to launch instead. Only local runs set it; CI does not, and then Playwright
// uses its own. Unset, the launch option is absent altogether.
const CHROMIUM_PATH = process.env["PW_CHROMIUM_PATH"];
const CHROMIUM_LAUNCH = { args: WEBGL_ARGS, ...(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {}) };

const PHONE_VIEWPORT = { width: 390, height: 844 };

// A WebKit project, for the owner's browser (iOS Safari), is there only when asked for: CI asks (see .github/workflows/docker-publish.yml), and a run
// on one's own machine is the Chromium projects as always, with no WebKit installed. It runs only the tests tagged `@smoke`, one or two of each flow
// (the app opens on today, day navigation, the month, opening a trip, renaming a place, Settings, and the service worker installing from a page that is not the app): enough to know that the app
// works in the engine of the phone, without a second run of the whole suite on a runner that is slow already. Tests that are not tagged are
// Chromium's. Left out on purpose: the test of removing points (edit-points.spec.ts), which reads the pixels of the points right after edit mode sets
// them: headless WebKit puts the last frame of a WebGL canvas into a screenshot late (the points are in the canvas, and in the screenshot only after
// another frame is drawn), and after the points the map is idle; the trips test, whose map keeps moving, runs on WebKit too. And the two service-worker
// cases that need `page.route` to see the requests of a page that a worker controls, which Playwright on WebKit does not route. And the test of a session that has ended at the login, which answers the API with a redirect that Playwright cannot fake on WebKit (`route.fulfill` refuses a 302 there). Edit mode and the login on Safari are
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
        launchOptions: CHROMIUM_LAUNCH,
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
        launchOptions: CHROMIUM_LAUNCH,
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
