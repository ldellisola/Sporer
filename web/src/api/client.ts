/** The methods the app calls the API with: reads are `GET`, and every write is one of the others (the API has no `PATCH`). */
type Method = "GET" | "POST" | "PUT" | "DELETE";

/** A request the server answered with something other than success. Its message names the method and the path. */
export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, path: string, method: Method = "GET") {
    super(`${method} ${path} failed with status ${status}`);
    this.name = "ApiError";
    this.status = status;
  }
}

/**
 * GETs `path` (an API path, `/api/...`) and returns its JSON. Throws `ApiError` for a response that is not a success, and
 * whatever `fetch` throws for a request that never got an answer (or was aborted through `signal`). No caching code is
 * needed here: the API's `ETag` and `Cache-Control: no-cache` make the browser ask again every time and reuse its copy on a 304.
 */
export async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { signal, headers: { Accept: "application/json" } });
  if (!response.ok) throw new ApiError(response.status, path);
  return (await response.json()) as T;
}

/**
 * Sends a write to `path` and returns the JSON of the answer, or undefined for the 204 that a write with nothing to say is answered with.
 * Every write says it is JSON, body or not: the API refuses (415) a POST or a PUT that does not, which is what keeps a cross-site form from
 * ever making one (P4-R4). A write that has no body of its own sends an empty object. Throws `ApiError` for an answer that is not a success,
 * and whatever `fetch` throws for a request that got none.
 */
async function send<T>(method: Exclude<Method, "GET">, path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new ApiError(response.status, path, method);
  return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
}

/** POSTs `body` (an empty object when there is none) to `path` as JSON, and returns the JSON that comes back. See `send`. */
export const postJson = <T = void>(path: string, body: unknown = {}): Promise<T> => send<T>("POST", path, body);

/** PUTs `body` (an empty object when there is none) to `path` as JSON, and returns the JSON that comes back. See `send`. */
export const putJson = <T = void>(path: string, body: unknown = {}): Promise<T> => send<T>("PUT", path, body);

/** DELETEs `path`: the API answers a delete with 204, so there is nothing to return. See `send`. */
export const deleteJson = (path: string): Promise<void> => send<void>("DELETE", path);

/** Whether `error` is the server saying there is no such thing (a 404): a place that was merged away or never was. Asking again cannot help. */
export const isNotFound = (error: unknown): boolean => error instanceof ApiError && error.status === 404;
