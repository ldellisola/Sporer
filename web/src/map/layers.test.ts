import { describe, expect, test } from "vitest";
import type {
  DayResponse,
  DaySegment,
  HeatResponse,
  LonLat,
  MoveSegment,
  PlaceRef,
  RangePlace,
  RangeResponse,
  StaySegment,
} from "../api/types";
import {
  dayGeoJson,
  heatGeoJson,
  layerSpecs,
  LAYER_IDS,
  MODE_COLORS,
  PIN_COLOR,
  placeGeoJson,
  rangeGeoJson,
  ROUTE_LAYERS,
  routeOpacity,
  SOURCE_IDS,
  stopOrders,
} from "./layers";

const SUMMARY = { places: 0, distanceMeters: 0, movingSeconds: 0 };
const WHEN = { start: "2026-10-22T08:00:00Z", end: "2026-10-22T09:00:00Z", startTimeZone: "Europe/Oslo", endTimeZone: "Europe/Oslo" };

function place(id: number, name: string | null, lon: number, lat: number, city: string | null = null): PlaceRef {
  return { id, name, city, country: null, lat, lon };
}

function stay(id: number, at: PlaceRef | null): StaySegment {
  return { id, kind: "stay", ...WHEN, place: at };
}

function move(id: number, mode: MoveSegment["mode"], geometry: LonLat[]): MoveSegment {
  return { id, kind: "move", ...WHEN, mode, distanceMeters: 1000, geometry };
}

function day(...segments: DaySegment[]): DayResponse {
  return { date: "2026-10-22", timeZone: "Europe/Oslo", state: "done", summary: SUMMARY, segments };
}

const HOME = place(1, "Home", 10.0, 59.0);
const CAFE = place(2, "Café", 10.1, 59.1);
const OFFICE = place(3, null, 10.2, 59.2, "Oslo");

describe("MODE_COLORS", () => {
  test("MODE_COLORS_use_the_mockup_palette", () => {
    expect(MODE_COLORS).toEqual({ walk: "#34C759", cycle: "#30B0C7", drive: "#007AFF", flight: "#FF9500" });
    expect(PIN_COLOR).toBe("#FF375F");
  });
});

describe("dayGeoJson", () => {
  test("dayGeoJson_numbers_stops_and_tags_modes", () => {
    const { routes, stops } = dayGeoJson(
      day(
        stay(10, HOME),
        move(11, "walk", [[10.0, 59.0], [10.05, 59.05]]),
        stay(12, CAFE),
        move(13, "drive", [[10.1, 59.1], [10.15, 59.15], [10.2, 59.2]]),
        stay(14, OFFICE),
        move(15, null, [[10.2, 59.2], [10.0, 59.0]]),
        stay(16, HOME),
      ),
    );

    expect(routes.type).toBe("FeatureCollection");
    expect(routes.features).toEqual([
      { type: "Feature", properties: { id: 11, mode: "walk" }, geometry: { type: "LineString", coordinates: [[10.0, 59.0], [10.05, 59.05]] } },
      { type: "Feature", properties: { id: 13, mode: "drive" }, geometry: { type: "LineString", coordinates: [[10.1, 59.1], [10.15, 59.15], [10.2, 59.2]] } },
      { type: "Feature", properties: { id: 15, mode: "unknown" }, geometry: { type: "LineString", coordinates: [[10.2, 59.2], [10.0, 59.0]] } },
    ]);

    // The day starts and ends at home: one pin for the place, with both numbers (ruling P2-R20).
    expect(stops.type).toBe("FeatureCollection");
    expect(stops.features).toEqual([
      { type: "Feature", properties: { order: 1, label: "1 · 4", name: "Home", id: 10, placeId: 1 }, geometry: { type: "Point", coordinates: [10.0, 59.0] } },
      { type: "Feature", properties: { order: 2, label: "2", name: "Café", id: 12, placeId: 2 }, geometry: { type: "Point", coordinates: [10.1, 59.1] } },
      { type: "Feature", properties: { order: 3, label: "3", name: null, id: 14, placeId: 3 }, geometry: { type: "Point", coordinates: [10.2, 59.2] } },
    ]);
  });

  test("dayGeoJson_draws_a_move_whose_mode_the_server_left_out_as_unknown", () => {
    const { mode: _left, ...withoutMode } = move(5, "walk", [[10, 59], [10.1, 59.1]]);

    const { routes } = dayGeoJson(day(withoutMode));

    expect(routes.features.map((feature) => feature.properties)).toEqual([{ id: 5, mode: "unknown" }]);
  });

  test("dayGeoJson_merges_the_stops_of_one_place_into_one_pin_that_lists_their_numbers", () => {
    const { stops } = dayGeoJson(
      day(
        stay(1, HOME),
        stay(2, CAFE),
        stay(3, HOME),
        stay(4, null), // no pin, no number
        stay(5, HOME),
        stay(6, CAFE),
      ),
    );

    expect(stops.features.map((feature) => [feature.properties.label, feature.properties.order, feature.properties.id])).toEqual([
      ["1 · 3 · 4", 1, 1], // in the order of the day, at the first of its stays: the stay at no place (4) took no number
      ["2 · 5", 2, 2],
    ]);
  });

  test("dayGeoJson_gives_each_pin_the_id_of_its_place_which_is_not_the_id_of_its_stay", () => {
    // A tap on a pin opens its place: the `id` of the pin is a stay's (the first of its stays), and a merged pin is the one place.
    const { stops } = dayGeoJson(day(stay(40, HOME), stay(41, CAFE), stay(42, HOME)));

    expect(stops.features.map((feature) => [feature.properties.id, feature.properties.placeId])).toEqual([
      [40, 1],
      [41, 2],
    ]);
  });

  test("dayGeoJson_keeps_apart_places_that_only_share_a_name_or_a_spot", () => {
    const other = place(9, "Home", 10.0, 59.0); // another place, same name and position: a merge of the places is the server's
    const { stops } = dayGeoJson(day(stay(1, HOME), stay(2, other)));

    expect(stops.features.map((feature) => feature.properties.label)).toEqual(["1", "2"]);
  });

  test("dayGeoJson_numbers_only_the_stops_it_can_draw_and_skips_gaps_and_degenerate_lines", () => {
    const { routes, stops } = dayGeoJson(
      day(
        stay(1, null), // a stay at a position that matched no place has no position to draw
        { id: 2, kind: "gap", ...WHEN, from: { lat: 59, lon: 10 }, to: { lat: 60, lon: 11 } },
        move(3, "walk", [[10, 59]]), // one point is not a line
        move(4, "walk", []),
        stay(5, CAFE),
        stay(6, HOME),
      ),
    );

    expect(routes.features).toEqual([]);
    expect(stops.features.map((feature) => [feature.properties.order, feature.properties.id])).toEqual([[1, 5], [2, 6]]);
  });

  test("dayGeoJson_of_an_empty_day_is_two_empty_collections", () => {
    expect(dayGeoJson(day())).toEqual({
      routes: { type: "FeatureCollection", features: [] },
      stops: { type: "FeatureCollection", features: [] },
    });
  });

  test("dayGeoJson_keeps_flight_longitudes_as_the_server_unwrapped_them", () => {
    const arc: LonLat[] = [[139.7, 35.7], [190, 50], [241.6, 34.0]];

    const { routes } = dayGeoJson(day(move(1, "flight", arc)));

    expect(routes.features[0]?.geometry.coordinates).toEqual(arc);
    expect(routes.features[0]?.properties.mode).toBe("flight");
  });
});

describe("placeGeoJson", () => {
  test("placeGeoJson_is_one_pin_at_the_place_with_no_number_and_its_name", () => {
    const { routes, stops } = placeGeoJson(CAFE);

    expect(routes).toEqual({ type: "FeatureCollection", features: [] });
    expect(stops.features).toEqual([
      // The pin of a stop of a day, which says its number: this one is no stop of a day, so the label is empty and the pin shows none.
      { type: "Feature", geometry: { type: "Point", coordinates: [10.1, 59.1] }, properties: { order: 1, label: "", name: "Café", id: 2, placeId: 2 } },
    ]);
  });

  test("placeGeoJson_gives_a_place_with_no_name_a_pin_with_none", () => {
    expect(placeGeoJson(OFFICE).stops.features[0]?.properties).toEqual({ order: 1, label: "", name: null, id: 3, placeId: 3 });
  });
});

describe("stopOrders", () => {
  test("stopOrders_numbers_the_stays_that_have_a_pin_from_1_in_the_order_of_the_day", () => {
    const orders = stopOrders(
      day(
        stay(10, HOME),
        move(11, "walk", [[10, 59], [10.1, 59.1]]),
        stay(12, null), // no place, no number
        { id: 13, kind: "gap", ...WHEN, from: null, to: null },
        stay(14, CAFE),
        stay(15, HOME), // the same place again: its own number
      ),
    );

    expect([...orders]).toEqual([[10, 1], [14, 2], [15, 3]]);
  });

  test("stopOrders_are_the_numbers_on_the_pins", () => {
    // The timeline reads its numbers from here and the pins are labelled from here: they cannot disagree (ruling P2-R16).
    const stays = [stay(1, HOME), stay(2, null), stay(3, CAFE), stay(4, HOME), stay(5, OFFICE), stay(6, CAFE)];
    const orders = stopOrders(day(...stays));
    const { stops } = dayGeoJson(day(...stays));

    const byPlace = new Map<number, string[]>();
    for (const segment of stays) {
      const order = orders.get(segment.id);
      if (segment.place !== null) byPlace.set(segment.place.id, [...(byPlace.get(segment.place.id) ?? []), String(order)]);
    }
    expect(stops.features.map((feature) => feature.properties.label)).toEqual([...byPlace.values()].map((numbers) => numbers.join(" · ")));
    expect(orders.has(2)).toBe(false);
  });

  test("stopOrders_of_an_empty_day_are_none", () => {
    expect(stopOrders(day()).size).toBe(0);
  });
});

describe("rangeGeoJson", () => {
  function rangePlace(id: number, name: string | null, seconds: number, city: string | null = null): RangePlace {
    return { ...place(id, name, 10 + id / 10, 59 + id / 10, city), seconds, visits: 1 };
  }

  function range(places: RangePlace[], moves: RangeResponse["moves"] = []): RangeResponse {
    return {
      from: "2026-10-01",
      to: "2026-10-31",
      state: "done",
      summary: { ...SUMMARY, moves: moves.length },
      moves,
      places,
      days: [],
    };
  }

  test("rangeGeoJson_sizes_places_by_time_and_labels_top_five", () => {
    // Seven places, listed in no particular order; the most time is 40 000 s.
    const places = [
      rangePlace(1, "Home", 40_000),
      rangePlace(2, "Office", 10_000),
      rangePlace(3, "Gym", 2_500),
      rangePlace(4, "Parents", 20_000),
      rangePlace(5, "Cabin", 90),
      rangePlace(6, null, 5_000, "Bergen"),
      rangePlace(7, "Shop", 1_000),
    ];

    const { places: dots } = rangeGeoJson(range(places));

    expect(dots.type).toBe("FeatureCollection");
    expect(dots.features).toHaveLength(7);
    const byId = new Map(dots.features.map((feature) => [feature.properties.id, feature]));
    // radius = 4 + 12 * sqrt(seconds / max)
    expect(byId.get(1)?.properties.radius).toBeCloseTo(16, 10);
    expect(byId.get(4)?.properties.radius).toBeCloseTo(4 + 12 * Math.sqrt(0.5), 10);
    expect(byId.get(2)?.properties.radius).toBeCloseTo(4 + 12 * Math.sqrt(0.25), 10);
    expect(byId.get(5)?.properties.radius).toBeCloseTo(4 + 12 * Math.sqrt(90 / 40_000), 10);
    // The top five by time carry a label (name, else city); the rest have none.
    expect([...byId.values()].filter((feature) => feature.properties.label !== undefined).map((feature) => feature.properties.id).sort()).toEqual([1, 2, 3, 4, 6]);
    expect(byId.get(1)?.properties.label).toBe("Home");
    expect(byId.get(6)?.properties.label).toBe("Bergen");
    expect(byId.get(5)?.properties).not.toHaveProperty("label");
    expect(byId.get(7)?.properties).not.toHaveProperty("label");
    // Point at the place, longitude first.
    expect(byId.get(1)?.geometry).toEqual({ type: "Point", coordinates: [10.1, 59.1] });
  });

  test("rangeGeoJson_labels_nothing_that_has_no_name_and_no_city", () => {
    const { places } = rangeGeoJson(range([rangePlace(1, null, 100), rangePlace(2, "Home", 50)]));

    expect(places.features.map((feature) => feature.properties.label)).toEqual([undefined, "Home"]);
  });

  test("rangeGeoJson_breaks_ties_in_the_order_given", () => {
    const six = [1, 2, 3, 4, 5, 6].map((id) => rangePlace(id, `P${id}`, 100));

    const { places } = rangeGeoJson(range(six));

    expect(places.features.filter((feature) => "label" in feature.properties).map((feature) => feature.properties.id)).toEqual([1, 2, 3, 4, 5]);
  });

  test("rangeGeoJson_gives_the_smallest_dot_when_no_time_was_spent_anywhere", () => {
    const { places } = rangeGeoJson(range([rangePlace(1, "Home", 0)]));

    expect(places.features[0]?.properties.radius).toBe(4);
  });

  test("rangeGeoJson_tags_moves_with_id_and_mode", () => {
    const { routes } = rangeGeoJson(
      range([], [
        { id: 7, mode: "cycle", start: WHEN.start, end: WHEN.end, geometry: [[10, 59], [10.1, 59.1]] },
        { id: 8, mode: null, start: WHEN.start, end: WHEN.end, geometry: [[10, 59], [10.2, 59.2]] },
        { id: 9, mode: "walk", start: WHEN.start, end: WHEN.end, geometry: [[10, 59]] },
        { id: 10, start: WHEN.start, end: WHEN.end, geometry: [[10, 59], [10.3, 59.3]] }, // the server leaves a mode it could not tell out of the JSON
      ]),
    );

    expect(routes.features.map((feature) => feature.properties)).toEqual([
      { id: 7, mode: "cycle" },
      { id: 8, mode: "unknown" },
      { id: 10, mode: "unknown" },
    ]);
    expect(routes.features[0]?.geometry).toEqual({ type: "LineString", coordinates: [[10, 59], [10.1, 59.1]] });
  });
});

describe("heatGeoJson", () => {
  test("heatGeoJson_normalises_weights", () => {
    const heat: HeatResponse = {
      maxSeconds: 8000,
      cells: [
        [10.0, 59.0, 8000],
        [10.1, 59.1, 2000],
        [10.2, 59.2, 80],
      ],
    };

    const points = heatGeoJson(heat);

    expect(points.type).toBe("FeatureCollection");
    expect(points.features).toEqual([
      { type: "Feature", properties: { weight: 1 }, geometry: { type: "Point", coordinates: [10.0, 59.0] } },
      { type: "Feature", properties: { weight: 0.25 }, geometry: { type: "Point", coordinates: [10.1, 59.1] } },
      { type: "Feature", properties: { weight: 0.01 }, geometry: { type: "Point", coordinates: [10.2, 59.2] } },
    ]);
  });

  test("heatGeoJson_without_cells_or_without_a_maximum_is_harmless", () => {
    expect(heatGeoJson({ maxSeconds: 0, cells: [] }).features).toEqual([]);
    // Never divide by zero, whatever the server says.
    expect(heatGeoJson({ maxSeconds: 0, cells: [[1, 2, 30]] }).features[0]?.properties.weight).toBe(0);
  });
});

/** Evaluates a MapLibre expression for the properties of one feature, for the few operators the pin radius is made of; any other throws. */
function evaluate(expression: unknown, properties: Record<string, unknown>): unknown {
  if (!Array.isArray(expression)) return expression;
  const [operator, ...operands] = expression as [string, ...unknown[]];
  if (operator === "get") return properties[operands[0] as string];
  const values = operands.map((operand) => evaluate(operand, properties));
  const numbers = values as number[];
  switch (operator) {
    case "to-string":
      return String(values[0]);
    case "length":
      return String(values[0]).length;
    case "+":
      return numbers.reduce((sum, n) => sum + n);
    case "*":
      return numbers.reduce((product, n) => product * n);
    case "/":
      return numbers[0]! / numbers[1]!;
    case "max":
      return Math.max(...numbers);
    default:
      throw new Error(`The test cannot evaluate "${operator}"`);
  }
}

describe("layerSpecs", () => {
  const find = (view: "day" | "range", id: string, dark = false) => {
    const spec = layerSpecs(view, dark).find((candidate) => candidate.id === id);
    if (spec === undefined) throw new Error(`no layer ${id}`);
    return spec;
  };
  const paint = (spec: { paint?: unknown }) => (spec.paint ?? {}) as Record<string, unknown>;
  const layout = (spec: { layout?: unknown }) => (spec.layout ?? {}) as Record<string, unknown>;

  test("layerSpecs_have_unique_ids_and_sources_that_the_map_adds", () => {
    const specs = layerSpecs("day", false);

    expect(new Set(specs.map((spec) => spec.id)).size).toBe(specs.length);
    const sources = new Set<string>(Object.values(SOURCE_IDS));
    for (const spec of specs) {
      expect(sources.has((spec as { source: string }).source), spec.id).toBe(true);
    }
    expect(specs.map((spec) => spec.id)).toEqual(Object.values(LAYER_IDS));
  });

  test("layerSpecs_draw_the_heat_first_and_the_stops_last", () => {
    const ids = layerSpecs("day", false).map((spec) => spec.id);

    expect(ids[0]).toBe(LAYER_IDS.heat);
    expect(ids.indexOf(LAYER_IDS.routeCasing)).toBeLessThan(ids.indexOf(LAYER_IDS.dayRoute));
    expect(ids.indexOf(LAYER_IDS.dayRoute)).toBeLessThan(ids.indexOf(LAYER_IDS.places));
    expect(ids.indexOf(LAYER_IDS.places)).toBeLessThan(ids.indexOf(LAYER_IDS.stops));
    // MapLibre places labels from the top layer down, so the numbers are last: no name hides one.
    expect(ids.indexOf(LAYER_IDS.stops)).toBeLessThan(ids.indexOf(LAYER_IDS.stopNames));
    expect(ids.indexOf(LAYER_IDS.stopNames)).toBeLessThan(ids.indexOf(LAYER_IDS.stopNumbers));
    expect(ids.at(-1)).toBe(LAYER_IDS.stopNumbers);
  });

  test("layerSpecs_draw_day_routes_4_wide_over_a_white_casing", () => {
    const casing = find("day", LAYER_IDS.routeCasing);
    const line = find("day", LAYER_IDS.dayRoute);

    expect(casing.type).toBe("line");
    expect(paint(casing)["line-color"]).toBe("#FFFFFF");
    expect(paint(casing)["line-width"]).toBeGreaterThan(4);
    expect(line.type).toBe("line");
    expect(paint(line)["line-width"]).toBe(4);
    expect(paint(line)["line-opacity"]).toBeUndefined();
    // The colour follows the mode of the feature.
    expect(JSON.stringify(paint(line)["line-color"])).toContain('"get","mode"');
    for (const colour of Object.values(MODE_COLORS)) expect(JSON.stringify(paint(line)["line-color"])).toContain(colour);
    expect(layout(line)["visibility"]).toBe("visible");
    expect(layout(casing)["visibility"]).toBe("visible");
  });

  test("layerSpecs_draw_range_routes_2_4_wide_at_35_percent", () => {
    const line = find("range", LAYER_IDS.rangeRoute);
    const flight = find("range", LAYER_IDS.rangeFlight);

    expect(paint(line)["line-width"]).toBe(2.4);
    expect(paint(line)["line-opacity"]).toBe(0.35);
    expect(paint(flight)["line-width"]).toBe(2.4);
    expect(paint(flight)["line-opacity"]).toBe(0.35);
    expect(layout(line)["visibility"]).toBe("visible");
  });

  test("layerSpecs_hide_the_routes_of_the_other_view", () => {
    const day = layerSpecs("day", false);
    const range = layerSpecs("range", false);
    const visibility = (specs: typeof day, id: string) => layout(specs.find((spec) => spec.id === id) ?? {})["visibility"];

    for (const id of [LAYER_IDS.routeCasing, LAYER_IDS.dayRoute, LAYER_IDS.dayFlight]) {
      expect(visibility(day, id), id).toBe("visible");
      expect(visibility(range, id), id).toBe("none");
    }
    for (const id of [LAYER_IDS.rangeRoute, LAYER_IDS.rangeFlight]) {
      expect(visibility(day, id), id).toBe("none");
      expect(visibility(range, id), id).toBe("visible");
    }
  });

  test("layerSpecs_dash_flights_only_and_cast_no_casing_under_them", () => {
    for (const [view, flightId, lineId] of [
      ["day", LAYER_IDS.dayFlight, LAYER_IDS.dayRoute],
      ["range", LAYER_IDS.rangeFlight, LAYER_IDS.rangeRoute],
    ] as const) {
      const flight = find(view, flightId);
      const line = find(view, lineId);
      expect(paint(flight)["line-dasharray"], view).toEqual([2, 2]);
      expect(paint(flight)["line-color"], view).toBe(MODE_COLORS.flight);
      expect(paint(line)["line-dasharray"], view).toBeUndefined();
      expect((flight as { filter?: unknown }).filter, view).toEqual(["==", ["get", "mode"], "flight"]);
      expect((line as { filter?: unknown }).filter, view).toEqual(["!=", ["get", "mode"], "flight"]);
    }
    // A solid casing under a dashed line would fill its gaps.
    expect((find("day", LAYER_IDS.routeCasing) as { filter?: unknown }).filter).toEqual(["!=", ["get", "mode"], "flight"]);
  });

  test("layerSpecs_draw_stop_pins_as_circles_with_the_order_number_as_text", () => {
    const pins = find("day", LAYER_IDS.stops);
    const numbers = find("day", LAYER_IDS.stopNumbers);

    expect(pins.type).toBe("circle");
    expect(paint(pins)["circle-color"]).toBe(PIN_COLOR);
    expect(paint(pins)["circle-stroke-color"]).toBe("#FFFFFF");
    expect(numbers.type).toBe("symbol");
    // The label of the pin: the number, or the numbers of every stay at the place ("1 · 4").
    expect(layout(numbers)["text-field"]).toEqual(["get", "label"]);
    // No number is left out for another one being near: the timeline shows them all, so does the map.
    expect(layout(numbers)["text-allow-overlap"]).toBe(true);
    expect((numbers as { source: string }).source).toBe(SOURCE_IDS.stops);
  });

  test("layerSpecs_grow_a_stop_pin_with_its_label_so_that_the_white_numbers_stay_inside_it", () => {
    const radius = paint(find("day", LAYER_IDS.stops))["circle-radius"];
    const offset = layout(find("day", LAYER_IDS.stopNames))["text-radial-offset"];
    const radiusOf = (label: string) => evaluate(radius, { label }) as number;
    const offsetOf = (label: string) => evaluate(offset, { label }) as number;

    // The expressions are MapLibre's, evaluated here for the few operators they are made of (the e2e tests have the real map take them).
    expect(radiusOf("1")).toBe(12); // one number: the pin as it was
    expect(radiusOf("10")).toBe(12);
    expect(radiusOf("1 · 4")).toBeCloseTo(17, 10); // 5 characters: 6 + 2.2 * 5
    expect(radiusOf("1 · 4 · 7")).toBeCloseTo(25.8, 10);
    expect(radiusOf("1 · 4")).toBeGreaterThan(radiusOf("1"));
    expect(radiusOf("1 · 4 · 7")).toBeGreaterThan(radiusOf("1 · 4"));
    // The name beside a pin clears it: its radius in ems of the 12 px text, and half an em more (1.5 em for a pin of one number).
    expect(offsetOf("1")).toBeCloseTo(1.5, 10);
    expect(offsetOf("1 · 4")).toBeCloseTo(17 / 12 + 0.5, 10);
  });

  test("layerSpecs_size_place_dots_by_their_radius_and_label_the_top_ones", () => {
    const dots = find("range", LAYER_IDS.places);
    const labels = find("range", LAYER_IDS.placeLabels);

    expect(dots.type).toBe("circle");
    expect(paint(dots)["circle-radius"]).toEqual(["get", "radius"]);
    expect(paint(dots)["circle-color"]).toBe(PIN_COLOR);
    expect(labels.type).toBe("symbol");
    expect(layout(labels)["text-field"]).toEqual(["get", "label"]);
    expect((labels as { filter?: unknown }).filter).toEqual(["has", "label"]);
  });

  test("layerSpecs_include_a_heatmap_driven_by_the_weight", () => {
    const heat = find("day", LAYER_IDS.heat);

    expect(heat.type).toBe("heatmap");
    expect(paint(heat)["heatmap-weight"]).toEqual(["get", "weight"]);
    expect((heat as { source: string }).source).toBe(SOURCE_IDS.heat);
  });

  test("layerSpecs_grow_the_heat_radius_with_the_zoom", () => {
    const radius = paint(find("day", LAYER_IDS.heat))["heatmap-radius"] as unknown[];

    expect(radius.slice(0, 3)).toEqual(["interpolate", ["linear"], ["zoom"]]);
    const pixels = radius.slice(3).filter((_, i) => i % 2 === 1) as number[]; // the stops are zoom, radius, zoom, radius, ...
    expect(pixels.length).toBeGreaterThan(1);
    expect(pixels).toEqual([...pixels].sort((a, b) => a - b)); // never smaller at a higher zoom
    expect(pixels.at(-1)).toBeGreaterThan(pixels[0]!);
  });

  test("layerSpecs_follow_the_colour_scheme_for_label_text_only", () => {
    const light = find("day", LAYER_IDS.stopNames, false);
    const dark = find("day", LAYER_IDS.stopNames, true);

    expect(paint(light)["text-color"]).not.toBe(paint(dark)["text-color"]);
    expect(paint(light)["text-halo-color"]).not.toBe(paint(dark)["text-halo-color"]);
    expect(paint(find("day", LAYER_IDS.stops, false))).toEqual(paint(find("day", LAYER_IDS.stops, true)));
  });
});

describe("routeOpacity", () => {
  test("routeOpacity_is_a_fifth_for_every_route_layer_under_a_heat_layer", () => {
    for (const id of ROUTE_LAYERS) expect(routeOpacity(id, true), id).toBe(0.2);
  });

  test("routeOpacity_is_what_the_layers_are_drawn_at_when_nothing_is_under_them", () => {
    for (const view of ["day", "range"] as const) {
      for (const spec of layerSpecs(view, false)) {
        if (!ROUTE_LAYERS.includes(spec.id)) continue;
        const own = (spec.paint as { "line-opacity"?: number } | undefined)?.["line-opacity"] ?? 1; // none given is full
        expect(routeOpacity(spec.id, false), `${view} ${spec.id}`).toBe(own);
      }
    }
  });

  test("routeOpacity_is_for_the_five_route_layers_and_no_other", () => {
    const lines = layerSpecs("day", false).filter((spec) => spec.type === "line" && (spec as { source: string }).source === SOURCE_IDS.routes);

    expect([...ROUTE_LAYERS].sort()).toEqual(lines.map((spec) => spec.id).sort());
    expect(ROUTE_LAYERS).toHaveLength(5);
  });
});
