import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Kept apart from vite.config.ts so that the production build carries nothing of the tests.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    globalSetup: ["./src/test/globalSetup.ts"],
    setupFiles: ["./src/test/setup.ts"],
    css: { modules: { classNameStrategy: "non-scoped" } },
    restoreMocks: true,
    unstubGlobals: true,
  },
});
