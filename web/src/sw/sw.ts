// The service worker: it keeps the app's shell (the page and the files of the build) so that the app opens when the network is slow
// or gone. It is built apart from the app, into one classic script, /sw.js (build/serviceWorker.ts), and is checked as a project of
// its own (tsconfig.json here): it runs in a worker, where the app's DOM types do not apply.
//
// It never answers anything under /api or of another origin, and it keeps no answer of the API: see routeOf (shellPolicy.ts). It keeps
// no answer to a navigation either: the page it shows offline is the one it fetched and checked when it was installed.
import { NAVIGATION_TIMEOUT_MS, cacheName, cachesToDelete, installCacheMode, isAppPage, isProxyError, isShellDocument, routeOf, shellPaths } from "./shellPolicy";

// The build puts this in front of the script: the version of the shell and the files of it, as root-relative paths.
type Shell = { readonly version: string; readonly files: readonly string[] };
const sw = self as unknown as ServiceWorkerGlobalScope & { __SHELL__: Shell };
const { version, files } = sw.__SHELL__;

const CACHE = cacheName(version);
const PAGE = "/index.html"; // every route of the app is answered with it (see Program.cs), so it is kept once, apart from the files
const shellFiles: ReadonlySet<string> = shellPaths(files, sw.location.origin); // as a request's path has them: percent-encoded

// The page and the files outside /assets/ are asked of the server and not of the browser's own HTTP cache (they keep their names when they
// change), so that what is kept is the build's and never a mix of two. A hashed file under /assets/ may come from that cache: its name is its content.
const forInstall = (path: string) => new Request(path, { cache: installCacheMode(path) });
// Vary: Accept-Encoding on a file means nothing to what was stored: the browser decodes it either way.
const lookup = { cacheName: CACHE, ignoreSearch: true, ignoreVary: true };

sw.addEventListener("install", (event) => {
  // Not ready until all of it is in, and the page is the app's page of this build: the install fails otherwise (addAll fails if any
  // file does), the worker that is running stays, and the next check for an update tries again.
  event.waitUntil(
    (async () => {
      const page = await fetch(forInstall(PAGE));
      if (!isShellDocument(page) || !isAppPage(await page.clone().text(), shellFiles)) {
        throw new Error(`${PAGE} is not the page of the app that this worker keeps (${page.status} ${page.type}${page.redirected ? ", redirected" : ""}).`);
      }
      const cache = await caches.open(CACHE);
      await cache.addAll(files.map(forInstall));
      await cache.put(PAGE, page);
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
      event.respondWith(navigate(event.request));
      return;
    case "pass":
      return; // no respondWith: the browser goes on as if there were no worker
  }
});

async function fromShell(request: Request): Promise<Response> {
  return (await caches.match(request, lookup)) ?? fetch(request);
}

// The network first, so that a page is never older than the server's, and the kept page only when the network fails, takes more than
// NAVIGATION_TIMEOUT_MS, or answers 502, 503 or 504 (a proxy that cannot reach the app: isProxyError; the views then show their own error
// with a Retry). Any other answer is the network's like the rest: a redirect (the login) is followed, not replaced. What the network
// answers is never kept, whatever it is: the kept page is the one of the install.
async function navigate(request: Request): Promise<Response> {
  const network = fetch(request);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<null>((resolve) => {
    timer = setTimeout(resolve, NAVIGATION_TIMEOUT_MS, null);
  });
  try {
    const answer = await Promise.race([network, timedOut]);
    if (answer !== null && !isProxyError(answer)) return answer;
  } catch {
    // the network failed: the kept page, below
  } finally {
    clearTimeout(timer);
  }

  // No kept page: the network's own answer (a proxy's error too), whenever it comes, or its error.
  return (await caches.match(PAGE, lookup)) ?? network;
}
