// Sizes of the production JavaScript, gzipped: `npm run build` first (it writes into the API's web root, which this reads).
//
//   node scripts/perf/bundle-size.mjs [dist-dir]
//
// Spec §8 / the plan's target: 450 kB gzip of JavaScript including MapLibre. MapLibre is two files, the library (a chunk of its
// own, see vite.config.ts) and the worker it draws and parses in (an asset of the build). Gzip at level 9, as a server would at
// its best: Vite's own report uses the default level (6) and comes out a little larger, so that is given too, and Brotli (quality 11).
// Neither is what the API sends: its response compression is the fastest level of each, which comes out larger than both.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

const root = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "src", "Sporer.Api", "wwwroot");
const assets = join(root, "assets");

const sizes = readdirSync(assets).map((name) => {
  const body = readFileSync(join(assets, name));
  return {
    name,
    raw: body.length,
    gzip: gzipSync(body, { level: 9 }).length,
    gzip6: gzipSync(body).length,
    brotli: brotliCompressSync(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length,
  };
});
const kB = (bytes) => `${(bytes / 1000).toFixed(1)} kB`;
const sum = (list, key) => list.reduce((total, item) => total + item[key], 0);

const js = sizes.filter((s) => /\.m?js$/.test(s.name));
const isLibrary = (s) => s.name.startsWith("maplibre-gl-worker") === false && s.name.startsWith("maplibre");
const isWorker = (s) => s.name.startsWith("maplibre-gl-worker");
const library = js.filter(isLibrary);
const worker = js.filter(isWorker);
const app = js.filter((s) => !isLibrary(s) && !isWorker(s));
const css = sizes.filter((s) => s.name.endsWith(".css"));

for (const s of [...js].sort((a, b) => b.gzip - a.gzip)) console.log(`${s.name.padEnd(40)} ${kB(s.raw).padStart(10)} raw ${kB(s.gzip).padStart(10)} gzip 9 ${kB(s.gzip6).padStart(10)} gzip 6 ${kB(s.brotli).padStart(10)} brotli 11`);
console.log("");
const row = (label, list) =>
  console.log(`${label.padEnd(34)} ${kB(sum(list, "gzip")).padStart(10)} gzip 9 ${kB(sum(list, "gzip6")).padStart(10)} gzip 6 ${kB(sum(list, "brotli")).padStart(10)} brotli 11`);
row("JavaScript, total", js);
row("  MapLibre library chunk", library);
row("  MapLibre worker", worker);
row("  MapLibre together", [...library, ...worker]);
row("  the rest (app, React, Query)", app);
row("  without the worker", [...library, ...app]);
row("CSS", css);
console.log(`JavaScript raw: ${kB(sum(js, "raw"))}`);
