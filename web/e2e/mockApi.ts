import type { Page, Request } from "@playwright/test";
import type { DayResponse, Mode, MoveModeResponse, RangeResponse } from "../src/api/types";
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
 * A key ending in `/*` matches every path below it (`"day/*"`); an exact key wins over it, in either spelling. A key is a read (`GET`) unless it starts with
 * another method and a space: `"POST status/retry"`, `"PUT trips/*"`, `"DELETE homes/3"`; a read may be written with its method too
 * (`"GET status"`), and the bare path wins over it. A write has no default: one that no test has mocked gets the 501 of the guard, and
 * fails the test.
 */
export type Overrides = Record<string, Override>;

/** A write that the page made, as the server would have seen it. */
export interface Write {
  method: string;
  /** The path and the query: `/api/status/retry`. */
  path: string;
  /** What the request said its body was; the API refuses a write that does not say JSON. */
  contentType: string | undefined;
  /** The body as JSON, or null when there was none. */
  body: unknown;
}

export interface MockApi {
  /** Every request to the API made so far, mocked or not, as path and query: `/api/day/2026-10-22`. */
  readonly requests: string[];
  /** Every write (a request that is not a `GET`) made so far, in order, mocked or not. */
  readonly writes: Write[];
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
  // No trip is deleted. An exact key beats the wildcard below, which would take "deleted" for the id of a trip.
  "trips/deleted": [],
  // What Settings lists besides: no home (detected or set), the distance that makes a trip as it is configured (50 km, and the owner has not changed it), and
  // no removed points.
  homes: { periods: [] },
  settings: { tripMinDistanceKm: 50, tripMinDistanceKmDefault: 50 },
  "points/removed": [],
  // The places of the map of a place and of the places view: none, unless a test has some.
  places: { places: [] },
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

function exact(table: Record<string, Override>, key: string): Override | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

/** The override of the key with its last segment made `*` (`"day/2026-10-22"` is answered by `"day/*"`), if there is one. */
function wildcard(table: Record<string, Override>, key: string): Override | undefined {
  const pattern = `${key.slice(0, Math.max(key.lastIndexOf("/"), 0))}/*`;
  return key.includes("/") && Object.hasOwn(table, pattern) ? table[pattern] : undefined;
}

/** The override of a write (or of any key spelt out): the exact key, else the wildcard. */
const find = (table: Record<string, Override>, key: string): Override | undefined => exact(table, key) ?? wildcard(table, key);

/**
 * The override of a read: an exact key beats a wildcard, in either spelling, and where both are the same kind the bare path beats the one with
 * `GET ` (`"places/2"`, `"GET places/2"`, `"places/*"`, `"GET places/*"`, in that order).
 */
const findRead = (table: Record<string, Override>, path: string): Override | undefined =>
  exact(table, path) ?? exact(table, `GET ${path}`) ?? wildcard(table, path) ?? wildcard(table, `GET ${path}`);

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
  const writes: Write[] = [];

  await page.route(isApiUrl, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    requests.push(url.pathname + url.search);
    const method = request.method();
    if (method !== "GET") {
      let body: unknown = null;
      try {
        body = request.postDataJSON();
      } catch {
        body = request.postData(); // not JSON: said as it was sent
      }
      writes.push({ method, path: url.pathname + url.search, contentType: request.headers()["content-type"], body });
    }

    const path = url.pathname.slice("/api/".length);
    const override = method === "GET" ? (findRead(overrides, path) ?? find(defaults, path)) : find(overrides, `${method} ${path}`);
    if (override === undefined) {
      await route.fallback(); // to the guard, which records it and answers 501
      return;
    }

    const reply: Reply = typeof override === "function" ? await override(request) : { json: override };
    const status = reply.status ?? 200;
    if (status >= 400) state.deliberateErrors.add(request.url());
    // A 204 has no body, and a write that says so (a delete) is answered with none.
    await (status === 204 ? route.fulfill({ status }) : route.fulfill({ status, json: reply.json ?? {} }));
  });
  return { requests, writes };
}

/** The modes that the API takes for a move (`PUT /api/moves/{id}/mode`). */
const MOVE_MODES: readonly string[] = ["walk", "cycle", "drive", "bus", "train", "flight"] satisfies Mode[];

/** A server that keeps the modes the owner sets on the moves of a day: see `moveModeServer`. */
export interface MoveModeServer {
  /** The day, and the writes of the modes of its moves: pass them to `mockApi` (with any others). */
  readonly overrides: Overrides;
  /** The modes the owner has set, by the time the move began. */
  edits(): ReadonlyMap<string, string>;
  /**
   * Rebuilds the day, as the worker does after an edit: every move has the mode the owner set, else the day's own (the mode detected), the day is done
   * again, and every segment has a new id from then on (a write to an old one is a 404).
   */
  rebuild(): void;
}

/**
 * A server of `day` that keeps the modes the owner sets on its moves, as the API does. `PUT moves/{id}/mode` stores the edit, sets the mode of the stored
 * move `id` at once (`modeEdited` true) and is answered with it (a mode that is not one of the six is a 400, in the server's words). `DELETE moves/{id}/mode`
 * takes the edit away, with a 204, and leaves the stored move as it was, the mode the owner set and `modeEdited` too: the detected mode is known only once
 * the stretch is rebuilt. After either the day is pending until `rebuild`. A write to a move the day does not have is a 404, as on the server, where the
 * ids of the moves change with every rebuild. An edit is kept by the time of the move, which a rebuild does not change.
 */
export function moveModeServer(day: DayResponse): MoveModeServer {
  const edits = new Map<string, string>(); // the owner's edits
  let stored = new Map<string, string>(); // the modes the owner set as the stored moves have them: a PUT sets one at once, a DELETE leaves it until the rebuild
  let pending = false; // a write since the last rebuild
  let shift = 0; // what a rebuild has added to the ids of the day
  const served = (): DayResponse => ({
    ...day,
    state: pending ? "pending" : day.state,
    segments: day.segments.map((segment) => {
      if (segment.kind !== "move") return { ...segment, id: segment.id + shift };
      const mode = stored.get(segment.start);
      return { ...segment, id: segment.id + shift, mode: (mode ?? segment.mode) as Mode, modeEdited: mode !== undefined };
    }),
  });
  /** The move that a write is to, by the id in its path (`/api/moves/{id}/mode`), if the day has it now. */
  const moveOf = (request: Request) => {
    const id = Number(new URL(request.url()).pathname.split("/").at(-2));
    return day.segments.find((segment) => segment.kind === "move" && segment.id + shift === id);
  };
  const overrides: Overrides = { [`day/${day.date}`]: (): Reply => ({ json: served() }) };
  // The writes of the ids that the day has now: exact keys, which `mockApi` finds in this object at each request (a rebuild adds those of the new ids).
  const answerWrites = (): void => {
    for (const segment of day.segments) {
      if (segment.kind !== "move") continue;
      overrides[`PUT moves/${segment.id + shift}/mode`] = (request): Reply => {
        const move = moveOf(request);
        if (move === undefined) return { status: 404, json: {} };
        const { mode } = request.postDataJSON() as { mode: string };
        if (!MOVE_MODES.includes(mode)) {
          return { status: 400, json: { statusCode: 400, message: "One or more errors occurred!", errors: { mode: ["The mode is not one of walk, cycle, drive, bus, train and flight."] } } };
        }
        edits.set(move.start, mode);
        stored.set(move.start, mode);
        pending = true;
        const answer: MoveModeResponse = { id: move.id + shift, mode: mode as Mode, modeEdited: true };
        return { json: answer };
      };
      overrides[`DELETE moves/${segment.id + shift}/mode`] = (request): Reply => {
        const move = moveOf(request);
        if (move === undefined) return { status: 404, json: {} };
        edits.delete(move.start);
        pending = true;
        return { status: 204 };
      };
    }
  };
  answerWrites();
  return {
    overrides,
    edits: () => edits,
    rebuild: () => {
      stored = new Map(edits);
      pending = false;
      shift += 100;
      answerWrites();
    },
  };
}
