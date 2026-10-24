import type {
  DayResponse,
  HeatResponse,
  LonLat,
  Mode,
  RangeResponse,
} from "../api/types";
import type { StyleSpecification } from "./style";

// --- GeoJSON ---
// Only what the map draws: points and lines, with the properties the layers below read. `maplibre-gl` takes these as they are.

export type Point = { type: "Point"; coordinates: LonLat };
export type LineString = { type: "LineString"; coordinates: LonLat[] };
export type Geometry = Point | LineString;
export type Feature<G extends Geometry, P> = { type: "Feature"; geometry: G; properties: P };
export type FeatureCollection<G extends Geometry, P> = { type: "FeatureCollection"; features: Feature<G, P>[] };

/** The mode of a move, or `unknown` for one the server could not tell. */
export type RouteMode = Mode | "unknown";

export type RouteProperties = { id: number; mode: RouteMode };
/** `order` counts the pins of the day from 1; `id` is the id of the stay; `name` is null for a place that has none (yet). */
export type StopProperties = { order: number; name: string | null; id: number };
/** `radius` is in pixels; `label` is only there for the places that are named on the map. */
export type PlaceProperties = { id: number; radius: number; label?: string };
export type HeatProperties = { weight: number };

export type RouteCollection = FeatureCollection<LineString, RouteProperties>;
export type StopCollection = FeatureCollection<Point, StopProperties>;
export type PlaceCollection = FeatureCollection<Point, PlaceProperties>;
export type HeatCollection = FeatureCollection<Point, HeatProperties>;

// --- Colours (the mockups) ---

export const MODE_COLORS: Record<Mode, string> = {
  walk: "#34C759",
  cycle: "#30B0C7",
  drive: "#007AFF",
  flight: "#FF9500",
};
const UNKNOWN_MODE_COLOR = "#8E8E93";
export const PIN_COLOR = "#FF375F";
const WHITE = "#FFFFFF";

// --- Data for the sources ---

function point<P>(lon: number, lat: number, properties: P): Feature<Point, P> {
  return { type: "Feature", properties, geometry: { type: "Point", coordinates: [lon, lat] } };
}

/** A move is a line only with two positions or more; the server never sends fewer, and the map would refuse them. */
function route(id: number, mode: Mode | null, geometry: LonLat[]): Feature<LineString, RouteProperties>[] {
  if (geometry.length < 2) return [];
  return [{ type: "Feature", properties: { id, mode: mode ?? "unknown" }, geometry: { type: "LineString", coordinates: geometry } }];
}

/**
 * The routes of a day (every move, with its mode) and its stops: a pin for each stay at a known place, numbered from 1 in the
 * order of the day. A stay at a position that matched no place has no position to draw; it gets no pin and no number. Gaps are
 * not drawn: the day is never bridged with a line that was not travelled.
 */
export function dayGeoJson(day: DayResponse): { routes: RouteCollection; stops: StopCollection } {
  const routes: RouteCollection = { type: "FeatureCollection", features: [] };
  const stops: StopCollection = { type: "FeatureCollection", features: [] };
  for (const segment of day.segments) {
    if (segment.kind === "move") {
      routes.features.push(...route(segment.id, segment.mode, segment.geometry));
    } else if (segment.kind === "stay" && segment.place !== null) {
      const { place } = segment;
      stops.features.push(point(place.lon, place.lat, { order: stops.features.length + 1, name: place.name, id: segment.id }));
    }
  }
  return { routes, stops };
}

/** How many places carry a name on the map. */
const LABELLED_PLACES = 5;
const MIN_DOT_RADIUS = 4;
const DOT_RADIUS_RANGE = 12;

/**
 * The routes of a period, and a dot for each place whose radius grows with the time spent there: `4 + 12 * sqrt(seconds / max)`
 * pixels (so that the area follows the time), where `max` is the most time spent in any place. The five places with the most
 * time carry a label, their name or else their city, when they have either.
 */
export function rangeGeoJson(range: RangeResponse): { routes: RouteCollection; places: PlaceCollection } {
  const routes: RouteCollection = {
    type: "FeatureCollection",
    features: range.moves.flatMap((move) => route(move.id, move.mode, move.geometry)),
  };

  const max = range.places.reduce((most, place) => Math.max(most, place.seconds), 0);
  // The sort is stable, so places that spent the same time are labelled in the order the server gave them.
  const labelled = new Set(
    [...range.places].sort((a, b) => b.seconds - a.seconds).slice(0, LABELLED_PLACES),
  );
  const places: PlaceCollection = {
    type: "FeatureCollection",
    features: range.places.map((place) => {
      const radius = max > 0 ? MIN_DOT_RADIUS + DOT_RADIUS_RANGE * Math.sqrt(place.seconds / max) : MIN_DOT_RADIUS;
      const label = labelled.has(place) ? (place.name ?? place.city ?? undefined) : undefined;
      return point(place.lon, place.lat, label === undefined ? { id: place.id, radius } : { id: place.id, radius, label });
    }),
  };
  return { routes, places };
}

/** A point for each cell of the heat, weighing what share of the most time spent in any cell its time is (0 to 1). */
export function heatGeoJson(heat: HeatResponse): HeatCollection {
  const { maxSeconds } = heat;
  return {
    type: "FeatureCollection",
    features: heat.cells.map(([lon, lat, seconds]) => point(lon, lat, { weight: maxSeconds > 0 ? seconds / maxSeconds : 0 })),
  };
}

// --- Sources and layers ---

/** The ids of the GeoJSON sources the map adds (prefixed, so that no style of a map server has the same). */
export const SOURCE_IDS = {
  routes: "sporer-routes",
  stops: "sporer-stops",
  places: "sporer-places",
  heat: "sporer-heat",
} as const;

/** The ids of the layers, in the order they are drawn: the first is at the bottom. */
export const LAYER_IDS = {
  heat: "sporer-heat",
  routeCasing: "sporer-route-casing",
  dayRoute: "sporer-day-route",
  dayFlight: "sporer-day-flight",
  rangeRoute: "sporer-range-route",
  rangeFlight: "sporer-range-flight",
  places: "sporer-places",
  placeLabels: "sporer-place-labels",
  stops: "sporer-stops",
  stopNames: "sporer-stop-names",
  stopNumbers: "sporer-stop-numbers",
} as const;

/** A day is drawn bold, with pins; a period (week, month, year, range) is drawn faint, with dots. */
export type RouteView = "day" | "range";

export type LayerSpecification = StyleSpecification["layers"][number];
type LineLayer = Extract<LayerSpecification, { type: "line" }>;
type FilterSpecification = NonNullable<LineLayer["filter"]>;
type LineColor = NonNullable<NonNullable<LineLayer["paint"]>["line-color"]>;

const DAY_ROUTE_WIDTH = 4;
const CASING_WIDTH = 7;
const RANGE_ROUTE_WIDTH = 2.4;
const RANGE_ROUTE_OPACITY = 0.35;
/** Dashes and gaps, in multiples of the line's width. */
const FLIGHT_DASH: [number, number] = [2, 2];

const IS_FLIGHT: FilterSpecification = ["==", ["get", "mode"], "flight"];
const IS_NOT_FLIGHT: FilterSpecification = ["!=", ["get", "mode"], "flight"];

/** The colour of a line by the mode of its feature. */
const MODE_COLOR: LineColor = [
  "match",
  ["get", "mode"],
  "walk", MODE_COLORS.walk,
  "cycle", MODE_COLORS.cycle,
  "drive", MODE_COLORS.drive,
  "flight", MODE_COLORS.flight,
  UNKNOWN_MODE_COLOR,
];

/** The font OpenFreeMap serves glyphs for; where a map server has no such font, MapLibre draws the text itself. */
const BOLD_FONT = ["Noto Sans Bold"];
const LABEL_SIZE = 12;

/**
 * Every layer the map draws, from the bottom up: the heat, the routes, the place dots with their labels, the stop pins with their
 * numbers and names. Layers of the routes of the other view are there but hidden, so that going from a day to a month, or back,
 * only changes their visibility. `dark` is for the text on the map, which is dark on a light map and light on a dark one.
 */
export function layerSpecs(view: RouteView, dark: boolean): LayerSpecification[] {
  const shown = (shownIn: RouteView): "visible" | "none" => (view === shownIn ? "visible" : "none");
  const ink = dark ? "#F2F2F7" : "#1C1C1E";
  const halo = dark ? "#1C1C1E" : WHITE;
  const labelPaint = { "text-color": ink, "text-halo-color": halo, "text-halo-width": 2 };

  return [
    {
      id: LAYER_IDS.heat,
      type: "heatmap",
      source: SOURCE_IDS.heat,
      paint: {
        "heatmap-weight": ["get", "weight"],
        "heatmap-intensity": ["interpolate", ["linear"], ["zoom"], 0, 0.6, 14, 2.4],
        "heatmap-radius": ["interpolate", ["linear"], ["zoom"], 0, 6, 8, 16, 14, 44],
        "heatmap-opacity": 0.85,
        "heatmap-color": [
          "interpolate", ["linear"], ["heatmap-density"],
          0, "rgba(255,45,85,0)",
          0.2, "rgba(255,45,85,0.35)",
          0.5, "#FF5A1F",
          0.8, "#FFC233",
          1, "#FFF6C2",
        ],
      },
    },
    {
      id: LAYER_IDS.routeCasing,
      type: "line",
      source: SOURCE_IDS.routes,
      filter: IS_NOT_FLIGHT, // a solid casing under a dashed line would fill its gaps
      layout: { "line-cap": "round", "line-join": "round", visibility: shown("day") },
      paint: { "line-color": WHITE, "line-width": CASING_WIDTH },
    },
    {
      id: LAYER_IDS.dayRoute,
      type: "line",
      source: SOURCE_IDS.routes,
      filter: IS_NOT_FLIGHT,
      layout: { "line-cap": "round", "line-join": "round", visibility: shown("day") },
      paint: { "line-color": MODE_COLOR, "line-width": DAY_ROUTE_WIDTH },
    },
    {
      id: LAYER_IDS.dayFlight,
      type: "line",
      source: SOURCE_IDS.routes,
      filter: IS_FLIGHT,
      layout: { "line-cap": "butt", "line-join": "round", visibility: shown("day") }, // round caps would close the gaps
      paint: { "line-color": MODE_COLORS.flight, "line-width": DAY_ROUTE_WIDTH, "line-dasharray": FLIGHT_DASH },
    },
    {
      id: LAYER_IDS.rangeRoute,
      type: "line",
      source: SOURCE_IDS.routes,
      filter: IS_NOT_FLIGHT,
      layout: { "line-cap": "round", "line-join": "round", visibility: shown("range") },
      paint: { "line-color": MODE_COLOR, "line-width": RANGE_ROUTE_WIDTH, "line-opacity": RANGE_ROUTE_OPACITY },
    },
    {
      id: LAYER_IDS.rangeFlight,
      type: "line",
      source: SOURCE_IDS.routes,
      filter: IS_FLIGHT,
      layout: { "line-cap": "butt", "line-join": "round", visibility: shown("range") },
      paint: {
        "line-color": MODE_COLORS.flight,
        "line-width": RANGE_ROUTE_WIDTH,
        "line-opacity": RANGE_ROUTE_OPACITY,
        "line-dasharray": FLIGHT_DASH,
      },
    },
    {
      id: LAYER_IDS.places,
      type: "circle",
      source: SOURCE_IDS.places,
      layout: { "circle-sort-key": ["-", ["get", "radius"]] }, // the small dots on top of the big ones
      paint: {
        "circle-radius": ["get", "radius"],
        "circle-color": PIN_COLOR,
        "circle-opacity": 0.92,
        "circle-stroke-color": WHITE,
        "circle-stroke-width": 2,
      },
    },
    {
      id: LAYER_IDS.placeLabels,
      type: "symbol",
      source: SOURCE_IDS.places,
      filter: ["has", "label"],
      layout: {
        "text-field": ["get", "label"],
        "text-font": BOLD_FONT,
        "text-size": LABEL_SIZE,
        "text-variable-anchor": ["left", "right", "top", "bottom"],
        "text-radial-offset": ["+", ["/", ["get", "radius"], LABEL_SIZE], 0.3], // clear of the dot, in ems
        "text-justify": "auto",
      },
      paint: labelPaint,
    },
    {
      id: LAYER_IDS.stops,
      type: "circle",
      source: SOURCE_IDS.stops,
      paint: {
        "circle-radius": 12,
        "circle-color": PIN_COLOR,
        "circle-stroke-color": WHITE,
        "circle-stroke-width": 3,
      },
    },
    {
      id: LAYER_IDS.stopNames,
      type: "symbol",
      source: SOURCE_IDS.stops,
      filter: ["has", "name"],
      layout: {
        "text-field": ["get", "name"],
        "text-font": BOLD_FONT,
        "text-size": LABEL_SIZE,
        "text-anchor": "left", // to the right of the pin, as in the mockup; two pins at one place are named once
        "text-offset": [1.5, 0], // the pin's radius and outline, and a little more, in ems
        "text-justify": "left",
        "symbol-sort-key": ["get", "order"],
      },
      paint: labelPaint,
    },
    {
      // The last layer, which MapLibre places first: no name or label hides a number. And no number is left out for another one
      // being near: the timeline shows every number, so the map does.
      id: LAYER_IDS.stopNumbers,
      type: "symbol",
      source: SOURCE_IDS.stops,
      layout: {
        "text-field": ["to-string", ["get", "order"]],
        "text-font": BOLD_FONT,
        "text-size": LABEL_SIZE,
        "text-allow-overlap": true,
      },
      paint: { "text-color": WHITE },
    },
  ];
}
