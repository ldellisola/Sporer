import type { GeoJSONSource, MapLibreMap } from "maplibre-gl";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactElement, type RefObject } from "react";
import { useConfig } from "../api/queries";
import { boundsOf, type Bounds } from "./bounds";
import {
  layerSpecs,
  ROUTE_LAYERS,
  routeOpacity,
  SOURCE_IDS,
  type Feature,
  type Geometry,
  type HeatCollection,
  type PlaceCollection,
  type RouteCollection,
  type RouteView,
  type StopCollection,
} from "./layers";
import { loadMapLibre, type MapLibreLoader } from "./maplibre";
import styles from "./MapView.module.css";
import { loadStyle, type StyleSpecification } from "./style";

/** What the map draws. Routes are drawn as a day (bold, with a casing) when `stops` is given, else as part of a period (faint). */
export interface MapData {
  routes: RouteCollection;
  stops?: StopCollection;
  places?: PlaceCollection;
  /** Drawn as a heat layer while given, under the routes, which fade (to a fifth) for as long as there is a glow to show through. */
  heat?: HeatCollection;
}

/** The map's heat button: whether the heat is on, and the way to ask for the other. The parent holds the state (and remembers it). */
export interface HeatToggle {
  on: boolean;
  onChange: (on: boolean) => void;
}

/**
 * The part of the map that something else (a sidebar, a bar, the bottom sheet) covers, in pixels from each edge. What is to be
 * shown is fitted into the rest exactly, so that a pin at the edge of it sits on the edge of what can be seen: add some air.
 */
export interface MapPadding {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface MapViewProps {
  /** A style to load in place of the one `/api/config` gives for the colour scheme; for tests and previews. */
  styleUrl?: string;
  /**
   * How MapLibre is fetched, when the map is made; for tests and previews. The default is the module's own chunk (see `./maplibre`).
   * Until it has arrived the map's place is the plain background, and what is given meanwhile (`data`, `fitTo`, `home`, `padding`)
   * is kept: the map is made with the latest of it as soon as the module is there, and brought to `fitTo` once. A module that cannot be
   * fetched is reported like a style that cannot be loaded, through `onStyleError`.
   */
  loadMapLibre?: MapLibreLoader;
  /**
   * What to draw. A collection is sent to the map when it is another object than the last time, so a parent keeps them (a
   * `useMemo` of the response) and builds a new one only when the data is new.
   */
  data: MapData;
  /**
   * What to bring into view, with `padding` left free. The map moves each time this is another array than the last: a day
   * looked at again, or a row tapped a second time, brings the view back even if the box is the same as before. So a parent keeps
   * the array (a `useMemo` of the response) and builds a new one only when the view is to move. Nothing is done for null or an
   * array without positions.
   */
  fitTo?: readonly Feature<Geometry, unknown>[] | null;
  /**
   * What the Recenter button brings back: the whole of what is drawn, where `fitTo` may be a part of it (a row of the timeline that
   * was tapped). Without it the button goes back to `fitTo`. It never moves the map by itself, so a parent may give a new one as
   * often as its data changes; null (or no position in it) says there is nothing to go back to, and disables the button.
   */
  home?: readonly Feature<Geometry, unknown>[] | null;
  padding?: MapPadding;
  /** The heat button, a button of the map's own like Recenter. Given only where there is a period to show the heat of: without it there is no button. */
  heatToggle?: HeatToggle;
  /**
   * Called once for each style that cannot be loaded (the request fails, it is not a style, MapLibre will not take it), and for
   * a map that cannot start (no WebGL, or MapLibre itself could not be fetched). The map then draws on a plain background, and
   * everything else on the page goes on.
   */
  onStyleError?: (error: Error) => void;
  /**
   * Called each time a style has finished loading: the first one, and the one of the other colour scheme after a switch, so that a
   * parent that noted a failure can take the note back. Not for the plain style the map falls back to after a failure: that map is
   * still not the one that was asked for.
   */
  onStyleLoad?: () => void;
}

const NO_PADDING: MapPadding = { top: 0, right: 0, bottom: 0, left: 0 };

/** The credit the map always carries, whatever its style says (a style of one's own may not say it at all). */
const OSM_ATTRIBUTION =
  '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors';

/** What a map shows when its style cannot be had: nothing, so that the routes lie on the background of the page. */
const FALLBACK_STYLE: StyleSpecification = { version: 8, sources: {}, layers: [] };

/** One point of a trip is a point on the map; never closer than this, which is about a street. */
const FIT_MAX_ZOOM = 16;
const FIT_DURATION_MS = 600;

const EMPTY_STOPS: StopCollection = { type: "FeatureCollection", features: [] };
const EMPTY_PLACES: PlaceCollection = { type: "FeatureCollection", features: [] };
const EMPTY_HEAT: HeatCollection = { type: "FeatureCollection", features: [] };

type MapState = "loading" | "ready" | "unavailable";

/** The state of the map as an attribute of its element, for whoever drives the page (the e2e tests wait for it). */
function showState(root: HTMLElement | null, state: MapState): void {
  if (root !== null) root.dataset["mapState"] = state;
}

const toError = (reason: unknown): Error => (reason instanceof Error ? reason : new Error(String(reason)));

/** The ref of a value that is always the one of the latest render, for the event handlers of a map that outlives them. */
function useLatest<T>(value: T): RefObject<T> {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  });
  return ref;
}

// --- Colour scheme ---

const DARK_SCHEME = "(prefers-color-scheme: dark)";

function subscribeToScheme(onChange: () => void): () => void {
  if (typeof window.matchMedia !== "function") return () => undefined;
  const query = window.matchMedia(DARK_SCHEME);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

const prefersDark = (): boolean => typeof window.matchMedia === "function" && window.matchMedia(DARK_SCHEME).matches;

/** Whether the system is dark, now and whenever it changes. A browser that cannot tell is taken to be light. */
const usePrefersDark = (): boolean => useSyncExternalStore(subscribeToScheme, prefersDark, () => false);

// --- Keeping the sources and layers of the map up to date ---

const SOURCE_KEYS = ["heat", "routes", "places", "stops"] as const;
type SourceKey = (typeof SOURCE_KEYS)[number];

/** What has been given to the map since its style last loaded: a new style has none of it, and its routes are as the specs have them. */
interface Pushed {
  collections: Partial<Record<SourceKey, object>>;
  view?: RouteView;
  /** Whether the routes have been faded for a heat layer. */
  underHeat: boolean;
}

const newPushed = (): Pushed => ({ collections: {}, underHeat: false });

/**
 * Brings the sources and layers of `map` up to date with `data`, doing only what is needed: a source that is not there yet (a
 * style has just loaded) is added with its data, one that is gets `setData` if its data is not the one it has; layers are added
 * once, only their visibility changes when the view changes between a day and a period, and only their opacity when a heat layer
 * comes or goes (a heat with no cell in it has no glow, so it does not fade them). Call it once a style has loaded, with a fresh
 * `pushed` for it, and again whenever the data changes.
 */
function syncData(map: MapLibreMap, data: MapData, dark: boolean, pushed: Pushed): void {
  const view: RouteView = data.stops === undefined ? "range" : "day";
  const collections = {
    routes: data.routes,
    stops: data.stops ?? EMPTY_STOPS,
    places: data.places ?? EMPTY_PLACES,
    heat: data.heat ?? EMPTY_HEAT,
  };
  for (const key of SOURCE_KEYS) {
    const collection = collections[key];
    if (pushed.collections[key] === collection) continue;
    const source = map.getSource<GeoJSONSource>(SOURCE_IDS[key]);
    if (source === undefined) map.addSource(SOURCE_IDS[key], { type: "geojson", data: collection });
    else source.setData(collection);
    pushed.collections[key] = collection;
  }
  if (pushed.view !== view) {
    for (const spec of layerSpecs(view, dark)) {
      if (map.getLayer(spec.id) === undefined) map.addLayer(spec);
      else map.setLayoutProperty(spec.id, "visibility", spec.layout?.visibility ?? "visible");
    }
    pushed.view = view;
  }
  const underHeat = collections.heat.features.length > 0;
  if (pushed.underHeat !== underHeat) {
    for (const id of ROUTE_LAYERS) map.setPaintProperty(id, "line-opacity", routeOpacity(id, underHeat));
    pushed.underHeat = underHeat;
  }
}

/**
 * The padding as custom properties of the map's element, which the style sheet sets the map's controls (the attribution, the
 * recenter button) in from: what covers the map must not cover them. MapLibre's own `padding` would move the centre of the view
 * but leaves its controls at the corners of the element, where a bottom sheet is.
 */
function paddingVariables(padding: MapPadding): CSSProperties {
  return {
    "--map-padding-top": `${padding.top}px`,
    "--map-padding-right": `${padding.right}px`,
    "--map-padding-bottom": `${padding.bottom}px`,
    "--map-padding-left": `${padding.left}px`,
  } as CSSProperties;
}

function fit(map: MapLibreMap, bounds: Bounds, padding: MapPadding): void {
  map.fitBounds(bounds, { padding, maxZoom: FIT_MAX_ZOOM, duration: FIT_DURATION_MS });
}

// --- The map ---

/** Where the style comes from: an address, a reason it cannot be had, or nothing yet (the config is still on its way). */
type StyleSource = { url: string } | { error: Error } | null;

interface SurfaceProps extends Omit<MapViewProps, "styleUrl"> {
  source: StyleSource;
  dark: boolean;
}

function MapSurface({
  source,
  dark,
  data,
  fitTo = null,
  home,
  padding = NO_PADDING,
  heatToggle,
  onStyleError,
  onStyleLoad,
  loadMapLibre: load = loadMapLibre,
}: SurfaceProps): ReactElement {
  const rootRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  /** The map, once MapLibre has arrived and has made it; null before that, and the effects below wait for it. */
  const [map, setMap] = useState<MapLibreMap | null>(null);
  /** Whether the style of the map has loaded, so that sources and layers may be added to it. */
  const readyRef = useRef(false);
  const pushedRef = useRef<Pushed>(newPushed());

  const { routes, stops, places, heat } = data;
  const bounds = useMemo(() => (fitTo === null ? null : boundsOf(fitTo)), [fitTo]);
  const homeBounds = useMemo(() => (home === undefined ? bounds : home === null ? null : boundsOf(home)), [home, bounds]);

  const latest = useLatest({ data, dark, padding, onStyleError, onStyleLoad, source, bounds, homeBounds, load });
  const styleUrl = source !== null && "url" in source ? source.url : null;
  const styleFailed = source !== null && "error" in source;

  // One map for as long as the component is on the page, made as soon as MapLibre has arrived: it is a chunk of its own, fetched when
  // this mounts so that the panel next to the map does not wait for it, and until then there is the plain background. Under StrictMode
  // this runs, is undone and runs again: the first run is cancelled, so that the module's arrival makes one map.
  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    let cancelled = false;
    let made: MapLibreMap | null = null;
    showState(rootRef.current, "loading");
    const unavailable = (error: unknown): void => {
      // No WebGL, most likely, or no MapLibre. The page goes on without a map.
      showState(rootRef.current, "unavailable");
      latest.current.onStyleError?.(toError(error));
    };
    latest.current.load().then(
      (maplibre) => {
        if (cancelled) return;
        try {
          made = new maplibre.MapLibreMap({
            container,
            center: [0, 20],
            zoom: 1,
            attributionControl: { compact: true, customAttribution: OSM_ATTRIBUTION },
            // North stays up: there is no compass to put it right again.
            dragRotate: false,
            maxPitch: 0,
          });
        } catch (error) {
          unavailable(error);
          return;
        }
        made.touchZoomRotate.disableRotation();
        // MapLibre drops its style when the context is lost, and sets it again when the context is back; until then it is not to be touched.
        made.on("webglcontextlost", () => {
          readyRef.current = false;
        });
        readyRef.current = false;
        pushedRef.current = newPushed();
        showState(rootRef.current, "loading");
        setMap(made); // the effects below take it from here: the style, the data, and the camera, each with the latest of what was given
      },
      (error: unknown) => {
        if (!cancelled) unavailable(error);
      },
    );
    return () => {
      cancelled = true;
      made?.remove();
      readyRef.current = false;
    };
  }, [latest]);

  // The style: fetched here, so that English labels can be put in it and a failure is ours to handle, then handed to the map.
  // A new one (the colour scheme changed) replaces the old one only once it is fetched, and the sources and layers come back
  // with the latest data when it has loaded.
  useEffect(() => {
    if (map === null || (styleUrl === null && !styleFailed)) return;
    const request = new AbortController();
    // fetching: the style is on its way. applying: the map has it, and neither loaded it nor refused it yet.
    // ready: loaded. failed: reported, and the map has been given a plain style instead.
    let phase: "fetching" | "applying" | "ready" | "failed" = "fetching";
    readyRef.current = false;
    showState(rootRef.current, "loading");

    const fail = (error: Error): void => {
      if (phase === "failed") return;
      phase = "failed";
      readyRef.current = false;
      showState(rootRef.current, "unavailable");
      latest.current.onStyleError?.(error);
      // Not at once: MapLibre may be in the middle of reporting the problems of the style, one error event after the other, and
      // takes its style away from under that; the events that are left would then have no listener and be logged.
      queueMicrotask(() => {
        if (!request.signal.aborted) map.setStyle(FALLBACK_STYLE, { diff: false });
      });
    };
    const styleLoaded = (): void => {
      if (phase === "applying") phase = "ready";
      readyRef.current = true;
      showState(rootRef.current, phase === "failed" ? "unavailable" : "ready");
      pushedRef.current = newPushed();
      syncData(map, latest.current.data, latest.current.dark, pushedRef.current);
      if (phase !== "failed") latest.current.onStyleLoad?.();
    };
    // MapLibre reports a style it will not take, and every problem in it, as error events and never loads it. Errors of a
    // style that is up (a tile that did not come) are not ours to handle: they are logged, as MapLibre would have done.
    const onError = ({ error }: { error: unknown }): void => {
      if (phase === "applying") fail(toError(error));
      else if (phase !== "failed") console.error(error);
    };
    map.on("style.load", styleLoaded);
    map.on("error", onError);

    if (styleUrl === null) {
      const { source: current } = latest.current;
      fail(current !== null && "error" in current ? current.error : new Error("The map style is not known."));
    } else {
      loadStyle(styleUrl, request.signal).then(
        (style) => {
          if (request.signal.aborted) return;
          phase = "applying";
          readyRef.current = false;
          try {
            map.setStyle(style, { diff: false }); // not a diff: a style of another look, which would only be patched
          } catch (error) {
            fail(toError(error));
          }
        },
        (error: unknown) => {
          if (!request.signal.aborted) fail(toError(error));
        },
      );
    }

    return () => {
      request.abort();
      map.off("style.load", styleLoaded);
      map.off("error", onError);
      readyRef.current = false;
    };
  }, [map, styleUrl, styleFailed, dark, latest]);

  // New data goes to the sources it belongs to. While there is no style the map is not touched: the style that loads picks up
  // the latest data by itself.
  useEffect(() => {
    if (map !== null && readyRef.current) {
      syncData(map, { routes, stops, places, heat }, latest.current.dark, pushedRef.current);
    }
  }, [map, routes, stops, places, heat, latest]);

  // A map that was not there yet when `fitTo` was given is brought to it, with the padding of now, the moment it is there.
  useEffect(() => {
    const target = latest.current.bounds;
    if (map !== null && target !== null) fit(map, target, latest.current.padding);
  }, [map, fitTo, latest]); // each new `fitTo` moves the map, whether or not its box is the one it is already at; padding does not

  const recenter = (): void => {
    const target = latest.current.homeBounds;
    if (map !== null && target !== null) fit(map, target, latest.current.padding);
  };

  return (
    <div ref={rootRef} className={styles.root} role="region" aria-label="Map view" style={paddingVariables(padding)}>
      <div ref={containerRef} className={styles.map} />
      <div className={styles.controls}>
        <button
          type="button"
          className={styles.button}
          aria-label="Recenter map"
          title="Recenter map"
          disabled={homeBounds === null}
          onClick={recenter}
        >
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
            <circle cx="12" cy="12" r="3.5" fill="none" stroke="currentColor" strokeWidth="2" />
            <path d="M12 2.5v4M12 17.5v4M2.5 12h4M17.5 12h4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>
        {heatToggle !== undefined && (
          <button
            type="button"
            className={styles.button}
            aria-label="Heat map"
            title="Heat map"
            aria-pressed={heatToggle.on}
            onClick={() => heatToggle.onChange(!heatToggle.on)}
          >
            {/* The ◐ of the mockup, drawn so that it is the same on every device: a ring with its left half filled. */}
            <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
              <circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" strokeWidth="2" />
              <path d="M12 4a8 8 0 0 0 0 16z" fill="currentColor" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}

/** The colour scheme the style follows, and the style of it that `/api/config` gives. */
function ConfiguredMap(props: Omit<SurfaceProps, "source">): ReactElement {
  const config = useConfig();
  let source: StyleSource = null;
  if (config.data !== undefined) {
    source = { url: props.dark ? config.data.mapStyleDark : config.data.mapStyleLight };
  } else if (config.isError) {
    source = { error: toError(config.error) };
  }
  return <MapSurface {...props} source={source} />;
}

/**
 * The map: MapLibre, used directly, full size of its parent. One map is made and kept; it loads the light or the dark style of
 * `/api/config` by the colour scheme of the system, switching as that does, with English labels. Whatever the style, the routes,
 * pins, dots and heat of `data` are drawn on top (the heat under the routes, which it fades), and the map moves to show `fitTo` within
 * `padding`. OpenStreetMap is credited.
 *
 * Without `styleUrl` it reads the config, so it needs a `QueryClientProvider`; with one it needs nothing.
 */
export function MapView({ styleUrl, ...props }: MapViewProps): ReactElement {
  const dark = usePrefersDark();
  if (styleUrl === undefined) return <ConfiguredMap {...props} dark={dark} />;
  return <MapSurface {...props} dark={dark} source={{ url: styleUrl }} />;
}
