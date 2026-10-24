import { defineConfig } from "@playwright/test";

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
