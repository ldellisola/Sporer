import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { APIRequestContext, BrowserContext, CDPSession, Page } from "@playwright/test";
import { expect, test } from "../e2e/base";
import { fixTime } from "../e2e/today";

declare const process: { env: Record<string, string | undefined> }; // this file runs in Node, whose types the app does not take

/**
 * The web half of the performance check (spec §8): the time from navigation to the panel's rows and to the map's `idle` event, for a
 * day, a month and a year, for the list of trips (its cards are the rows) and for each trip (its days are the rows), on a phone's page
 * with the processor held back 4 times and, unless PERF_NETWORK=off, a network like the owner's VPN (60 ms round trip, 20 Mbit/s down, 5 up),
 * against API answers recorded from a server over the synthetic history (`npm run perf:record`).
 * Run by `npm run perf`, not by `npm run e2e`: it is a measurement, and asserts only that it measured what it meant to (every run
 * reached the panel's rows and the map's idle, nothing outside the recording was asked for).
 * The `edit-points` scenario is the day with the most raw points, opened cold, and then the tap on Edit points: it times what the owner waits for
 * after that tap, the points on the map (the answer, the map having the tiles of its source of them, the first frame that draws them and the map's idle).
 * `open-first` and `open-installed` are the app opened on today (the address `/`, with the date fixed on a recorded day): the first visit, with no service
 * worker and nothing kept, and the installed app, with the worker active and the shell in its cache, as a new page of the same browser. `pan-year` is a
 * scripted pan and zoom on the year with its routes, and says how long the frames took.
 * Every answer of the API is a real HTTP response, from perf/serve.mjs, so that the emulated network is what it goes through (a mocked answer would not
 * be slowed by it). What that network does not reach is what the service worker asks for itself: it is slowed here by hand (see `slowWorker`).
 * The method, what is measured and what is not, is in docs/superpowers/plans/2026-10-24-sporer-plan-2-perf.md, for the trips in
 * docs/superpowers/plans/2026-10-26-sporer-plan-3-perf.md, for editing in docs/superpowers/plans/2026-10-28-sporer-plan-4-perf.md and for the final pass
 * (the network, the installed app, the pan) in docs/superpowers/plans/2026-10-29-sporer-plan-5-perf.md.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const RECORDED = join(HERE, "recorded");
const RESULTS = join(HERE, "results");
const RUNS = Number(process.env["PERF_RUNS"] ?? "7");
const CPU_RATE = Number(process.env["PERF_CPU"] ?? "4");
/** The owner's VPN (spec §8): 60 ms round trip, 20 Mbit/s down and 5 up, as bytes a second; null with PERF_NETWORK=off (no network, as in Plans 2 to 4). */
const NETWORK = process.env["PERF_NETWORK"] === "off" ? null : { latency: 60, download: 20_000_000 / 8, upload: 5_000_000 / 8 };

interface Scenario {
  id: string;
  label: string;
  url: string;
  request: string;
  file: string;
  bytes: number;
  /** For the scenario of edit mode: the request for the points that the tap on Edit points makes, how many there are, and the size of the answer. */
  edit?: { request: string; points: number; bytes: number };
  /**
   * What the scenario is, when it is not the page of a view opened cold: `open` is the app opened on today (the date is fixed to `today`), as a first visit;
   * `installed` the same with the service worker active and its cache filled, as a new page; `pan` a pan and zoom on the page once it is open.
   */
  kind?: "open" | "installed" | "pan";
  /** For the scenarios that open the app on today: the moment the page's clock stands at. */
  today?: string;
}
interface Recording {
  recordedFrom: string;
  scenarios: Scenario[];
  requests: Record<string, string>;
}

function loadRecording(): Recording {
  try {
    return JSON.parse(readFileSync(join(RECORDED, "index.json"), "utf8")) as Recording;
  } catch {
    throw new Error(
      "Nothing recorded yet. Start the API over the synthetic history and run: " +
        "node scripts/perf/record.mjs <api-url> <first-date> <last-date> (see the performance document).",
    );
  }
}

const recording = loadRecording();
const day = recording.scenarios.find((scenario) => scenario.id === "day") as Scenario;
const year = recording.scenarios.find((scenario) => scenario.id === "year") as Scenario;
/** The day of the typical weekday, as the app writes it: the page's clock is put on it, so that "today" is a day that was recorded. */
const TODAY = `${day.url.slice("/day/".length)}T10:00:00Z`;
/** The app opened on today, first and installed, and a pan and zoom on the year: what is measured besides the views the recording has. */
const extra: Scenario[] = [
  { ...day, id: "open-first", label: "the app opened for the first time: no worker, nothing kept", url: "/", kind: "open", today: TODAY },
  { ...day, id: "open-installed", label: "the installed app: the worker active and the shell in its cache, a new page", url: "/", kind: "installed", today: TODAY },
  { ...year, id: "pan-year", label: "a scripted pan and zoom on the year with its routes", kind: "pan" },
];

/** What the page notes about itself, all as `performance.now()`, that is milliseconds from the start of the navigation. */
interface Probe {
  rows: Array<[at: number, count: number]>;
  rowsPainted: number | null;
  mapReady: number | null;
  mapHooked: boolean;
  idles: number[];
  loads: number[];
  /** When the map drew a frame, and when its routes source had its data (parsed in the worker and ready to draw). */
  renderAt: number[];
  routeLoads: number[];
  /** When the map had every tile of its source of the raw points of edit mode (made in the worker from the data, and ready to draw). */
  editLoads: number[];
  longTasks: Array<[start: number, duration: number]>;
  finished: boolean;
  /** The step to the next day or period, when the run makes one: the click, the new rows, the map idle after them. */
  step: { clickedAt: number | null; rowsAt: number | null; paintedAt: number | null; idleAt: number | null; finished: boolean };
  /** The tap on Edit points, when the answer with the points was received, when the map had them, when it drew them, and the idle after. */
  edit: { clickedAt: number | null; answerAt: number | null; loadedAt: number | null; drawnAt: number | null; idleAt: number | null; finished: boolean };
  /** The second tap on › or ‹, made as soon as the first one's rows are there, before the answer for the period after them has come: the step with nothing prefetched. */
  cold: { clickedAt: number | null; rowsAt: number | null; paintedAt: number | null; idleAt: number | null; finished: boolean };
  /** The map, for the pan and zoom of `pan-year`. */
  map: PanMap | null;
}
/** What the scripted pan and zoom asks of the map. */
interface PanMap {
  panBy: (offset: [number, number], options: { duration: number }) => unknown;
  zoomTo: (zoom: number, options: { duration: number }) => unknown;
  getZoom: () => number;
  once: (type: string, listener: () => void) => unknown;
}
declare global {
  interface Window {
    __probe: Probe;
  }
}

/** Installed before the page's own scripts. Everything it does is cheap: a counter, a timestamp, a listener. */
function installProbe(): void {
  const probe: Probe = {
    rows: [], rowsPainted: null, mapReady: null, mapHooked: false, idles: [], loads: [], renderAt: [], routeLoads: [], editLoads: [], longTasks: [], finished: false,
    step: { clickedAt: null, rowsAt: null, paintedAt: null, idleAt: null, finished: false },
    edit: { clickedAt: null, answerAt: null, loadedAt: null, drawnAt: null, idleAt: null, finished: false },
    cold: { clickedAt: null, rowsAt: null, paintedAt: null, idleAt: null, finished: false },
    map: null,
  };
  window.__probe = probe;
  const now = (): number => performance.now();

  let seen = 0;
  const countRows = (): number => document.querySelector('[aria-label="Details"]')?.querySelectorAll("li").length ?? 0;

  // The map has no handle on the page. Its component keeps it in its state (it is made when MapLibre has arrived, see map/MapView.tsx),
  // which React keeps in the fiber of the component that renders the map's element, so the probe finds it there, once the component
  // has taken it over (it sets `data-map-state` right after), and listens. The element knows one of the component's two fibers (the
  // current one and the one it is being rendered into); the map is in whichever is the later.
  const hookMap = (): void => {
    if (probe.mapHooked) return;
    const element = document.querySelector('[aria-label="Map view"]');
    if (element === null) return;
    const key = Object.keys(element).find((k) => k.startsWith("__reactFiber$"));
    if (key === undefined) return;
    type Hook = { memoizedState: unknown; next: Hook | null };
    type Fiber = { return: Fiber | null; alternate: Fiber | null; memoizedState: Hook | null };
    const owner = ((element as unknown as Record<string, Fiber>)[key] as Fiber).return;
    type MapLike = { on: (type: string, listener: (event: { sourceId?: string; isSourceLoaded?: boolean; tile?: unknown }) => void) => void; getCanvas: unknown };
    const isMap = (value: unknown): value is MapLike =>
      typeof value === "object" && value !== null && typeof (value as MapLike).on === "function" && typeof (value as MapLike).getCanvas === "function";
    for (const fiber of [owner, owner?.alternate ?? null]) {
      for (let hook = fiber?.memoizedState ?? null; hook !== null; hook = hook.next) {
        const state = hook.memoizedState;
        const map = [state, (state as { current?: unknown } | null)?.current].find(isMap);
        if (map === undefined) continue;
        map.on("idle", () => probe.idles.push(now()));
        map.on("load", () => probe.loads.push(now()));
        map.on("render", () => probe.renderAt.push(now()));
        map.on("sourcedata", (event) => {
          if (event.sourceId === "sporer-routes" && event.isSourceLoaded === true) probe.routeLoads.push(now());
          // A tile of the points, with every tile of the source loaded: what the points are drawn from. (The event that comes when the worker has the
          // data has no tile, and comes before the tiles are made: a frame after it does not have the points yet.)
          if (event.sourceId === "sporer-edit-points" && event.isSourceLoaded === true && event.tile !== undefined) probe.editLoads.push(now());
        });
        probe.map = map as unknown as PanMap;
        probe.mapHooked = true;
        return;
      }
    }
  };

  new MutationObserver(() => {
    const count = countRows();
    if (count !== seen) {
      seen = count;
      probe.rows.push([now(), count]);
      if (count > 0 && probe.rowsPainted === null) {
        // The frame after the one the rows were committed in.
        requestAnimationFrame(() => requestAnimationFrame(() => (probe.rowsPainted ??= now())));
      }
    }
    const state = document.querySelector('[aria-label="Map view"]')?.getAttribute("data-map-state");
    if (state === "ready") probe.mapReady ??= now();
    if (state !== undefined) hookMap();
  }).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-map-state"] });

  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) probe.longTasks.push([entry.startTime, entry.duration]);
  }).observe({ type: "longtask", buffered: true });

  // Done when the panel has its rows, the map has been idle since, and nothing has changed for a moment.
  const check = (): void => {
    const first = probe.rows.find(([, count]) => count > 0)?.[0];
    if (first !== undefined && probe.idles.some((at) => at >= first)) {
      setTimeout(() => (probe.finished = true), 400);
    } else {
      setTimeout(check, 100);
    }
  };
  setTimeout(check, 100);
}

/** One run's numbers, in ms from the start of the navigation. */
interface Sample {
  dataAt: number | null;
  rowsAt: number;
  rowsPaintedAt: number | null;
  rowCount: number;
  idleAt: number;
  mapReadyAt: number | null;
  firstContentfulPaint: number | null;
  domContentLoaded: number | null;
  renders: number;
  /** The first frame the map drew with this period's routes ready, after the rows: the routes are on screen, the camera may still be moving. */
  routesDrawnAt: number | null;
  blockedBeforeRows: number;
  /**
   * From a tap on "Next day" (or month, year) to the new panel's rows, to their paint, and to the map's idle after them. Null for the
   * list of trips and for a trip, which are timed on the cold navigation only.
   */
  stepRowsMs: number | null;
  stepPaintedMs: number | null;
  stepIdleMs: number | null;
  stepRoutesDrawnMs: number | null;
  /** The same for the second tap, made as soon as the first one's rows were there: the period after it had been asked for a moment before, and not come. */
  coldRowsMs: number | null;
  coldPaintedMs: number | null;
  coldIdleMs: number | null;
  /**
   * From a tap on "Edit points" to the answer with the points, to the map having the tiles of its source of them, to the first frame that draws them and to the map's idle
   * after it. Null for every scenario but the one of edit mode.
   */
  editAnswerMs: number | null;
  editLoadedMs: number | null;
  editDrawnMs: number | null;
  editIdleMs: number | null;
  /** How many of the page's resources the service worker answered with a file of its cache, and how many of the files under /assets/ were not fetched from the network. */
  workerAnswered: number;
  assetsNotFetched: number;
  /** The scripted pan and zoom of `pan-year`: how many frames the browser drew, over how many seconds, the time between two of them (median, 95th percentile, longest) and how many were over 50 ms. */
  panFrames: number | null;
  panSeconds: number | null;
  panP50Ms: number | null;
  panP95Ms: number | null;
  panMaxMs: number | null;
  panOver50: number | null;
}

/** What a scenario that makes no step, or no edit, says of it. */
const NO_STEP = { stepRowsMs: null, stepPaintedMs: null, stepIdleMs: null, stepRoutesDrawnMs: null, coldRowsMs: null, coldPaintedMs: null, coldIdleMs: null };
const NO_EDIT = { editAnswerMs: null, editLoadedMs: null, editDrawnMs: null, editIdleMs: null };
const NO_PAN = { panFrames: null, panSeconds: null, panP50Ms: null, panP95Ms: null, panMaxMs: null, panOver50: null };

const samples = new Map<string, Sample[]>();
const probes: Record<string, unknown> = {};

const sorted = (values: number[]): number[] => [...values].sort((a, b) => a - b);
const median = (values: number[]): number => sorted(values)[Math.floor((values.length - 1) / 2)] ?? Number.NaN;
const worst = (values: number[]): number => Math.max(...values);

/**
 * Installed once the page is at rest: notes the next tap, the moment the rows of the panel are other rows, and the map's next idle. For a day or a month
 * it then taps › once more at once, in the same breath as the rows of the first step come: the answer for the period after that has been asked for
 * a moment before (the prefetch, which the page makes as it shows a period) and has not come, so that the second step has nothing prefetched to find.
 */
function watchStep(view: string): void {
  const { step, cold, idles } = window.__probe;
  const rows = (): { count: number; signature: string } => {
    const items = document.querySelectorAll('[aria-label="Details"] li');
    return { count: items.length, signature: `${items.length}|${items[0]?.textContent}|${items[items.length - 1]?.textContent}` };
  };
  const before = rows().signature;
  document.addEventListener("click", () => (step.clickedAt = performance.now()), { capture: true, once: true });

  /** Notes the rows of the other period, their paint and the map's idle after them, in `into`; `done` is called once the rows are there. */
  const watch = (into: typeof step, than: string, done: () => void): void => {
    const observer = new MutationObserver(() => {
      const now = rows();
      // Rows, and other rows than the ones that were there: while the answer is awaited the panel may show a loading state with none.
      if (into.clickedAt === null || into.rowsAt !== null || now.count === 0 || now.signature === than) return;
      into.rowsAt = performance.now();
      requestAnimationFrame(() => requestAnimationFrame(() => (into.paintedAt = performance.now())));
      const wait = (): void => {
        const idle = idles.find((at) => at >= (into.rowsAt as number));
        if (idle === undefined) setTimeout(wait, 50);
        else {
          into.idleAt = idle;
          setTimeout(() => (into.finished = true), 400);
        }
      };
      wait();
      observer.disconnect();
      done();
    });
    observer.observe(document, { childList: true, subtree: true, characterData: true });
  };

  watch(step, before, () => {
    if (view === "year") {
      cold.finished = true; // no year after the next has any data in the history: nothing to tap, and nothing to wait for
      return;
    }
    const after = rows().signature;
    const button = document.querySelector<HTMLElement>(`[aria-label="Next ${view}"]`);
    cold.clickedAt = performance.now();
    watch(cold, after, () => undefined);
    button?.click();
  });
}

/**
 * Installed once the page is at rest: notes the tap on Edit points, and then, as the answer with the points is received, as the map has the tiles of its
 * source of them and as the map draws its first frame after that (the points are on the screen), and the map's idle after it. The source is empty until
 * the points are there, so the first tiles it has after the answer is received are the points': nothing but them is put in it.
 */
function watchEdit(pointsPath: string): void {
  const probe = window.__probe;
  const { edit } = probe;
  document.addEventListener("click", () => (edit.clickedAt = performance.now()), { capture: true, once: true });
  const poll = (): void => {
    if (edit.clickedAt !== null) {
      const answer = (performance.getEntriesByType("resource") as PerformanceResourceTiming[]).find((r) => r.name.endsWith(pointsPath));
      edit.answerAt = answer?.responseEnd ?? null;
      if (edit.answerAt !== null) {
        edit.loadedAt = probe.editLoads.find((at) => at >= (edit.answerAt as number)) ?? null;
        edit.drawnAt = edit.loadedAt === null ? null : (probe.renderAt.find((at) => at >= (edit.loadedAt as number)) ?? null);
        edit.idleAt = edit.drawnAt === null ? null : (probe.idles.find((at) => at >= (edit.drawnAt as number)) ?? null);
      }
      if (edit.idleAt !== null) {
        setTimeout(() => (edit.finished = true), 400);
        return;
      }
    }
    setTimeout(poll, 50);
  };
  poll();
}

const isApi = (url: URL): boolean => url.pathname.startsWith("/api/");
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost"]);

/**
 * What a page of the run needs before it navigates: its API requests go to the server of the run (perf/serve.mjs) and not to the 501 of the guard
 * (base.ts), which a route registered after it is asked before; and, unless it is the page that only gets the app installed, the processor is held
 * back, the network emulated and the probe put in. Playwright keeps the browser's HTTP cache off while a page has a route, which this one has: the
 * run's pages never read a file from it, and the installed app is read from the worker's cache alone.
 */
async function prepare(page: Page, { timed }: { timed: boolean }): Promise<void> {
  await page.route(isApi, (route) => route.continue());
  if (!timed) return;
  const client: CDPSession = await page.context().newCDPSession(page);
  await client.send("Emulation.setCPUThrottlingRate", { rate: CPU_RATE });
  if (NETWORK !== null) {
    await client.send("Network.emulateNetworkConditions", { offline: false, latency: NETWORK.latency, downloadThroughput: NETWORK.download, uploadThroughput: NETWORK.upload });
  }
  await page.addInitScript(installProbe);
}

/**
 * The emulation of the network is of the page, and the service worker is a target of its own: what it asks of the network itself is not slowed by
 * it (a navigation answered by the worker would reach the server as if the phone were next to it; checked with a page of 300 kB, which took 5 ms). The only request
 * of that kind that the installed app waits for is the page of the navigation, a file of a kilobyte or two, so it is held back by the round trip here.
 * The requests of a worker are seen by `context.route` only (see playwright.config.ts for what makes it so).
 */
async function slowWorker(context: BrowserContext): Promise<void> {
  const network = NETWORK;
  if (network === null) return;
  await context.route("**/*", async (route) => {
    if (route.request().serviceWorker() !== null) await new Promise((resolve) => setTimeout(resolve, network.latency));
    await route.fallback();
  });
}

/**
 * The app installed: opened once, with nothing held back, and left until the worker is active, in control of the page and has put the shell into its
 * cache. The worker is then stopped: an app that has been left for a while is not running (the phone ends it), and the next page starts it.
 */
async function install(page: Page, scenario: Scenario): Promise<void> {
  await prepare(page, { timed: false });
  if (scenario.today !== undefined) await fixTime(page, scenario.today);
  await page.goto(scenario.url);
  await page.waitForFunction(async () => (await navigator.serviceWorker.getRegistration())?.active?.state === "activated");
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  const kept = await page.evaluate(async () => {
    const names = await caches.keys();
    return { names: names.length, files: names[0] === undefined ? 0 : (await (await caches.open(names[0])).keys()).length };
  });
  expect(kept.names, "caches of the installed app").toBe(1);
  expect(kept.files, "files in the cache of the worker").toBeGreaterThan(5);
  const client = await page.context().newCDPSession(page);
  await client.send("ServiceWorker.enable");
  await client.send("ServiceWorker.stopAllWorkers");
}

/** What the page's requests that the recording has no answer for were, since the last time (the server forgets them as it tells). */
async function takeUnrecorded(request: APIRequestContext): Promise<string[]> {
  return (await (await request.get("/__perf/unrecorded")).json()) as string[];
}

/** The scripted pan and zoom, in the page: the frames the browser draws while the map is moved about and zoomed in and out, as the time between one and the next. */
async function panAndZoom(): Promise<Pick<Sample, "panFrames" | "panSeconds" | "panP50Ms" | "panP95Ms" | "panMaxMs" | "panOver50">> {
  const map = window.__probe.map as PanMap;
  const intervals: number[] = [];
  let last = 0;
  let running = true;
  const frame = (at: number): void => {
    if (last > 0) intervals.push(at - last);
    last = at;
    if (running) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  const move = (start: () => void): Promise<void> =>
    new Promise((resolve) => {
      map.once("moveend", () => resolve());
      start();
    });
  const zoom = map.getZoom();
  const begun = performance.now();
  await move(() => map.panBy([-160, 0], { duration: 700 }));
  await move(() => map.panBy([0, -160], { duration: 700 }));
  await move(() => map.zoomTo(zoom + 1.5, { duration: 900 }));
  await move(() => map.panBy([220, 0], { duration: 700 }));
  await move(() => map.panBy([0, 220], { duration: 700 }));
  await move(() => map.zoomTo(zoom, { duration: 900 }));
  await move(() => map.panBy([-160, 160], { duration: 700 }));
  running = false;
  const seconds = (performance.now() - begun) / 1000;
  const sorted = [...intervals].sort((a, b) => a - b);
  const at = (q: number): number => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] as number;
  return { panFrames: intervals.length, panSeconds: seconds, panP50Ms: at(0.5), panP95Ms: at(0.95), panMaxMs: sorted[sorted.length - 1] as number, panOver50: intervals.filter((d) => d > 50).length };
}

async function run(page: Page, request: APIRequestContext, scenario: Scenario, keep: boolean): Promise<Sample> {
  await takeUnrecorded(request); // what an earlier page asked for is not this one's
  const problems: string[] = [];
  if (scenario.kind === "installed") {
    // The page of the fixture gets the app installed; the one that is timed is a new page of the same browser, which the guard of the fixture does not watch.
    const context = page.context();
    await slowWorker(context); // before the worker exists: a route added to a context whose worker has been stopped waits half a minute for it
    await install(page, scenario);
    const installer = page;
    page = await context.newPage();
    await installer.close(); // the app has one page open, as the phone has
    page.on("console", (message) => message.type() === "error" && problems.push(`console.error: ${message.text()}`));
    page.on("pageerror", (error) => problems.push(`uncaught: ${error.message}`));
    await page.route(
      (url) => /^https?:$/.test(url.protocol) && !LOCAL_HOSTS.has(url.hostname),
      (route) => {
        problems.push(`external request: ${route.request().url()}`);
        return route.abort();
      },
    );
    await takeUnrecorded(request);
  }
  await prepare(page, { timed: true });
  if (scenario.today !== undefined) await fixTime(page, scenario.today);

  await page.goto(scenario.url, { waitUntil: "commit" });
  await page.waitForFunction(() => window.__probe.finished, null, { polling: 200, timeout: 90_000 });

  type Cold = Omit<Sample, keyof typeof NO_STEP | keyof typeof NO_EDIT | keyof typeof NO_PAN>;
  const sample = await page.evaluate((requested): Cold => {
    const probe = window.__probe;
    const firstFrameAfterRoutes = (loads: number[], frames: number[], since: number): number | null => {
      const loaded = loads.find((at) => at >= since);
      return loaded === undefined ? null : (frames.find((at) => at >= loaded) ?? null);
    };
    const entry = (name: string): PerformanceEntry | undefined => performance.getEntriesByName(name)[0];
    const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    const rowsFirst = probe.rows.find(([, count]) => count > 0) as [number, number];
    const idle = probe.idles.find((at) => at >= rowsFirst[0]) as number;
    // The answer the panel is made of: the request of the scenario itself (the first the app makes, for a day, a month or a year; for a
    // trip, the one of the trip, which is not necessarily the first of the page, since the bar asks for the list too).
    const resources = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
    const api = resources.filter((r) => r.name.endsWith(requested));
    const [, rowCount] = probe.rows[probe.rows.length - 1] as [number, number];
    return {
      dataAt: api[0]?.responseEnd ?? null,
      rowsAt: rowsFirst[0],
      rowsPaintedAt: probe.rowsPainted,
      rowCount,
      idleAt: idle,
      mapReadyAt: probe.mapReady,
      firstContentfulPaint: entry("first-contentful-paint")?.startTime ?? null,
      domContentLoaded: navigation?.domContentLoadedEventEnd ?? null,
      renders: probe.renderAt.length,
      routesDrawnAt: firstFrameAfterRoutes(probe.routeLoads, probe.renderAt, rowsFirst[0]),
      blockedBeforeRows: probe.longTasks.filter(([start]) => start < rowsFirst[0]).reduce((sum, [, duration]) => sum + duration, 0),
      workerAnswered: resources.filter((r) => r.workerStart > 0 && r.transferSize === 0).length,
      assetsNotFetched: resources.filter((r) => new URL(r.name).pathname.startsWith("/assets/") && r.transferSize === 0).length,
    };
  }, scenario.request);
  if (keep) {
    mkdirSync(RESULTS, { recursive: true });
    await page.screenshot({ path: join(RESULTS, `${scenario.id}.png`) });
  }
  const nothingElse = async (): Promise<void> => {
    expect(await takeUnrecorded(request), "requests the recording has no answer for").toEqual([]);
    expect(problems, "what the page logged that it should not have").toEqual([]);
    expect(sample.rowCount, "rows of the panel").toBeGreaterThan(0);
  };

  // The app opened on today. Installed, the files of the shell came from the worker's cache and none from the network; not installed, all of them from the network.
  if (scenario.kind === "open" || scenario.kind === "installed") {
    await nothingElse();
    if (scenario.kind === "installed") {
      expect(sample.workerAnswered, "resources the worker answered from its cache").toBeGreaterThan(5);
      expect(sample.assetsNotFetched, "files under /assets/ that were not fetched").toBeGreaterThan(2);
    } else {
      expect(sample.workerAnswered, "resources a worker answered").toBe(0);
      expect(sample.assetsNotFetched, "files under /assets/ that were not fetched").toBe(0);
    }
    return { ...sample, ...NO_STEP, ...NO_EDIT, ...NO_PAN };
  }

  // The year, opened, and then moved about and zoomed. Its routes are on the map by now.
  if (scenario.kind === "pan") {
    await nothingElse();
    expect(sample.routesDrawnAt, "the routes of the year are drawn").not.toBeNull();
    const pan = await page.evaluate(panAndZoom);
    if (keep) await page.screenshot({ path: join(RESULTS, `${scenario.id}-after.png`) });
    return { ...sample, ...NO_STEP, ...NO_EDIT, ...pan };
  }

  // The list of trips and a trip are timed on the cold navigation only (the brief of the trips asks for no more).
  const view = scenario.url.split("/")[1] as string;
  if (view === "trips" || view === "trip") {
    await nothingElse();
    return { ...sample, ...NO_STEP, ...NO_EDIT, ...NO_PAN };
  }

  // The tap on Edit points of the day with the most points, with the day open and at rest: the points answer is asked for then, and not before. It is
  // timed to the first frame that draws them; the bar's note says that they are there (there are some) and nothing else of them is looked at.
  if (scenario.edit !== undefined) {
    await page.evaluate(watchEdit, scenario.edit.request);
    await page.getByRole("button", { name: "Edit points" }).click();
    await page.waitForFunction(() => window.__probe.edit.finished, null, { polling: 200, timeout: 90_000 });
    const edit = await page.evaluate(() => window.__probe.edit);
    await nothingElse();
    // What the rows of the panel are to the other scenarios: the day has points and the app has them (its bar says to select one only when it has some).
    // That the map drew them is what `finished` says: the probe sets it only after the frame that draws them.
    expect(scenario.edit.points, "points of the day").toBeGreaterThan(0);
    await expect(page.getByRole("group", { name: "Edit points" }).getByText("Tap a point, or use Select area on the map.")).toBeVisible();
    if (keep) await page.screenshot({ path: join(RESULTS, `${scenario.id}-edit.png`) });
    const clicked = edit.clickedAt as number;
    return {
      ...sample,
      ...NO_STEP,
      ...NO_PAN,
      editAnswerMs: (edit.answerAt as number) - clicked,
      editLoadedMs: (edit.loadedAt as number) - clicked,
      editDrawnMs: (edit.drawnAt as number) - clicked,
      editIdleMs: (edit.idleAt as number) - clicked,
    };
  }

  // Then the step the spec means by "navigating": a tap on › with the page open and the next day or period already fetched (the app
  // prefetches it as soon as the one on show is). The page is at rest by now: the map has been idle, and so has everything else. For a day and a month a
  // second tap follows at once, with nothing prefetched for it (see watchStep).
  await page.evaluate(watchStep, view);
  await page.getByRole("button", { name: `Next ${view}` }).click();
  await page.waitForFunction(() => window.__probe.step.finished && window.__probe.cold.finished, null, { polling: 200, timeout: 60_000 });
  const step = await page.evaluate(() => {
    const { step: made, cold, routeLoads, renderAt } = window.__probe;
    const loaded = routeLoads.find((at) => at >= (made.rowsAt as number));
    return { ...made, cold, routesDrawnAt: loaded === undefined ? null : (renderAt.find((at) => at >= loaded) ?? null) };
  });
  await nothingElse();
  const clicked = step.clickedAt as number;
  const coldClicked = step.cold.clickedAt;
  return {
    ...sample,
    ...NO_EDIT,
    ...NO_PAN,
    stepRowsMs: (step.rowsAt as number) - clicked,
    stepPaintedMs: step.paintedAt === null ? null : step.paintedAt - clicked,
    stepIdleMs: (step.idleAt as number) - clicked,
    stepRoutesDrawnMs: step.routesDrawnAt === null ? null : step.routesDrawnAt - clicked,
    coldRowsMs: coldClicked === null || step.cold.rowsAt === null ? null : step.cold.rowsAt - coldClicked,
    coldPaintedMs: coldClicked === null || step.cold.paintedAt === null ? null : step.cold.paintedAt - coldClicked,
    coldIdleMs: coldClicked === null || step.cold.idleAt === null ? null : step.cold.idleAt - coldClicked,
  };
}

test.describe("web timing", () => {
  test.describe.configure({ mode: "serial" });

  test("warm-up (discarded)", async ({ page, request }) => {
    // The first page of a browser pays for starting the GPU process and compiling its shaders; it is not what a second look costs.
    await run(page, request, recording.scenarios[0] as Scenario, false);
  });

  for (const scenario of recording.scenarios) {
    for (let k = 1; k <= RUNS; k++) {
      test(`${scenario.id} run ${k}`, async ({ page, request }) => {
        const sample = await run(page, request, scenario, k === 1);
        samples.set(scenario.id, [...(samples.get(scenario.id) ?? []), sample]);
      });
    }
  }

  // The app opened on today for the first time, then a scripted pan and zoom on the year, with no worker (the e2e config blocks them: nothing but the run's own page asks for one).
  for (const scenario of extra.filter((candidate) => candidate.kind !== "installed")) {
    for (let k = 1; k <= RUNS; k++) {
      test(`${scenario.id} run ${k}`, async ({ page, request }) => {
        const sample = await run(page, request, scenario, k === 1);
        samples.set(scenario.id, [...(samples.get(scenario.id) ?? []), sample]);
      });
    }
  }

  test.describe("with the service worker", () => {
    test.use({ serviceWorkers: "allow" });

    test("warm-up, installed (discarded)", async ({ page, request }) => {
      await run(page, request, extra.find((candidate) => candidate.kind === "installed") as Scenario, false);
    });

    for (const scenario of extra.filter((candidate) => candidate.kind === "installed")) {
      for (let k = 1; k <= RUNS; k++) {
        test(`${scenario.id} run ${k}`, async ({ page, request }) => {
          const sample = await run(page, request, scenario, k === 1);
          samples.set(scenario.id, [...(samples.get(scenario.id) ?? []), sample]);
        });
      }
    }
  });

  test("probe: does the CPU throttle reach a worker", async ({ page }) => {
    // MapLibre parses its GeoJSON in a worker. Whether `Emulation.setCPUThrottlingRate` slows a worker too decides what the map's
    // `idle` time says about a phone, so it is measured: a fixed loop on the page's thread and in a worker, with and without.
    await page.goto("/test-style.json", { waitUntil: "load" }); // any page of the preview server will do: the probe needs one to run scripts in
    const client = await page.context().newCDPSession(page);
    const loop = (): Promise<{ main: number; worker: number }> => {
      const spin = "let x = 0; for (let i = 0; i < 3e8; i++) x += i % 7; x";
      const main = ((): number => {
        const t = performance.now();
        new Function(spin)();
        return performance.now() - t;
      })();
      const url = URL.createObjectURL(new Blob([`const t = performance.now(); ${spin}; postMessage(performance.now() - t);`]));
      return new Promise((resolve) => {
        const worker = new Worker(url);
        worker.onmessage = (event: MessageEvent<number>) => resolve({ main, worker: event.data });
      });
    };
    await client.send("Emulation.setCPUThrottlingRate", { rate: 1 });
    const open = await page.evaluate(loop);
    await client.send("Emulation.setCPUThrottlingRate", { rate: CPU_RATE });
    const held = await page.evaluate(loop);
    probes["workerThrottle"] = { rate: CPU_RATE, unthrottledMs: open, throttledMs: held, mainSlowdown: held.main / open.main, workerSlowdown: held.worker / open.worker };
  });

  test.afterAll(() => {
    const rows: Record<string, unknown>[] = [];
    const metrics = [
      ["dataAt", "API answer received"],
      ["rowsAt", "panel rows in the DOM"],
      ["rowsPaintedAt", "panel rows painted"],
      ["routesDrawnAt", "routes drawn on the map"],
      ["idleAt", "map idle"],
      ["mapReadyAt", "map style loaded"],
      ["firstContentfulPaint", "first contentful paint"],
      ["blockedBeforeRows", "main thread blocked before the rows"],
      ["workerAnswered", "resources the worker answered"],
      ["assetsNotFetched", "files of /assets/ not fetched"],
      ["stepRowsMs", "STEP (tap next): rows"],
      ["stepPaintedMs", "STEP (tap next): rows painted"],
      ["stepRoutesDrawnMs", "STEP (tap next): routes drawn"],
      ["stepIdleMs", "STEP (tap next): map idle"],
      ["coldRowsMs", "COLD STEP (tap next at once): rows"],
      ["coldPaintedMs", "COLD STEP: rows painted"],
      ["coldIdleMs", "COLD STEP: map idle"],
      ["editAnswerMs", "EDIT (tap Edit points): answer"],
      ["editLoadedMs", "EDIT: the map has the points"],
      ["editDrawnMs", "EDIT: points drawn"],
      ["editIdleMs", "EDIT: map idle"],
      ["panFrames", "PAN AND ZOOM: frames drawn"],
      ["panSeconds", "PAN AND ZOOM: seconds"],
      ["panP50Ms", "PAN AND ZOOM: frame time, median (ms)"],
      ["panP95Ms", "PAN AND ZOOM: frame time, p95 (ms)"],
      ["panMaxMs", "PAN AND ZOOM: frame time, longest (ms)"],
      ["panOver50", "PAN AND ZOOM: frames over 50 ms"],
    ] as const;
    const lines: string[] = [];
    const network = NETWORK === null ? "no network" : `network ${NETWORK.latency} ms round trip, ${NETWORK.download * 8e-6} Mbit/s down, ${NETWORK.upload * 8e-6} up`;
    lines.push(`CPU throttling ${CPU_RATE}x, ${network}, ${RUNS} runs of each; ms from the start of the navigation; median / worst`);
    for (const scenario of [...recording.scenarios, ...extra]) {
      const list = samples.get(scenario.id) ?? [];
      if (list.length === 0) continue;
      const summary: Record<string, unknown> = { scenario: scenario.id, url: scenario.url, bytes: scenario.bytes, runs: list.length, rowCount: list[0]?.rowCount, edit: scenario.edit };
      const points = scenario.edit === undefined ? "" : `; ${scenario.edit.points} points, ${(scenario.edit.bytes / 1000).toFixed(0)} kB`;
      lines.push(`${scenario.id.padEnd(12)} ${scenario.url.padEnd(20)} ${(scenario.bytes / 1000).toFixed(0)} kB, ${list[0]?.rowCount} rows${points}`);
      for (const [key, label] of metrics) {
        const values = list.map((s) => s[key]).filter((v): v is number => typeof v === "number");
        if (values.length === 0) continue;
        summary[key] = { median: Math.round(median(values)), worst: Math.round(worst(values)), all: values.map(Math.round) };
        lines.push(`    ${label.padEnd(40)} ${String(Math.round(median(values))).padStart(6)} / ${String(Math.round(worst(values))).padStart(6)}`);
      }
      const renders = list.map((s) => s.renders);
      summary["renders"] = { median: median(renders), worst: worst(renders) };
      rows.push(summary);
    }
    mkdirSync(RESULTS, { recursive: true });
    writeFileSync(
      join(RESULTS, "web-timing.json"),
      JSON.stringify({ cpuThrottling: CPU_RATE, network: NETWORK, runs: RUNS, recordedFrom: recording.recordedFrom, scenarios: rows, probes }, null, 2),
    );
    console.log(`\n${lines.join("\n")}\n${JSON.stringify(probes)}\n`);
  });
});
