import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRef, StrictMode, type ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ConfigResponse } from "../api/types";
import { boundsOf } from "./bounds";
import { LAYER_IDS, ROUTE_LAYERS, routeOpacity, SOURCE_IDS } from "./layers";
import type { EditPointCollection, Feature, FeatureCollection, HeatCollection, LineString, Point, StopCollection } from "./layers";
import type { MapLibreLoader, MapLibreModule } from "./maplibre";
import { MapView, type MapData, type MapEdit, type MapViewHandle, type MapViewProps } from "./MapView";

// jsdom has no WebGL, so `maplibre-gl` is replaced by a map that records what it is asked to do and fires the events a
// real one fires, when the test says so (`emit`). It is as strict as the real one is helpful: adding a source twice, or a
// layer for a source that is not there, throws here where MapLibre only logs.
const maplibre = vi.hoisted(() => {
  type Listener = (event: unknown) => void;

  class FakeSource {
    setDataCalls = 0;
    constructor(public data: unknown) {}
    setData(data: unknown): void {
      this.data = data;
      this.setDataCalls += 1;
    }
  }

  /** A handler of the map's gestures (`boxZoom`, `dragPan`): on or off, and every change there was. */
  class FakeHandler {
    readonly calls: string[] = [];
    constructor(public enabled = true) {}
    isEnabled(): boolean {
      return this.enabled;
    }
    enable(): void {
      this.calls.push("enable");
      this.enabled = true;
    }
    disable(): void {
      this.calls.push("disable");
      this.enabled = false;
    }
  }

  class FakeMap {
    static instances: FakeMap[] = [];
    static failWith: Error | null = null;
    static failRotation: Error | null = null;

    readonly options: Record<string, unknown>;
    removed = false;
    contextLost = false;
    rotationDisabled = false;
    readonly styleCalls: { style: unknown; options: unknown }[] = [];
    readonly fitCalls: { bounds: unknown; options: Record<string, unknown> }[] = [];
    readonly visibilityCalls: [string, unknown][] = [];
    readonly paintCalls: [id: string, name: string, value: unknown][] = [];
    readonly sources = new Map<string, FakeSource>();
    readonly layers = new Map<string, Record<string, any>>();
    /** The images of the style, by id (a style has its own, and a new one has none), and every `addImage` there was, in order. */
    readonly images = new Map<string, unknown>();
    readonly imageCalls: { id: string; image: { width: number; height: number; data: ArrayLike<number> }; options: unknown }[] = [];
    /** What was added to the style, in order, for a test that says one is before the other: `image:{id}` and `layer:{id}`. */
    readonly additions: string[] = [];
    private readonly listeners = new Map<string, Set<Listener>>();
    /** The canvas the real map draws on, for the cursor over it. */
    readonly canvas = document.createElement("canvas");
    /**
     * What is drawn at positions of the screen, for `queryRenderedFeatures`: a feature is at the pixel that its coordinates are, in this
     * double (see `project`), so a test says where on the screen a dot is by where it puts it.
     */
    readonly drawn: { layerId: string; properties: Record<string, unknown>; at: [number, number]; id?: number }[] = [];
    /** The gestures of the map that edit mode turns off: on to begin with, as a map is made. */
    readonly boxZoom = new FakeHandler();
    readonly dragPan = new FakeHandler();
    readonly doubleClickZoom = new FakeHandler();
    /**
     * The feature state of each source, by the id of the feature: what `setFeatureState` set and `removeFeatureState` took away. A style has none of it.
     * `stateCalls` has every call, in order, as `set 3`, `remove 3` and `clear`.
     */
    readonly featureStates = new Map<string, Map<number, Record<string, unknown>>>();
    readonly stateCalls: string[] = [];
    /** The boxes and layers that `queryRenderedFeatures` was asked, in order. */
    readonly queries: { box: unknown; layers: string[] }[] = [];
    readonly touchZoomRotate = {
      disableRotation: () => {
        if (FakeMap.failRotation) throw FakeMap.failRotation;
        this.rotationDisabled = true;
      },
    };

    /**
     * MapLibre's credit as it is built for a compact attribution: open (`maplibregl-compact-show`, and the `open` of the `<details>`, which a
     * closed one draws nothing of but its summary) until it is folded. A drag takes the class only; ⓘ takes both.
     */
    readonly credit = document.createElement("details");
    /** Its ⓘ button, which toggles the class and `open`, as MapLibre's own handler does. It is no tap on the map: no `click` of the map comes of it. */
    readonly infoButton = document.createElement("summary");

    constructor(options: Record<string, unknown>) {
      if (FakeMap.failWith) throw FakeMap.failWith;
      this.options = options;
      this.credit.className = "maplibregl-ctrl maplibregl-ctrl-attrib maplibregl-compact maplibregl-compact-show";
      this.credit.setAttribute("open", "");
      this.infoButton.className = "maplibregl-ctrl-attrib-button";
      // MapLibre's `_toggleAttribution`: it sets or takes away `open` as the click is about to toggle it (a `<summary>` does that by itself,
      // after the handlers, and so does jsdom), so that the class and `open` end up together.
      this.infoButton.addEventListener("click", () => {
        if (this.credit.classList.contains("maplibregl-compact-show")) {
          this.credit.setAttribute("open", "");
          this.credit.classList.remove("maplibregl-compact-show");
        } else {
          this.credit.classList.add("maplibregl-compact-show");
          this.credit.removeAttribute("open");
        }
      });
      this.credit.append(this.infoButton);
      this.on("drag", () => this.credit.classList.remove("maplibregl-compact-show")); // MapLibre's own: the one thing that folds a credit
      (options["container"] as HTMLElement | undefined)?.append(this.credit);
      FakeMap.instances.push(this);
    }

    on(type: string, listener: Listener): this {
      const set = this.listeners.get(type) ?? new Set<Listener>();
      set.add(listener);
      this.listeners.set(type, set);
      return this;
    }
    off(type: string, listener: Listener): this {
      this.listeners.get(type)?.delete(listener);
      return this;
    }
    listenerCount(type: string): number {
      return this.listeners.get(type)?.size ?? 0;
    }
    emit(type: string, event: unknown = {}): void {
      for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
    }
    /** An event of the pointer at the pixel (`x`, `y`) of the map, as MapLibre tells of one (`click`, `mousemove`). */
    pointer(type: string, x: number, y: number): void {
      this.emit(type, { point: { x, y } });
    }
    getCanvas(): HTMLCanvasElement {
      return this.canvas;
    }
    /** The pixel that a position is at: the position itself, so that a test places things where it wants them. */
    project([x, y]: [number, number]): { x: number; y: number } {
      return { x, y };
    }
    /**
     * The features of `layers` that are in the box, as MapLibre gives them: like the real one it will not look in a layer that is not in
     * the style (it reports an error and finds nothing), which here is a test that fails.
     */
    queryRenderedFeatures(box: [[number, number], [number, number]], options: { layers: string[] }): object[] {
      this.requireStyle();
      this.queries.push({ box, layers: options.layers });
      for (const id of options.layers) if (!this.layers.has(id)) throw new Error(`The layer '${id}' does not exist in the map's style and cannot be queried for features.`);
      const [[left, top], [right, bottom]] = box;
      return this.drawn
        .filter(({ layerId, at: [x, y] }) => options.layers.includes(layerId) && x >= left && x <= right && y >= top && y <= bottom)
        .map(({ layerId, properties, at, id }) => ({ id, properties, layer: { id: layerId }, geometry: { type: "Point", coordinates: at } }));
    }
    /** MapLibre's: the source has to be in the style (it reports an error and does nothing for one that is not, which here is a test that fails). */
    private requireSource(source: string): Map<number, Record<string, unknown>> {
      this.requireStyle();
      if (!this.sources.has(source)) throw new Error(`The source '${source}' does not exist in the map's style.`);
      const states = this.featureStates.get(source) ?? new Map<number, Record<string, unknown>>();
      this.featureStates.set(source, states);
      return states;
    }
    setFeatureState({ source, id }: { source: string; id: number }, state: Record<string, unknown>): void {
      const states = this.requireSource(source);
      states.set(id, { ...states.get(id), ...state });
      this.stateCalls.push(`set ${id}`);
    }
    removeFeatureState({ source, id }: { source: string; id?: number }, key?: string): void {
      const states = this.requireSource(source);
      if (id === undefined) {
        states.clear();
        this.stateCalls.push("clear");
        return;
      }
      const state = { ...states.get(id) };
      if (key === undefined) for (const name of Object.keys(state)) delete state[name];
      else delete state[key];
      if (Object.keys(state).length === 0) states.delete(id);
      else states.set(id, state);
      this.stateCalls.push(`remove ${id}`);
    }
    /** The ids that have the state `selected` in `source`, sorted. */
    selectedIn(source: string): number[] {
      return [...(this.featureStates.get(source) ?? [])].filter(([, state]) => state["selected"] === true).map(([id]) => id).sort((a, b) => a - b);
    }

    private requireStyle(): void {
      if (this.contextLost) throw new TypeError("Cannot read properties of null (reading 'getSource')");
    }
    setStyle(style: unknown, options: unknown): this {
      this.styleCalls.push({ style, options });
      this.featureStates.clear(); // a style has none of the state of the one before
      this.sources.clear();
      this.layers.clear();
      this.images.clear(); // the images of a style go with it
      return this;
    }
    hasImage(id: string): boolean {
      this.requireStyle();
      return this.images.has(id);
    }
    addImage(id: string, image: { width: number; height: number; data: ArrayLike<number> }, options: unknown): this {
      this.requireStyle();
      if (this.images.has(id)) throw new Error(`An image named "${id}" already exists.`); // MapLibre reports it and adds nothing
      this.images.set(id, image);
      this.imageCalls.push({ id, image, options });
      this.additions.push(`image:${id}`);
      return this;
    }
    getSource(id: string): FakeSource | undefined {
      this.requireStyle();
      return this.sources.get(id);
    }
    addSource(id: string, spec: { data: unknown }): this {
      this.requireStyle();
      if (this.sources.has(id)) throw new Error(`Source "${id}" already exists.`);
      this.sources.set(id, new FakeSource(spec.data));
      return this;
    }
    getLayer(id: string): Record<string, any> | undefined {
      this.requireStyle();
      return this.layers.get(id);
    }
    addLayer(spec: Record<string, any>): this {
      this.requireStyle();
      if (this.layers.has(spec.id)) throw new Error(`Layer "${spec.id}" already exists.`);
      if (!this.sources.has(spec.source)) throw new Error(`Layer "${spec.id}" needs the missing source "${spec.source}".`);
      this.layers.set(spec.id, structuredClone(spec));
      this.additions.push(`layer:${spec.id}`);
      return this;
    }
    setLayoutProperty(id: string, name: string, value: unknown): void {
      this.requireStyle();
      this.visibilityCalls.push([id, value]);
      const layer = this.layers.get(id);
      if (layer) layer.layout = { ...layer.layout, [name]: value };
    }
    setPaintProperty(id: string, name: string, value: unknown): void {
      this.requireStyle();
      this.paintCalls.push([id, name, value]);
      const layer = this.layers.get(id);
      if (layer) layer.paint = { ...layer.paint, [name]: value };
    }
    fitBounds(bounds: unknown, options: Record<string, unknown>): this {
      this.fitCalls.push({ bounds, options });
      return this;
    }
    remove(): void {
      this.removed = true;
      this.credit.remove();
    }
  }

  const workerUrls: string[] = [];

  return { FakeMap, workerUrls, setWorkerUrl: (url: string) => workerUrls.push(url) };
});

vi.mock("maplibre-gl", () => ({ MapLibreMap: maplibre.FakeMap, Map: maplibre.FakeMap, setWorkerUrl: maplibre.setWorkerUrl }));

const { FakeMap } = maplibre;

const liveMaps = () => FakeMap.instances.filter((map) => !map.removed);
const theMap = () => {
  const maps = liveMaps();
  if (maps.length !== 1) throw new Error(`expected one live map, found ${maps.length}`);
  return maps[0]!;
};

const NONE = { top: 0, right: 0, bottom: 0, left: 0 };

function routes(id = 1, ...lonLat: [number, number][]): FeatureCollection<LineString, { id: number; mode: "walk" }> {
  return {
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      properties: { id, mode: "walk" },
      geometry: { type: "LineString", coordinates: lonLat.length > 0 ? lonLat : [[10, 59], [10.1, 59.1]] },
    }],
  };
}

function stops(): StopCollection {
  return {
    type: "FeatureCollection",
    features: [{ type: "Feature", properties: { order: 1, label: "1", name: "Home", id: 5, placeId: 50 }, geometry: { type: "Point", coordinates: [10, 59] } }],
  };
}

/** The heat of one cell, as the map is given it: a point with its weight. */
function heatCells(...weights: number[]): HeatCollection {
  return {
    type: "FeatureCollection",
    features: (weights.length > 0 ? weights : [1]).map((weight, i) => ({
      type: "Feature",
      properties: { weight },
      geometry: { type: "Point", coordinates: [10 + i / 100, 59] },
    })),
  };
}

const EMPTY_ROUTES = routes();
const STYLE = { version: 8, name: "light", sources: {}, layers: [{ id: "city", type: "symbol", source: "t", layout: { "text-field": "{name}" } }] };

/** Answers every fetch with `answer(url)`; returns the URLs asked for, in order. */
function stubFetch(answer: (url: string, init?: RequestInit) => Response | Promise<Response>): string[] {
  const urls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    urls.push(url);
    return answer(url, init);
  }));
  return urls;
}

const goodStyle = () => stubFetch(() => Response.json(STYLE));

/** What `toEnglishLabels` makes of the text field of `STYLE`. */
const ENGLISH_LABEL = ["coalesce", ["get", "name:en"], ["get", "name_en"], ["get", "name:latin"], ["get", "name"]];

function view(props: Partial<MapViewProps> = {}): ReactElement {
  return <MapView styleUrl="/style.json" data={{ routes: EMPTY_ROUTES }} fitTo={null} padding={NONE} {...props} />;
}

/** Waits until MapLibre has arrived and the component has taken the map it made over (it is a chunk of its own, fetched when the map mounts); returns the map. */
const mapUp = async (): Promise<InstanceType<typeof FakeMap>> => {
  const map = await waitFor(() => theMap());
  await act(async () => undefined); // the component takes the map over (its effects run) in the render that follows its arrival
  return map;
};

/** Waits until the map has been given the style it fetched. */
async function styleApplied(count = 1): Promise<void> {
  await waitFor(() => expect(theMap().styleCalls).toHaveLength(count));
}

const region = () => screen.getByRole("region", { name: "Map view" });

/** A loader whose module arrives when the test says so (`arrive`), or never does (`fail`). */
function slowLoader() {
  let arrive: () => void = () => undefined;
  let fail: (error: Error) => void = () => undefined;
  const load = vi.fn<MapLibreLoader>(
    () => new Promise((resolve, reject) => {
      arrive = () => resolve({ MapLibreMap: FakeMap, setWorkerUrl: () => undefined, workerUrl: "/w.mjs" } as unknown as MapLibreModule);
      fail = reject;
    }),
  );
  return { load, arrive: () => act(async () => arrive()), fail: (error: Error) => act(async () => fail(error)) };
}

const CONFIG: ConfigResponse = { mapStyleLight: "/styles/liberty", mapStyleDark: "/styles/dark" };

function withConfig(client: QueryClient, props: Partial<MapViewProps> = {}): ReactElement {
  return (
    <QueryClientProvider client={client}>
      <MapView data={{ routes: EMPTY_ROUTES }} fitTo={null} padding={NONE} {...props} />
    </QueryClientProvider>
  );
}

function clientWithConfig(): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["config"], CONFIG);
  return client;
}

/** `window.matchMedia` for the colour scheme; the function it returns switches the scheme and tells whoever listens. */
function stubColourScheme(initial: "light" | "dark"): (next: "light" | "dark") => void {
  let scheme = initial;
  const listeners = new Set<() => void>();
  vi.stubGlobal("matchMedia", (query: string) => ({
    media: query,
    get matches() { return query === "(prefers-color-scheme: dark)" && scheme === "dark"; },
    addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
  }));
  return (next) => {
    scheme = next;
    act(() => listeners.forEach((listener) => listener()));
  };
}

beforeEach(() => {
  FakeMap.instances.length = 0;
  FakeMap.failWith = null;
  FakeMap.failRotation = null;
});

afterEach(() => {
  FakeMap.failWith = null;
  FakeMap.failRotation = null;
});

describe("MapView", () => {
  test("MapView_tells_MapLibre_where_the_build_put_its_worker", async () => {
    goodStyle();
    render(view());
    await mapUp();

    // Once, when the module has arrived, before any map is made. MapLibre would look for it next to itself, in a chunk: not there.
    expect(maplibre.workerUrls).toHaveLength(1);
    expect(maplibre.workerUrls[0]).toContain("maplibre-gl-worker");
  });

  test("MapView_reports_style_failure_without_throwing", async () => {
    stubFetch(() => Promise.reject(new TypeError("Failed to fetch"))); // OpenFreeMap down or blocked
    const onStyleError = vi.fn<(error: Error) => void>();

    const { rerender } = render(view({ onStyleError }));

    await waitFor(() => expect(onStyleError).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 20)); // nothing reports it a second time
    expect(onStyleError).toHaveBeenCalledTimes(1);
    expect(onStyleError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    expect(onStyleError.mock.calls[0]?.[0].message).toBe("Failed to fetch");
    // The component is still on the page, still has its button, and the map got a plain style to draw the routes on.
    expect(region()).toBeInTheDocument();
    expect(region()).toHaveAttribute("data-map-state", "unavailable");
    expect(screen.getByRole("button", { name: "Recenter map" })).toBeInTheDocument();
    await styleApplied();
    expect(theMap().styleCalls[0]?.style).toEqual({ version: 8, sources: {}, layers: [] });
    theMap().emit("style.load");
    expect([...theMap().sources.keys()].sort()).toEqual(Object.values(SOURCE_IDS).sort());

    // And it keeps working: new data still reaches the map.
    const next = routes(2);
    expect(() => rerender(view({ onStyleError, data: { routes: next } }))).not.toThrow();
    expect(theMap().sources.get(SOURCE_IDS.routes)?.data).toBe(next);
    expect(onStyleError).toHaveBeenCalledTimes(1);
  });

  test.each([
    ["an error status", () => new Response("down", { status: 503 }), /503/],
    ["a body that is not JSON", () => new Response("<html>oops</html>"), undefined],
    ["JSON that is not a style", () => Response.json({ hello: "world" }), /style/i],
  ])("MapView_reports_%s_as_a_style_failure_once", async (_name, response, message) => {
    stubFetch(() => response());
    const onStyleError = vi.fn<(error: Error) => void>();

    render(view({ onStyleError }));

    await waitFor(() => expect(onStyleError).toHaveBeenCalledTimes(1));
    if (message) expect(onStyleError.mock.calls[0]?.[0].message).toMatch(message);
    expect(region()).toHaveAttribute("data-map-state", "unavailable");
    await styleApplied();
    expect(theMap().styleCalls[0]?.style).toEqual({ version: 8, sources: {}, layers: [] });
  });

  test("MapView_reports_a_style_that_MapLibre_rejects_once_and_falls_back", async () => {
    goodStyle();
    const onStyleError = vi.fn<(error: Error) => void>();
    render(view({ onStyleError }));
    await styleApplied();

    // MapLibre reports every validation problem of a style it will not load as an error event, one after the other, and never
    // fires style.load.
    theMap().emit("error", { error: new Error("layers[3].paint: unknown property") });
    theMap().emit("error", { error: new Error("layers[4].paint: unknown property") });

    expect(onStyleError).toHaveBeenCalledTimes(1);
    expect(onStyleError.mock.calls[0]?.[0].message).toContain("unknown property");
    // The plain style is not set from inside the reporting: MapLibre would drop the errors that are still to come on the floor.
    expect(theMap().styleCalls).toHaveLength(1);
    await waitFor(() => expect(theMap().styleCalls).toHaveLength(2));
    expect(theMap().styleCalls[1]?.style).toEqual({ version: 8, sources: {}, layers: [] });
    expect(region()).toHaveAttribute("data-map-state", "unavailable");
    theMap().emit("style.load"); // the plain style loads
    expect(region()).toHaveAttribute("data-map-state", "unavailable");
    expect(theMap().sources.size).toBe(Object.values(SOURCE_IDS).length);
  });

  test("MapView_calls_onStyleLoad_for_every_style_that_loads_but_not_for_the_plain_one_it_falls_back_to", async () => {
    goodStyle();
    const onStyleLoad = vi.fn<() => void>();
    const onStyleError = vi.fn<(error: Error) => void>();
    const { rerender } = render(view({ onStyleLoad, onStyleError }));
    await styleApplied();
    const map = theMap();
    expect(onStyleLoad).not.toHaveBeenCalled(); // the style is on its way

    map.emit("style.load");
    expect(onStyleLoad).toHaveBeenCalledTimes(1);

    // The other colour scheme's style: loaded again, and told again.
    map.setStyle({ version: 8, sources: {}, layers: [] }, { diff: false });
    map.emit("style.load");
    expect(onStyleLoad).toHaveBeenCalledTimes(2);

    // A style that MapLibre refuses is an error, and the plain style it falls back to is not a map that is available.
    rerender(view({ onStyleLoad, onStyleError, styleUrl: "/other.json" }));
    await styleApplied(3);
    map.emit("error", { error: new Error("layers[3].paint: unknown property") });
    await waitFor(() => expect(map.styleCalls).toHaveLength(4));
    map.emit("style.load");
    expect(onStyleError).toHaveBeenCalledTimes(1);
    expect(onStyleLoad).toHaveBeenCalledTimes(2);

    // A good one after that: told, so that whoever noted the failure can take the note back.
    rerender(view({ onStyleLoad, onStyleError, styleUrl: "/third.json" }));
    await styleApplied(5);
    map.emit("style.load");
    expect(onStyleLoad).toHaveBeenCalledTimes(3);
  });

  test("MapView_works_without_onStyleLoad", async () => {
    goodStyle();
    render(view());
    await styleApplied();

    expect(() => theMap().emit("style.load")).not.toThrow();
    expect(region()).toHaveAttribute("data-map-state", "ready");
  });

  test("MapView_leaves_map_errors_after_the_style_loaded_to_the_console", async () => {
    goodStyle();
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const onStyleError = vi.fn<(error: Error) => void>();
    render(view({ onStyleError }));
    await styleApplied();
    theMap().emit("style.load");

    const tileError = new Error("Failed to fetch tile");
    theMap().emit("error", { error: tileError });

    expect(onStyleError).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(tileError);
    expect(region()).toHaveAttribute("data-map-state", "ready");
  });

  test("MapView_reports_a_map_that_cannot_start_and_stays_rendered", async () => {
    goodStyle();
    FakeMap.failWith = new Error("Failed to initialize WebGL");
    const onStyleError = vi.fn<(error: Error) => void>();

    expect(() => render(view({ onStyleError }))).not.toThrow();

    await waitFor(() => expect(onStyleError).toHaveBeenCalledTimes(1));
    expect(onStyleError.mock.calls[0]?.[0].message).toBe("Failed to initialize WebGL");
    expect(region()).toHaveAttribute("data-map-state", "unavailable");
    expect(screen.getByRole("button", { name: "Recenter map" })).toBeInTheDocument();
  });

  test("MapView_creates_one_map_under_StrictMode_and_removes_it_on_unmount", async () => {
    // The first mount of StrictMode is torn down at once, before MapLibre has arrived: no map is made for it, and the style is asked for
    // once, by the map that is made.
    const signals: AbortSignal[] = [];
    stubFetch((_url, init) => {
      signals.push(init!.signal!);
      return new Promise<Response>((resolve, reject) => {
        init!.signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        setTimeout(() => resolve(Response.json(STYLE)), 5);
      });
    });
    const onStyleError = vi.fn<(error: Error) => void>();

    const { unmount } = render(<StrictMode>{view({ onStyleError })}</StrictMode>);

    const map = await mapUp();
    await styleApplied();
    expect(FakeMap.instances).toEqual([map]);
    expect(signals.map((signal) => signal.aborted)).toEqual([false]);
    unmount();

    expect(map.removed).toBe(true);
    expect(liveMaps()).toHaveLength(0);
    expect(map.listenerCount("style.load")).toBe(0);
    expect(map.listenerCount("error")).toBe(0);
    expect(onStyleError).not.toHaveBeenCalled();
  });

  test("MapView_aborts_the_style_request_and_stays_quiet_when_unmounted_while_it_fails", async () => {
    let fail: (reason: unknown) => void = () => undefined;
    stubFetch((_url, init) => new Promise<Response>((_resolve, reject) => {
      fail = reject;
      init!.signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    }));
    const onStyleError = vi.fn<(error: Error) => void>();
    const { unmount } = render(view({ onStyleError }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const map = theMap();

    unmount();
    fail(new TypeError("Failed to fetch")); // too late: nobody is interested any more
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(onStyleError).not.toHaveBeenCalled();
    expect(map.styleCalls).toHaveLength(0);
  });

  test("MapView_creates_the_map_with_compact_attribution_and_a_north_up_view", async () => {
    goodStyle();

    render(view());

    const { options, rotationDisabled } = await mapUp();
    expect(options["container"]).toBeInstanceOf(HTMLElement);
    expect(region()).toContainElement(options["container"] as HTMLElement);
    expect(options["attributionControl"]).toMatchObject({ compact: true });
    expect(JSON.stringify(options["attributionControl"])).toContain("OpenStreetMap");
    expect(options["dragRotate"]).toBe(false);
    expect(options["maxPitch"]).toBe(0);
    expect(rotationDisabled).toBe(true);
  });

  // MapLibre opens the compact credit and folds it only when the map is dragged. The app folds it sooner, once for each map: five seconds
  // after the map has its first style (the credit is made from the style's sources, so that is when it appears) or at once when the user
  // first zooms or taps the map, and never for the app's own moves. It folds as MapLibre's drag does, by taking away the class that has it
  // open, so that the ⓘ button of MapLibre still shows it again (the fake map's button toggles the class, as MapLibre's does).
  describe("the credit", () => {
    const OPEN = "maplibregl-compact-show";

    afterEach(() => {
      vi.useRealTimers();
    });

    /** The map, up, with its first style loaded, on fake timers from there on: the five seconds are counted from that. */
    async function appeared(props: Partial<MapViewProps> = {}) {
      goodStyle();
      const rendered = render(view(props));
      const map = await mapUp();
      await styleApplied();
      vi.useFakeTimers();
      map.emit("style.load");
      return { map, ...rendered };
    }

    /** What MapLibre fires when the user moves the map: the event of the pointer, wheel or keyboard is in `originalEvent`. A zoom is a move too. */
    const userZoom = (map: InstanceType<typeof FakeMap>, type: string): void => {
      const originalEvent = new Event(type);
      map.emit("movestart", { originalEvent });
      map.emit("zoomstart", { originalEvent });
    };

    test("MapView_opens_the_credit_when_the_map_appears_and_folds_it_five_seconds_after", async () => {
      goodStyle();
      render(view());
      const map = await mapUp();
      await styleApplied();
      vi.useFakeTimers();
      expect(map.credit).toHaveClass(OPEN);

      vi.advanceTimersByTime(60_000); // the style is still on its way: there is no credit to fold yet, and it is not folded before it was seen
      expect(map.credit).toHaveClass(OPEN);
      map.emit("style.load");
      vi.advanceTimersByTime(4_999);
      expect(map.credit).toHaveClass(OPEN);
      vi.advanceTimersByTime(1);

      expect(map.credit).not.toHaveClass(OPEN);
      expect(map.credit).toHaveClass("maplibregl-compact"); // still MapLibre's compact credit, with its ⓘ button to show it again
      expect(map.credit).toBeInTheDocument(); // folded, not taken away
    });

    test("MapView_counts_the_five_seconds_from_the_first_style_and_not_from_the_one_of_another_colour_scheme", async () => {
      const { map } = await appeared();

      vi.advanceTimersByTime(2_000);
      map.emit("style.load"); // a theme switch
      expect(vi.getTimerCount()).toBe(1);
      vi.advanceTimersByTime(2_999);
      expect(map.credit).toHaveClass(OPEN);
      vi.advanceTimersByTime(1);

      expect(map.credit).not.toHaveClass(OPEN);
    });

    test.each(["touchmove", "wheel", "dblclick"])("MapView_folds_the_credit_at_once_when_the_user_zooms_with_a_%s", async (type) => {
      const { map } = await appeared();
      vi.advanceTimersByTime(1_000);
      expect(map.credit).toHaveClass(OPEN);

      userZoom(map, type);

      expect(map.credit).not.toHaveClass(OPEN);
      expect(vi.getTimerCount()).toBe(0); // the five seconds are no longer waited for
      // Once for each map: a credit that ⓘ has opened again is not folded again, by the timer that was left or by the next zoom or tap.
      fireEvent.click(map.infoButton);
      expect(map.credit).toHaveClass(OPEN);
      userZoom(map, type);
      map.pointer("click", 200, 300);
      vi.advanceTimersByTime(60_000);
      expect(map.credit).toHaveClass(OPEN);
    });

    test("MapView_folds_the_credit_at_once_when_the_user_taps_the_map", async () => {
      const { map } = await appeared();
      vi.advanceTimersByTime(1_000);

      map.pointer("click", 200, 300);

      expect(map.credit).not.toHaveClass(OPEN);
      expect(vi.getTimerCount()).toBe(0);
      expect(map.listenerCount("click")).toBe(1); // the tap that opens a place is still listened for
      expect(map.listenerCount("movestart")).toBe(0);
      fireEvent.click(map.infoButton); // ⓘ opens it again
      expect(map.credit).toHaveClass(OPEN);
      vi.advanceTimersByTime(60_000);
      expect(map.credit).toHaveClass(OPEN);
    });

    test("MapView_does_not_fold_the_credit_for_a_move_of_its_own_but_for_the_five_seconds", async () => {
      const row: Feature<Point, object> = { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [10.7, 59.9] } };
      const { map } = await appeared({ fitTo: [row] });
      expect(map.fitCalls).toHaveLength(1);

      // What `fitBounds` makes MapLibre fire: no event of the user's behind any of them. The Recenter button is the app's own as well.
      for (const type of ["movestart", "zoomstart", "zoom", "zoomend", "moveend"]) map.emit(type, {});
      map.emit("movestart", { originalEvent: undefined });
      fireEvent.click(screen.getByRole("button", { name: "Recenter map" }));
      for (const type of ["movestart", "zoomstart", "zoom", "zoomend", "moveend"]) map.emit(type, {});

      expect(map.fitCalls).toHaveLength(2);
      expect(map.credit).toHaveClass(OPEN);
      vi.advanceTimersByTime(4_999);
      expect(map.credit).toHaveClass(OPEN);
      vi.advanceTimersByTime(1);
      expect(map.credit).not.toHaveClass(OPEN);
    });

    test("MapView_leaves_a_credit_open_that_the_user_closed_and_opened_again_with_its_button_in_the_first_five_seconds", async () => {
      const { map } = await appeared();
      vi.advanceTimersByTime(1_000);

      fireEvent.click(map.infoButton); // closes it: a tap on the button is no tap on the map, and the map's `click` does not hear of it
      expect(map.credit).not.toHaveClass(OPEN);
      vi.advanceTimersByTime(500);
      fireEvent.click(map.infoButton); // opens it again, with four seconds of the five still to go
      expect(map.credit).toHaveClass(OPEN);

      vi.advanceTimersByTime(4_000); // the five seconds are over
      expect(map.credit).toHaveClass(OPEN);
      vi.advanceTimersByTime(60_000);
      expect(map.credit).toHaveClass(OPEN);
      expect(map.listenerCount("movestart")).toBe(0);
      expect(map.listenerCount("click")).toBe(1); // the place tap's
    });

    /** A map whose style could not be had the first time (the network is down), on the plain style that it fell back to, loaded, on fake timers. */
    async function blankMap() {
      let seen = 0;
      stubFetch(() => (++seen === 1 ? Promise.reject(new TypeError("Failed to fetch")) : Response.json(STYLE))); // down, then not
      const handle = createRef<MapViewHandle>();
      const onStyleError = vi.fn<(error: Error) => void>();
      render(view({ ref: handle, onStyleError }));
      await waitFor(() => expect(onStyleError).toHaveBeenCalledTimes(1));
      await styleApplied();
      const map = theMap();
      expect(map.styleCalls[0]?.style).toEqual({ version: 8, sources: {}, layers: [] });
      vi.useFakeTimers();
      map.emit("style.load"); // the plain style loads: a blank map, with the credit on it
      return { map, handle };
    }

    /** Retry brings the real style, and the map that the credit is for appears when it has loaded. */
    async function realStyleLoads(map: InstanceType<typeof FakeMap>, handle: { current: MapViewHandle | null }): Promise<void> {
      vi.useRealTimers();
      act(() => handle.current!.retry());
      await waitFor(() => expect(map.styleCalls).toHaveLength(2));
      expect(map.styleCalls[1]?.style).not.toEqual({ version: 8, sources: {}, layers: [] });
      vi.useFakeTimers();
      map.emit("style.load");
    }

    test("MapView_does_not_count_the_credits_five_seconds_for_the_plain_style_of_a_failure_but_for_the_real_style_that_Retry_brings", async () => {
      const { map, handle } = await blankMap();

      vi.advanceTimersByTime(60_000);
      map.pointer("click", 200, 300); // a tap on the blank map
      userZoom(map, "wheel");
      expect(map.credit).toHaveClass(OPEN);
      expect(vi.getTimerCount()).toBe(0);

      await realStyleLoads(map, handle);

      expect(map.credit).toHaveClass(OPEN);
      vi.advanceTimersByTime(4_999);
      expect(map.credit).toHaveClass(OPEN);
      vi.advanceTimersByTime(1);
      expect(map.credit).not.toHaveClass(OPEN);
    });

    test("MapView_opens_the_credit_when_the_real_style_first_loads_though_a_drag_on_the_blank_map_had_folded_it", async () => {
      const { map, handle } = await blankMap();

      map.emit("drag", { originalEvent: new Event("mousemove") }); // MapLibre folds the credit on a drag, and never opens it again
      expect(map.credit).not.toHaveClass(OPEN);
      vi.advanceTimersByTime(60_000);
      expect(map.credit).not.toHaveClass(OPEN); // the blank map is left as the user has it

      await realStyleLoads(map, handle);

      expect(map.credit).toHaveClass(OPEN); // the map that it credits appears with it open...
      vi.advanceTimersByTime(4_999);
      expect(map.credit).toHaveClass(OPEN);
      vi.advanceTimersByTime(1);
      expect(map.credit).not.toHaveClass(OPEN); // ...and it folds five seconds after
    });

    test("MapView_opens_the_credit_and_its_details_when_the_real_style_first_loads_though_ⓘ_had_closed_it_on_the_blank_map", async () => {
      const { map, handle } = await blankMap();
      expect(map.credit).toHaveClass(OPEN);
      expect(map.credit).toHaveAttribute("open");

      fireEvent.click(map.infoButton); // ⓘ closes it for good: the class is gone, and so is the `open` of the <details>, which draws nothing closed
      expect(map.credit).not.toHaveClass(OPEN);
      expect(map.credit).not.toHaveAttribute("open");
      await realStyleLoads(map, handle);

      expect(map.credit).toHaveClass(OPEN);
      expect(map.credit).toHaveAttribute("open"); // not an empty box
      fireEvent.click(map.infoButton); // and ⓘ works as it does on any map: it closes what is open...
      expect(map.credit).not.toHaveClass(OPEN);
      expect(map.credit).not.toHaveAttribute("open");
      fireEvent.click(map.infoButton); // ...and opens what is closed
      expect(map.credit).toHaveClass(OPEN);
      expect(map.credit).toHaveAttribute("open");
    });

    test("MapView_does_not_open_the_credit_again_for_the_style_of_another_colour_scheme", async () => {
      const { map } = await appeared();
      vi.advanceTimersByTime(5_000); // folded
      expect(map.credit).not.toHaveClass(OPEN);

      map.emit("style.load"); // a theme switch

      expect(map.credit).not.toHaveClass(OPEN); // it is the user's from here on, as MapLibre has it
    });

    test("MapView_clears_the_timer_and_the_listeners_of_the_credit_when_the_map_is_removed", async () => {
      const { map, unmount } = await appeared();
      expect(vi.getTimerCount()).toBe(1);
      expect(map.listenerCount("movestart")).toBe(1);
      expect(map.listenerCount("click")).toBe(2); // the credit's, and the place tap's

      unmount();

      expect(map.removed).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      for (const type of ["style.load", "movestart", "click"]) expect(map.listenerCount(type), type).toBe(0);
    });

    test("MapView_folds_no_credit_of_a_map_that_is_removed_before_its_style_came", async () => {
      goodStyle();
      const { unmount } = render(view());
      const map = await mapUp();
      await styleApplied();
      vi.useFakeTimers();

      unmount();
      map.emit("style.load"); // too late: nobody is listening, and no timer is started

      expect(vi.getTimerCount()).toBe(0);
    });
  });

  test("MapView_loads_the_style_with_English_labels_and_without_diffing", async () => {
    const urls = goodStyle();

    render(view({ styleUrl: "/styles/liberty" }));
    await styleApplied();

    expect(urls).toEqual(["/styles/liberty"]);
    const { style, options } = theMap().styleCalls[0]!;
    expect(options).toEqual({ diff: false });
    expect((style as typeof STYLE).layers[0]?.layout["text-field"]).toEqual([
      "coalesce", ["get", "name:en"], ["get", "name_en"], ["get", "name:latin"], ["get", "name"],
    ]);
    expect(region()).toHaveAttribute("data-map-state", "loading");
  });

  test("MapView_adds_sources_and_layers_after_every_style_load_and_updates_with_setData", async () => {
    goodStyle();
    const first = routes(1);
    const { rerender } = render(view({ data: { routes: first } }));
    await styleApplied();
    const map = theMap();
    expect(map.sources.size).toBe(0); // nothing can be added before the style is there

    map.emit("style.load");

    expect([...map.sources.keys()].sort()).toEqual(Object.values(SOURCE_IDS).sort());
    expect(map.sources.get(SOURCE_IDS.routes)?.data).toBe(first);
    expect([...map.layers.keys()]).toEqual(Object.values(LAYER_IDS));
    expect(region()).toHaveAttribute("data-map-state", "ready");

    // New data goes in with setData, to the source it belongs to, and nothing is added a second time.
    const second = routes(2);
    rerender(view({ data: { routes: second } }));
    expect(map.sources.get(SOURCE_IDS.routes)?.data).toBe(second);
    expect(map.sources.get(SOURCE_IDS.routes)?.setDataCalls).toBe(1);
    for (const id of [SOURCE_IDS.stops, SOURCE_IDS.places, SOURCE_IDS.heat]) expect(map.sources.get(id)?.setDataCalls, id).toBe(0);

    // The same collections in a new object, as a parent that builds `data` in its render gives, is no change.
    rerender(view({ data: { routes: second } }));
    expect(map.sources.get(SOURCE_IDS.routes)?.setDataCalls).toBe(1);

    // Stops arrive, then go: the source is emptied, not left with the old pins.
    const pins = stops();
    rerender(view({ data: { routes: second, stops: pins } }));
    expect(map.sources.get(SOURCE_IDS.stops)?.data).toBe(pins);
    rerender(view({ data: { routes: second } }));
    expect((map.sources.get(SOURCE_IDS.stops)?.data as FeatureCollection<Point, unknown>).features).toEqual([]);

    // A theme switch loads another style: its sources and layers are gone, and come back with the latest data.
    map.setStyle({ version: 8, sources: {}, layers: [] }, { diff: false });
    expect(map.sources.size).toBe(0);
    map.emit("style.load");
    expect(map.sources.get(SOURCE_IDS.routes)?.data).toBe(second);
    expect(map.sources.get(SOURCE_IDS.routes)?.setDataCalls).toBe(0);
    expect([...map.layers.keys()]).toEqual(Object.values(LAYER_IDS));
  });

  test("MapView_keeps_the_latest_data_for_a_style_that_is_still_loading", async () => {
    goodStyle();
    const { rerender } = render(view());
    await styleApplied();
    const map = theMap();
    const latest = routes(9);

    rerender(view({ data: { routes: latest } })); // the style has not loaded: the map is not touched
    expect(map.sources.size).toBe(0);
    map.emit("style.load");

    expect(map.sources.get(SOURCE_IDS.routes)?.data).toBe(latest);
  });

  // Home is a house on its pin: an image that the map draws itself (an SDF, so that the layer colours it) and adds to every style, since a style has
  // no image of ours and a theme switch loads another.
  describe("the house image", () => {
    test("MapView_adds_the_house_image_on_every_style_load", async () => {
      const urls = goodStyle();
      render(view());
      await styleApplied();
      const map = theMap();
      expect(map.imageCalls).toEqual([]); // nothing can be added before the style is there

      map.emit("style.load");

      expect(map.imageCalls).toHaveLength(1);
      const [call] = map.imageCalls;
      expect(call?.id).toBe("sporer-home");
      expect([call?.image.width, call?.image.height]).toEqual([32, 32]);
      expect(call?.image.data).toHaveLength(32 * 32 * 4);
      expect(call?.options).toEqual({ sdf: true, pixelRatio: 2 });
      // It is there before a layer that draws it is added, so that the first frame has it.
      expect(map.additions.indexOf("image:sporer-home")).toBeLessThan(map.additions.indexOf(`layer:${LAYER_IDS.stopHome}`));

      // The style of the other colour scheme has none of it: it is added again, with the layers.
      map.setStyle({ version: 8, sources: {}, layers: [] }, { diff: false });
      expect(map.images.size).toBe(0);
      map.emit("style.load");
      expect(map.imageCalls).toHaveLength(2);
      expect(map.images.has("sporer-home")).toBe(true);
      expect(map.layers.has(LAYER_IDS.stopHome)).toBe(true);

      // And once more, to a style that has it already (a style that loads again, as it does when the context comes back): not a second time.
      map.emit("style.load");
      expect(map.imageCalls).toHaveLength(2);
      expect(urls).toEqual(["/style.json"]); // the icon is drawn here: no request is made for it
    });

    test("MapView_adds_the_house_image_to_the_plain_style_it_falls_back_to_and_to_the_one_it_puts_back", async () => {
      stubFetch(() => Promise.reject(new TypeError("Failed to fetch")));
      render(view());
      await styleApplied(); // the plain style, which draws the routes and the pins on the background
      const map = theMap();

      map.emit("style.load");

      expect(map.images.has("sporer-home")).toBe(true);
    });

    test("MapView_adds_the_layer_of_the_house_with_the_others", async () => {
      goodStyle();
      render(view({ data: { routes: EMPTY_ROUTES, stops: stops() } }));
      await styleApplied();
      const map = theMap();

      map.emit("style.load");

      expect(map.layers.get(LAYER_IDS.stopHome)).toMatchObject({ type: "symbol", source: SOURCE_IDS.stops, layout: { "icon-image": "sporer-home" } });
    });
  });

  test("MapView_shows_the_day_routes_when_there_are_stops_and_the_range_routes_when_there_are_not", async () => {
    goodStyle();
    const { rerender } = render(view());
    await styleApplied();
    const map = theMap();
    map.emit("style.load");
    const visibility = (id: string) => map.layers.get(id)?.layout?.visibility;

    expect([LAYER_IDS.rangeRoute, LAYER_IDS.rangeFlight].map(visibility)).toEqual(["visible", "visible"]);
    expect([LAYER_IDS.routeCasing, LAYER_IDS.dayRoute, LAYER_IDS.dayFlight].map(visibility)).toEqual(["none", "none", "none"]);

    rerender(view({ data: { routes: EMPTY_ROUTES, stops: stops() } }));

    expect([LAYER_IDS.rangeRoute, LAYER_IDS.rangeFlight].map(visibility)).toEqual(["none", "none"]);
    expect([LAYER_IDS.routeCasing, LAYER_IDS.dayRoute, LAYER_IDS.dayFlight].map(visibility)).toEqual(["visible", "visible", "visible"]);

    const calls = map.visibilityCalls.length;
    rerender(view({ data: { routes: routes(3), stops: stops() } })); // same kind of view: no layer is touched
    expect(map.visibilityCalls).toHaveLength(calls);
  });

  test("MapView_draws_the_cities_of_the_trips_with_no_route_layers_and_one_trip_with_the_bold_ones", async () => {
    goodStyle();
    const { rerender } = render(view());
    await styleApplied();
    const map = theMap();
    map.emit("style.load");
    const visibility = (id: string) => map.layers.get(id)?.layout?.visibility ?? "visible"; // a layer that says nothing is shown
    const day = [LAYER_IDS.routeCasing, LAYER_IDS.dayRoute, LAYER_IDS.dayFlight];
    const range = [LAYER_IDS.rangeRoute, LAYER_IDS.rangeFlight];
    const dots = { type: "FeatureCollection" as const, features: [{ type: "Feature" as const, properties: { id: 0, radius: 9, label: "Lisbon · 9 nights" }, geometry: { type: "Point" as const, coordinates: [-9.14, 38.72] as [number, number] } }] };

    // Dots with no stops are a period's, as they were: the faint routes.
    rerender(view({ data: { routes: EMPTY_ROUTES, places: dots } }));
    expect([...range, ...day].map(visibility)).toEqual(["visible", "visible", "none", "none", "none"]);

    // The trips say what they are, and the list draws no routes at all (it has none, and what is left of the range's must not show).
    rerender(view({ data: { routes: EMPTY_ROUTES, places: dots, view: "trips" } }));
    expect([...range, ...day].map(visibility)).toEqual(["none", "none", "none", "none", "none"]);
    expect([LAYER_IDS.places, LAYER_IDS.placeLabelsWest, LAYER_IDS.placeLabelsEast].map(visibility)).toEqual(["visible", "visible", "visible"]);
    expect(map.sources.get(SOURCE_IDS.places)?.data).toBe(dots);

    // A trip is drawn bold, as a day is, with its cities as dots.
    rerender(view({ data: { routes: routes(4), places: dots, view: "trip" } }));
    expect([...range, ...day].map(visibility)).toEqual(["none", "none", "visible", "visible", "visible"]);
    expect([LAYER_IDS.places, LAYER_IDS.placeLabelsWest, LAYER_IDS.placeLabelsEast].map(visibility)).toEqual(["visible", "visible", "visible"]);

    // And a day is a day again without the data having to say so.
    rerender(view({ data: { routes: EMPTY_ROUTES, stops: stops() } }));
    expect([...range, ...day].map(visibility)).toEqual(["none", "none", "visible", "visible", "visible"]);
  });

  test("MapView_keeps_the_route_layers_hidden_when_the_style_reloads_under_the_trips", async () => {
    // A theme switch (or a context that comes back) loads a style that has none of the layers: they are added again from the specs of the
    // view on show, and the list of trips, which draws no routes, must not find the range's faint ones drawn over it by that.
    goodStyle();
    const dots = { type: "FeatureCollection" as const, features: [{ type: "Feature" as const, properties: { id: 0, radius: 9, label: "Lisbon · 9 nights" }, geometry: { type: "Point" as const, coordinates: [-9.14, 38.72] as [number, number] } }] };
    render(view({ data: { routes: EMPTY_ROUTES, places: dots, view: "trips" } }));
    await styleApplied();
    const map = theMap();
    map.emit("style.load");
    const visibility = (id: string) => map.layers.get(id)?.layout?.visibility ?? "visible"; // a layer that says nothing is shown
    expect(ROUTE_LAYERS.map(visibility)).toEqual(["none", "none", "none", "none", "none"]);

    map.setStyle({ version: 8, sources: {}, layers: [] }, { diff: false }); // the style of the other colour scheme: no source, no layer
    expect(map.layers.size).toBe(0);
    map.emit("style.load");

    expect(ROUTE_LAYERS.map(visibility)).toEqual(["none", "none", "none", "none", "none"]); // added as the trips have them, not as the specs of a period
    expect([LAYER_IDS.places, LAYER_IDS.placeLabelsWest, LAYER_IDS.placeLabelsEast].map(visibility)).toEqual(["visible", "visible", "visible"]);
    expect(map.sources.get(SOURCE_IDS.places)?.data).toBe(dots);
  });

  test("MapView_stays_off_the_map_between_a_lost_WebGL_context_and_its_restored_style", async () => {
    goodStyle();
    const { rerender } = render(view());
    await styleApplied();
    const map = theMap();
    map.emit("style.load");

    map.contextLost = true; // MapLibre drops its style when the context goes; any call into it would throw
    map.emit("webglcontextlost");
    expect(() => rerender(view({ data: { routes: routes(4) } }))).not.toThrow();

    map.contextLost = false; // restored: MapLibre sets the style again, with the sources and layers it had
    map.emit("style.load");
    expect(map.sources.get(SOURCE_IDS.routes)).toBeDefined();
  });

  describe("MapLibre arriving later", () => {
    const FLIGHT: Feature<LineString, object> = {
      type: "Feature",
      properties: {},
      geometry: { type: "LineString", coordinates: [[10.5, 59.8], [10.9, 60.1]] },
    };
    const PADDING = { top: 120, right: 20, bottom: 300, left: 340 };

    test("MapView_shows_the_plain_background_until_MapLibre_has_arrived_and_makes_no_map_before", async () => {
      goodStyle();
      const slow = slowLoader();

      render(view({ loadMapLibre: slow.load }));

      expect(slow.load).toHaveBeenCalledTimes(1);
      expect(region()).toHaveAttribute("data-map-state", "loading");
      expect(screen.getByRole("button", { name: "Recenter map" })).toBeInTheDocument(); // the page around it is all there
      expect(FakeMap.instances).toHaveLength(0);
      expect(fetch).not.toHaveBeenCalled(); // no style is asked for before there is a map to give it to

      await slow.arrive();
      await styleApplied();
      expect(FakeMap.instances).toHaveLength(1);
      theMap().emit("style.load");
      expect(region()).toHaveAttribute("data-map-state", "ready");
    });

    test("MapView_applies_what_it_was_given_while_MapLibre_was_on_its_way_and_fits_once", async () => {
      goodStyle();
      const slow = slowLoader();
      const early = routes(1);
      const { rerender } = render(view({ loadMapLibre: slow.load, data: { routes: early }, fitTo: [FLIGHT], padding: PADDING }));

      // The day was polled and the sheet moved while the module was coming: only the latest of each is what counts.
      const latest = routes(2);
      const elsewhere: Feature<Point, object> = { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [-0.1, 51.5] } };
      const sheet = { ...PADDING, bottom: 500 };
      const target = [elsewhere];
      const day = { routes: latest, stops: stops() };
      rerender(view({ loadMapLibre: slow.load, data: day, fitTo: target, home: target, padding: sheet }));
      expect(FakeMap.instances).toHaveLength(0);

      await slow.arrive();
      const map = await mapUp();
      await styleApplied();

      // The camera: one fit, to the latest `fitTo`, with the padding of now.
      expect(map.fitCalls).toHaveLength(1);
      expect(map.fitCalls[0]?.bounds).toEqual([[-0.1, 51.5], [-0.1, 51.5]]);
      expect(map.fitCalls[0]?.options).toMatchObject({ padding: sheet });
      // The data: the latest, once the style has loaded, and as a day (it has stops).
      map.emit("style.load");
      expect(map.sources.get(SOURCE_IDS.routes)?.data).toBe(latest);
      expect((map.sources.get(SOURCE_IDS.stops)?.data as FeatureCollection<Point, unknown>).features).toHaveLength(1);
      expect(map.layers.get(LAYER_IDS.dayRoute)?.layout?.visibility).toBe("visible");
      // And Recenter goes to the latest `home`.
      fireEvent.click(screen.getByRole("button", { name: "Recenter map" }));
      expect(map.fitCalls).toHaveLength(2);
      expect(map.fitCalls[1]?.bounds).toEqual(boundsOf([elsewhere]));
      // Nothing is fitted again for being rendered again.
      rerender(view({ loadMapLibre: slow.load, data: day, fitTo: target, home: target, padding: sheet }));
      expect(map.fitCalls).toHaveLength(2);
    });

    test("MapView_makes_no_map_when_it_is_unmounted_before_MapLibre_arrives", async () => {
      goodStyle();
      const slow = slowLoader();
      const onStyleError = vi.fn<(error: Error) => void>();
      const { unmount } = render(view({ loadMapLibre: slow.load, onStyleError }));

      unmount();
      await slow.arrive();
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(FakeMap.instances).toHaveLength(0);
      expect(fetch).not.toHaveBeenCalled();
      expect(onStyleError).not.toHaveBeenCalled();
    });

    test("MapView_makes_one_map_for_one_arrival_under_StrictMode", async () => {
      goodStyle();
      const slow = slowLoader();

      render(<StrictMode>{view({ loadMapLibre: slow.load })}</StrictMode>);
      await slow.arrive();
      await mapUp();

      expect(FakeMap.instances).toHaveLength(1);
      expect(liveMaps()).toHaveLength(1);
    });

    test("MapView_reports_MapLibre_that_cannot_be_fetched_as_map_unavailable_once_and_stays_rendered", async () => {
      goodStyle();
      const slow = slowLoader();
      const onStyleError = vi.fn<(error: Error) => void>();
      const rejections: unknown[] = [];
      const onRejection = (event: PromiseRejectionEvent) => rejections.push(event.reason);
      window.addEventListener("unhandledrejection", onRejection);
      const { rerender } = render(view({ loadMapLibre: slow.load, onStyleError, fitTo: [FLIGHT] }));

      await slow.fail(new TypeError("Failed to fetch dynamically imported module: /assets/maplibre-abc.js"));

      expect(onStyleError).toHaveBeenCalledTimes(1);
      expect(onStyleError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
      expect(onStyleError.mock.calls[0]?.[0].message).toContain("dynamically imported module");
      expect(region()).toHaveAttribute("data-map-state", "unavailable");
      expect(screen.getByRole("button", { name: "Recenter map" })).toBeEnabled();
      // It stays a page: more data, another fit, a re-render, all of them go nowhere, quietly.
      expect(() => rerender(view({ loadMapLibre: slow.load, onStyleError, fitTo: [{ ...FLIGHT }], data: { routes: routes(3) } }))).not.toThrow();
      fireEvent.click(screen.getByRole("button", { name: "Recenter map" }));
      await new Promise((resolve) => setTimeout(resolve, 10));
      window.removeEventListener("unhandledrejection", onRejection);
      expect(FakeMap.instances).toHaveLength(0);
      expect(onStyleError).toHaveBeenCalledTimes(1);
      expect(rejections).toEqual([]);
      expect(fetch).not.toHaveBeenCalled();
    });

    test("MapView_reports_a_map_that_fails_while_it_is_set_up_and_gives_it_back", async () => {
      // Making the map is not the only thing that can throw: so can what follows it, and nobody is waiting on the promise to catch that.
      goodStyle();
      FakeMap.failRotation = new Error("Cannot set up the touch handlers");
      const onStyleError = vi.fn<(error: Error) => void>();
      const slow = slowLoader();
      render(view({ loadMapLibre: slow.load, onStyleError, fitTo: [FLIGHT] }));

      await slow.arrive();

      expect(onStyleError).toHaveBeenCalledTimes(1);
      expect(onStyleError.mock.calls[0]?.[0].message).toBe("Cannot set up the touch handlers");
      expect(region()).toHaveAttribute("data-map-state", "unavailable");
      expect(FakeMap.instances).toHaveLength(1);
      expect(FakeMap.instances[0]?.removed).toBe(true); // the one that was made is not kept
      expect(screen.getByRole("button", { name: "Recenter map" })).toBeEnabled();
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(onStyleError).toHaveBeenCalledTimes(1);
      expect(fetch).not.toHaveBeenCalled();
    });

    test("MapView_reports_a_loader_that_throws_instead_of_rejecting", async () => {
      goodStyle();
      const onStyleError = vi.fn<(error: Error) => void>();
      const throwing: MapLibreLoader = () => {
        throw new Error("No loader");
      };

      expect(() => render(view({ loadMapLibre: throwing, onStyleError }))).not.toThrow();

      await waitFor(() => expect(onStyleError).toHaveBeenCalledTimes(1));
      expect(onStyleError.mock.calls[0]?.[0].message).toBe("No loader");
      expect(region()).toHaveAttribute("data-map-state", "unavailable");
    });

    test("MapView_asks_for_the_style_that_is_the_latest_when_MapLibre_arrives", async () => {
      // The style was changed while MapLibre was on its way (another address): the first was never asked for, the second is.
      const urls = goodStyle();
      const slow = slowLoader();
      const { rerender } = render(view({ loadMapLibre: slow.load, styleUrl: "/styles/first" }));
      rerender(view({ loadMapLibre: slow.load, styleUrl: "/styles/second" }));
      expect(urls).toEqual([]);

      await slow.arrive();
      await styleApplied();

      expect(urls).toEqual(["/styles/second"]);
      expect(theMap().styleCalls).toHaveLength(1);
    });

    test("MapView_keeps_quiet_when_the_style_changes_after_MapLibre_failed", async () => {
      // No map to give a style to: a new style address is no reason to try again, to throw, or to report a second time.
      const urls = goodStyle();
      const slow = slowLoader();
      const onStyleError = vi.fn<(error: Error) => void>();
      const onStyleLoad = vi.fn<() => void>();
      const { rerender } = render(view({ loadMapLibre: slow.load, onStyleError, onStyleLoad, styleUrl: "/styles/first" }));
      await slow.fail(new TypeError("Failed to fetch dynamically imported module"));
      expect(onStyleError).toHaveBeenCalledTimes(1);

      expect(() => rerender(view({ loadMapLibre: slow.load, onStyleError, onStyleLoad, styleUrl: "/styles/second" }))).not.toThrow();
      expect(() => rerender(view({ loadMapLibre: slow.load, onStyleError, onStyleLoad, styleUrl: "/styles/first", data: { routes: routes(2) } }))).not.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(onStyleError).toHaveBeenCalledTimes(1);
      expect(onStyleLoad).not.toHaveBeenCalled();
      expect(slow.load).toHaveBeenCalledTimes(1); // not asked again, so no loop
      expect(urls).toEqual([]);
      expect(FakeMap.instances).toHaveLength(0);
      expect(region()).toHaveAttribute("data-map-state", "unavailable");
    });
  });

  // A home-screen app has no reload button, and a network blip (or a VPN that is still connecting when the app is opened) must not leave the
  // basemap blank until the owner kills it: what failed is tried again, once for each Retry and for each time the page comes back.
  describe("recovering from a failure", () => {
    /** Whether the page is on show, as the browser tells it; the test says when it comes back (`show`). */
    function stubPageVisibility(initial: "visible" | "hidden") {
      let state = initial;
      vi.spyOn(document, "visibilityState", "get").mockImplementation(() => state);
      return (next: "visible" | "hidden") => {
        state = next;
        act(() => void document.dispatchEvent(new Event("visibilitychange")));
      };
    }
    const comesOnline = () => act(() => void window.dispatchEvent(new Event("online")));
    const retryOf = (handle: { current: MapViewHandle | null }) => act(() => handle.current!.retry());
    /** Lets whatever a failed attempt would do next (a loop, say) happen, if it is going to. */
    const quietly = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 30)));

    /** Answers the first `failures` requests with a failure (the network is down), the ones after them with a style. */
    function flakyFetch(failures: number): string[] {
      let seen = 0;
      return stubFetch(() => (++seen <= failures ? Promise.reject(new TypeError("Failed to fetch")) : Response.json(STYLE)));
    }

    test("MapView_asks_the_loader_again_for_MapLibre_when_it_could_not_be_fetched_and_Retry_is_called", async () => {
      goodStyle();
      const handle = createRef<MapViewHandle>();
      const onStyleError = vi.fn<(error: Error) => void>();
      const onStyleLoad = vi.fn<() => void>();
      const slow = slowLoader();
      render(view({ ref: handle, loadMapLibre: slow.load, onStyleError, onStyleLoad }));
      await slow.fail(new TypeError("Failed to fetch dynamically imported module"));
      expect(onStyleError).toHaveBeenCalledTimes(1);
      expect(region()).toHaveAttribute("data-map-state", "unavailable");

      retryOf(handle);
      expect(slow.load).toHaveBeenCalledTimes(2);
      expect(region()).toHaveAttribute("data-map-state", "loading");
      await slow.arrive();
      await mapUp();
      await styleApplied();
      theMap().emit("style.load");

      expect(region()).toHaveAttribute("data-map-state", "ready");
      expect(onStyleLoad).toHaveBeenCalledTimes(1); // the app takes its note back
      expect(onStyleError).toHaveBeenCalledTimes(1);
      expect(FakeMap.instances).toHaveLength(1);
    });

    test("MapView_tries_a_map_that_could_not_start_again_on_Retry_and_reports_it_again_when_it_still_cannot", async () => {
      goodStyle();
      FakeMap.failWith = new Error("Failed to initialize WebGL");
      const handle = createRef<MapViewHandle>();
      const onStyleError = vi.fn<(error: Error) => void>();
      render(view({ ref: handle, onStyleError }));
      await waitFor(() => expect(onStyleError).toHaveBeenCalledTimes(1));

      retryOf(handle);
      await waitFor(() => expect(onStyleError).toHaveBeenCalledTimes(2)); // still no WebGL: told once more, for the one more attempt
      await quietly();
      expect(onStyleError).toHaveBeenCalledTimes(2); // and no attempt of its own after that

      FakeMap.failWith = null;
      retryOf(handle);
      await mapUp();
      await styleApplied();
      expect(FakeMap.instances).toHaveLength(1);
    });

    test("MapView_loads_the_style_again_when_it_could_not_be_had_and_Retry_is_called", async () => {
      const urls = flakyFetch(1);
      const handle = createRef<MapViewHandle>();
      const onStyleError = vi.fn<(error: Error) => void>();
      const onStyleLoad = vi.fn<() => void>();
      render(view({ ref: handle, onStyleError, onStyleLoad }));
      await waitFor(() => expect(onStyleError).toHaveBeenCalledTimes(1));
      await styleApplied();
      const map = theMap();
      map.emit("style.load"); // the plain style that it fell back to
      expect(onStyleLoad).not.toHaveBeenCalled();
      expect(region()).toHaveAttribute("data-map-state", "unavailable");

      retryOf(handle);
      await waitFor(() => expect(map.styleCalls).toHaveLength(2));
      expect(urls).toEqual(["/style.json", "/style.json"]);
      expect((map.styleCalls[1]?.style as typeof STYLE).layers[0]?.layout["text-field"]).toEqual(ENGLISH_LABEL); // the real style, with English labels
      map.emit("style.load");

      expect(region()).toHaveAttribute("data-map-state", "ready");
      expect(onStyleLoad).toHaveBeenCalledTimes(1);
      expect(onStyleError).toHaveBeenCalledTimes(1);
      expect(liveMaps()).toEqual([map]); // the same map: nothing is made again for a style
      expect([...map.sources.keys()].sort()).toEqual(Object.values(SOURCE_IDS).sort());
    });

    test("MapView_leaves_the_plain_style_alone_when_the_style_cannot_be_had_a_second_time", async () => {
      const urls = flakyFetch(2);
      const handle = createRef<MapViewHandle>();
      const onStyleError = vi.fn<(error: Error) => void>();
      const first = routes(1);
      const { rerender } = render(view({ ref: handle, onStyleError, data: { routes: first } }));
      await waitFor(() => expect(onStyleError).toHaveBeenCalledTimes(1));
      await styleApplied();
      const map = theMap();
      map.emit("style.load");

      retryOf(handle);
      await waitFor(() => expect(onStyleError).toHaveBeenCalledTimes(2));
      await quietly();

      expect(urls).toHaveLength(2);
      expect(map.styleCalls).toHaveLength(1); // the plain style is on the map, and is not set again
      expect(region()).toHaveAttribute("data-map-state", "unavailable");
      // And the map is not frozen: what arrives meanwhile is drawn on the plain style.
      const next = routes(2);
      rerender(view({ ref: handle, onStyleError, data: { routes: next } }));
      expect(map.sources.get(SOURCE_IDS.routes)?.data).toBe(next);
    });

    test("MapView_keeps_the_style_on_screen_when_the_one_of_the_new_colour_scheme_cannot_be_had", async () => {
      // The system goes dark with the network down: the map that works is not taken away for one that is blank.
      let darkWorks = false;
      const urls = stubFetch((url) => (url === "/styles/dark" && !darkWorks ? Promise.reject(new TypeError("Failed to fetch")) : Response.json({ ...STYLE, name: url })));
      const setScheme = stubColourScheme("light");
      const handle = createRef<MapViewHandle>();
      const onStyleError = vi.fn<(error: Error) => void>();
      const onStyleLoad = vi.fn<() => void>();
      const first = routes(1);
      const { rerender } = render(withConfig(clientWithConfig(), { ref: handle, onStyleError, onStyleLoad, data: { routes: first } }));
      await styleApplied(1);
      const map = theMap();
      map.emit("style.load");
      expect(onStyleLoad).toHaveBeenCalledTimes(1);

      setScheme("dark");
      await waitFor(() => expect(onStyleError).toHaveBeenCalledTimes(1));
      await quietly();

      expect(map.styleCalls).toHaveLength(1); // not the plain style: the light one stays
      expect(map.sources.size).toBe(Object.values(SOURCE_IDS).length);
      expect([...map.layers.keys()]).toEqual(Object.values(LAYER_IDS));
      expect(region()).toHaveAttribute("data-map-state", "unavailable"); // reported, so that a note with its Retry can be shown
      // It goes on working: data that comes meanwhile reaches the style that is there.
      const next = routes(2);
      rerender(withConfig(clientWithConfig(), { ref: handle, onStyleError, onStyleLoad, data: { routes: next } }));
      expect(map.sources.get(SOURCE_IDS.routes)?.data).toBe(next);

      darkWorks = true;
      retryOf(handle);
      await styleApplied(2);
      expect(urls.filter((url) => url === "/styles/dark")).toHaveLength(2);
      expect((map.styleCalls[1]?.style as { name: string }).name).toBe("/styles/dark");
      map.emit("style.load");
      expect(region()).toHaveAttribute("data-map-state", "ready");
      expect(onStyleLoad).toHaveBeenCalledTimes(2);
      expect(onStyleError).toHaveBeenCalledTimes(1);
    });

    test("MapView_puts_the_style_that_worked_back_when_MapLibre_refuses_the_one_of_the_new_colour_scheme", async () => {
      const urls = stubFetch((url) => Response.json({ ...STYLE, name: url }));
      const setScheme = stubColourScheme("light");
      const onStyleError = vi.fn<(error: Error) => void>();
      render(withConfig(clientWithConfig(), { onStyleError }));
      await styleApplied(1);
      const map = theMap();
      map.emit("style.load");
      const working = map.styleCalls[0]?.style;

      setScheme("dark");
      await styleApplied(2); // MapLibre has the dark style, which drops the light one, and finds that it will not take it
      map.emit("error", { error: new Error("layers[3].paint: unknown property") });

      await waitFor(() => expect(map.styleCalls).toHaveLength(3));
      expect(urls).toEqual(["/styles/liberty", "/styles/dark"]);
      expect(map.styleCalls[2]?.style).toBe(working); // the light style again, and not the blank one
      expect(map.styleCalls[2]?.options).toEqual({ diff: false });
      expect(onStyleError).toHaveBeenCalledTimes(1);
      map.emit("style.load");
      expect(region()).toHaveAttribute("data-map-state", "unavailable"); // still not the style that was asked for
      expect(map.sources.size).toBe(Object.values(SOURCE_IDS).length); // but it is drawn on
    });

    // The app says "Couldn't switch the map style" when a basemap is still drawn and only the switch failed, and "Map unavailable" when
    // there is none: the second argument of `onStyleError` tells which.
    describe("whether a basemap is kept", () => {
      type Told = (error: Error, basemapKept: boolean) => void;
      const kept = (onStyleError: { mock: { calls: Parameters<Told>[] } }) => onStyleError.mock.calls.map(([, basemapKept]) => basemapKept);

      test("MapView_says_there_is_no_basemap_when_the_first_style_cannot_be_had_or_MapLibre_or_the_map_cannot_start", async () => {
        flakyFetch(1);
        const first = vi.fn<Told>();
        const view1 = render(view({ onStyleError: first }));
        await waitFor(() => expect(first).toHaveBeenCalledTimes(1));
        expect(kept(first)).toEqual([false]);
        view1.unmount();

        goodStyle();
        const slow = slowLoader();
        const second = vi.fn<Told>();
        const view2 = render(view({ loadMapLibre: slow.load, onStyleError: second }));
        await slow.fail(new TypeError("Failed to fetch dynamically imported module"));
        expect(kept(second)).toEqual([false]);
        view2.unmount();

        FakeMap.failWith = new Error("Failed to initialize WebGL");
        const third = vi.fn<Told>();
        render(view({ onStyleError: third }));
        await waitFor(() => expect(third).toHaveBeenCalledTimes(1));
        expect(kept(third)).toEqual([false]);
      });

      test("MapView_says_a_basemap_is_kept_when_only_the_switch_to_the_other_colour_scheme_failed_and_when_it_fails_again", async () => {
        let darkWorks = false;
        stubFetch((url) => (url === "/styles/dark" && !darkWorks ? Promise.reject(new TypeError("Failed to fetch")) : Response.json({ ...STYLE, name: url })));
        const setScheme = stubColourScheme("light");
        const handle = createRef<MapViewHandle>();
        const onStyleError = vi.fn<Told>();
        render(withConfig(clientWithConfig(), { ref: handle, onStyleError }));
        await styleApplied(1);
        theMap().emit("style.load");

        setScheme("dark");
        await waitFor(() => expect(onStyleError).toHaveBeenCalledTimes(1));
        retryOf(handle); // and it still cannot
        await waitFor(() => expect(onStyleError).toHaveBeenCalledTimes(2));

        expect(kept(onStyleError)).toEqual([true, true]);
      });

      test("MapView_says_a_basemap_is_kept_when_MapLibre_refuses_the_style_of_the_other_colour_scheme_and_the_old_one_is_put_back", async () => {
        stubFetch((url) => Response.json({ ...STYLE, name: url }));
        const setScheme = stubColourScheme("light");
        const onStyleError = vi.fn<Told>();
        render(withConfig(clientWithConfig(), { onStyleError }));
        await styleApplied(1);
        theMap().emit("style.load");

        setScheme("dark");
        await styleApplied(2);
        theMap().emit("error", { error: new Error("layers[3].paint: unknown property") });

        expect(kept(onStyleError)).toEqual([true]);
      });

      test("MapView_says_there_is_still_no_basemap_when_the_first_style_failed_and_so_does_the_switch_after_it", async () => {
        stubFetch(() => Promise.reject(new TypeError("Failed to fetch")));
        const setScheme = stubColourScheme("light");
        const onStyleError = vi.fn<Told>();
        render(withConfig(clientWithConfig(), { onStyleError }));
        await waitFor(() => expect(onStyleError).toHaveBeenCalledTimes(1));
        await styleApplied(1);
        theMap().emit("style.load"); // the plain style: no map to speak of

        setScheme("dark");
        await waitFor(() => expect(onStyleError).toHaveBeenCalledTimes(2));

        expect(kept(onStyleError)).toEqual([false, false]);
      });

      test("MapView_says_a_basemap_is_kept_for_a_switch_that_fails_after_a_failed_first_style_was_put_right", async () => {
        let lightAsked = 0;
        stubFetch((url) => {
          if (url === "/styles/dark") return Promise.reject(new TypeError("Failed to fetch"));
          return ++lightAsked === 1 ? Promise.reject(new TypeError("Failed to fetch")) : Response.json({ ...STYLE, name: url });
        });
        const setScheme = stubColourScheme("light");
        const handle = createRef<MapViewHandle>();
        const onStyleError = vi.fn<Told>();
        render(withConfig(clientWithConfig(), { ref: handle, onStyleError }));
        await waitFor(() => expect(onStyleError).toHaveBeenCalledTimes(1)); // the first style: nothing to draw
        await styleApplied(1);
        theMap().emit("style.load"); // the plain style
        retryOf(handle);
        await styleApplied(2);
        theMap().emit("style.load"); // the light style, which is a basemap now

        setScheme("dark"); // and the dark one cannot be had
        await waitFor(() => expect(onStyleError).toHaveBeenCalledTimes(2));

        expect(kept(onStyleError)).toEqual([false, true]);
      });
    });

    test("MapView_retries_when_the_page_comes_back_into_view_but_only_while_something_has_failed_and_only_once", async () => {
      const urls = flakyFetch(2);
      const onStyleError = vi.fn<(error: Error) => void>();
      const show = stubPageVisibility("visible");
      render(view({ onStyleError }));
      await waitFor(() => expect(onStyleError).toHaveBeenCalledTimes(1));
      await styleApplied();

      show("hidden"); // the page going away is not a reason
      await quietly();
      expect(urls).toHaveLength(1);

      show("visible");
      await waitFor(() => expect(onStyleError).toHaveBeenCalledTimes(2)); // the second request fails too
      expect(urls).toHaveLength(2);
      await quietly();
      expect(urls).toHaveLength(2); // no attempt of its own: it waits for the next reason

      show("hidden");
      show("visible");
      await waitFor(() => expect(theMap().styleCalls).toHaveLength(2)); // the third request has the style
      expect(urls).toHaveLength(3);
      theMap().emit("style.load");
      expect(region()).toHaveAttribute("data-map-state", "ready");

      show("hidden");
      show("visible");
      comesOnline();
      await quietly();
      expect(urls).toHaveLength(3); // the map works: nothing is tried
    });

    test("MapView_retries_when_the_network_comes_back_and_the_two_reasons_at_once_make_one_attempt", async () => {
      const urls = flakyFetch(1);
      const onStyleError = vi.fn<(error: Error) => void>();
      const show = stubPageVisibility("visible");
      render(view({ onStyleError }));
      await waitFor(() => expect(onStyleError).toHaveBeenCalledTimes(1));
      await styleApplied();

      comesOnline(); // a phone that wakes up says both, one after the other
      show("visible");
      await waitFor(() => expect(theMap().styleCalls).toHaveLength(2));
      await quietly();

      expect(urls).toHaveLength(2);
    });

    test("MapView_retries_MapLibre_when_the_page_comes_back_or_the_network_does", async () => {
      goodStyle();
      const slow = slowLoader();
      const onStyleError = vi.fn<(error: Error) => void>();
      const show = stubPageVisibility("visible");
      render(view({ loadMapLibre: slow.load, onStyleError }));
      await slow.fail(new TypeError("Failed to fetch dynamically imported module"));

      comesOnline();
      expect(slow.load).toHaveBeenCalledTimes(2);
      await slow.fail(new TypeError("Failed to fetch dynamically imported module"));
      expect(onStyleError).toHaveBeenCalledTimes(2);
      await quietly();
      expect(slow.load).toHaveBeenCalledTimes(2); // no loop

      show("visible");
      expect(slow.load).toHaveBeenCalledTimes(3);
      await slow.arrive();
      await mapUp();
      expect(FakeMap.instances).toHaveLength(1);
    });

    test("MapView_does_nothing_on_Retry_or_on_events_when_nothing_has_failed", async () => {
      const urls = goodStyle();
      const handle = createRef<MapViewHandle>();
      const loader = vi.fn<MapLibreLoader>(async () => ({ MapLibreMap: FakeMap, setWorkerUrl: () => undefined, workerUrl: "/w.mjs" }) as unknown as MapLibreModule);
      const show = stubPageVisibility("visible");
      render(view({ ref: handle, loadMapLibre: loader }));
      await styleApplied();
      theMap().emit("style.load");

      retryOf(handle);
      show("visible");
      comesOnline();
      await quietly();

      expect(loader).toHaveBeenCalledTimes(1);
      expect(urls).toHaveLength(1);
      expect(theMap().styleCalls).toHaveLength(1);
      expect(region()).toHaveAttribute("data-map-state", "ready");
    });

    test("MapView_does_not_start_a_second_attempt_while_one_is_on_its_way", async () => {
      const slow = slowLoader();
      goodStyle();
      const handle = createRef<MapViewHandle>();
      render(view({ ref: handle, loadMapLibre: slow.load }));
      await slow.fail(new TypeError("Failed to fetch dynamically imported module"));

      retryOf(handle);
      retryOf(handle);
      comesOnline();

      expect(slow.load).toHaveBeenCalledTimes(2);
    });

    test("MapView_takes_the_config_again_when_that_is_what_failed_and_Retry_is_called", async () => {
      let configWorks = false;
      const urls = stubFetch((url) => {
        if (url !== "/api/config") return Response.json(STYLE);
        return configWorks ? Response.json({ mapStyleLight: "/styles/liberty", mapStyleDark: "/styles/dark" }) : new Response("{}", { status: 500 });
      });
      const handle = createRef<MapViewHandle>();
      const onStyleError = vi.fn<(error: Error) => void>();
      const onStyleLoad = vi.fn<() => void>();
      render(withConfig(new QueryClient({ defaultOptions: { queries: { retry: false } } }), { ref: handle, onStyleError, onStyleLoad }));
      await waitFor(() => expect(onStyleError).toHaveBeenCalledTimes(1));
      await styleApplied();
      theMap().emit("style.load"); // the plain style

      configWorks = true;
      retryOf(handle);
      await waitFor(() => expect(theMap().styleCalls).toHaveLength(2));
      theMap().emit("style.load");

      expect(urls).toEqual(["/api/config", "/api/config", "/styles/liberty"]);
      expect(region()).toHaveAttribute("data-map-state", "ready");
      expect(onStyleLoad).toHaveBeenCalledTimes(1);
      expect(onStyleError).toHaveBeenCalledTimes(1);
    });

    test("MapView_stops_listening_for_the_page_and_the_network_when_it_is_unmounted", async () => {
      const urls = flakyFetch(5);
      const onStyleError = vi.fn<(error: Error) => void>();
      const show = stubPageVisibility("visible");
      const { unmount } = render(view({ onStyleError }));
      await waitFor(() => expect(onStyleError).toHaveBeenCalledTimes(1));
      unmount();

      show("visible");
      comesOnline();
      await quietly();

      expect(urls).toHaveLength(1);
    });
  });

  // Spec 4.6: a place is reached by tapping it anywhere. A finger is wider than a dot (4 px at the least), so a tap or a click looks for a
  // dot or a pin in a box of 12 px round the point (`queryRenderedFeatures`), and the nearest one wins. MapLibre's own `click` is not
  // fired for the end of a drag, and a tap is a click to it; the pointer over what a click would open is the same look.
  describe("opening a place", () => {
    /** Something drawn on the map: the layer it is in, what MapLibre says of it (its properties), and the place that a tap on it opens (0: none). */
    interface Thing {
      layer: string;
      properties: Record<string, unknown>;
      place: number;
    }
    const DOT: Thing = { layer: LAYER_IDS.places, properties: { id: 7, radius: 9 }, place: 7 };
    const PIN: Thing = { layer: LAYER_IDS.stops, properties: { order: 2, label: "2 · 4", name: "Home", id: 301, placeId: 11 }, place: 11 };
    const NUMBER: Thing = { layer: LAYER_IDS.stopNumbers, properties: { order: 2, label: "2 · 4", name: "Home", id: 301, placeId: 11 }, place: 11 };
    const HOUSE: Thing = { layer: LAYER_IDS.stopHome, properties: { order: 0, label: "", name: "Home", id: 301, placeId: 11, home: true }, place: 11 };

    /** A map with its style loaded (its layers are there to be looked in), and `things` drawn where `at` says. */
    async function drawn(things: [Thing, [number, number]][], props: Partial<MapViewProps> = {}) {
      goodStyle();
      const view_ = render(view(props));
      const map = await mapUp();
      await styleApplied();
      map.emit("style.load");
      for (const [{ layer, properties }, at] of things) map.drawn.push({ layerId: layer, properties, at });
      return { map, ...view_ };
    }

    test.each([
      ["a_dot_of_a_period", DOT],
      ["a_pin_of_a_day", PIN],
      ["the_number_on_a_pin", NUMBER],
      ["the_house_on_a_pin", HOUSE],
    ])("MapView_calls_onPlaceTap_with_the_place_when_%s_is_clicked", async (_name, thing) => {
      const onPlaceTap = vi.fn<(id: number) => void>();
      const { map } = await drawn([[thing, [200, 300]]], { onPlaceTap });

      map.pointer("click", 200, 300);

      expect(onPlaceTap).toHaveBeenCalledTimes(1);
      expect(onPlaceTap).toHaveBeenCalledWith(thing.place); // the place, and not the stay that the pin's `id` is
    });

    test("MapView_looks_for_dots_and_pins_in_a_box_of_12px_round_the_point_in_those_layers_only", async () => {
      const { map } = await drawn([]);

      map.pointer("click", 200, 300);

      expect(map.queries).toEqual([
        { box: [[188, 288], [212, 312]], layers: [LAYER_IDS.places, LAYER_IDS.stops, LAYER_IDS.stopHome, LAYER_IDS.stopNumbers] },
      ]);
    });

    test("MapView_opens_a_dot_that_a_finger_missed_by_10px_and_does_nothing_for_a_tap_farther_off", async () => {
      const onPlaceTap = vi.fn<(id: number) => void>();
      const { map } = await drawn([[DOT, [200, 300]]], { onPlaceTap });

      map.pointer("click", 208, 306); // 10 px away
      expect(onPlaceTap).toHaveBeenCalledTimes(1);
      expect(onPlaceTap).toHaveBeenLastCalledWith(7);

      map.pointer("click", 200, 313); // 13 px away: a tap on the map, which has nothing to open
      map.pointer("click", 225, 300);
      expect(onPlaceTap).toHaveBeenCalledTimes(1);
    });

    test("MapView_opens_the_nearer_of_two_places_when_a_tap_is_in_reach_of_both", async () => {
      const onPlaceTap = vi.fn<(id: number) => void>();
      const other: Thing = { ...DOT, properties: { id: 8, radius: 5 }, place: 8 };
      const { map } = await drawn([[DOT, [200, 300]], [other, [215, 300]]], { onPlaceTap });

      map.pointer("click", 212, 300); // 12 from one, 3 from the other
      expect(onPlaceTap).toHaveBeenLastCalledWith(8);
      map.pointer("click", 203, 300); // 3 from the first, 12 from the other
      expect(onPlaceTap).toHaveBeenLastCalledWith(7);
      map.pointer("click", 207, 302); // 7.3 and 8.2: the first, and not the one that is drawn on top or comes first in the answer
      expect(onPlaceTap).toHaveBeenLastCalledWith(7);
      expect(onPlaceTap).toHaveBeenCalledTimes(3);
    });

    test("MapView_picks_the_nearest_across_the_kinds_of_feature_and_by_the_position_of_the_place_not_by_the_edge_of_what_was_hit", async () => {
      // A big dot's edge is near, and its middle is far: the place whose middle is nearest is the one meant.
      const onPlaceTap = vi.fn<(id: number) => void>();
      const big: Thing = { ...DOT, properties: { id: 3, radius: 16 }, place: 3 };
      const { map } = await drawn([[big, [190, 300]], [PIN, [208, 300]]], { onPlaceTap });

      map.pointer("click", 200, 300); // 10 from the big dot's middle, 8 from the pin's

      expect(onPlaceTap).toHaveBeenCalledWith(11);
    });

    test("MapView_skips_a_feature_that_names_no_place_for_the_next_one_in_reach", async () => {
      const onPlaceTap = vi.fn<(id: number) => void>();
      const noPlace: Thing = { layer: LAYER_IDS.stops, properties: { order: 1, label: "1", name: null, id: 5 }, place: 0 }; // a pin that says no place
      const { map } = await drawn([[noPlace, [200, 300]], [DOT, [208, 300]]], { onPlaceTap });

      map.pointer("click", 201, 300);

      expect(onPlaceTap).toHaveBeenCalledTimes(1);
      expect(onPlaceTap).toHaveBeenCalledWith(7);
      map.drawn.splice(1, 1);
      map.pointer("click", 201, 300);
      expect(onPlaceTap).toHaveBeenCalledTimes(1); // and with none in reach there is nothing to open
    });

    // The dots of the trips' map are cities, which are no places: they are `id: 0`, and a tap on one opens nothing (and shows no pointer).
    const CITY: Thing = { layer: LAYER_IDS.places, properties: { id: 0, radius: 12, label: "Lisbon · 9 nights" }, place: 0 };

    test("MapView_city_dots_are_not_tappable", async () => {
      const onPlaceTap = vi.fn<(id: number) => void>();
      const { map } = await drawn([[CITY, [200, 300]]], { onPlaceTap });

      map.pointer("click", 200, 300); // right on it
      map.pointer("click", 208, 306); // and where a finger would have meant it

      expect(onPlaceTap).not.toHaveBeenCalled();
      map.pointer("mousemove", 200, 300);
      expect(map.canvas.style.cursor).toBe(""); // the ordinary cursor: a click here would do nothing
    });

    test("MapView_takes_no_dot_for_a_place_whose_id_is_below_1", async () => {
      const onPlaceTap = vi.fn<(id: number) => void>();
      const { map } = await drawn([[{ ...CITY, properties: { ...CITY.properties, id: -1 } }, [200, 300]]], { onPlaceTap });

      map.pointer("click", 200, 300);
      map.pointer("mousemove", 200, 300);

      expect(onPlaceTap).not.toHaveBeenCalled();
      expect(map.canvas.style.cursor).toBe("");
    });

    test("MapView_taps_the_place_next_to_a_city_dot_and_not_the_city", async () => {
      const onPlaceTap = vi.fn<(id: number) => void>();
      const { map } = await drawn([[CITY, [200, 300]], [DOT, [208, 300]]], { onPlaceTap }); // the city is the nearer one

      map.pointer("click", 201, 300);
      expect(onPlaceTap).toHaveBeenCalledTimes(1);
      expect(onPlaceTap).toHaveBeenCalledWith(7);
      map.pointer("mousemove", 201, 300);
      expect(map.canvas.style.cursor).toBe("pointer"); // for the place in reach, and for that one only

      map.drawn.splice(1, 1); // only the city is left in reach
      map.pointer("click", 201, 300);
      map.pointer("mousemove", 201, 300);
      expect(onPlaceTap).toHaveBeenCalledTimes(1);
      expect(map.canvas.style.cursor).toBe("");
    });

    test("MapView_does_nothing_for_a_click_where_there_is_nothing_in_the_box_or_only_other_layers", async () => {
      const onPlaceTap = vi.fn<(id: number) => void>();
      const { map } = await drawn([[{ layer: LAYER_IDS.dayRoute, properties: { id: 11, mode: "walk" }, place: 0 }, [200, 300]]], { onPlaceTap });

      map.pointer("click", 200, 300);
      map.pointer("click", 10, 10);

      expect(onPlaceTap).not.toHaveBeenCalled();
    });

    test("MapView_looks_in_no_layer_that_the_style_does_not_have_yet", async () => {
      // Before the style has loaded (or while another is on its way, or the context is lost) there are no layers: the real map reports an
      // error for each one that it is asked to look in, and a click must not make that.
      goodStyle();
      const onPlaceTap = vi.fn<(id: number) => void>();
      render(view({ onPlaceTap }));
      const map = await mapUp();
      await styleApplied();

      expect(() => map.pointer("click", 200, 300)).not.toThrow();
      expect(() => map.pointer("mousemove", 200, 300)).not.toThrow();

      expect(map.queries).toEqual([]);
      expect(onPlaceTap).not.toHaveBeenCalled();
    });

    test("MapView_calls_the_latest_onPlaceTap_and_copes_without_one", async () => {
      const first = vi.fn<(id: number) => void>();
      const second = vi.fn<(id: number) => void>();
      const { map, rerender } = await drawn([[DOT, [200, 300]]], { onPlaceTap: first });

      rerender(view({ onPlaceTap: second })); // a new function on each render of the parent is the usual
      map.pointer("click", 200, 300);
      expect(first).not.toHaveBeenCalled();
      expect(second).toHaveBeenCalledWith(7);

      rerender(view());
      expect(() => map.pointer("click", 200, 300)).not.toThrow();
      expect(map.listenerCount("click")).toBe(1); // one listener, whatever it is rendered with
    });

    test("MapView_shows_a_pointer_where_a_click_would_open_a_place_and_the_ordinary_cursor_elsewhere", async () => {
      const { map } = await drawn([[DOT, [200, 300]], [PIN, [400, 300]], [HOUSE, [600, 300]]]);
      expect(map.canvas.style.cursor).toBe("");

      map.pointer("mousemove", 205, 300);
      expect(map.canvas.style.cursor).toBe("pointer");
      map.pointer("mousemove", 207, 309); // 12 px off, as a click would still find it
      expect(map.canvas.style.cursor).toBe("pointer");
      map.pointer("mousemove", 300, 300);
      expect(map.canvas.style.cursor).toBe("");
      map.pointer("mousemove", 400, 305);
      expect(map.canvas.style.cursor).toBe("pointer");
      map.pointer("mousemove", 500, 300);
      expect(map.canvas.style.cursor).toBe("");
      map.pointer("mousemove", 603, 300); // the house on the pin of home, which is a place like the others
      expect(map.canvas.style.cursor).toBe("pointer");
      map.emit("mouseout"); // the pointer leaves the map
      expect(map.canvas.style.cursor).toBe("");
    });

    test("MapView_leaves_the_cursor_alone_over_a_feature_that_names_no_place", async () => {
      const noPlace: Thing = { layer: LAYER_IDS.stops, properties: { order: 1, label: "1", name: null, id: 5 }, place: 0 };
      const { map } = await drawn([[noPlace, [200, 300]]]);

      map.pointer("mousemove", 200, 300);

      expect(map.canvas.style.cursor).toBe("");
    });

    test("MapView_listens_for_taps_once_for_each_map_and_stops_when_it_is_gone", async () => {
      goodStyle();
      const onPlaceTap = vi.fn<(id: number) => void>();
      const { unmount } = render(<StrictMode>{view({ onPlaceTap })}</StrictMode>);
      const map = await mapUp();
      await styleApplied();
      map.emit("style.load"); // a style that loads (a theme switch too) is no reason to listen again: the listeners are the map's
      map.drawn.push({ layerId: DOT.layer, properties: DOT.properties, at: [200, 300] });

      expect(map.listenerCount("click")).toBe(2); // the place tap's, and the credit's (which folds it on the first tap, see "the credit")
      expect(map.listenerCount("mousemove")).toBe(1);
      expect(map.listenerCount("mouseout")).toBe(1);
      map.pointer("click", 200, 300);
      expect(onPlaceTap).toHaveBeenCalledTimes(1);

      unmount();

      for (const type of ["click", "mousemove", "mouseout"]) expect(map.listenerCount(type), type).toBe(0);
    });

    test("MapView_taps_open_places_also_when_the_map_is_made_after_the_data_arrived", async () => {
      goodStyle();
      const onPlaceTap = vi.fn<(id: number) => void>();
      const slow = slowLoader();
      render(view({ loadMapLibre: slow.load, onPlaceTap, data: { routes: EMPTY_ROUTES, stops: stops() } }));

      await slow.arrive();
      const map = await mapUp();
      await styleApplied();
      map.emit("style.load");
      map.drawn.push({ layerId: LAYER_IDS.stops, properties: { id: 5, placeId: 50 }, at: [200, 300] });
      map.pointer("click", 203, 303);

      expect(onPlaceTap).toHaveBeenCalledWith(50);
    });
  });

  describe("editing points", () => {
    /** The points of a day as the map is given them: with ids that are their indices, at the pixels of the screen that the double puts them at (`project` is the identity). */
    const pointsAt = (...at: [number, number][]): EditPointCollection => ({
      type: "FeatureCollection",
      features: at.map(([x, y], id) => ({ type: "Feature", id, properties: {}, geometry: { type: "Point", coordinates: [x, y] } })),
    });
    const edit = (over: Partial<MapEdit> = {}): MapEdit => ({
      selected: new Set<number>(),
      area: false,
      onAreaChange: vi.fn(),
      onToggle: vi.fn(),
      onSelect: vi.fn(),
      ...over,
    });
    const withData = (editPoints: EditPointCollection | undefined, over: Partial<MapViewProps> = {}): Partial<MapViewProps> => ({
      data: { routes: EMPTY_ROUTES, ...(editPoints === undefined ? {} : { editPoints }) },
      ...over,
    });
    /** Draws each point of `points` where it is (as the real map has them in its layer), for a tap to find. */
    const drawPoints = (map: InstanceType<typeof FakeMap>, points: EditPointCollection) => {
      for (const feature of points.features) map.drawn.push({ layerId: LAYER_IDS.editPoints, properties: {}, at: feature.geometry.coordinates as [number, number], id: feature.id });
    };
    const POINTS = pointsAt([100, 100], [140, 100], [100, 140], [300, 300]);

    /** A map with its style loaded, with `props`. */
    async function up(props: Partial<MapViewProps> = {}) {
      goodStyle();
      const rendered = render(view(props));
      const map = await mapUp();
      await styleApplied();
      map.emit("style.load");
      return { map, ...rendered };
    }

    test("MapView_gives_the_edit_points_to_their_source_in_one_setData_and_their_layer_is_over_the_routes_and_under_the_pins", async () => {
      const { map, rerender } = await up(withData(undefined, { edit: edit() }));
      const source = map.sources.get(SOURCE_IDS.editPoints)!;
      expect(source.data).toEqual({ type: "FeatureCollection", features: [] }); // an empty source: the layer is there, with nothing in it
      const layers = [...map.layers.keys()];
      for (const route of ROUTE_LAYERS) expect(layers.indexOf(route), route).toBeLessThan(layers.indexOf(LAYER_IDS.editPoints));
      expect(layers.indexOf(LAYER_IDS.editPoints)).toBeLessThan(layers.indexOf(LAYER_IDS.stops));

      const big = pointsAt(...Array.from({ length: 40_000 }, (_, i): [number, number] => [i % 400, Math.floor(i / 400)]));
      rerender(view(withData(big, { edit: edit() })));

      expect(source.data).toBe(big);
      expect(source.setDataCalls).toBe(1); // when the points load: one call for all of them
    });

    test("MapView_selects_by_feature_state_and_never_by_new_data", async () => {
      const { map, rerender } = await up(withData(POINTS, { edit: edit() }));
      const source = map.sources.get(SOURCE_IDS.editPoints)!;
      const setData = source.setDataCalls;
      expect(map.selectedIn(SOURCE_IDS.editPoints)).toEqual([]);

      rerender(view(withData(POINTS, { edit: edit({ selected: new Set([0, 2]) }) })));
      expect(map.selectedIn(SOURCE_IDS.editPoints)).toEqual([0, 2]);
      expect(map.stateCalls).toEqual(["set 0", "set 2"]);

      rerender(view(withData(POINTS, { edit: edit({ selected: new Set([2, 3]) }) })));
      expect(map.selectedIn(SOURCE_IDS.editPoints)).toEqual([2, 3]);
      expect(map.stateCalls).toEqual(["set 0", "set 2", "remove 0", "set 3"]); // only what changed: 2 was selected, and is not touched again

      rerender(view(withData(POINTS, { edit: edit({ selected: new Set() }) })));
      expect(map.selectedIn(SOURCE_IDS.editPoints)).toEqual([]);
      expect(source.setDataCalls).toBe(setData); // not one setData for any of it
    });

    test("MapView_does_not_touch_the_state_when_it_is_rendered_again_with_the_same_selection", async () => {
      const selected = new Set([1]);
      const { map, rerender } = await up(withData(POINTS, { edit: edit({ selected }) }));
      const calls = [...map.stateCalls];

      rerender(view(withData(POINTS, { edit: edit({ selected }) })));

      expect(map.stateCalls).toEqual(calls);
    });

    test("MapView_selects_the_points_of_a_dense_day_one_state_each_and_clears_them_when_edit_mode_ends", async () => {
      const dense = pointsAt(...Array.from({ length: 40_000 }, (_, i): [number, number] => [i % 400, Math.floor(i / 400)]));
      const all = new Set(Array.from({ length: 40_000 }, (_, i) => i));
      const { map, rerender } = await up(withData(dense, { edit: edit() }));

      rerender(view(withData(dense, { edit: edit({ selected: all }) })));
      expect(map.stateCalls).toHaveLength(40_000);
      expect(map.selectedIn(SOURCE_IDS.editPoints)).toHaveLength(40_000);

      rerender(view(withData(undefined))); // Done: no edit mode, no points

      expect(map.selectedIn(SOURCE_IDS.editPoints)).toEqual([]);
      expect(map.sources.get(SOURCE_IDS.editPoints)?.data).toEqual({ type: "FeatureCollection", features: [] });
    });

    test("MapView_sets_the_state_of_the_selection_again_when_a_style_has_loaded_for_a_style_has_none", async () => {
      const { map } = await up(withData(POINTS, { edit: edit({ selected: new Set([1, 3]) }) }));
      expect(map.selectedIn(SOURCE_IDS.editPoints)).toEqual([1, 3]);

      map.setStyle({}, {}); // the colour scheme changed: the new style has no source, no layer, no state
      expect(map.selectedIn(SOURCE_IDS.editPoints)).toEqual([]);
      map.emit("style.load");

      expect(map.sources.get(SOURCE_IDS.editPoints)?.data).toBe(POINTS); // the points came back with the style
      expect(map.selectedIn(SOURCE_IDS.editPoints)).toEqual([1, 3]); // and what was selected is still selected
      expect(map.layers.has(LAYER_IDS.editPoints)).toBe(true);
    });

    test("MapView_takes_the_state_off_when_the_points_are_other_points", async () => {
      // The ids are indices into the points: the same ids of another list are other points.
      const { map, rerender } = await up(withData(POINTS, { edit: edit({ selected: new Set([0, 1]) }) }));

      const other = pointsAt([10, 10], [20, 20]);
      rerender(view(withData(other, { edit: edit({ selected: new Set() }) })));

      expect(map.selectedIn(SOURCE_IDS.editPoints)).toEqual([]);
      expect(map.stateCalls).toContain("clear");
      expect(map.sources.get(SOURCE_IDS.editPoints)?.data).toBe(other);
    });

    test("MapView_selects_the_point_that_is_tapped_the_nearest_within_12px_and_opens_no_place", async () => {
      const onPlaceTap = vi.fn<(id: number) => void>();
      const onToggle = vi.fn<(id: number) => void>();
      const { map } = await up(withData(POINTS, { edit: edit({ onToggle }), onPlaceTap }));
      drawPoints(map, POINTS);
      map.drawn.push({ layerId: LAYER_IDS.places, properties: { id: 7, radius: 9 }, at: [101, 101] }); // a place right over a point

      map.pointer("click", 102, 101);

      expect(onToggle).toHaveBeenCalledTimes(1);
      expect(onToggle).toHaveBeenCalledWith(0);
      expect(onPlaceTap).not.toHaveBeenCalled(); // in edit mode a tap is for the points
    });

    test("MapView_looks_for_points_in_a_box_of_12px_round_the_tap_in_their_layer_only", async () => {
      const { map } = await up(withData(POINTS, { edit: edit() }));

      map.pointer("click", 200, 300);

      expect(map.queries).toEqual([{ box: [[188, 288], [212, 312]], layers: [LAYER_IDS.editPoints] }]);
    });

    test("MapView_picks_the_nearer_of_two_points_a_tap_is_between_and_nothing_for_a_tap_farther_off_than_12px", async () => {
      const onToggle = vi.fn<(id: number) => void>();
      const { map } = await up(withData(POINTS, { edit: edit({ onToggle }) }));
      drawPoints(map, POINTS);

      map.pointer("click", 128, 100); // between 0 (100) and 1 (140): 28 and 12 px
      expect(onToggle).toHaveBeenLastCalledWith(1);
      map.pointer("click", 118, 100); // 18 and 22 px: farther than the slop of both... the box finds none
      expect(onToggle).toHaveBeenCalledTimes(1);
      map.pointer("click", 109, 104); // 9 px and 5 px away: 0 is the nearer
      expect(onToggle).toHaveBeenLastCalledWith(0);
      map.pointer("click", 200, 200);
      expect(onToggle).toHaveBeenCalledTimes(2);
    });

    test("MapView_finds_a_point_by_its_id_and_measures_from_where_the_points_say_it_is_and_not_from_where_the_map_says_the_feature_is", async () => {
      // What MapLibre gives back of a feature is cut to its tile, and is a little off: the point is where the day's points say it is.
      const onToggle = vi.fn<(id: number) => void>();
      const { map } = await up(withData(POINTS, { edit: edit({ onToggle }) }));
      map.drawn.push({ layerId: LAYER_IDS.editPoints, properties: {}, at: [104, 100], id: 1 }); // the feature of point 1 is cut at 104: point 1 is at 140
      map.drawn.push({ layerId: LAYER_IDS.editPoints, properties: {}, at: [100, 100], id: 0 });
      map.drawn.push({ layerId: LAYER_IDS.editPoints, properties: {}, at: [101, 100], id: 99 }); // and one that the points have no id of is passed over

      map.pointer("click", 105, 100);

      expect(onToggle).toHaveBeenCalledTimes(1);
      expect(onToggle).toHaveBeenCalledWith(0); // 5 px from point 0, 35 from point 1: the geometry of the feature would have said 1
    });

    test("MapView_taps_nothing_in_edit_mode_before_there_are_points_and_before_the_style_has_the_layer", async () => {
      const onToggle = vi.fn<(id: number) => void>();
      const { map } = await up(withData(undefined, { edit: edit({ onToggle }) }));
      map.pointer("click", 100, 100); // no points yet
      map.layers.delete(LAYER_IDS.editPoints); // a style that has been replaced, whose layers are not there yet
      map.pointer("click", 100, 100);

      expect(onToggle).not.toHaveBeenCalled();
      expect(map.queries).toEqual([]);
    });

    test("MapView_opens_places_by_a_tap_as_ever_when_it_is_not_in_edit_mode_even_where_there_are_points", async () => {
      const onPlaceTap = vi.fn<(id: number) => void>();
      const { map } = await up(withData(POINTS, { onPlaceTap })); // no `edit`: points that were left in the data are not for tapping
      map.drawn.push({ layerId: LAYER_IDS.places, properties: { id: 7, radius: 9 }, at: [100, 100] });
      drawPoints(map, POINTS);

      map.pointer("click", 100, 100);

      expect(onPlaceTap).toHaveBeenCalledWith(7);
    });

    test("MapView_calls_the_latest_onToggle_and_goes_back_to_places_when_edit_mode_ends", async () => {
      const first = vi.fn<(id: number) => void>();
      const second = vi.fn<(id: number) => void>();
      const onPlaceTap = vi.fn<(id: number) => void>();
      const { map, rerender } = await up(withData(POINTS, { edit: edit({ onToggle: first }), onPlaceTap }));
      drawPoints(map, POINTS);
      map.drawn.push({ layerId: LAYER_IDS.places, properties: { id: 7, radius: 9 }, at: [300, 300] });

      rerender(view(withData(POINTS, { edit: edit({ onToggle: second }), onPlaceTap })));
      map.pointer("click", 100, 100);
      expect(first).not.toHaveBeenCalled();
      expect(second).toHaveBeenCalledWith(0);

      rerender(view(withData(POINTS, { onPlaceTap })));
      map.pointer("click", 300, 300);
      expect(onPlaceTap).toHaveBeenCalledWith(7);
    });

    test("MapView_shows_a_pointer_over_a_point_in_edit_mode_and_not_over_a_place", async () => {
      const { map } = await up(withData(POINTS, { edit: edit() }));
      drawPoints(map, POINTS);
      map.drawn.push({ layerId: LAYER_IDS.places, properties: { id: 7, radius: 9 }, at: [300, 200] });

      map.pointer("mousemove", 102, 100);
      expect(map.canvas.style.cursor).toBe("pointer");
      map.pointer("mousemove", 300, 200); // a place: a tap would not open it
      expect(map.canvas.style.cursor).toBe("");
      map.pointer("mousemove", 140, 104);
      expect(map.canvas.style.cursor).toBe("pointer");
      map.emit("mouseout");
      expect(map.canvas.style.cursor).toBe("");
    });

    test("MapView_turns_box_zoom_off_in_edit_mode_and_back_on_when_it_ends", async () => {
      const { map, rerender } = await up();
      expect(map.boxZoom.enabled).toBe(true);

      rerender(view({ edit: edit() }));
      expect(map.boxZoom.enabled).toBe(false);
      rerender(view({ edit: edit({ selected: new Set([1]) }) })); // rendered again: no second call
      expect(map.boxZoom.calls).toEqual(["disable"]);

      rerender(view());
      expect(map.boxZoom.enabled).toBe(true);
      expect(map.boxZoom.calls).toEqual(["disable", "enable"]);
    });

    test("MapView_leaves_box_zoom_off_after_edit_mode_when_it_was_off_before", async () => {
      const { map, rerender } = await up();
      map.boxZoom.enabled = false;

      rerender(view({ edit: edit() }));
      rerender(view());

      expect(map.boxZoom.enabled).toBe(false);
      expect(map.boxZoom.calls).toEqual(["disable"]); // as it was found
    });

    test("MapView_turns_double_tap_zoom_off_in_edit_mode_for_two_quick_taps_are_two_points_and_back_on_when_it_ends", async () => {
      const { map, rerender } = await up();
      expect(map.doubleClickZoom.enabled).toBe(true);

      rerender(view({ edit: edit() }));
      expect(map.doubleClickZoom.enabled).toBe(false);
      rerender(view({ edit: edit({ area: true }) }));
      expect(map.doubleClickZoom.calls).toEqual(["disable"]); // not again for another render

      rerender(view());
      expect(map.doubleClickZoom.enabled).toBe(true);
      expect(map.doubleClickZoom.calls).toEqual(["disable", "enable"]);
    });

    test("MapView_turns_panning_off_only_while_select_area_is_on_and_back_on_when_it_ends", async () => {
      const { map, rerender } = await up({ edit: edit() });
      expect(map.dragPan.enabled).toBe(true); // edit mode alone does not stop the map being moved

      rerender(view({ edit: edit({ area: true }) }));
      expect(map.dragPan.enabled).toBe(false);

      rerender(view({ edit: edit({ area: false }) }));
      expect(map.dragPan.enabled).toBe(true);

      rerender(view({ edit: edit({ area: true }) }));
      expect(map.dragPan.enabled).toBe(false);
      rerender(view()); // edit mode ends with select area on
      expect(map.dragPan.enabled).toBe(true);
      expect(map.boxZoom.enabled).toBe(true);
    });

    test("MapView_puts_both_gestures_back_when_the_map_goes_while_it_is_in_edit_mode", async () => {
      const { map, unmount } = await up({ edit: edit({ area: true }) });

      unmount();

      expect(map.boxZoom.enabled).toBe(true);
      expect(map.dragPan.enabled).toBe(true);
      expect(map.doubleClickZoom.enabled).toBe(true);
      expect(map.removed).toBe(true);
    });

    test("MapView_has_a_select_area_button_only_in_edit_mode_that_says_whether_it_is_on_and_asks_for_the_other", async () => {
      const onAreaChange = vi.fn<(on: boolean) => void>();
      goodStyle();
      const { rerender } = render(view());
      expect(screen.queryByRole("button", { name: "Select area" })).not.toBeInTheDocument();

      rerender(view({ edit: edit({ onAreaChange }) }));
      const button = screen.getByRole("button", { name: "Select area" });
      expect(button).toHaveAttribute("type", "button");
      expect(button).toHaveAttribute("aria-pressed", "false");
      fireEvent.click(button);
      expect(onAreaChange).toHaveBeenLastCalledWith(true);
      expect(button).toHaveAttribute("aria-pressed", "false"); // the parent holds the state

      rerender(view({ edit: edit({ onAreaChange, area: true }) }));
      expect(button).toHaveAttribute("aria-pressed", "true");
      fireEvent.click(button);
      expect(onAreaChange).toHaveBeenLastCalledWith(false);

      rerender(view());
      expect(screen.queryByRole("button", { name: "Select area" })).not.toBeInTheDocument();
    });

    test("MapView_has_the_select_area_button_in_the_group_of_the_map_buttons_like_the_heat_button", () => {
      goodStyle();
      render(view({ edit: edit(), heatToggle: { on: false, onChange: () => undefined } }));

      const group = screen.getByRole("button", { name: "Recenter map" }).parentElement;
      expect(screen.getByRole("button", { name: "Select area" }).parentElement).toBe(group);
      expect(screen.getByRole("button", { name: "Select area" })).toHaveClass("button");
    });

    test("MapView_selects_every_point_inside_a_rectangle_that_is_drawn_with_select_area_on", async () => {
      const onSelect = vi.fn<(ids: readonly number[]) => void>();
      const onToggle = vi.fn<(id: number) => void>();
      const { container } = await up(withData(POINTS, { edit: edit({ area: true, onSelect, onToggle }) }));
      const surface = container.querySelector(".surface")!;
      expect(surface).not.toBeNull();

      fireEvent.pointerDown(surface, { clientX: 90, clientY: 90, pointerId: 1, isPrimary: true, pointerType: "touch" });
      fireEvent.pointerMove(surface, { clientX: 150, clientY: 150, pointerId: 1, isPrimary: true, pointerType: "touch" });
      fireEvent.pointerUp(surface, { clientX: 150, clientY: 150, pointerId: 1, isPrimary: true, pointerType: "touch" });

      expect(onSelect).toHaveBeenCalledTimes(1);
      expect(onSelect).toHaveBeenCalledWith([0, 1, 2]); // (100, 100), (140, 100) and (100, 140) are inside; (300, 300) is not
      expect(onToggle).not.toHaveBeenCalled();
    });

    test("MapView_takes_the_edges_of_a_rectangle_as_inside_and_finds_the_points_of_a_box_with_none", async () => {
      const onSelect = vi.fn<(ids: readonly number[]) => void>();
      const { container } = await up(withData(POINTS, { edit: edit({ area: true, onSelect }) }));
      const surface = container.querySelector(".surface")!;
      const drag = (from: [number, number], to: [number, number]) => {
        const at = (point: [number, number]) => ({ clientX: point[0], clientY: point[1], pointerId: 1, isPrimary: true, pointerType: "touch" });
        fireEvent.pointerDown(surface, at(from));
        fireEvent.pointerMove(surface, at(to));
        fireEvent.pointerUp(surface, at(to));
      };

      drag([100, 100], [140, 140]); // the points are on its edges and at its corner: 0 and 1 on the top, 2 on the left
      expect(onSelect).toHaveBeenLastCalledWith([0, 1, 2]);

      drag([400, 400], [500, 500]); // none
      expect(onSelect).toHaveBeenLastCalledWith([]);
    });

    test("MapView_selects_a_point_for_a_tap_on_the_surface_of_select_area_for_the_map_under_it_never_saw_it", async () => {
      const onToggle = vi.fn<(id: number) => void>();
      const { map, container } = await up(withData(POINTS, { edit: edit({ area: true, onToggle }) }));
      drawPoints(map, POINTS);
      const surface = container.querySelector(".surface")!;

      fireEvent.pointerDown(surface, { clientX: 142, clientY: 99, pointerId: 1, isPrimary: true, pointerType: "touch" });
      fireEvent.pointerUp(surface, { clientX: 142, clientY: 99, pointerId: 1, isPrimary: true, pointerType: "touch" });

      expect(onToggle).toHaveBeenCalledWith(1);
    });

    test("MapView_has_no_surface_for_select_area_while_it_is_off_and_the_shift_drag_of_a_mouse_still_selects", async () => {
      const onSelect = vi.fn<(ids: readonly number[]) => void>();
      const { container } = await up(withData(POINTS, { edit: edit({ onSelect }) }));
      expect(container.querySelector(".surface")).toBeNull();

      fireEvent.mouseDown(region().querySelector("canvas") ?? region(), { clientX: 90, clientY: 90, button: 0, shiftKey: true });
      fireEvent.mouseMove(window, { clientX: 150, clientY: 150, shiftKey: true });
      fireEvent.mouseUp(window, { clientX: 150, clientY: 150, shiftKey: true });

      expect(onSelect).toHaveBeenCalledWith([0, 1, 2]);
    });

    test("MapView_has_no_area_selection_outside_edit_mode", async () => {
      const { container } = await up(withData(POINTS));

      expect(container.querySelector(".surface")).toBeNull();
      expect(container.querySelector(".layer")).toBeNull();
    });
  });

  describe("heat", () => {
    const toggle = (on: boolean, onChange: (on: boolean) => void = () => undefined) => ({ on, onChange });
    const opacityOf = (map: InstanceType<typeof FakeMap>, id: string) => map.layers.get(id)?.paint?.["line-opacity"];

    test("MapView_has_a_heat_button_only_when_the_parent_says_heat_is_available", () => {
      goodStyle();
      const { rerender } = render(view());
      expect(screen.queryByRole("button", { name: "Heat map" })).not.toBeInTheDocument();

      rerender(view({ heatToggle: toggle(false) }));
      expect(screen.getByRole("button", { name: "Heat map" })).toBeInTheDocument();

      rerender(view()); // a place has no period to show the heat of: the button goes
      expect(screen.queryByRole("button", { name: "Heat map" })).not.toBeInTheDocument();
    });

    test("MapView_heat_button_says_whether_heat_is_on_and_asks_for_the_other_when_pressed", () => {
      goodStyle();
      const onChange = vi.fn<(on: boolean) => void>();
      const { rerender } = render(view({ heatToggle: toggle(false, onChange) }));
      const button = screen.getByRole("button", { name: "Heat map" });
      expect(button).toHaveAttribute("type", "button");
      expect(button).toHaveAttribute("aria-pressed", "false");

      fireEvent.click(button);
      expect(onChange).toHaveBeenLastCalledWith(true);
      expect(button).toHaveAttribute("aria-pressed", "false"); // the parent holds the state: it is on when the parent says so

      rerender(view({ heatToggle: toggle(true, onChange) }));
      expect(button).toHaveAttribute("aria-pressed", "true");
      fireEvent.click(button);
      expect(onChange).toHaveBeenLastCalledWith(false);
      expect(onChange).toHaveBeenCalledTimes(2);
    });

    test("MapView_heat_button_sits_with_the_recenter_button_inside_what_is_left_of_the_map", () => {
      // The one group of buttons is what the style sheet insets by the padding: a button of the group is not under the sheet or the bar.
      goodStyle();
      render(view({ heatToggle: toggle(false), padding: { top: 120, right: 20, bottom: 300, left: 340 } }));

      const group = screen.getByRole("button", { name: "Recenter map" }).parentElement;
      expect(screen.getByRole("button", { name: "Heat map" }).parentElement).toBe(group);
      expect(region().contains(group)).toBe(true);
    });

    test("MapView_gives_the_heat_to_its_source_and_fades_the_routes_to_a_fifth_without_making_the_layers_again", async () => {
      goodStyle();
      const data = { routes: routes(1) };
      const { rerender } = render(view({ data }));
      await styleApplied();
      const map = theMap();
      map.emit("style.load");
      const layers = new Map(map.layers); // the layers as they are, to be told if one is made again
      expect(ROUTE_LAYERS.map((id) => opacityOf(map, id))).toEqual([undefined, undefined, undefined, 0.35, 0.35]); // as the specs have them
      expect(map.paintCalls).toEqual([]);

      const heat = heatCells(1, 0.5);
      rerender(view({ data: { ...data, heat } }));

      expect(map.sources.get(SOURCE_IDS.heat)?.data).toBe(heat);
      expect(map.paintCalls).toEqual(ROUTE_LAYERS.map((id) => [id, "line-opacity", 0.2]));
      expect(ROUTE_LAYERS.map((id) => opacityOf(map, id))).toEqual([0.2, 0.2, 0.2, 0.2, 0.2]); // the routes of the other view too
      expect(opacityOf(map, LAYER_IDS.places)).toBeUndefined(); // only routes fade: the dots and pins stay as they are
      expect(map.layers.size).toBe(layers.size);
      for (const [id, layer] of layers) expect(map.layers.get(id), id).toBe(layer);

      // A new heat (another period) is new data for the source, and the routes are not touched again.
      const other = heatCells(1);
      rerender(view({ data: { ...data, heat: other } }));
      expect(map.sources.get(SOURCE_IDS.heat)?.data).toBe(other);
      expect(map.paintCalls).toHaveLength(ROUTE_LAYERS.length);

      // Heat gone: the routes are as they were, and the heat source is emptied.
      rerender(view({ data }));
      expect(ROUTE_LAYERS.map((id) => opacityOf(map, id))).toEqual(ROUTE_LAYERS.map((id) => routeOpacity(id, false)));
      expect((map.sources.get(SOURCE_IDS.heat)?.data as HeatCollection).features).toEqual([]);
      expect(map.layers.size).toBe(layers.size);
    });

    test("MapView_leaves_the_routes_alone_for_a_heat_with_no_cell_in_it", async () => {
      // Nothing glows, so nothing is behind the routes to let through: they stay as they are.
      goodStyle();
      const data = { routes: routes(1) };
      const { rerender } = render(view({ data }));
      await styleApplied();
      const map = theMap();
      map.emit("style.load");

      rerender(view({ data: { ...data, heat: { type: "FeatureCollection", features: [] } } }));

      expect(map.paintCalls).toEqual([]);
    });

    test("MapView_fades_the_routes_of_a_style_that_loads_while_heat_is_on", async () => {
      // A theme switch loads another style, whose layers have the routes as the specs say; the heat is still on.
      goodStyle();
      const data = { routes: routes(1), heat: heatCells() };
      render(view({ data }));
      await styleApplied();
      const map = theMap();
      map.emit("style.load");
      expect(ROUTE_LAYERS.map((id) => opacityOf(map, id))).toEqual([0.2, 0.2, 0.2, 0.2, 0.2]); // a style that loads with the heat given

      map.setStyle({ version: 8, sources: {}, layers: [] }, { diff: false });
      map.emit("style.load");

      expect(ROUTE_LAYERS.map((id) => opacityOf(map, id))).toEqual([0.2, 0.2, 0.2, 0.2, 0.2]);
      expect(map.layers.get(LAYER_IDS.heat)).toBeDefined();
    });
  });

  describe("camera", () => {
    const flight: Feature<LineString, object> = {
      type: "Feature",
      properties: {},
      geometry: { type: "LineString", coordinates: [[10.5, 59.8], [10.9, 60.1]] },
    };
    const PADDING = { top: 120, right: 20, bottom: 300, left: 340 };

    test("MapView_fits_to_the_features_with_padding", async () => {
      goodStyle();

      render(view({ fitTo: [flight], padding: PADDING }));

      const map = await mapUp();
      expect(map.fitCalls).toHaveLength(1);
      expect(map.fitCalls[0]?.bounds).toEqual([[10.5, 59.8], [10.9, 60.1]]);
      expect(map.fitCalls[0]?.options).toMatchObject({ padding: PADDING });
      expect(map.fitCalls[0]?.options["duration"]).toBeGreaterThan(0); // animated
      expect(map.fitCalls[0]?.options["maxZoom"]).toBeLessThanOrEqual(18); // one point does not zoom in to the street
    });

    test("MapView_fits_again_for_every_new_fitTo_even_when_it_is_the_same_box_and_not_for_the_same_object", async () => {
      goodStyle();
      const home = [flight];
      const { rerender } = render(view({ fitTo: home, padding: PADDING }));
      const map = await mapUp();
      expect(map.fitCalls).toHaveLength(1);

      // The same array again (the parent rendered for another reason): the map is where the owner left it.
      rerender(view({ fitTo: home, padding: PADDING }));
      rerender(view({ fitTo: home, padding: { ...PADDING, bottom: 500 } })); // nor does padding, such as a sheet changing its height
      expect(map.fitCalls).toHaveLength(1);

      // Another day with the same box (two days spent at home), or a row of the timeline tapped a second time: the owner has
      // panned away since, and is brought back.
      const sameBox = [{ ...flight }];
      rerender(view({ fitTo: sameBox, padding: { ...PADDING, bottom: 500 } }));
      expect(map.fitCalls).toHaveLength(2);
      expect(map.fitCalls[1]?.bounds).toEqual(map.fitCalls[0]?.bounds);
      expect(map.fitCalls[1]?.options).toMatchObject({ padding: { ...PADDING, bottom: 500 } }); // with the padding as it is now

      // And somewhere else, of course.
      const elsewhere: Feature<Point, object> = { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [-0.1, 51.5] } };
      rerender(view({ fitTo: [elsewhere], padding: { ...PADDING, bottom: 500 } }));
      expect(map.fitCalls).toHaveLength(3);
      expect(map.fitCalls[2]?.bounds).toEqual([[-0.1, 51.5], [-0.1, 51.5]]);
    });

    // A label points toward the inside of the drawing (the layers say which side of it a dot is on), so that the dots at the edges of the fit have
    // their names on the screen: all that the fit leaves at the sides is room for the dots themselves, their radius and their outline (and for no
    // other reason: the controls are set in by the padding itself, which does not change).
    describe("room for the labels", () => {
      const LABEL_AIR = 24;
      const dot = (label: string | undefined, lon: number): Feature<Point, object> => ({
        type: "Feature",
        properties: label === undefined ? { id: 1, radius: 8 } : { id: 1, radius: 8, label },
        geometry: { type: "Point", coordinates: [lon, 59.9] },
      });
      const dots = (...features: Feature<Point, object>[]) => ({ type: "FeatureCollection" as const, features }) as unknown as MapData["places"];
      const labelled = dots(dot("Lisbon · 4 nights", -9.14), dot(undefined, 12.57));
      const AIRY = { ...PADDING, left: PADDING.left + LABEL_AIR, right: PADDING.right + LABEL_AIR };

      test("MapView_fits_with_air_at_the_sides_when_a_dot_has_a_label", async () => {
        goodStyle();
        const places = labelled;

        render(view({ data: { routes: EMPTY_ROUTES, places, view: "trips" }, fitTo: places!.features, padding: PADDING }));

        const map = await mapUp();
        expect(map.fitCalls).toHaveLength(1);
        expect(map.fitCalls[0]?.options["padding"]).toEqual(AIRY); // the sides only: the top and the bottom are what the bar and the sheet cover
      });

      test("MapView_recenter_leaves_the_same_air_for_the_labels", async () => {
        goodStyle();
        const places = labelled;
        render(view({ data: { routes: EMPTY_ROUTES, places, view: "trip" }, fitTo: places!.features, home: places!.features, padding: PADDING }));
        const map = await mapUp();

        fireEvent.click(screen.getByRole("button", { name: "Recenter map" }));

        expect(map.fitCalls).toHaveLength(2);
        expect(map.fitCalls[1]?.options["padding"]).toEqual(AIRY);
      });

      test("MapView_fits_without_the_air_when_no_dot_has_a_label_or_there_are_no_dots", async () => {
        goodStyle();
        const places = dots(dot(undefined, -9.14), dot(undefined, 12.57)); // a period whose places have no name or city to show
        const { rerender } = render(view({ data: { routes: EMPTY_ROUTES, places }, fitTo: places!.features, padding: PADDING }));
        const map = await mapUp();
        expect(map.fitCalls[0]?.options["padding"]).toEqual(PADDING);

        rerender(view({ data: { routes: EMPTY_ROUTES, stops: stops() }, fitTo: [flight], padding: PADDING })); // a day: pins, no dots
        expect(map.fitCalls[1]?.options["padding"]).toEqual(PADDING);
      });

      test("MapView_gives_the_controls_the_padding_without_the_air", async () => {
        goodStyle();
        const places = labelled;

        render(view({ data: { routes: EMPTY_ROUTES, places, view: "trips" }, fitTo: places!.features, padding: PADDING }));
        await mapUp();

        // The buttons and the credit sit by the padding that the shell gives, which is what covers the map: the air is for the fit alone.
        expect(["top", "right", "bottom", "left"].map((side) => region().style.getPropertyValue(`--map-padding-${side}`))).toEqual(["120px", "20px", "300px", "340px"]);
      });
    });

    test("MapView_does_not_fit_to_nothing", async () => {
      goodStyle();
      const { rerender } = render(view({ fitTo: null }));
      const map = await mapUp();
      rerender(view({ fitTo: [] }));
      rerender(view({ fitTo: [{ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [] } }] }));

      expect(map.fitCalls).toEqual([]);
    });

    test("MapView_recenter_button_refits_the_current_data_with_the_current_padding", async () => {
      goodStyle();
      const home = [flight];
      const { rerender } = render(view({ fitTo: home, padding: PADDING }));
      const map = await mapUp();
      const button = screen.getByRole("button", { name: "Recenter map" });
      expect(button).toBeEnabled();

      rerender(view({ fitTo: home, padding: { ...PADDING, bottom: 500 } }));
      fireEvent.click(button);

      expect(map.fitCalls).toHaveLength(2);
      expect(map.fitCalls[1]?.bounds).toEqual(boundsOf([flight]));
      expect(map.fitCalls[1]?.options).toMatchObject({ padding: { ...PADDING, bottom: 500 } });
    });

    describe("home", () => {
      const row: Feature<Point, object> = { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [10.7, 59.9] } };
      const whole = [flight, row];

      test("MapView_recenter_brings_back_home_when_the_map_was_taken_to_a_row", async () => {
        goodStyle();
        const { rerender } = render(view({ fitTo: whole, home: whole, padding: PADDING }));
        const map = await mapUp();
        rerender(view({ fitTo: [row], home: whole, padding: PADDING })); // a row of the timeline tapped
        expect(map.fitCalls).toHaveLength(2);
        expect(map.fitCalls[1]?.bounds).toEqual(boundsOf([row]));

        fireEvent.click(screen.getByRole("button", { name: "Recenter map" }));

        expect(map.fitCalls).toHaveLength(3); // the whole day, and not the row it was last taken to
        expect(map.fitCalls[2]?.bounds).toEqual(boundsOf(whole));
        expect(map.fitCalls[2]?.options).toMatchObject({ padding: PADDING });
      });

      test("MapView_home_alone_does_not_move_the_map_and_the_latest_home_is_the_one_recentered_to", async () => {
        goodStyle();
        const tapped = [row];
        const { rerender } = render(view({ fitTo: tapped, home: [row], padding: PADDING }));
        const map = await mapUp();
        expect(map.fitCalls).toHaveLength(1);

        rerender(view({ fitTo: tapped, home: whole, padding: PADDING })); // the day was polled and has more in it: the map stays
        expect(map.fitCalls).toHaveLength(1);

        fireEvent.click(screen.getByRole("button", { name: "Recenter map" }));
        expect(map.fitCalls).toHaveLength(2);
        expect(map.fitCalls[1]?.bounds).toEqual(boundsOf(whole));
      });

      test("MapView_recenter_goes_to_the_fit_when_there_is_no_home_given", async () => {
        goodStyle();
        render(view({ fitTo: [row], padding: PADDING }));
        const map = await mapUp();

        fireEvent.click(screen.getByRole("button", { name: "Recenter map" }));

        expect(map.fitCalls[1]?.bounds).toEqual(boundsOf([row]));
      });

      test("MapView_recenter_is_disabled_when_home_is_null_whatever_the_fit_is", async () => {
        goodStyle();
        const { rerender } = render(view({ fitTo: [row], home: null }));
        const map = await mapUp();
        const button = screen.getByRole("button", { name: "Recenter map" });

        expect(button).toBeDisabled();
        fireEvent.click(button);
        expect(map.fitCalls).toHaveLength(1); // the fit that was asked for, and no more

        rerender(view({ fitTo: [row], home: whole }));
        expect(button).toBeEnabled();
        rerender(view({ fitTo: [row], home: [] })); // nothing in it to bring back
        expect(button).toBeDisabled();
      });
    });

    test("MapView_recenter_button_is_disabled_when_there_is_nothing_to_show", () => {
      goodStyle();
      const { rerender } = render(view({ fitTo: null }));
      const button = screen.getByRole("button", { name: "Recenter map" });
      expect(button).toBeDisabled();

      rerender(view({ fitTo: [flight] }));
      expect(button).toBeEnabled();
    });

    test("MapView_hands_the_padding_to_the_style_sheet_for_its_controls_to_sit_inside", () => {
      // The style sheet (see the e2e test of the attribution) sets the buttons and MapLibre's controls, the attribution among
      // them, in by these, so that a bottom sheet, a sidebar or a bar does not cover them.
      goodStyle();
      const { rerender } = render(view({ padding: PADDING }));

      const root = region();
      const padding = () => ["top", "right", "bottom", "left"].map((side) => root.style.getPropertyValue(`--map-padding-${side}`));
      expect(padding()).toEqual(["120px", "20px", "300px", "340px"]);

      rerender(view({ padding: { top: 0, right: 0, bottom: 96, left: 0 } })); // the peek of the sheet
      expect(padding()).toEqual(["0px", "0px", "96px", "0px"]);
    });

    test("MapView_without_padding_leaves_the_controls_at_the_corners", () => {
      goodStyle();
      render(view({ padding: undefined }));

      expect(["top", "right", "bottom", "left"].map((side) => region().style.getPropertyValue(`--map-padding-${side}`))).toEqual(["0px", "0px", "0px", "0px"]);
    });
  });

  describe("theme", () => {
    test("MapView_picks_the_light_or_dark_style_from_the_config_and_switches_live", async () => {
      const urls = stubFetch((url) => Response.json({ ...STYLE, name: url }));
      const setScheme = stubColourScheme("light");

      render(withConfig(clientWithConfig()));
      await styleApplied(1);
      expect(urls).toEqual(["/styles/liberty"]);
      const map = theMap();
      map.emit("style.load");
      expect(map.sources.size).toBe(Object.values(SOURCE_IDS).length);

      setScheme("dark");
      await styleApplied(2);
      expect(urls).toEqual(["/styles/liberty", "/styles/dark"]);
      expect((map.styleCalls[1]?.style as { name: string }).name).toBe("/styles/dark");
      expect(map.styleCalls[1]?.options).toEqual({ diff: false });
      expect(liveMaps()).toEqual([map]); // the same map: its view is kept
      map.emit("style.load"); // the new style is loaded: layers and sources come back
      expect([...map.layers.keys()]).toEqual(Object.values(LAYER_IDS));

      setScheme("light");
      await styleApplied(3);
      expect(urls).toEqual(["/styles/liberty", "/styles/dark", "/styles/liberty"]);
    });

    test("MapView_starts_with_the_dark_style_when_the_system_is_dark", async () => {
      const urls = stubFetch(() => Response.json(STYLE));
      stubColourScheme("dark");

      render(withConfig(clientWithConfig()));
      await styleApplied();

      expect(urls).toEqual(["/styles/dark"]);
    });

    test("MapView_asks_for_the_style_of_the_scheme_it_is_in_when_MapLibre_arrives", async () => {
      // The system went dark while MapLibre was on its way: the light style is never asked for.
      const urls = stubFetch(() => Response.json(STYLE));
      const setScheme = stubColourScheme("light");
      const slow = slowLoader();
      render(withConfig(clientWithConfig(), { loadMapLibre: slow.load }));

      setScheme("dark");
      await slow.arrive();
      await styleApplied();

      expect(urls).toEqual(["/styles/dark"]);
      expect(theMap().styleCalls).toHaveLength(1);
    });

    test("MapView_keeps_quiet_when_the_colour_scheme_changes_after_MapLibre_failed", async () => {
      const urls = stubFetch(() => Response.json(STYLE));
      const setScheme = stubColourScheme("light");
      const slow = slowLoader();
      const onStyleError = vi.fn<(error: Error) => void>();
      render(withConfig(clientWithConfig(), { loadMapLibre: slow.load, onStyleError }));
      await slow.fail(new TypeError("Failed to fetch dynamically imported module"));

      setScheme("dark");
      setScheme("light");
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(onStyleError).toHaveBeenCalledTimes(1);
      expect(slow.load).toHaveBeenCalledTimes(1);
      expect(urls).toEqual([]);
      expect(FakeMap.instances).toHaveLength(0);
      expect(region()).toHaveAttribute("data-map-state", "unavailable");
    });

    test("MapView_reads_the_light_style_when_the_browser_cannot_tell_the_scheme", async () => {
      const urls = stubFetch(() => Response.json(STYLE));

      render(withConfig(clientWithConfig())); // jsdom has no matchMedia
      await styleApplied();

      expect(urls).toEqual(["/styles/liberty"]);
    });

    test("MapView_keeps_the_old_style_on_screen_until_the_new_one_has_been_fetched", async () => {
      let release: () => void = () => undefined;
      const urls = stubFetch((url) => url === "/styles/dark"
        ? new Promise<Response>((resolve) => { release = () => resolve(Response.json(STYLE)); })
        : Response.json(STYLE));
      const setScheme = stubColourScheme("light");
      render(withConfig(clientWithConfig()));
      await styleApplied(1);
      const map = theMap();

      setScheme("dark");
      await waitFor(() => expect(urls).toHaveLength(2));
      expect(map.styleCalls).toHaveLength(1); // not blanked while the dark style is on its way
      release();
      await styleApplied(2);
    });

    test("MapView_waits_for_the_config_before_it_asks_for_a_style", async () => {
      let release: () => void = () => undefined;
      const urls = stubFetch((url) => url === "/api/config"
        ? new Promise<Response>((resolve) => { release = () => resolve(Response.json(CONFIG)); })
        : Response.json(STYLE));
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

      render(withConfig(client));
      const map = await mapUp();
      expect(map.styleCalls).toHaveLength(0);
      expect(urls).toEqual(["/api/config"]); // the map is there and has no style to ask for yet

      release();
      await styleApplied();

      expect(urls).toEqual(["/api/config", "/styles/liberty"]);
    });

    test("MapView_reports_a_config_that_cannot_be_read_as_a_style_failure", async () => {
      stubFetch(() => new Response("{}", { status: 500 }));
      const onStyleError = vi.fn<(error: Error) => void>();

      render(withConfig(new QueryClient({ defaultOptions: { queries: { retry: false } } }), { onStyleError }));

      await waitFor(() => expect(onStyleError).toHaveBeenCalledTimes(1));
      await styleApplied();
      expect(theMap().styleCalls[0]?.style).toEqual({ version: 8, sources: {}, layers: [] });
      expect(region()).toHaveAttribute("data-map-state", "unavailable");
    });

    test("MapView_uses_styleUrl_instead_of_the_config_and_needs_no_query_client", async () => {
      const urls = stubFetch(() => Response.json(STYLE));

      render(view({ styleUrl: "/styles/custom" })); // no QueryClientProvider
      await styleApplied();

      expect(urls).toEqual(["/styles/custom"]);
    });
  });
});
