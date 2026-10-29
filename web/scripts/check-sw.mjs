// Checks the service worker that a build made: `npm run build` first (it writes into the API's web root, which this reads).
//
//   node scripts/check-sw.mjs [web-root]
//
// Exits 1, saying what is wrong, if /sw.js
//   - is missing, or is not a classic script (a top-level import or export: Safari's support for module workers is not to be relied on),
//   - does not start with the constant the build injects ({ version, files }),
//   - does not list every file of the output, above all every file under /assets/, or lists a file that is not there,
//   - lists what it must not keep: index.html (it is kept apart), test-style.json (it is for the tests), itself, a source map or a hidden file,
//   - has another version than the one that the files, index.html and the manifest and icons (by their bytes) make.
// The version is worked out here again, independently of build/serviceWorker.ts: the hash of the sorted files, index.html and the bytes of
// the files outside /assets/ (see below).
// Otherwise it prints what the worker keeps on first start: the number of files and their size, raw and Brotli at quality 11.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, constants } from "node:zlib";
import { Script } from "node:vm";

const root = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "Sporer.Api", "wwwroot");
const NOT_KEPT = ["index.html", "test-style.json", "sw.js"]; // and source maps, and hidden files (a stray .DS_Store the server does not serve)
const problems = [];
const fail = (message) => problems.push(message);

const swPath = join(root, "sw.js");
if (!existsSync(swPath)) {
  console.error(`check-sw: ${swPath} does not exist. Run the build first.`);
  process.exit(1);
}
const sw = readFileSync(swPath, "utf8");

// A classic script: it compiles as a script, which a top-level import or export does not.
try {
  new Script(sw, { filename: "sw.js" });
} catch (error) {
  fail(`sw.js is not a classic script: ${error.message}`);
}
if (/^\s*(import|export)\b/m.test(sw)) fail("sw.js has a top-level import or export.");

// The constant the build puts in front: a line of its own, `self.__SHELL__={...};`.
let shell;
const first = /^self\.__SHELL__=(.*);$/.exec(sw.split("\n", 1)[0]);
if (first === null) {
  fail("sw.js does not start with `self.__SHELL__={ version, files };`.");
} else {
  let parsed;
  try {
    parsed = JSON.parse(first[1]);
  } catch (error) {
    fail(`the constant at the start of sw.js is not JSON: ${error.message}`);
  }
  if (parsed !== undefined) {
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      fail("the constant at the start of sw.js is not an object with a version and files.");
    } else {
      shell = parsed;
      if (typeof shell.version !== "string" || shell.version.length < 12 || !/^[0-9a-f]+$/.test(shell.version)) fail(`the version is not a hex hash of 12 or more characters: ${JSON.stringify(shell.version)}.`);
      if (!Array.isArray(shell.files) || shell.files.some((file) => typeof file !== "string")) fail("the files are not a list of paths.");
    }
  }
}

// What is in the output, as root-relative paths.
const output = readdirSync(root, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => `/${relative(root, join(entry.parentPath, entry.name)).split(sep).join("/")}`)
  .sort();
const isKept = (path) => !NOT_KEPT.includes(path.slice(1)) && !path.endsWith(".map") && !path.split("/").some((part) => part.startsWith("."));
const expected = output.filter(isKept);

if (shell !== undefined && Array.isArray(shell.files)) {
  const listed = new Set(shell.files);
  for (const path of expected) if (!listed.has(path)) fail(`sw.js does not list ${path}${path.startsWith("/assets/") ? ", a hashed file under /assets/" : ""}.`);
  for (const path of shell.files) {
    if (!isKept(path)) fail(`sw.js lists ${path}, which it must not keep.`);
    else if (!output.includes(path)) fail(`sw.js lists ${path}, which is not in the output.`);
  }
  if (listed.size !== shell.files.length) fail("sw.js lists a file more than once.");
  if (shell.files.some((path, index) => index > 0 && path < shell.files[index - 1])) fail("sw.js does not list the files in order.");
}

// The version: the sorted files, a blank line, the page, a blank line, and a `name<TAB>sha256 of the bytes` line for each file that is not
// under /assets/ (the manifest and icons keep their names when they change; the files of /assets/ are named by their content). Of the files that
// are in the output, not of what sw.js says, so that a list that is wrong is not hidden by a version that agrees with it.
const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const indexPath = join(root, "index.html");
if (!existsSync(indexPath)) {
  fail("the output has no index.html.");
} else if (shell !== undefined) {
  const unhashed = expected.filter((path) => !path.startsWith("/assets/")).map((path) => `${path}\t${sha256(readFileSync(join(root, path)))}`);
  const hash = sha256(`${expected.join("\n")}\n\n${readFileSync(indexPath, "utf8")}\n\n${unhashed.join("\n")}`).slice(0, 16);
  if (shell.version !== hash) fail(`the version is ${shell.version}, and the files, index.html and the bytes of the files outside /assets/ make ${hash}.`);
}

if (problems.length > 0) {
  console.error(`check-sw: ${swPath}`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

// What the first start fetches: the files, and index.html, which the worker keeps as the page.
const kept = [...expected, "/index.html"];
let raw = 0;
let brotli = 0;
for (const path of kept) {
  const body = readFileSync(join(root, path));
  raw += body.length;
  brotli += brotliCompressSync(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length;
}
const kB = (bytes) => `${(bytes / 1000).toFixed(1)} kB`;
console.log(`check-sw: ok. version ${shell.version}, ${shell.files.length} files and index.html, ${kB(raw)} raw, ${kB(brotli)} Brotli (quality 11).`);
