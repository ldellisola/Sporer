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

export function cacheName(version: string): string {
  return `${CACHE_PREFIX}${version}`;
}

/** Every shell cache but the current one, given by its cache name (`cacheName(version)`). Caches of any other name are not ours. */
export function cachesToDelete(names: readonly string[], current: string): string[] {
  return names.filter((name) => name.startsWith(CACHE_PREFIX) && name !== current);
}

/**
 * Whether the network's answer to a navigation is the app's page, to be kept as the page to show offline. Any other answer, a redirect
 * to the login included, is only handed to the browser.
 */
export function isShellDocument(response: { ok: boolean; type: string; headers: { get(name: string): string | null } }): boolean {
  return response.ok && response.type === "basic" && (response.headers.get("content-type") ?? "").trim().toLowerCase().startsWith("text/html");
}
