import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The production build goes straight into the API's web root, which the API serves (see Program.cs). Vite's default
// `assets/` directory stays: the API gives everything under /assets/ a year-long immutable cache.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "../src/Sporer.Api/wwwroot",
    emptyOutDir: true, // the output lies outside the project root, so Vite must be told it may clear it
  },
  server: {
    proxy: { "/api": "http://localhost:5097" },
  },
});
