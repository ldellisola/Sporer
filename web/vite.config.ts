import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { serviceWorker } from "./build/serviceWorker.ts";

// The production build goes straight into the API's web root, which the API serves (see Program.cs). Vite's default
// `assets/` directory stays: the API gives everything under /assets/ a year-long immutable cache.
export default defineConfig({
  plugins: [react(), serviceWorker()],
  build: {
    outDir: "../src/Sporer.Api/wwwroot",
    emptyOutDir: true, // the output lies outside the project root, so Vite must be told it may clear it
    rolldownOptions: {
      // MapLibre is most of the bytes of the app. In a chunk of its own it is fetched once and kept while the app around it
      // changes from release to release.
      output: { codeSplitting: { groups: [{ name: "maplibre", test: /node_modules[\\/]maplibre-gl[\\/]/ }] } },
    },
    // ...and it is a megabyte on its own (a third of that over the wire), which is no reason for the build to warn every time.
    chunkSizeWarningLimit: 1500,
  },
  server: {
    proxy: { "/api": "http://localhost:5097" },
  },
  preview: {
    // `vite preview` serves the e2e tests, which must never reach a real API (they mock it; see e2e/mockApi.ts). Left out,
    // it would inherit the proxy above.
    proxy: {},
  },
});
