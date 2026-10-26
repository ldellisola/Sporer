// Sizes of the production JavaScript, gzipped: `npm run build` first (it writes into the API's web root, which this reads).
//
//   node scripts/perf/bundle-size.mjs [dist-dir]
//
// The plan's target, 450 kB gzip of JavaScript including MapLibre, is judged on main-thread JavaScript (ruling P2-R63): the chunks
// the page runs. MapLibre is two files, the library (a chunk of its own, see vite.config.ts, fetched when the map mounts) and the
// worker it parses in (an asset of the build, a file that is not run on the main thread); the worker is reported apart, and the
// total of every file is given too. Gzip at level 9, as a server would at its best: Vite's own report uses the default level (6) and
// comes out a little larger, so that is given too, and Brotli at quality 11. The API itself compresses at the Optimal level of both
// (Program.cs), which comes out at about gzip 9; see the performance document.
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
// What the page starts with: the module script of index.html and what it preloads. MapLibre's chunk is not among them: the map fetches it
// itself once it is mounted (src/map/maplibre.ts).
const html = readFileSync(join(root, "index.html"), "utf8");
const starting = new Set([...html.matchAll(/<(?:script|link)[^>]*\s(?:src|href)="\/assets\/([^"]+\.m?js)"/g)].map((match) => match[1]));
const start = js.filter((s) => starting.has(s.name));

row("JavaScript, all files", js);
row("  main-thread JavaScript (target)", [...library, ...app]);
row("    the page starts with", start);
row("    MapLibre chunk, fetched by the map", library);
row("  MapLibre's worker, apart", worker);
row("  MapLibre together", [...library, ...worker]);
row("  the rest (app, React, Query)", app);
row("CSS", css);
console.log(`JavaScript raw: ${kB(sum(js, "raw"))}`);
