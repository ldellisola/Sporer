// The service worker: it keeps the app's shell (the page and the files of the build) so that the app opens when the network is slow
// or gone. It is built apart from the app, into one classic script, /sw.js (build/serviceWorker.ts), and is checked as a project of
// its own (tsconfig.json here): it runs in a worker, where the app's DOM types do not apply.
//
// It never answers anything under /api or of another origin, and it keeps no answer of the API: see routeOf (shellPolicy.ts).
import { NAVIGATION_TIMEOUT_MS, cacheName, cachesToDelete, isShellDocument, routeOf } from "./shellPolicy";

// The build puts this in front of the script: the version of the shell and the files of it, as root-relative paths.
type Shell = { readonly version: string; readonly files: readonly string[] };
const sw = self as unknown as ServiceWorkerGlobalScope & { __SHELL__: Shell };
const { version, files } = sw.__SHELL__;

const CACHE = cacheName(version);
const PAGE = "/index.html"; // every route of the app is answered with it (see Program.cs), so it is kept once, apart from the files
const shellFiles: ReadonlySet<string> = new Set(files);

// Asked of the server and not of the browser's own HTTP cache, so that what is kept is the build's and never a mix of two.
const fresh = (path: string) => new Request(path, { cache: "reload" });
// Vary: Accept-Encoding on a file means nothing to what was stored: the browser decodes it either way.
const lookup = { cacheName: CACHE, ignoreSearch: true, ignoreVary: true };

sw.addEventListener("install", (event) => {
  // Not ready until all of it is in: addAll fails if any file does, and the worker that is running stays.
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await cache.addAll([...files, PAGE].map(fresh));
      await sw.skipWaiting();
    })(),
  );
});

sw.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const name of cachesToDelete(await caches.keys(), CACHE)) await caches.delete(name);
      await sw.clients.claim();
    })(),
  );
});

sw.addEventListener("fetch", (event) => {
  switch (routeOf(event.request, sw.location.origin, shellFiles)) {
    case "shell":
      event.respondWith(fromShell(event.request));
      return;
    case "navigation":
      event.respondWith(navigate(event));
      return;
    case "pass":
      return; // no respondWith: the browser goes on as if there were no worker
  }
});

async function fromShell(request: Request): Promise<Response> {
  return (await caches.match(request, lookup)) ?? fetch(request);
}

// The network first, so that a page is never older than the server's, and the kept page only when the network fails or takes more
// than NAVIGATION_TIMEOUT_MS. A redirect (the login) is the network's answer like any other: it is followed, not replaced.
async function navigate(event: FetchEvent): Promise<Response> {
  const network = fetch(event.request);
  // An answer that comes late is kept as well, for the next time the network is slow.
  event.waitUntil(network.then((response) => remember(response.clone()), () => undefined));

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<null>((resolve) => {
    timer = setTimeout(resolve, NAVIGATION_TIMEOUT_MS, null);
  });
  try {
    const answer = await Promise.race([network, timedOut]);
    if (answer !== null) return answer;
  } catch {
    // the network failed: the kept page, below
  } finally {
    clearTimeout(timer);
  }

  // No kept page: the network's own answer, whenever it comes, or its error.
  return (await caches.match(PAGE, lookup)) ?? network;
}

async function remember(response: Response): Promise<void> {
  if (!isShellDocument(response)) return;
  const cache = await caches.open(CACHE);
  await cache.put(PAGE, response);
}
