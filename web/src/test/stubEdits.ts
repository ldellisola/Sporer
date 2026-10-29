import { vi } from "vitest";

// A stub of the API for the tests of the edits: it answers each request by the handler of its method and path, and keeps what was asked.

export interface Call {
  method: string;
  path: string;
  search: string;
  contentType: string | null;
  body: unknown;
}

export type Handler = (call: Call) => Response | Promise<Response>;

/**
 * Answers each request by the handler of `"METHOD /path"` (the query is in the call): a request that has no handler is a failure of the test.
 * Returns the calls in the order they were made. `routes` can be changed to change what the next request finds.
 */
export function stubEdits(routes: Record<string, Handler>) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input, "http://sporer.test");
      const method = init?.method ?? "GET";
      const call: Call = {
        method,
        path: url.pathname,
        search: url.search,
        contentType: new Headers(init?.headers).get("Content-Type"),
        body: typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : init?.body,
      };
      calls.push(call);
      const handler = routes[`${method} ${url.pathname}`];
      if (handler === undefined) throw new Error(`unexpected request ${method} ${input}`);
      return handler(call);
    }),
  );
  return {
    routes,
    calls,
    writes: () => calls.filter((call) => call.method !== "GET"),
    reads: (path: string) => calls.filter((call) => call.method === "GET" && call.path === path),
  };
}

/** The error body of the API, as FastEndpoints writes it: what is wrong, by field. */
export const refusal = (status: number, message: string): Response =>
  Response.json({ statusCode: status, message: "One or more errors occurred!", errors: { place: [message] } }, { status });
