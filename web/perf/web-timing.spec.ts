import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Request } from "@playwright/test";
import { expect, test } from "../e2e/base";
import config from "../e2e/fixtures/config.json" with { type: "json" };
import { mockApi, type Reply } from "../e2e/mockApi";

declare const process: { env: Record<string, string | undefined> }; // this file runs in Node, whose types the app does not take

/**
 * The web half of the performance check (spec §8): the time from navigation to the panel's rows and to the map's `idle` event, for a
 * day, a month and a year, for the list of trips (its cards are the rows) and for each trip (its days are the rows), on a phone's page
 * with the processor held back 4 times, against API answers recorded from a server over the synthetic history (`npm run perf:record`).
 * Run by `npm run perf`, not by `npm run e2e`: it is a measurement, and asserts only that it measured what it meant to (every run
 * reached the panel's rows and the map's idle, nothing outside the recording was asked for).
 * The `edit-points` scenario is the day with the most raw points, opened cold, and then the tap on Edit points: it times what the owner waits for
 * after that tap, the points on the map (the answer, the map having the tiles of its source of them, the first frame that draws them and the map's idle).
 * The method, what is measured and what is not, is in docs/superpowers/plans/2026-10-24-sporer-plan-2-perf.md, for the trips in
 * docs/superpowers/plans/2026-10-26-sporer-plan-3-perf.md and for editing in docs/superpowers/plans/2026-10-28-sporer-plan-4-perf.md.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const RECORDED = join(HERE, "recorded");
const RESULTS = join(HERE, "results");
const RUNS = Number(process.env["PERF_RUNS"] ?? "7");
const CPU_RATE = Number(process.env["PERF_CPU"] ?? "4");

interface Scenario {
  id: string;
  label: string;
  url: string;
  request: string;
  file: string;
  bytes: number;
  /** For the scenario of edit mode: the request for the points that the tap on Edit points makes, how many there are, and the size of the answer. */
  edit?: { request: string; points: number; bytes: number };
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
/** The paths of the recorded answers with the points of a day: the mock answers each by a key of its own. */
const pointsPaths = Object.keys(recording.requests).filter((request) => request.endsWith("/points"));
const bodies = new Map<string, unknown>(
  Object.entries(recording.requests).map(([request, file]) => [request, JSON.parse(readFileSync(join(RECORDED, file), "utf8")) as unknown]),
);

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
  /**
   * From a tap on "Edit points" to the answer with the points, to the map having the tiles of its source of them, to the first frame that draws them and to the map's idle
   * after it. Null for every scenario but the one of edit mode.
   */
  editAnswerMs: number | null;
  editLoadedMs: number | null;
  editDrawnMs: number | null;
  editIdleMs: number | null;
}

/** What a scenario that makes no step, or no edit, says of it. */
const NO_STEP = { stepRowsMs: null, stepPaintedMs: null, stepIdleMs: null, stepRoutesDrawnMs: null };
const NO_EDIT = { editAnswerMs: null, editLoadedMs: null, editDrawnMs: null, editIdleMs: null };

const samples = new Map<string, Sample[]>();
const probes: Record<string, unknown> = {};

const sorted = (values: number[]): number[] => [...values].sort((a, b) => a - b);
const median = (values: number[]): number => sorted(values)[Math.floor((values.length - 1) / 2)] ?? Number.NaN;
const worst = (values: number[]): number => Math.max(...values);

/** Installed once the page is at rest: notes the next tap, the moment the rows of the panel are other rows, and the map's next idle. */
function watchStep(): void {
  const { step, idles } = window.__probe;
  const signature = (): string => {
    const items = document.querySelectorAll('[aria-label="Details"] li');
    return `${items.length}|${items[0]?.textContent}|${items[items.length - 1]?.textContent}`;
  };
  const before = signature();
  document.addEventListener("click", () => (step.clickedAt = performance.now()), { capture: true, once: true });
  const observer = new MutationObserver(() => {
    if (step.clickedAt === null || step.rowsAt !== null || signature() === before) return;
    step.rowsAt = performance.now();
    requestAnimationFrame(() => requestAnimationFrame(() => (step.paintedAt = performance.now())));
    const wait = (): void => {
      const idle = idles.find((at) => at >= (step.rowsAt as number));
      if (idle === undefined) setTimeout(wait, 50);
      else {
        step.idleAt = idle;
        setTimeout(() => (step.finished = true), 400);
      }
    };
    wait();
    observer.disconnect();
  });
  observer.observe(document, { childList: true, subtree: true, characterData: true });
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

async function run(page: import("@playwright/test").Page, scenario: Scenario, keep: boolean): Promise<Sample> {
  const unrecorded: string[] = [];
  await mockApi(page, {
    config,
    status: bodies.get("/api/status") as object,
    "day/*": (request): Reply => answer(request.url(), unrecorded),
    range: (request): Reply => answer(request.url(), unrecorded),
    trips: (request): Reply => answer(request.url(), unrecorded),
    "trips/*": (request): Reply => answer(request.url(), unrecorded),
    // The points of a day, which a key of the day's own beats `day/*` (that one has the last segment of the path made `*`): one for each that was recorded.
    ...Object.fromEntries(pointsPaths.map((path) => [path.slice("/api/".length), (request: Request): Reply => answer(request.url(), unrecorded)])),
  });

  const client = await page.context().newCDPSession(page);
  await client.send("Emulation.setCPUThrottlingRate", { rate: CPU_RATE });
  await page.addInitScript(installProbe);

  await page.goto(scenario.url, { waitUntil: "commit" });
  await page.waitForFunction(() => window.__probe.finished, null, { polling: 200, timeout: 90_000 });

  type Cold = Omit<Sample, "stepRowsMs" | "stepPaintedMs" | "stepIdleMs" | "stepRoutesDrawnMs" | "editAnswerMs" | "editLoadedMs" | "editDrawnMs" | "editIdleMs">;
  const sample = await page.evaluate((request): Cold => {
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
    const api = (performance.getEntriesByType("resource") as PerformanceResourceTiming[]).filter((r) => r.name.endsWith(request));
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
    };
  }, scenario.request);
  if (keep) {
    mkdirSync(RESULTS, { recursive: true });
    await page.screenshot({ path: join(RESULTS, `${scenario.id}.png`) });
  }

  // The list of trips and a trip are timed on the cold navigation only (the brief of the trips asks for no more).
  const view = scenario.url.split("/")[1] as string;
  if (view === "trips" || view === "trip") {
    expect(unrecorded, "requests the recording has no answer for").toEqual([]);
    expect(sample.rowCount, "rows of the panel").toBeGreaterThan(0);
    return { ...sample, ...NO_STEP, ...NO_EDIT };
  }

  // The tap on Edit points of the day with the most points, with the day open and at rest: the points answer is asked for then, and not before. It is
  // timed to the first frame that draws them; the bar's note says that they are there (there are some) and nothing else of them is looked at.
  if (scenario.edit !== undefined) {
    await page.evaluate(watchEdit, scenario.edit.request);
    await page.getByRole("button", { name: "Edit points" }).click();
    await page.waitForFunction(() => window.__probe.edit.finished, null, { polling: 200, timeout: 90_000 });
    const edit = await page.evaluate(() => window.__probe.edit);
    expect(unrecorded, "requests the recording has no answer for").toEqual([]);
    // What the rows of the panel are to the other scenarios: the day has points, the app has them (its bar says to select one only when it has some) and
    // the map drew them.
    expect(scenario.edit.points, "points of the day").toBeGreaterThan(0);
    await expect(page.getByRole("group", { name: "Edit points" }).getByText("Tap a point, or use Select area on the map.")).toBeVisible();
    expect(edit.drawnAt, "the frame that draws the points").not.toBeNull();
    if (keep) await page.screenshot({ path: join(RESULTS, `${scenario.id}-edit.png`) });
    const clicked = edit.clickedAt as number;
    return {
      ...sample,
      ...NO_STEP,
      editAnswerMs: (edit.answerAt as number) - clicked,
      editLoadedMs: (edit.loadedAt as number) - clicked,
      editDrawnMs: (edit.drawnAt as number) - clicked,
      editIdleMs: (edit.idleAt as number) - clicked,
    };
  }

  // Then the step the spec means by "navigating": a tap on › with the page open and the next day or period already fetched (the app
  // prefetches it as soon as the one on show is). The page is at rest by now: the map has been idle, and so has everything else.
  await page.evaluate(watchStep);
  await page.getByRole("button", { name: `Next ${view}` }).click();
  await page.waitForFunction(() => window.__probe.step.finished, null, { polling: 200, timeout: 60_000 });
  const step = await page.evaluate(() => {
    const { step: made, routeLoads, renderAt } = window.__probe;
    const loaded = routeLoads.find((at) => at >= (made.rowsAt as number));
    return { ...made, routesDrawnAt: loaded === undefined ? null : (renderAt.find((at) => at >= loaded) ?? null) };
  });
  expect(unrecorded, "requests the recording has no answer for").toEqual([]);
  expect(sample.rowCount, "rows of the panel").toBeGreaterThan(0);
  const clicked = step.clickedAt as number;
  return {
    ...sample,
    ...NO_EDIT,
    stepRowsMs: (step.rowsAt as number) - clicked,
    stepPaintedMs: step.paintedAt === null ? null : step.paintedAt - clicked,
    stepIdleMs: (step.idleAt as number) - clicked,
    stepRoutesDrawnMs: step.routesDrawnAt === null ? null : step.routesDrawnAt - clicked,
  };
}

/** The recorded answer to a request; one that was not recorded is noted (and fails the run) and answered with an empty 404. */
function answer(url: string, unrecorded: string[]): Reply {
  const { pathname, search } = new URL(url);
  const body = bodies.get(pathname + search);
  if (body === undefined) {
    unrecorded.push(pathname + search);
    return { status: 404, json: {} };
  }
  return { json: body };
}

test.describe("web timing", () => {
  test.describe.configure({ mode: "serial" });

  test("warm-up (discarded)", async ({ page }) => {
    // The first page of a browser pays for starting the GPU process and compiling its shaders; it is not what a second look costs.
    await run(page, recording.scenarios[0] as Scenario, false);
  });

  for (const scenario of recording.scenarios) {
    for (let k = 1; k <= RUNS; k++) {
      test(`${scenario.id} run ${k}`, async ({ page }) => {
        const sample = await run(page, scenario, k === 1);
        samples.set(scenario.id, [...(samples.get(scenario.id) ?? []), sample]);
      });
    }
  }

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
      ["stepRowsMs", "STEP (tap next): rows"],
      ["stepPaintedMs", "STEP (tap next): rows painted"],
      ["stepRoutesDrawnMs", "STEP (tap next): routes drawn"],
      ["stepIdleMs", "STEP (tap next): map idle"],
      ["editAnswerMs", "EDIT (tap Edit points): answer"],
      ["editLoadedMs", "EDIT: the map has the points"],
      ["editDrawnMs", "EDIT: points drawn"],
      ["editIdleMs", "EDIT: map idle"],
    ] as const;
    const lines: string[] = [];
    lines.push(`CPU throttling ${CPU_RATE}x, ${RUNS} runs of each; ms from the start of the navigation; median / worst`);
    for (const scenario of recording.scenarios) {
      const list = samples.get(scenario.id) ?? [];
      if (list.length === 0) continue;
      const summary: Record<string, unknown> = { scenario: scenario.id, url: scenario.url, bytes: scenario.bytes, runs: list.length, rowCount: list[0]?.rowCount, edit: scenario.edit };
      const points = scenario.edit === undefined ? "" : `; ${scenario.edit.points} points, ${(scenario.edit.bytes / 1000).toFixed(0)} kB`;
      lines.push(`${scenario.id.padEnd(12)} ${scenario.url.padEnd(20)} ${(scenario.bytes / 1000).toFixed(0)} kB, ${list[0]?.rowCount} rows${points}`);
      for (const [key, label] of metrics) {
        const values = list.map((s) => s[key]).filter((v): v is number => typeof v === "number");
        if (values.length === 0) continue;
        summary[key] = { median: Math.round(median(values)), worst: Math.round(worst(values)), all: values.map(Math.round) };
        lines.push(`    ${label.padEnd(36)} ${String(Math.round(median(values))).padStart(6)} / ${String(Math.round(worst(values))).padStart(6)}`);
      }
      const renders = list.map((s) => s.renders);
      summary["renders"] = { median: median(renders), worst: worst(renders) };
      rows.push(summary);
    }
    mkdirSync(RESULTS, { recursive: true });
    writeFileSync(join(RESULTS, "web-timing.json"), JSON.stringify({ cpuThrottling: CPU_RATE, runs: RUNS, recordedFrom: recording.recordedFrom, scenarios: rows, probes }, null, 2));
    console.log(`\n${lines.join("\n")}\n${JSON.stringify(probes)}\n`);
  });
});
