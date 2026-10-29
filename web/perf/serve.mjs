// The server of the web performance run (`npm run perf`, see playwright.perf.config.ts): the production build and the API answers that
// `npm run perf:record` recorded, over real HTTP, so that the network the run emulates (CDP `Network.emulateNetworkConditions`) is what
// every one of them goes through. A mocked answer (`page.route`) would not: the browser's throttle sits in its network stack, and a fulfilled
// request never reaches it.
//
//   node perf/serve.mjs [--port 4174] [--root ../src/Sporer.Api/wwwroot]
//
// It serves what the API serves, the way it serves it (Program.cs), and nothing else: the files of the web root with a strong ETag and a 304,
// `Cache-Control: public, max-age=31536000, immutable` under /assets/ and `no-cache` for the rest, text compressed with Brotli at quality 4
// (what `CompressionLevel.Optimal` is) or else gzip, every path that is no file and no /api/ call answered with index.html, and /api/ answered
// from the recording. What it leaves out: the time the API takes (a few milliseconds to a few tens, see the performance document: the
// recording is answered at once), and compressing on every request (it is done once and kept: 12 to 26 ms for a script at Optimal, Plan 2).
// A request for a path that was not recorded is answered 404 and noted: GET /__perf/unrecorded gives the list, and empties it, so that a run can
// check that it asked for nothing else.
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { readFileSync, statSync } from "node:fs";
import { dirname, extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const port = Number(option("--port", "4174"));
const root = join(here, "..", option("--root", join("..", "src", "Sporer.Api", "wwwroot")));
const recorded = join(here, "recorded");

const TYPES = {
  ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml",
  ".png": "image/png", ".webmanifest": "application/manifest+json", ".ico": "image/x-icon", ".woff2": "font/woff2",
};
// What the API compresses (Program.cs, options.MimeTypes).
const COMPRESSED = new Set(["application/json", "text/html", "text/css", "application/javascript", "text/javascript", "image/svg+xml"]);

const index = JSON.parse(readFileSync(join(recorded, "index.json"), "utf8"));
const config = readFileSync(join(here, "..", "e2e", "fixtures", "config.json"));
const unrecorded = [];

/** The answers that do not change: the body, its type, its tag and its compressed forms, made once. */
const entries = new Map();
function entry(key, body, type) {
  let found = entries.get(key);
  if (found === undefined) {
    const compress = COMPRESSED.has(type) && body.length >= 256; // the middleware leaves a tiny body alone
    found = {
      type,
      etag: `"${createHash("sha256").update(body).digest("base64url").slice(0, 27)}"`,
      identity: body,
      br: compress ? brotliCompressSync(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 4, [constants.BROTLI_PARAM_SIZE_HINT]: body.length } }) : null,
      gzip: compress ? gzipSync(body, { level: 6 }) : null,
    };
    entries.set(key, found);
  }
  return found;
}

function send(request, response, found, cacheControl) {
  const accepted = String(request.headers["accept-encoding"] ?? "");
  const encoding = found.br !== null && /\bbr\b/.test(accepted) ? "br" : found.gzip !== null && /\bgzip\b/.test(accepted) ? "gzip" : null;
  const body = encoding === null ? found.identity : found[encoding];
  response.setHeader("Content-Type", found.type.startsWith("text/") || found.type === "application/json" ? `${found.type}; charset=utf-8` : found.type);
  response.setHeader("ETag", found.etag);
  response.setHeader("Vary", "Accept-Encoding");
  if (cacheControl !== null) response.setHeader("Cache-Control", cacheControl);
  if (request.headers["if-none-match"] === found.etag) {
    response.statusCode = 304;
    response.end();
    return;
  }
  if (encoding !== null) response.setHeader("Content-Encoding", encoding);
  response.setHeader("Content-Length", body.length);
  response.end(request.method === "HEAD" ? undefined : body);
}

function file(path) {
  // Inside the root and nowhere else, whatever the path says.
  const full = normalize(join(root, path));
  if (full !== root && !full.startsWith(root + sep)) return null;
  try {
    return statSync(full).isFile() ? full : null;
  } catch {
    return null;
  }
}

createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  const { pathname } = url;

  if (pathname === "/__perf/unrecorded") {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(unrecorded.splice(0)));
    return;
  }

  if (pathname.startsWith("/api/")) {
    if (pathname === "/api/config") return send(request, response, entry("/api/config", config, "application/json"), null);
    const name = index.requests[pathname + url.search];
    if (name === undefined) {
      unrecorded.push(pathname + url.search);
      response.statusCode = 404;
      response.setHeader("Content-Type", "application/json");
      response.end("{}");
      return;
    }
    return send(request, response, entry(name, readFileSync(join(recorded, name)), "application/json"), null);
  }

  // A file of the web root; else, as the API does (Program.cs), a path whose last segment has no extension is a route of the app.
  let decoded = pathname;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    // not valid percent-encoding: it is no file, and is looked for as it is written
  }
  const path = file(pathname === "/" ? "index.html" : decoded) ?? (/\.\w+$/.test(pathname) ? null : file("index.html"));
  if (path === null) {
    response.statusCode = 404;
    response.end();
    return;
  }
  const isIndex = path === join(root, "index.html");
  const hashed = pathname.startsWith("/assets/") && !isIndex;
  send(request, response, entry(path, readFileSync(path), TYPES[extname(path)] ?? "application/octet-stream"), hashed ? "public, max-age=31536000, immutable" : "no-cache");
}).listen(port, "127.0.0.1", () => console.log(`perf server on http://127.0.0.1:${port}, serving ${root}`));
