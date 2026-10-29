import { readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { build, normalizePath, type Plugin, type ResolvedConfig } from "vite";

// Makes /sw.js, the service worker (src/sw/sw.ts), when the app is built: the worker, with the list of the files it keeps and the version
// of that list in front of it. `vite dev` neither builds nor serves it.
//
// The worker is a script of its own, not a module of the app: a nested build of src/sw/sw.ts into one classic script (an IIFE, with no
// import or export, for Safari does not run module workers reliably), which this plugin emits next to the app's files, wherever the build's
// outDir is.

const WORKER_SOURCE = "src/sw/sw.ts";
const WORKER_FILE = "sw.js";

// What the worker does not keep as a file of the shell: the page (it is kept apart, as /index.html, for navigations), the style that only
// the tests use, the worker itself, source maps, and hidden files (a stray .DS_Store of public/ is copied, and the server does not serve it:
// one file that is not there fails the whole install).
const NOT_IN_SHELL = new Set(["index.html", "test-style.json", WORKER_FILE]);

/** The files of a build that the worker keeps, as root-relative paths in order. `names` are relative to the build's outDir. */
export function shellFilesOf(names: Iterable<string>): string[] {
  return [...new Set(names)]
    .filter((name) => !NOT_IN_SHELL.has(name) && !name.endsWith(".map") && !name.split("/").some((part) => part.startsWith(".")))
    .map((name) => `/${name}`)
    .sort();
}

/**
 * Names the shell: a hash of the files' names and of the page. Vite names what it makes after its content (a file under assets/), so this
 * changes whenever anything of the app does, and stays when nothing does. scripts/check-sw.mjs makes the same hash, on its own.
 */
export async function versionOf(files: readonly string[], indexHtml: string): Promise<string> {
  const text = `${[...files].sort().join("\n")}\n\n${indexHtml}`;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return [...digest.slice(0, 8)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function serviceWorker(): Plugin {
  let config: ResolvedConfig;

  return {
    name: "sporer:service-worker",
    apply: "build",
    // After Vite's own plugins, so that the bundle has the page as it is written, with its hashed names.
    enforce: "post",
    configResolved(resolved) {
      config = resolved;
      if (resolved.base !== "/") throw new Error(`The service worker's scope is /: build.base must be "/", not "${resolved.base}".`);
    },
    async generateBundle(_options, bundle) {
      const page = bundle["index.html"];
      if (page?.type !== "asset") throw new Error("The service worker keeps the page, and the build has no index.html.");
      const indexHtml = typeof page.source === "string" ? page.source : new TextDecoder().decode(page.source);

      // The bundle has what Vite makes; what it copies from public/ it does not list.
      const names = [...Object.keys(bundle), ...(await publicFiles(config))];
      const files = shellFilesOf(names);
      const version = await versionOf(files, indexHtml);

      const code = await buildWorker(config);
      // The constant first: sw.ts reads it as `self.__SHELL__`. A line of its own, so that scripts/check-sw.mjs can read it back.
      this.emitFile({ type: "asset", fileName: WORKER_FILE, source: `self.__SHELL__=${JSON.stringify({ version, files })};\n${code}` });
    },
  };
}

// The files that Vite copies from public/ into the output, relative to it. (Vite copies them before it writes the bundle, and not into the bundle.)
async function publicFiles(config: ResolvedConfig): Promise<string[]> {
  const { publicDir } = config;
  if (!config.build.copyPublicDir || publicDir === "") return [];
  const entries = await readdir(publicDir, { recursive: true, withFileTypes: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => normalizePath(relative(publicDir, join(entry.parentPath, entry.name))));
}

async function buildWorker(config: ResolvedConfig): Promise<string> {
  const result = await build({
    configFile: false, // none of the app's plugins or settings, and so not this plugin again
    root: config.root,
    logLevel: "warn",
    publicDir: false,
    build: {
      write: false,
      emptyOutDir: false,
      target: config.build.target,
      minify: true,
      reportCompressedSize: false,
      rolldownOptions: {
        input: resolve(config.root, WORKER_SOURCE),
        output: { format: "iife", entryFileNames: WORKER_FILE },
      },
    },
  });

  const outputs = (Array.isArray(result) ? result : [result]).flatMap((one) => ("output" in one ? one.output : []));
  const chunks = outputs.filter((output) => output.type === "chunk");
  const [worker, ...others] = chunks;
  if (worker === undefined || others.length > 0 || outputs.length !== chunks.length) {
    throw new Error(`The service worker must be one script: ${WORKER_SOURCE} built into ${outputs.map((output) => output.fileName).join(", ")}.`);
  }
  return worker.code;
}
