import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode, type ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ConfigResponse } from "../api/types";
import { boundsOf } from "./bounds";
import { LAYER_IDS, SOURCE_IDS } from "./layers";
import type { Feature, FeatureCollection, LineString, Point } from "./layers";
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

    readonly options: Record<string, unknown>;
    removed = false;
    contextLost = false;
    rotationDisabled = false;
    readonly styleCalls: { style: unknown; options: unknown }[] = [];
    readonly fitCalls: { bounds: unknown; options: Record<string, unknown> }[] = [];
    readonly visibilityCalls: [string, unknown][] = [];
    readonly sources = new Map<string, FakeSource>();
    readonly layers = new Map<string, Record<string, any>>();
    private readonly listeners = new Map<string, Set<Listener>>();
    readonly touchZoomRotate = { disableRotation: () => { this.rotationDisabled = true; } };

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

function stops(): FeatureCollection<Point, { order: number; name: string | null; id: number }> {
  return {
    type: "FeatureCollection",
    features: [{ type: "Feature", properties: { order: 1, name: "Home", id: 5 }, geometry: { type: "Point", coordinates: [10, 59] } }],
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

/** Waits until the map has been given the style it fetched. */
async function styleApplied(count = 1): Promise<void> {
  await waitFor(() => expect(theMap().styleCalls).toHaveLength(count));
}

const region = () => screen.getByRole("region", { name: "Map view" });

beforeEach(() => {
  FakeMap.instances.length = 0;
  FakeMap.failWith = null;
});

afterEach(() => {
  FakeMap.failWith = null;
});

describe("MapView", () => {
  test("MapView_tells_MapLibre_where_the_build_put_its_worker", () => {
    // Once, when the module loads, before any map is made. MapLibre would look for it next to itself, in a bundle: not there.
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

  test("MapView_reports_a_map_that_cannot_start_and_stays_rendered", () => {
    goodStyle();
    FakeMap.failWith = new Error("Failed to initialize WebGL");
    const onStyleError = vi.fn<(error: Error) => void>();

    expect(() => render(view({ onStyleError }))).not.toThrow();

    expect(onStyleError).toHaveBeenCalledTimes(1);
    expect(onStyleError.mock.calls[0]?.[0].message).toBe("Failed to initialize WebGL");
    expect(region()).toHaveAttribute("data-map-state", "unavailable");
    expect(screen.getByRole("button", { name: "Recenter map" })).toBeInTheDocument();
  });

  test("MapView_creates_one_map_under_StrictMode_and_removes_it_on_unmount", async () => {
    // The first mount of StrictMode is torn down at once: its map is removed, its style request aborted and not reported.
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

    expect(FakeMap.instances).toHaveLength(2);
    expect(liveMaps()).toHaveLength(1);
    expect(FakeMap.instances[0]?.removed).toBe(true);
    await styleApplied();
    expect(FakeMap.instances[0]?.styleCalls).toHaveLength(0); // the aborted request never reached its map
    expect(signals.map((signal) => signal.aborted)).toEqual([true, false]);

    const map = theMap();
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

  test("MapView_creates_the_map_with_compact_attribution_and_a_north_up_view", () => {
    goodStyle();

    render(view());

    const { options, rotationDisabled } = theMap();
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

  describe("camera", () => {
    const flight: Feature<LineString, object> = {
      type: "Feature",
      properties: {},
      geometry: { type: "LineString", coordinates: [[10.5, 59.8], [10.9, 60.1]] },
    };
    const PADDING = { top: 120, right: 20, bottom: 300, left: 340 };

    test("MapView_fits_to_the_features_with_padding", () => {
      goodStyle();

      render(view({ fitTo: [flight], padding: PADDING }));

      const map = theMap();
      expect(map.fitCalls).toHaveLength(1);
      expect(map.fitCalls[0]?.bounds).toEqual([[10.5, 59.8], [10.9, 60.1]]);
      expect(map.fitCalls[0]?.options).toMatchObject({ padding: PADDING });
      expect(map.fitCalls[0]?.options["duration"]).toBeGreaterThan(0); // animated
      expect(map.fitCalls[0]?.options["maxZoom"]).toBeLessThanOrEqual(18); // one point does not zoom in to the street
    });

    test("MapView_fits_again_for_every_new_fitTo_even_when_it_is_the_same_box_and_not_for_the_same_object", () => {
      goodStyle();
      const home = [flight];
      const { rerender } = render(view({ fitTo: home, padding: PADDING }));
      const map = theMap();
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

    test("MapView_does_not_fit_to_nothing", () => {
      goodStyle();
      const { rerender } = render(view({ fitTo: null }));
      rerender(view({ fitTo: [] }));
      rerender(view({ fitTo: [{ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [] } }] }));

      expect(theMap().fitCalls).toEqual([]);
    });

    test("MapView_recenter_button_refits_the_current_data_with_the_current_padding", () => {
      goodStyle();
      const home = [flight];
      const { rerender } = render(view({ fitTo: home, padding: PADDING }));
      const map = theMap();
      const button = screen.getByRole("button", { name: "Recenter map" });
      expect(button).toBeEnabled();

      rerender(view({ fitTo: home, padding: { ...PADDING, bottom: 500 } }));
      fireEvent.click(button);

      expect(map.fitCalls).toHaveLength(2);
      expect(map.fitCalls[1]?.bounds).toEqual(boundsOf([flight]));
      expect(map.fitCalls[1]?.options).toMatchObject({ padding: { ...PADDING, bottom: 500 } });
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
      const urls = stubFetch((url) => url === "/api/config" ? Response.json(CONFIG) : Response.json(STYLE));
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

      render(withConfig(client));
      expect(theMap().styleCalls).toHaveLength(0);
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
