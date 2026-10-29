/** The methods the app calls the API with: reads are `GET`, and every write is one of the others (the API has no `PATCH`). */
type Method = "GET" | "POST" | "PUT" | "DELETE";

/**
 * A request the server answered with something other than success. Its message names the method and the path, and is for whoever looks
 * at a failure. `detail` is the server's own message about what was wrong, when its error body has one (see `detailOf`): it is for showing
 * to the owner as it is, and is never branched on. What a failure is, is its status.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly detail: string | null;

  constructor(status: number, path: string, method: Method = "GET", detail: string | null = null) {
    super(`${method} ${path} failed with status ${status}`);
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
  }
}

/**
 * The first message of the API's error body, `{ "errors": { "place": ["The place is …"] } }` (FastEndpoints, P4-R3): of the first field that
 * has one. Null for whatever else the body is: a proxy's HTML, no body, a shape that is not this one, a body that has been read already.
 * What went wrong is the status's business first; this must never turn a failure into a different one.
 */
async function detailOf(response: Response): Promise<string | null> {
  try {
    const body: unknown = await response.json();
    const errors = typeof body === "object" && body !== null && !Array.isArray(body) ? (body as { errors?: unknown }).errors : undefined;
    if (typeof errors !== "object" || errors === null || Array.isArray(errors)) return null;
    for (const messages of Object.values(errors)) {
      if (Array.isArray(messages) && typeof messages[0] === "string") return messages[0];
    }
    return null;
  } catch {
    return null;
  }
}

/** The error for a response that was not a success. */
async function failure(response: Response, path: string, method: Method): Promise<ApiError> {
  return new ApiError(response.status, path, method, await detailOf(response));
}

// Signed out. The API itself never redirects, but something in front of it may: the login of a proxy, when the owner's session there has
// ended. `fetch` would follow that redirect to the login page and hand the app a page of HTML that is not JSON, and the owner would see
// an error that has nothing to do with it. Every request is made with `redirect: "manual"` instead: the redirect is then the answer,
// of type `opaqueredirect` (and of status 0), which the app takes to be a sign-out. It reloads the page, which the proxy sends to its
// login (a navigation is redirected as well), and the owner is back in the app after signing in. The call still fails, so that a
// view that is still showing shows its error with Retry for as long as the page lives.
//
// The reload happens at most once per RELOAD_GAP_MS: if the login keeps redirecting (a page that is not the proxy's, say), the page would
// otherwise reload for ever. The time of the last reload is kept for the tab in sessionStorage under RELOAD_KEY, which a reload keeps and
// a new tab does not. Storage that is not there (a private window, blocked site data) is "never reloaded".
const RELOAD_KEY = "sporer:signed-out-reload";
const RELOAD_GAP_MS = 60_000;

/** The time (as `Date.now()` has it) that the page last reloaded because it was signed out; null when it has not, or when that cannot be told. */
function lastSignedOutReload(): number | null {
  try {
    const stored = window.sessionStorage.getItem(RELOAD_KEY);
    if (stored === null || stored.trim() === "") return null;
    const time = Number(stored);
    return Number.isFinite(time) && time >= 0 ? time : null;
  } catch {
    return null;
  }
}

/** Reloads the page, unless it did so less than RELOAD_GAP_MS ago (a time that is ahead of the clock, which was set back since, is no such time). */
function reloadSignedOutPage(): void {
  const now = Date.now();
  const last = lastSignedOutReload();
  if (last !== null && last <= now && now - last < RELOAD_GAP_MS) return;
  try {
    window.sessionStorage.setItem(RELOAD_KEY, String(now));
  } catch {
    // Not kept: the next redirect reloads again.
  }
  window.location.reload();
}

/**
 * Makes the request and returns its response when it is a success; throws `ApiError` for a response that is not (see `failure`) and for a
 * redirect, which is a sign-out (see above): its status is 0, so that it is not a refusal (`isRefusal`) and a view offers a Retry.
 * Whatever `fetch` throws for a request that got no answer is not caught: a dropped connection is not a sign-out, and never reloads.
 */
async function request(path: string, method: Method, init: RequestInit): Promise<Response> {
  const response = await fetch(path, { ...init, redirect: "manual" });
  if (response.type === "opaqueredirect") {
    reloadSignedOutPage();
    throw new ApiError(0, path, method); // the status of an opaque redirect is 0, which the response says too
  }
  if (!response.ok) throw await failure(response, path, method);
  return response;
}

/**
 * GETs `path` (an API path, `/api/...`) and returns its JSON. Throws `ApiError` for a response that is not a success, and
 * whatever `fetch` throws for a request that never got an answer (or was aborted through `signal`). No caching code is
 * needed here: the API's `ETag` and `Cache-Control: no-cache` make the browser ask again every time and reuse its copy on a 304.
 */
export async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await request(path, "GET", { signal, headers: { Accept: "application/json" } });
  return (await response.json()) as T;
}

/**
 * Sends a write to `path` and returns the JSON of the answer, or undefined for the 204 that a write with nothing to say is answered with.
 * Every write says it is JSON, body or not: the API refuses (415) a POST or a PUT that does not, which is what keeps a cross-site form from
 * ever making one (P4-R4). A write that has no body of its own sends an empty object. Throws `ApiError` for an answer that is not a success,
 * and whatever `fetch` throws for a request that got none.
 */
async function send<T>(method: Exclude<Method, "GET">, path: string, body?: unknown): Promise<T> {
  const response = await request(path, method, {
    method,
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
}

/** POSTs `body` (an empty object when there is none) to `path` as JSON, and returns the JSON that comes back. See `send`. */
export const postJson = <T = void>(path: string, body: unknown = {}): Promise<T> => send<T>("POST", path, body);

/** PUTs `body` (an empty object when there is none) to `path` as JSON, and returns the JSON that comes back. See `send`. */
export const putJson = <T = void>(path: string, body: unknown = {}): Promise<T> => send<T>("PUT", path, body);

/** DELETEs `path`: the API answers a delete with 204, so there is nothing to return. See `send`. */
export const deleteJson = (path: string): Promise<void> => send<void>("DELETE", path);

/**
 * Whether `error` is the server refusing the request itself (P4-R29): every 4xx but a 408 (the request timed out) and a 429 (it was told to wait),
 * which may pass when sent again. A 400, a 404, a 409, a 415... is the same the next time, so a control does not offer to send it again. A 5xx, a
 * 408, a 429, a request that got no answer and a redirect (status 0: the owner is signed out, see `request`) may pass, and are offered a Retry.
 */
export const isRefusal = (error: unknown): error is ApiError =>
  error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429;

/** Whether `error` is the server saying there is no such thing (a 404): a place that was merged away or never was. Asking again cannot help. */
export const isNotFound = (error: unknown): boolean => error instanceof ApiError && error.status === 404;
