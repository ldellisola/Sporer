import type { Page, Request } from "@playwright/test";
import type { DayResponse, RangeResponse } from "../src/api/types";
import config from "./fixtures/config.json" with { type: "json" };
import heat from "./fixtures/heat.json" with { type: "json" };
import status from "./fixtures/status.json" with { type: "json" };

/** What an API request is answered with: JSON, with 200 unless a status is given. */
export interface Reply {
  status?: number;
  json?: unknown;
}

/** An override is a function that answers the request, or the JSON to answer every matching request with. */
export type Override = ((request: Request) => Reply | Promise<Reply>) | object;

/**
 * Overrides by API path, without the `/api/` prefix and without the query: `"day/2026-10-22"`, `"range"`, `"places/7"`.
 * A key ending in `/*` matches every path below it (`"day/*"`); an exact key wins over it.
 */
export type Overrides = Record<string, Override>;

export interface MockApi {
  /** Every request to the API made so far, mocked or not, as path and query: `/api/day/2026-10-22`. */
  readonly requests: string[];
}

const unmocked = new WeakMap<Page, string[]>();

/** The API requests of `page` that nothing answered. The shared fixture (base.ts) fails the test if there are any. */
export function unmockedRequests(page: Page): readonly string[] {
  return unmocked.get(page) ?? [];
}

const EMPTY_SUMMARY = { places: 0, distanceMeters: 0, movingSeconds: 0 };

const defaults: Record<string, Override> = {
  config,
  status,
  heat,
  "day/*": (request): Reply => {
    const date = new URL(request.url()).pathname.split("/").pop() ?? "";
    const day: DayResponse = { date, timeZone: "Europe/Oslo", state: "done", summary: EMPTY_SUMMARY, segments: [] };
    return { json: day };
  },
  range: (request): Reply => {
    const { searchParams } = new URL(request.url());
    const range: RangeResponse = {
      from: searchParams.get("from") ?? "",
      to: searchParams.get("to") ?? "",
      state: "done",
      summary: { ...EMPTY_SUMMARY, moves: 0 },
      moves: [],
      places: [],
      days: [],
    };
    return { json: range };
  },
};

function find(table: Record<string, Override>, path: string): Override | undefined {
  if (Object.hasOwn(table, path)) return table[path];
  const wildcard = `${path.slice(0, Math.max(path.lastIndexOf("/"), 0))}/*`;
  return path.includes("/") && Object.hasOwn(table, wildcard) ? table[wildcard] : undefined;
}

/**
 * Answers every `/api/*` request of `page` from the fixtures in `e2e/fixtures/` (empty days and ranges are made up from the
 * dates asked for) or from `overrides`. A request that nothing answers gets a 501 and fails the test (see base.ts), so a test
 * never depends on an API call it did not mean to make. Call it before `page.goto`.
 */
export async function mockApi(page: Page, overrides: Overrides = {}): Promise<MockApi> {
  const requests: string[] = [];
  const missing: string[] = [];
  unmocked.set(page, missing);

  await page.route(
    (url) => url.pathname.startsWith("/api/"),
    async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      requests.push(url.pathname + url.search);

      const path = url.pathname.slice("/api/".length);
      const override = request.method() === "GET" ? (find(overrides, path) ?? find(defaults, path)) : undefined;
      if (override === undefined) {
        missing.push(`${request.method()} ${url.pathname}${url.search}`);
        await route.fulfill({ status: 501, json: { error: "No mock for this request." } });
        return;
      }

      const reply: Reply = typeof override === "function" ? await override(request) : { json: override };
      await route.fulfill({ status: reply.status ?? 200, json: reply.json ?? {} });
    },
  );
  return { requests };
}
