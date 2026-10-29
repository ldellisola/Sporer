// What the service worker (sw.ts) decides, as pure functions: which requests it answers, how its caches are named and which of them
// go. Nothing here touches a worker global, so the rules can be tested without a worker.

/** How long a navigation waits for the network before the cached page is shown instead. */
export const NAVIGATION_TIMEOUT_MS = 3000;

const CACHE_PREFIX = "sporer-shell-";

export type RoutedRequest = { url: string; mode: string; method: string };

/**
 * - `navigation`: a page of the app: network first, the cached `index.html` when the network fails or is slow;
 * - `shell`: a file of the build: the cache, else the network;
 * - `pass`: not the worker's to answer, the browser deals with it as if there were no worker.
 *
 * Only a GET of this origin is ever answered, and never anything under /api: the worker must not hold a private answer or hand one
 * out stale. Another origin (the map's tiles and style) is not the shell's either.
 */
export function routeOf(request: RoutedRequest, origin: string, shellFiles: ReadonlySet<string>): "navigation" | "shell" | "pass" {
  if (request.method !== "GET") return "pass";
  const url = new URL(request.url);
  if (url.origin !== origin) return "pass";
  if (isApiPath(url.pathname)) return "pass";
  if (request.mode === "navigate") return "navigation";
  return shellFiles.has(url.pathname) ? "shell" : "pass";
}

// The server matches its routes without regard to case and decodes the path first, so /API and /%61pi reach the API like /api does.
// `/api` is a prefix by segment: /apiary is a page.
function isApiPath(pathname: string): boolean {
  return isApi(pathname) || isApi(decoded(pathname));
}

function isApi(path: string): boolean {
  const lower = path.toLowerCase();
  return lower === "/api" || lower.startsWith("/api/");
}

function decoded(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path; // not valid percent-encoding: the server would turn it away, and it is not an API path here
  }
}

/**
 * The files of the shell as a request has their paths: percent-encoded (a name with a space is asked for as `%20`), which is what
 * `routeOf` and `isAppPage` compare with. The build gives the names as they are on disk.
 */
export function shellPaths(files: readonly string[], origin: string): Set<string> {
  return new Set(files.map((file) => new URL(file, origin).pathname));
}

export function cacheName(version: string): string {
  return `${CACHE_PREFIX}${version}`;
}

/** Every shell cache but the current one, given by its cache name (`cacheName(version)`). Caches of any other name are not ours. */
export function cachesToDelete(names: readonly string[], current: string): string[] {
  return names.filter((name) => name.startsWith(CACHE_PREFIX) && name !== current);
}

/**
 * Whether the server's answer for /index.html can be the page of the app: ok, of this origin, and not what a redirect led to (a sign-in
 * page): its body is then looked at (`isAppPage`). Any other answer is not kept.
 */
export function isShellDocument(response: { ok: boolean; type: string; redirected: boolean; headers: { get(name: string): string | null } }): boolean {
  return (
    response.ok &&
    response.type === "basic" &&
    !response.redirected &&
    (response.headers.get("content-type") ?? "").trim().toLowerCase().startsWith("text/html")
  );
}

// An attribute `src` or `href` and its value, quoted either way or not at all. (Not `data-src`: nothing before it that is part of a name.)
const URL_ATTRIBUTE = /(?<![\w-])(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;
const ROOT_ELEMENT = /<div\b[^>]*?(?<![\w-])id\s*=\s*(?:"root"|'root'|root(?![\w-]))/i;

/**
 * Whether `html` is the app's page of this build: it has the element the app mounts in, and every file it names under /assets/ is one of
 * the worker's (`shellFiles`, as `shellPaths` gives them). A page of another build, or no page of the app at all, is not to be kept as the
 * page that opens offline: it would open an app whose files are not there.
 */
export function isAppPage(html: string, shellFiles: ReadonlySet<string>): boolean {
  if (!ROOT_ELEMENT.test(html)) return false;
  for (const match of html.matchAll(URL_ATTRIBUTE)) {
    const value = match[1] ?? match[2] ?? match[3] ?? "";
    if (value.startsWith("/assets/") && !shellFiles.has(new URL(value, "https://page.invalid").pathname)) return false;
  }
  return true;
}
