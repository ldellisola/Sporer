/** A request the server answered with something other than success. */
export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, path: string) {
    super(`GET ${path} failed with status ${status}`);
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
