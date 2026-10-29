import type { GeoJSONSource, MapLibreMap, MapMouseEvent } from "maplibre-gl";
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactElement,
  type Ref,
  type RefObject,
} from "react";
import { useConfig } from "../api/queries";
import { boundsOf, type Bounds } from "./bounds";
import { EditControls } from "./EditControls";
import { editPointAt, type MapEdit } from "./editPoints";
import { addHomeImage } from "./house";
import {
  LAYER_IDS,
  layerSpecs,
  ROUTE_LAYERS,
  routeOpacity,
  SOURCE_IDS,
  type EditPointCollection,
  type Feature,
  type Geometry,
  type HeatCollection,
  type PlaceCollection,
  type RouteCollection,
  type RouteView,
  type StopCollection,
} from "./layers";
import { loadMapLibre, type MapLibreLoader, type MapLibreModule } from "./maplibre";
import styles from "./MapView.module.css";
import { loadStyle, type StyleSpecification } from "./style";
import { nearestTapped } from "./taps";

export type { MapEdit } from "./editPoints";

/**
 * What the map draws. Routes are drawn as a day (bold, with a casing) when `stops` is given, else as part of a period (faint), unless
 * `view` says which they are: the trips (a dot for each city, no routes) and a trip (bold routes and dots) are not told from a period
 * by the shape of their data.
 */
export interface MapData {
  routes: RouteCollection;
  stops?: StopCollection;
  places?: PlaceCollection;
  view?: RouteView;
  /** Drawn as a heat layer while given, under the routes, which fade (to a fifth) for as long as there is a glow to show through. */
  heat?: HeatCollection;
  /**
   * The raw points of the day in edit mode, one feature for each with its index as its numeric `id` (see `editPointsGeoJson`): drawn as small dots over
   * the routes, in one `setData` as they come. What is selected is not here: a tap would redraw them all. It is `MapEdit`'s, and is the map's feature state.
   */
  editPoints?: EditPointCollection;
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

/** What the app can ask of the map besides what it draws: to try again what failed. */
export interface MapViewHandle {
  /**
   * Tries again what has failed: MapLibre, if it could not be fetched or the map could not start, else the style, if that could not be
   * loaded. One attempt for each call, and none when nothing has failed or an attempt is already on its way. The map does this by itself
   * as well, each time the page comes back into view and the network comes back, for as long as it has failed; this is for the owner's
   * own Retry. How an attempt goes is told as for the first: `onStyleLoad` when it worked, `onStyleError` when it did not.
   */
  retry(): void;
}

export interface MapViewProps {
  /** The handle by which the app asks the map to try again (see `MapViewHandle`). */
  ref?: Ref<MapViewHandle>;
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
  /**
   * What covers the map. The controls are set in by it, and what is fitted is fitted into the rest, with a little more air at the left and at
   * the right while a dot of the drawing has a label (see `LABEL_AIR_PX`): the air is for the camera and is not added to the controls' insets.
   */
  padding?: MapPadding;
  /** The heat button, a button of the map's own like Recenter. Given only where there is a period to show the heat of: without it there is no button. */
  heatToggle?: HeatToggle;
  /**
   * Called with the id of the place when one is tapped (clicked, on a desktop): a dot of a period, or a pin of a day (the number on it
   * too), or the one nearest to the point of those within 12 px of it, so that a finger need not hit a dot of 8 px. The map does not know
   * of routes: the parent takes the owner there. A drag that ends over a dot is no tap, as MapLibre has it. A dot that is no place (the
   * city of the trips, whose `id` is 0) is not tapped, and has no pointer over it.
   */
  onPlaceTap?: (id: number) => void;
  /** Edit mode for points, while the owner is in it (see `MapEdit`): the map's own taps and drags are the points', and the Select area button is there. */
  edit?: MapEdit;
  /**
   * Called once for each style that cannot be loaded (the request fails, it is not a style, MapLibre will not take it), and for
   * a map that cannot start (no WebGL, or MapLibre itself could not be fetched), and again for each attempt that fails once more
   * (see `MapViewHandle`). The map then draws on a plain background, and everything else on the page goes on. A style that cannot
   * be had for a map that already has one (the colour scheme changed) leaves the one it has on screen: a working map is not swapped
   * for a blank one. `basemapKept` says which of the two it is: true when the map still draws the style it had (only the switch to
   * another failed), false when there is no basemap (MapLibre or the map did not start, or the first style failed).
   */
  onStyleError?: (error: Error, basemapKept: boolean) => void;
  /**
   * Called each time a style has finished loading: the first one, the one of the other colour scheme after a switch, and the one of an
   * attempt that has put right a failure, so that a parent that noted the failure can take the note back. Not for the plain style the
   * map falls back to after a failure: that map is still not the one that was asked for.
   */
  onStyleLoad?: () => void;
}

/** The layers of the dots of a period, and of the pins of a day with the house or the numbers on them: what a tap opens the place of. */
const TAPPABLE_LAYERS = [LAYER_IDS.places, LAYER_IDS.stops, LAYER_IDS.stopHome, LAYER_IDS.stopNumbers];

const NO_PADDING: MapPadding = { top: 0, right: 0, bottom: 0, left: 0 };

/** The credit the map always carries, whatever its style says (a style of one's own may not say it at all). */
const OSM_ATTRIBUTION =
  '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors';

/**
 * How long the credit stays open when the map appears before it folds to its ⓘ button: the OSMF attribution guidelines
 * (https://osmfoundation.org/wiki/Licence/Attribution_Guidelines) allow it after about five seconds, or on interaction with the map.
 */
const CREDIT_OPEN_MS = 5000;

/** MapLibre's credit, the class that has it open (in its compact form, which the map is made with), and its ⓘ button. */
const CREDIT_SELECTOR = ".maplibregl-ctrl-attrib";
const CREDIT_OPEN_CLASS = "maplibregl-compact-show";
const CREDIT_COMPACT_CLASS = "maplibregl-compact";
const CREDIT_BUTTON_SELECTOR = ".maplibregl-ctrl-attrib-button";

/** What a map shows when its style cannot be had: nothing, so that the routes lie on the background of the page. */
const FALLBACK_STYLE: StyleSpecification = { version: 8, sources: {}, layers: [] };

/** One point of a trip is a point on the map; never closer than this, which is about a street. */
const FIT_MAX_ZOOM = 16;
const FIT_DURATION_MS = 600;

const EMPTY_STOPS: StopCollection = { type: "FeatureCollection", features: [] };
const EMPTY_PLACES: PlaceCollection = { type: "FeatureCollection", features: [] };
const EMPTY_HEAT: HeatCollection = { type: "FeatureCollection", features: [] };
const EMPTY_EDIT_POINTS: EditPointCollection = { type: "FeatureCollection", features: [] };
const NO_SELECTION: ReadonlySet<number> = new Set();

type MapState = "loading" | "ready" | "unavailable";

/** What has gone wrong with the map, for as long as it has: there is no map (MapLibre could not be had, or would not start), or it has no style. */
type Failure = "map" | "style";

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

const SOURCE_KEYS = ["heat", "routes", "places", "stops", "editPoints"] as const;
type SourceKey = (typeof SOURCE_KEYS)[number];

/** What has been given to the map since its style last loaded: a new style has none of it, and its routes are as the specs have them. */
interface Pushed {
  collections: Partial<Record<SourceKey, object>>;
  view?: RouteView;
  /** Whether the routes have been faded for a heat layer. */
  underHeat: boolean;
  /** The ids that have the feature state `selected` in the map: a style has none of it, and a new set of points has had it taken away. */
  selected: ReadonlySet<number>;
}

const newPushed = (): Pushed => ({ collections: {}, underHeat: false, selected: NO_SELECTION });

/**
 * Sets the feature state `selected` of the edit points that are in `selected` and were not, and takes it off those that were and are not: only the
 * ones that changed, never all of them, so that a tap costs one point and not forty thousand. A source that has other points (`setData`) has no
 * state kept for them (the ids are indices into the old ones), and a style that has just loaded has none at all: `pushed` says what the map has.
 */
function syncSelection(map: MapLibreMap, selected: ReadonlySet<number>, pushed: Pushed): void {
  if (pushed.selected === selected) return;
  const source = SOURCE_IDS.editPoints;
  for (const id of pushed.selected) if (!selected.has(id)) map.removeFeatureState({ source, id }, "selected");
  for (const id of selected) if (!pushed.selected.has(id)) map.setFeatureState({ source, id }, { selected: true });
  pushed.selected = selected;
}

/**
 * Brings the sources and layers of `map` up to date with `data`, doing only what is needed: a source that is not there yet (a
 * style has just loaded) is added with its data, one that is gets `setData` if its data is not the one it has; layers are added
 * once, only their visibility changes when the view changes between a day and a period, and only their opacity when a heat layer
 * comes or goes (a heat with no cell in it has no glow, so it does not fade them). The points of edit mode are one source like the others, set
 * in one `setData` as they come; which are selected is the feature state of their ids (`syncSelection`), re-applied when a style has loaded. Call it
 * once a style has loaded, with a fresh `pushed` for it, and again whenever the data or the selection changes.
 */
function syncData(map: MapLibreMap, data: MapData, dark: boolean, pushed: Pushed, selected: ReadonlySet<number>): void {
  const view: RouteView = data.view ?? (data.stops === undefined ? "range" : "day");
  const collections = {
    routes: data.routes,
    stops: data.stops ?? EMPTY_STOPS,
    places: data.places ?? EMPTY_PLACES,
    heat: data.heat ?? EMPTY_HEAT,
    editPoints: data.editPoints ?? EMPTY_EDIT_POINTS,
  };
  for (const key of SOURCE_KEYS) {
    const collection = collections[key];
    if (pushed.collections[key] === collection) continue;
    const source = map.getSource<GeoJSONSource>(SOURCE_IDS[key]);
    if (source === undefined) map.addSource(SOURCE_IDS[key], { type: "geojson", data: collection });
    else source.setData(collection);
    pushed.collections[key] = collection;
    if (key === "editPoints" && pushed.selected.size > 0) {
      map.removeFeatureState({ source: SOURCE_IDS.editPoints }); // other points: the state was of the ids of the ones that went
      pushed.selected = NO_SELECTION;
    }
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
  syncSelection(map, selected, pushed);
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

/**
 * The air a fit leaves at the left and at the right while the drawing has labelled dots, in pixels: what the dot at an edge of the fit takes
 * beyond its position, which is its radius (16 px at the most) and its outline. The labels point toward the inside of the drawing (`withSides`
 * of `layers`), so none of them needs room beyond the outermost dots. MapLibre never moves a label back onto the screen once it is beyond its
 * edge, which is what a label that pointed outward at an edge would have needed the width of the label in air for: so much that a phone would
 * have no room left to fit anything into.
 */
const LABEL_AIR_PX = 24;

/** Whether any dot of the drawing carries a label (the places that the period's, the trips' and a trip's dots name): they are what the air is for. */
const hasLabels = (data: MapData): boolean => data.places?.features.some((dot) => dot.properties.label !== undefined) ?? false;

/**
 * The padding that a fit is made with: what covers the map, and for a drawing with labelled dots some air at each side, for the outermost
 * dots to lie in whole. The air is for the camera alone: the controls are set in by the padding that covers the map (`paddingVariables`),
 * which does not change.
 */
function fitPadding(padding: MapPadding, data: MapData): MapPadding {
  return hasLabels(data) ? { ...padding, left: padding.left + LABEL_AIR_PX, right: padding.right + LABEL_AIR_PX } : padding;
}

function fit(map: MapLibreMap, bounds: Bounds, padding: MapPadding, data: MapData): void {
  map.fitBounds(bounds, { padding: fitPadding(padding, data), maxZoom: FIT_MAX_ZOOM, duration: FIT_DURATION_MS });
}

/**
 * The place that a tap at `point` (pixels of the map) opens: the dot or the pin nearest to it, of those that are drawn within the slop of it (`taps`),
 * or undefined when there is none. The dot says the place as its `id`; a pin's `id` is a stay's (the first of them), so it says it as `placeId`. A
 * feature that says no place is passed over: one with no id, and one whose id is not a place's (0 or less: the dots of the cities of the trips are
 * `id: 0`), so that the place next to such a dot is the one that is found, and a tap on a dot of a city, or the pointer over it, is a tap on the map.
 */
function placeAt(map: MapLibreMap, point: { x: number; y: number }): number | undefined {
  return nearestTapped(map, point, TAPPABLE_LAYERS, (feature) => {
    const id: unknown = feature.properties[feature.layer.id === LAYER_IDS.places ? "id" : "placeId"];
    if (typeof id !== "number" || id <= 0 || feature.geometry.type !== "Point") return undefined;
    const [lon, lat] = feature.geometry.coordinates;
    return { value: id, at: [lon!, lat!] };
  });
}

/** What `foldCreditEarly` gives back: `arm` for when the map first shows its real style, `stop` for when the map goes. */
interface CreditFold {
  arm: () => void;
  stop: () => void;
}

/**
 * Folds the credit of `map` (whose element is `container`) sooner than MapLibre does, which does it only when the map is dragged: once,
 * five seconds after `arm` is called or at once when the user first touches the map, whichever comes first. The caller arms it when the
 * map first shows its real style, and not for the plain one that stands in for a style that could not be had: the credit is to be open
 * when the map that it credits first appears, whatever was tapped on the blank map before, and MapLibre never opens a folded credit again
 * by itself: so `arm` opens it, if the blank map's drag (MapLibre folds it on one) or ⓘ has folded it. Open is two things, as MapLibre's
 * `_updateCompact` makes it at the start: the class that shows the text, and the `open` of the `<details>`, which an ⓘ tap takes away too
 * (a closed `<details>` draws nothing but its summary, whatever the style sheet says; a drag takes only the class). A touch is a tap
 * (`click`) or a move that the user makes (`movestart` with the event of the pointer, wheel or keyboard in it: a pinch, a wheel, a double
 * tap, a drag); the app's own `fitBounds` has none and leaves it open. A tap on the ⓘ button ends it as well (it is not a tap on the map
 * to MapLibre): whoever closes and opens the credit again is not to have it folded under their finger.
 * It folds as MapLibre's drag does, by taking away the class that has it open, so that its own ⓘ button still shows it again. This is done
 * once for a map: afterwards a credit that was opened with ⓘ is MapLibre's again, and folds on the next drag. `stop` undoes it all (the
 * timer, the listeners), for when the map is removed, and keeps a later `arm` from starting anything.
 */
function foldCreditEarly(map: MapLibreMap, container: HTMLElement): CreditFold {
  let state: "waiting" | "armed" | "done" = "waiting";
  let timer: ReturnType<typeof setTimeout> | undefined;
  let infoButton: Element | null = null;
  const stop = (): void => {
    state = "done";
    clearTimeout(timer);
    infoButton?.removeEventListener("click", stop);
    map.off("movestart", onMove);
    map.off("click", fold);
  };
  const fold = (): void => {
    stop();
    container.querySelector(CREDIT_SELECTOR)?.classList.remove(CREDIT_OPEN_CLASS);
  };
  const onMove = ({ originalEvent }: { originalEvent?: unknown }): void => {
    if (originalEvent !== undefined) fold();
  };
  const arm = (): void => {
    if (state !== "waiting") return; // the first real style only: the one of another colour scheme is no new map
    state = "armed";
    const credit = container.querySelector(CREDIT_SELECTOR);
    if (credit?.classList.contains(CREDIT_COMPACT_CLASS)) {
      // Open when the map first appears, whatever it was before: as MapLibre makes it, the class and the `open` of the `<details>` both.
      credit.classList.add(CREDIT_OPEN_CLASS);
      credit.setAttribute("open", "");
    }
    timer = setTimeout(fold, CREDIT_OPEN_MS);
    infoButton = container.querySelector(CREDIT_BUTTON_SELECTOR);
    infoButton?.addEventListener("click", stop);
    map.on("movestart", onMove);
    map.on("click", fold);
  };
  return { arm, stop };
}

// --- The map ---

/** Where the style comes from: an address, a reason it cannot be had, or nothing yet (the config is still on its way). */
type StyleSource = { url: string } | { error: Error } | null;

interface SurfaceProps extends Omit<MapViewProps, "styleUrl"> {
  source: StyleSource;
  dark: boolean;
  /** Asks again for where the style comes from, when that is what failed (the config): the style is asked for once it is there. */
  retrySource?: () => void;
}

function MapSurface({
  ref,
  source,
  retrySource,
  dark,
  data,
  fitTo = null,
  home,
  padding = NO_PADDING,
  heatToggle,
  edit,
  onPlaceTap,
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
  /** What has failed and is not being tried again yet; null while all is well, and while an attempt is on its way. */
  const failureRef = useRef<Failure | null>(null);
  /** The fold of the credit of the map that there is (see `foldCreditEarly`): the style arms it once it shows the real map. */
  const creditFoldRef = useRef<CreditFold | null>(null);
  /** The style the map can be drawn on: the last one that loaded, or else the plain one that it fell back to; null before it has any. */
  const shownRef = useRef<StyleSpecification | null>(null);
  // One count for each thing there is to try again. A change of either is what runs the effect again.
  const [mapAttempts, setMapAttempts] = useState(0);
  const [styleAttempts, setStyleAttempts] = useState(0);

  const { routes, stops, places, heat, view, editPoints } = data;
  const selected = edit?.selected ?? NO_SELECTION;
  const bounds = useMemo(() => (fitTo === null ? null : boundsOf(fitTo)), [fitTo]);
  const homeBounds = useMemo(() => (home === undefined ? bounds : home === null ? null : boundsOf(home)), [home, bounds]);

  const latest = useLatest({ data, dark, padding, edit, selected, onPlaceTap, onStyleError, onStyleLoad, source, retrySource, bounds, homeBounds, load });
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
    failureRef.current = null; // an attempt is on its way (the first, or one that was asked for)
    showState(rootRef.current, "loading");
    const unavailable = (error: unknown): void => {
      // No WebGL, most likely, or no MapLibre. The page goes on without a map, and tries again when it is asked to (`retry`).
      failureRef.current = "map";
      showState(rootRef.current, "unavailable");
      latest.current.onStyleError?.(toError(error), false);
    };
    // A loader that throws, as one that rejects, is a MapLibre that cannot be had.
    new Promise<MapLibreModule>((resolve) => resolve(latest.current.load())).then(
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
          made.touchZoomRotate.disableRotation();
          creditFoldRef.current = foldCreditEarly(made, container);
          // MapLibre drops its style when the context is lost, and sets it again when the context is back; until then it is not to be touched.
          made.on("webglcontextlost", () => {
            readyRef.current = false;
          });
          readyRef.current = false;
          pushedRef.current = newPushed();
          shownRef.current = null;
          showState(rootRef.current, "loading");
          setMap(made); // the effects below take it from here: the style, the data, and the camera, each with the latest of what was given
        } catch (error) {
          // Whatever fails in making the map, or in setting it up, is reported and not thrown: nobody is waiting on this promise to catch
          // it. A map that was made and could not be set up is given back (it holds a WebGL context) and not kept.
          creditFoldRef.current?.stop();
          creditFoldRef.current = null;
          try {
            made?.remove();
          } catch {
            // it was not set up far enough to be removed; the page goes on without it
          }
          made = null;
          unavailable(error);
        }
      },
      (error: unknown) => {
        if (!cancelled) unavailable(error);
      },
    );
    return () => {
      cancelled = true;
      creditFoldRef.current?.stop(); // the timer and the listeners go with the map
      creditFoldRef.current = null;
      made?.remove();
      readyRef.current = false;
    };
  }, [latest, mapAttempts]);

  // The style: fetched here, so that English labels can be put in it and a failure is ours to handle, then handed to the map.
  // A new one (the colour scheme changed) replaces the old one only once it is fetched, and the sources and layers come back
  // with the latest data when it has loaded. A style that cannot be had leaves the map with what it shows (see `fail`), and is
  // asked for again when the map is told to try again (`retry`).
  useEffect(() => {
    if (map === null || (styleUrl === null && !styleFailed)) return;
    const request = new AbortController();
    // fetching: the style is on its way, and the map still has what it had. applying: the map has the new style, and neither loaded
    // it nor refused it yet. ready: loaded. failed: reported.
    let phase: "fetching" | "applying" | "ready" | "failed" = "fetching";
    let applying: StyleSpecification | null = null;
    failureRef.current = null; // an attempt is on its way
    readyRef.current = false;
    showState(rootRef.current, "loading");

    const fail = (error: Error): void => {
      if (phase === "failed") return;
      const replaced = phase === "applying"; // the map was given the style that failed, which took the one it had away
      phase = "failed";
      failureRef.current = "style";
      showState(rootRef.current, "unavailable");
      // Whether there is a basemap to keep: a style that loaded, and not the plain one that stands in for one that did not.
      latest.current.onStyleError?.(error, shownRef.current !== null && shownRef.current !== FALLBACK_STYLE);
      if (!replaced && shownRef.current !== null) {
        // The map has not been touched, and what it shows is a style that works (the one of the other colour scheme, or the plain one
        // of an earlier failure): it stays, and draws what comes, instead of being swapped for a blank map.
        readyRef.current = true;
        try {
          syncData(map, latest.current.data, latest.current.dark, pushedRef.current, latest.current.selected);
        } catch {
          readyRef.current = false; // the context was lost meanwhile: MapLibre sets its style again, and that loads (`styleLoaded`)
        }
        return;
      }
      readyRef.current = false;
      // The style that worked before (MapLibre dropped it for the one that failed), or else a plain one for the routes to lie on. Not
      // at once: MapLibre may be in the middle of reporting the problems of the style, one error event after the other, and takes its
      // style away from under that; the events that are left would then have no listener and be logged.
      const back = shownRef.current ?? FALLBACK_STYLE;
      shownRef.current = back;
      queueMicrotask(() => {
        if (!request.signal.aborted) map.setStyle(back, { diff: false });
      });
    };
    const styleLoaded = (): void => {
      if (phase === "applying") {
        phase = "ready";
        shownRef.current = applying;
      }
      // The credit's five seconds begin when the map first shows a style of its own, and not at the plain one that stands in for a style that
      // could not be had (the credit is there on a blank map too, and a tap on it must not fold it for the map that Retry brings).
      if (shownRef.current !== null && shownRef.current !== FALLBACK_STYLE) creditFoldRef.current?.arm();
      readyRef.current = true;
      showState(rootRef.current, phase === "failed" ? "unavailable" : "ready");
      pushedRef.current = newPushed();
      addHomeImage(map); // each style has its own images: the house comes before the layer that draws it
      syncData(map, latest.current.data, latest.current.dark, pushedRef.current, latest.current.selected);
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
          applying = style;
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
  }, [map, styleUrl, styleFailed, dark, latest, styleAttempts]);

  // A tap on a place opens it, and in edit mode a tap on a point selects it (or takes it off): the points are what a tap is for then, and no place
  // is opened. The listeners are the map's, not the style's: they are made once for each map and stay through every style (a theme switch drops
  // the layers, and they are looked for by id at the time of a click). `click` is MapLibre's, which is not fired for a drag that ends where it
  // began (a pan that happens to end over a dot) and is what a tap is to it. The pointer over a place, or over a point in edit mode, asks what a
  // click would find, so that it says what a click would do.
  useEffect(() => {
    if (map === null) return;
    const canvas = map.getCanvas();
    const onClick = ({ point }: MapMouseEvent): void => {
      const { edit: editing, data: current } = latest.current;
      if (editing !== undefined) {
        const id = editPointAt(map, point, current.editPoints);
        if (id !== undefined) editing.onToggle(id);
        return;
      }
      const id = placeAt(map, point);
      if (id !== undefined) latest.current.onPlaceTap?.(id);
    };
    const onMove = ({ point }: MapMouseEvent): void => {
      const { edit: editing, data: current } = latest.current;
      const over = editing !== undefined ? editPointAt(map, point, current.editPoints) : placeAt(map, point);
      const cursor = over === undefined ? "" : "pointer";
      if (canvas.style.cursor !== cursor) canvas.style.cursor = cursor;
    };
    const onOut = (): void => {
      canvas.style.cursor = "";
    };
    map.on("click", onClick);
    map.on("mousemove", onMove);
    map.on("mouseout", onOut);
    return () => {
      map.off("click", onClick);
      map.off("mousemove", onMove);
      map.off("mouseout", onOut);
    };
  }, [map, latest]);

  // Tries again what failed, once. Whoever asks (the owner's Retry, the page coming back, the network coming back) gets one attempt at
  // most, and none while there is nothing to put right or an attempt is on its way (`failureRef` is null then), so that a phone that
  // wakes up and says both does not ask twice. An attempt that fails sets `failureRef` again; nothing tries again until the next ask.
  const retry = useCallback((): void => {
    const failure = failureRef.current;
    if (failure === null) return;
    failureRef.current = null;
    const { source: current, retrySource: refetchSource } = latest.current;
    if (failure === "map") setMapAttempts((count) => count + 1);
    else if (current !== null && "error" in current && refetchSource !== undefined) refetchSource(); // the style is asked for once the config is there
    else setStyleAttempts((count) => count + 1);
  }, [latest]);
  useImperativeHandle(ref, () => ({ retry }), [retry]);

  // A page that was in the background comes back, or the network does: reasons enough to try again what failed, which the VPN not yet
  // being up when the app was opened, or a blip, would have left blank. Not a reason to try again a map that works.
  useEffect(() => {
    const onVisibilityChange = (): void => {
      if (document.visibilityState === "visible") retry();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("online", retry);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("online", retry);
    };
  }, [retry]);

  // New data goes to the sources it belongs to. While there is no style the map is not touched: the style that loads picks up
  // the latest data by itself.
  useEffect(() => {
    if (map !== null && readyRef.current) {
      syncData(map, { routes, stops, places, heat, view, editPoints }, latest.current.dark, pushedRef.current, selected);
    }
  }, [map, routes, stops, places, heat, view, editPoints, selected, latest]);

  // A map that was not there yet when `fitTo` was given is brought to it, with the padding of now, the moment it is there.
  useEffect(() => {
    const target = latest.current.bounds;
    if (map !== null && target !== null) fit(map, target, latest.current.padding, latest.current.data);
  }, [map, fitTo, latest]); // each new `fitTo` moves the map, whether or not its box is the one it is already at; padding does not

  const recenter = (): void => {
    const target = latest.current.homeBounds;
    if (map !== null && target !== null) fit(map, target, latest.current.padding, latest.current.data);
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
        {edit !== undefined && <EditControls edit={edit} map={map} points={editPoints} host={rootRef} within={padding} />}
      </div>
    </div>
  );
}

/** The colour scheme the style follows, and the style of it that `/api/config` gives. */
function ConfiguredMap(props: Omit<SurfaceProps, "source" | "retrySource">): ReactElement {
  const config = useConfig();
  const { refetch } = config;
  const retrySource = useCallback(() => void refetch(), [refetch]);
  let source: StyleSource = null;
  if (config.data !== undefined) {
    source = { url: props.dark ? config.data.mapStyleDark : config.data.mapStyleLight };
  } else if (config.isError) {
    source = { error: toError(config.error) };
  }
  return <MapSurface {...props} source={source} retrySource={retrySource} />;
}

/**
 * The map: MapLibre, used directly, full size of its parent. One map is made and kept; it loads the light or the dark style of
 * `/api/config` by the colour scheme of the system, switching as that does, with English labels. Whatever the style, the routes,
 * pins, dots and heat of `data` are drawn on top (the heat under the routes, which it fades), and the map moves to show `fitTo` within
 * `padding`. OpenStreetMap is credited. What fails (MapLibre, the map, a style) is told (`onStyleError`) and tried again when the page or
 * the network comes back, and on `ref`'s `retry`: an app on a home screen has no reload.
 *
 * Without `styleUrl` it reads the config, so it needs a `QueryClientProvider`; with one it needs nothing.
 */
export function MapView({ styleUrl, ...props }: MapViewProps): ReactElement {
  const dark = usePrefersDark();
  if (styleUrl === undefined) return <ConfiguredMap {...props} dark={dark} />;
  return <MapSurface {...props} dark={dark} source={{ url: styleUrl }} />;
}
