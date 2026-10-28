import type { Page, Request } from "@playwright/test";
import type { DayResponse, RangeResponse } from "../src/api/types";
import config from "./fixtures/config.json" with { type: "json" };
import heat from "./fixtures/heat.json" with { type: "json" };
import status from "./fixtures/status.json" with { type: "json" };
import trip from "./fixtures/trip-2026-09-12.json" with { type: "json" };
import trips from "./fixtures/trips.json" with { type: "json" };

/**
 * What an API request is answered with: JSON, with 200 unless a status is given. A status of 400 or more is a deliberate
 * error (a test of the error state): the browser's own console error about it, "Failed to load resource", is excused for that
 * URL (see base.ts). Nothing else is.
 */
export interface Reply {
  status?: number;
  json?: unknown;
}

/** An override is a function that answers the request, or the JSON to answer every matching request with. */
export type Override = ((request: Request) => Reply | Promise<Reply>) | object;

/**
 * Overrides by API path, without the `/api/` prefix and without the query: `"day/2026-10-22"`, `"range"`, `"places/7"`, `"trips"`.
 * A key ending in `/*` matches every path below it (`"day/*"`); an exact key wins over it.
 */
export type Overrides = Record<string, Override>;

export interface MockApi {
  /** Every request to the API made so far, mocked or not, as path and query: `/api/day/2026-10-22`. */
  readonly requests: string[];
}

interface ApiState {
  /** API requests that nothing answered. */
  readonly unmocked: string[];
  /** Full URLs that a mock answered with a status of 400 or more, on purpose. */
  readonly deliberateErrors: Set<string>;
}

const states = new WeakMap<Page, ApiState>();

/**
 * Makes `page` unable to reach any backend: every request to `/api/` is recorded and answered with a 501, until `mockApi`
 * puts its own route in front (a route registered later is asked first; whatever it has no answer for falls back to this one).
 * The shared fixture (base.ts) calls it for every test, so a spec that never calls `mockApi` cannot silently get through to
 * a real API on the machine either. Calling it again does nothing.
 */
export async function guardApi(page: Page): Promise<void> {
  if (states.has(page)) return;
  const state: ApiState = { unmocked: [], deliberateErrors: new Set() };
  states.set(page, state);
  await page.route(isApiUrl, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    state.unmocked.push(`${request.method()} ${url.pathname}${url.search}`);
    await route.fulfill({ status: 501, json: { error: "No mock for this request." } });
  });
}

const isApiUrl = (url: URL): boolean => url.pathname.startsWith("/api/");

/** The API requests of `page` that nothing answered, which are forgotten once handed over. */
export function takeUnmockedRequests(page: Page): string[] {
  const state = states.get(page);
  return state ? state.unmocked.splice(0) : [];
}

/** Whether the mock of `page` answered `url` (absolute, as the browser reports it) with an error status on purpose. */
export function isDeliberateError(page: Page, url: string): boolean {
  return states.get(page)?.deliberateErrors.has(url) ?? false;
}

const EMPTY_SUMMARY = { places: 0, distanceMeters: 0, movingSeconds: 0 };

const defaults: Record<string, Override> = {
  config,
  status,
  heat,
  trips,
  // The page of a trip: the fixture's own for the one that has days and moves, the summary of the list (with nothing in it) for the other
  // trips of the list, and the 404 that the server gives for an id that is not a stored trip.
  "trips/*": (request): Reply => {
    const id = new URL(request.url()).pathname.split("/").pop();
    if (id === trip.id) return { json: trip };
    const listed = trips.trips.find((candidate) => candidate.id === id);
    if (listed === undefined) return { status: 404, json: { title: "Not Found" } };
    const { thumbnail: _thumbnail, ...summary } = listed;
    return { json: { ...summary, stats: { flights: 0, cities: summary.cities.length, places: 0, groundDistanceMeters: 0 }, moves: [], days: [] } };
  },
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
 * never depends on an API call it did not mean to make. A reply with a status of 400 or more is a deliberate error and does
 * not fail the test. Call it before `page.goto`.
 */
export async function mockApi(page: Page, overrides: Overrides = {}): Promise<MockApi> {
  await guardApi(page);
  const state = states.get(page) as ApiState;
  const requests: string[] = [];

  await page.route(isApiUrl, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    requests.push(url.pathname + url.search);

    const path = url.pathname.slice("/api/".length);
    const override = request.method() === "GET" ? (find(overrides, path) ?? find(defaults, path)) : undefined;
    if (override === undefined) {
      await route.fallback(); // to the guard, which records it and answers 501
      return;
    }

    const reply: Reply = typeof override === "function" ? await override(request) : { json: override };
    const status = reply.status ?? 200;
    if (status >= 400) state.deliberateErrors.add(request.url());
    await route.fulfill({ status, json: reply.json ?? {} });
  });
  return { requests };
}
