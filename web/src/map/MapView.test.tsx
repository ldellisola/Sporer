import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode, type ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ConfigResponse } from "../api/types";
import { boundsOf } from "./bounds";
import { LAYER_IDS, ROUTE_LAYERS, routeOpacity, SOURCE_IDS } from "./layers";
import type { Feature, FeatureCollection, HeatCollection, LineString, Point } from "./layers";
import type { MapLibreLoader, MapLibreModule } from "./maplibre";
import { MapView, type MapViewProps } from "./MapView";

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
    private readonly listeners = new Map<string, Set<Listener>>();
    readonly touchZoomRotate = {
      disableRotation: () => {
        if (FakeMap.failRotation) throw FakeMap.failRotation;
        this.rotationDisabled = true;
      },
    };

    constructor(options: Record<string, unknown>) {
      if (FakeMap.failWith) throw FakeMap.failWith;
      this.options = options;
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

    private requireStyle(): void {
      if (this.contextLost) throw new TypeError("Cannot read properties of null (reading 'getSource')");
    }
    setStyle(style: unknown, options: unknown): this {
      this.styleCalls.push({ style, options });
      this.sources.clear();
      this.layers.clear();
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

function stops(): FeatureCollection<Point, { order: number; label: string; name: string | null; id: number }> {
  return {
    type: "FeatureCollection",
    features: [{ type: "Feature", properties: { order: 1, label: "1", name: "Home", id: 5 }, geometry: { type: "Point", coordinates: [10, 59] } }],
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
    expect(theMap().sources.size).toBe(4);
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

    test("MapView_picks_the_light_or_dark_style_from_the_config_and_switches_live", async () => {
      const urls = stubFetch((url) => Response.json({ ...STYLE, name: url }));
      const setScheme = stubColourScheme("light");

      render(withConfig(clientWithConfig()));
      await styleApplied(1);
      expect(urls).toEqual(["/styles/liberty"]);
      const map = theMap();
      map.emit("style.load");
      expect(map.sources.size).toBe(4);

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
