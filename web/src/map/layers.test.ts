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
  RawPoint,
  StaySegment,
  TripCity,
  TripListItem,
  TripMove,
  TripResponse,
  TripsResponse,
} from "../api/types";
import {
  dayGeoJson,
  editPointsGeoJson,
  EDIT_SELECTED_COLOR,
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
  tripGeoJson,
  tripsGeoJson,
  type RouteView,
} from "./layers";

const SUMMARY = { places: 0, distanceMeters: 0, movingSeconds: 0 };
const WHEN = { start: "2026-10-22T08:00:00Z", end: "2026-10-22T09:00:00Z", startTimeZone: "Europe/Oslo", endTimeZone: "Europe/Oslo" };

function place(id: number, name: string | null, lon: number, lat: number, city: string | null = null): PlaceRef {
  return { id, name, city, country: null, lat, lon };
}

function stay(id: number, at: PlaceRef | null, home = false): StaySegment {
  return { id, kind: "stay", ...WHEN, place: at, home };
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

  // Plan 3: home is drawn with a house in place of its number, and the numbers are those of the other stops (refines P2-R16 and P2-R20).
  test("dayGeoJson_marks_home_stops_and_never_merges_them_into_numbers", () => {
    const { stops } = dayGeoJson(
      day(
        stay(10, HOME, true), // the day starts at home...
        move(11, "walk", [[10.0, 59.0], [10.05, 59.05]]),
        stay(12, CAFE),
        move(13, "drive", [[10.1, 59.1], [10.2, 59.2]]),
        stay(14, OFFICE),
        move(15, "drive", [[10.2, 59.2], [10.0, 59.0]]),
        stay(16, HOME, true), // ...and ends there
      ),
    );

    expect(stops.features).toEqual([
      // One pin for home, in the order of the day: a house (the layers draw it where `home` is true) and no number, so that its label is empty.
      { type: "Feature", properties: { order: 0, label: "", name: "Home", id: 10, placeId: 1, home: true }, geometry: { type: "Point", coordinates: [10.0, 59.0] } },
      // The others are as they are: the numbers count them alone, from 1.
      { type: "Feature", properties: { order: 1, label: "1", name: "Café", id: 12, placeId: 2 }, geometry: { type: "Point", coordinates: [10.1, 59.1] } },
      { type: "Feature", properties: { order: 2, label: "2", name: null, id: 14, placeId: 3 }, geometry: { type: "Point", coordinates: [10.2, 59.2] } },
    ]);
    expect(stops.features[1]?.properties).not.toHaveProperty("home"); // a stop that is not home says nothing of it
  });

  test("dayGeoJson_draws_a_day_spent_at_home_as_one_house_and_a_home_in_the_middle_of_the_day_where_it_is", () => {
    const { stops } = dayGeoJson(day(stay(1, HOME, true), stay(2, HOME, true), stay(3, HOME, true)));
    expect(stops.features.map((feature) => [feature.properties.home, feature.properties.label, feature.properties.id])).toEqual([[true, "", 1]]);

    const mid = dayGeoJson(day(stay(1, CAFE), stay(2, HOME, true), stay(3, OFFICE), stay(4, CAFE)));
    expect(mid.stops.features.map((feature) => [feature.properties.home ?? false, feature.properties.label])).toEqual([
      [false, "1 · 3"], // the second stay at the café is the third that has a number
      [true, ""],
      [false, "2"],
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

  test("stopOrders_skips_home_stays", () => {
    const orders = stopOrders(
      day(
        stay(10, HOME, true),
        move(11, "walk", [[10, 59], [10.1, 59.1]]),
        stay(12, CAFE),
        stay(13, null),
        stay(14, OFFICE),
        stay(15, HOME, true), // home again: no number either
      ),
    );

    expect([...orders]).toEqual([[12, 1], [14, 2]]); // home has no number, and the others are counted from 1
    expect(orders.has(10)).toBe(false);
    expect(orders.has(15)).toBe(false);
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

  test("stopOrders_are_the_numbers_on_the_pins_with_a_home_among_the_stays", () => {
    const stays = [stay(1, HOME, true), stay(2, CAFE), stay(3, OFFICE), stay(4, CAFE), stay(5, HOME, true)];
    const orders = stopOrders(day(...stays));
    const { stops } = dayGeoJson(day(...stays));

    expect(stops.features.map((feature) => feature.properties.label)).toEqual(["", "1 · 3", "2"]); // the house has none, the café's are 1 and 3
    expect([...orders.values()]).toEqual([1, 2, 3]);
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

  // A label goes to the inside of the drawing (P3-R20): a dot east of the middle of it says "east" and has its text on its left, a west one "west".
  // The middle is the middle, in longitude, of what the map is brought to, the routes and the dots together.
  test("rangeGeoJson_says_for_each_label_which_side_of_the_middle_of_the_drawing_its_dot_is_on", () => {
    const places = [rangePlace(1, "West", 300), rangePlace(2, "Just west", 200), rangePlace(3, "East", 100), rangePlace(4, null, 50)].map((p, i) => ({ ...p, lon: [10.1, 10.5, 10.9, 10.95][i]! }));

    const { places: dots } = rangeGeoJson(range(places));

    expect(dots.features.map((feature) => feature.properties.side)).toEqual(["west", "west", "east", undefined]); // 10.1 to 10.95: the middle is 10.525
    expect(dots.features[3]?.properties).not.toHaveProperty("side"); // a dot with no label has no text to put anywhere
  });

  test("rangeGeoJson_takes_the_middle_of_the_drawing_from_the_routes_too", () => {
    const places = [rangePlace(1, "A", 300), rangePlace(2, "B", 200)].map((p, i) => ({ ...p, lon: [10.1, 10.9][i]! }));
    const moves = [{ id: 7, mode: "drive" as const, start: WHEN.start, end: WHEN.end, geometry: [[10, 59], [13, 59.1]] as LonLat[] }]; // out to 13

    const { places: dots } = rangeGeoJson(range(places, moves));

    expect(dots.features.map((feature) => feature.properties.side)).toEqual(["west", "west"]); // the middle is 11.5, and both are at its west
  });

  test("rangeGeoJson_puts_a_dot_in_the_middle_of_a_drawing_that_is_one_dot_on_the_west", () => {
    const { places: dots } = rangeGeoJson(range([rangePlace(1, "Home", 100)]));

    expect(dots.features[0]?.properties.side).toBe("west"); // it has the free width to itself, and its text goes to its right as it did
  });

  test("rangeGeoJson_tells_the_sides_across_the_antimeridian", () => {
    // Tokyo to Los Angeles: the flight goes on past 180 and the dot of LA is at -118.4, so that the drawing is the stretch from 139.7 east to 241.6.
    const tokyo = { ...rangePlace(1, "Tokyo", 200), lon: 139.7 };
    const la = { ...rangePlace(2, "Los Angeles", 100), lon: -118.4 };
    const flight = { id: 3, mode: "flight" as const, start: WHEN.start, end: WHEN.end, geometry: [[139.7, 35.7], [190, 50], [241.6, 33.9]] as LonLat[] };

    const { places: dots } = rangeGeoJson(range([tokyo, la], [flight]));

    expect(dots.features.map((feature) => feature.properties.side)).toEqual(["west", "east"]); // not Tokyo at the east of LA, as the numbers would have it
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

describe("tripsGeoJson", () => {
  const city = (name: string, country: string | null, nights: number, lat: number, lon: number): TripCity => ({ name, country, nights, lat, lon });

  /** A trip of the list with these cities; everything else about it is of no matter to the map. */
  function trip(id: string, ...cities: TripCity[]): TripListItem {
    return {
      id,
      name: "Trip",
      firstNight: id,
      lastNight: id,
      nights: cities.reduce((sum, c) => sum + c.nights, 0),
      start: WHEN.start,
      end: WHEN.end,
      startTimeZone: "Europe/Oslo",
      endTimeZone: "Europe/Oslo",
      localStartDate: id,
      localEndDate: id,
      ongoing: false,
      edited: false,
      cities,
      thumbnail: [],
    };
  }
  const trips = (...list: TripListItem[]): TripsResponse => ({ trips: list });

  /** Two trips, the newer one first: Lisbon is slept in on both. */
  const TWO_TRIPS = trips(
    trip("2026-09-12", city("Lisbon", "Portugal", 5, 38.72, -9.14), city("Porto", "Portugal", 1, 41.15, -8.61), city("Madrid", "Spain", 2, 40.42, -3.7)),
    trip(
      "2026-03-02",
      city("Lisbon", "Portugal", 4, 38.72, -9.14),
      city("Paris", "France", 3, 48.86, 2.35),
      city("Rome", "Italy", 1, 41.9, 12.5),
      city("Vienna", "Austria", 1, 48.21, 16.37),
      city("Iceland", "Iceland", 1, 64.9, -18.6),
    ),
  );
  const byLabel = (dots: ReturnType<typeof tripsGeoJson>["places"]) =>
    new Map(dots.features.filter((feature) => feature.properties.label !== undefined).map((feature) => [feature.properties.label, feature]));

  test("tripsGeoJson_sums_nights_per_city_and_labels_the_top_five", () => {
    const { routes, places } = tripsGeoJson(TWO_TRIPS);

    expect(routes).toEqual({ type: "FeatureCollection", features: [] }); // the cities and no line between them
    // One dot for each city, in the order each was first met (the newest trip first), Lisbon's nights summed: 5 and 4.
    expect(places.features).toHaveLength(7);
    const where = [[-9.14, 38.72], [-8.61, 41.15], [-3.7, 40.42], [2.35, 48.86], [12.5, 41.9], [16.37, 48.21], [-18.6, 64.9]]; // longitude first
    for (const [index, feature] of places.features.entries()) {
      expect(feature.geometry.type).toBe("Point");
      expect(feature.geometry.coordinates[0], `${index}`).toBeCloseTo(where[index]![0]!, 10);
      expect(feature.geometry.coordinates[1], `${index}`).toBeCloseTo(where[index]![1]!, 10);
    }
    // The five with the most nights carry the label of the trips' wording, "Lisbon · 9 nights" and "Porto · 1 night"; of those that tie at one
    // night the ones met first are labelled, and the rest have none.
    expect(places.features.map((feature) => feature.properties.label)).toEqual([
      "Lisbon · 9 nights",
      "Porto · 1 night",
      "Madrid · 2 nights",
      "Paris · 3 nights",
      "Rome · 1 night",
      undefined,
      undefined,
    ]);
    expect(places.features[5]?.properties).not.toHaveProperty("label");
    // radius = 4 + 12 * sqrt(nights / max) with the most nights in any city, as the dots of a period have it: Lisbon's 9 are 16 px.
    const radius = (index: number) => places.features[index]!.properties.radius;
    expect(radius(0)).toBeCloseTo(16, 10);
    expect(radius(3)).toBeCloseTo(4 + 12 * Math.sqrt(3 / 9), 10);
    expect(radius(2)).toBeCloseTo(4 + 12 * Math.sqrt(2 / 9), 10);
    expect(radius(1)).toBeCloseTo(4 + 12 * Math.sqrt(1 / 9), 10);
  });

  test("tripsGeoJson_says_for_each_label_which_side_of_the_middle_of_the_cities_its_dot_is_on", () => {
    const { places } = tripsGeoJson(TWO_TRIPS);

    // From Iceland (-18.6) to Vienna (16.37): the middle is -1.115, so Lisbon, Porto and Madrid are at its west and Paris and Rome at its east.
    // Vienna and Iceland have no label (they are not among the five with the most nights), and so no side.
    expect(places.features.map((feature) => feature.properties.side)).toEqual(["west", "west", "west", "east", "east", undefined, undefined]);
  });

  test("tripsGeoJson_makes_dots_that_are_no_place_so_that_a_tap_on_one_opens_nothing", () => {
    const { places } = tripsGeoJson(TWO_TRIPS);

    expect(places.features.map((feature) => feature.properties.id)).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });

  test("tripsGeoJson_keeps_apart_cities_that_share_a_name_in_other_countries_and_joins_those_that_share_both", () => {
    const { places } = tripsGeoJson(
      trips(
        trip("2026-09-12", city("Valencia", "Spain", 2, 39.47, -0.38), city("Valencia", "Venezuela", 1, 10.18, -68)),
        trip("2026-03-02", city("Valencia", "Spain", 1, 39.47, -0.38), city("Singapore", null, 1, 1.35, 103.82)),
      ),
    );

    expect([...byLabel(places).keys()]).toEqual(["Valencia · 3 nights", "Valencia · 1 night", "Singapore · 1 night"]);
  });

  test("tripsGeoJson_puts_a_city_that_was_slept_in_on_several_trips_at_the_mean_of_where_they_put_it_by_nights", () => {
    const { places } = tripsGeoJson(
      trips(
        trip("2026-09-12", city("Lisbon", "Portugal", 3, 38.7, -9.1)),
        trip("2026-03-02", city("Lisbon", "Portugal", 1, 38.9, -9.5)),
      ),
    );

    expect(places.features).toHaveLength(1);
    const [lon, lat] = places.features[0]!.geometry.coordinates;
    expect(lon).toBeCloseTo((3 * -9.1 + 1 * -9.5) / 4, 10);
    expect(lat).toBeCloseTo((3 * 38.7 + 1 * 38.9) / 4, 10);
  });

  test("tripsGeoJson_of_no_trips_or_trips_with_no_cities_is_two_empty_collections_and_of_no_nights_the_smallest_dot", () => {
    expect(tripsGeoJson(trips())).toEqual({
      routes: { type: "FeatureCollection", features: [] },
      places: { type: "FeatureCollection", features: [] },
    });
    expect(tripsGeoJson(trips(trip("2026-09-12"))).places.features).toEqual([]);
    expect(tripsGeoJson(trips(trip("2026-09-12", city("Lisbon", "Portugal", 0, 38.72, -9.14)))).places.features[0]?.properties.radius).toBe(4);
  });
});

describe("tripGeoJson", () => {
  const city = (name: string, nights: number, lon: number, lat: number): TripCity => ({ name, country: "Portugal", nights, lat, lon });
  const move = (id: number, mode: TripMove["mode"], geometry: LonLat[]): TripMove => ({ id, mode, distanceMeters: 1000, geometry });

  /** A trip with these moves and cities; everything else about it is of no matter to the map. */
  function trip(moves: TripMove[], cities: TripCity[]): TripResponse {
    return {
      id: "2026-09-12",
      name: "Lisbon & Sintra",
      firstNight: "2026-09-12",
      lastNight: "2026-09-15",
      nights: 4,
      start: WHEN.start,
      end: WHEN.end,
      startTimeZone: "Europe/Oslo",
      endTimeZone: "Europe/Oslo",
      localStartDate: "2026-09-12",
      localEndDate: "2026-09-16",
      ongoing: false,
      edited: false,
      cities,
      stats: { flights: 0, cities: cities.length, places: 0, groundDistanceMeters: 0 },
      moves,
      days: [],
    };
  }

  test("tripGeoJson_labels_every_city_with_its_nights", () => {
    // More than the five that the list's map labels: a trip is a map of its own, and all of its cities are named on it.
    const cities = [
      city("Lisbon", 4, -9.14, 38.72),
      city("Sintra", 1, -9.38, 38.8),
      city("Porto", 2, -8.61, 41.15),
      city("Évora", 1, -7.91, 38.57),
      city("Faro", 1, -7.93, 37.02),
      city("Coimbra", 1, -8.43, 40.2),
      city("Braga", 3, -8.42, 41.55),
    ];

    const { places } = tripGeoJson(trip([], cities));

    expect(places.features.map((feature) => feature.properties.label)).toEqual([
      "Lisbon · 4 nights",
      "Sintra · 1 night",
      "Porto · 2 nights",
      "Évora · 1 night",
      "Faro · 1 night",
      "Coimbra · 1 night",
      "Braga · 3 nights",
    ]);
  });

  test("tripGeoJson_says_for_each_label_which_side_of_the_middle_of_the_trip_its_dot_is_on_the_routes_included", () => {
    const cities = [city("Oslo", 1, 10.75, 59.91), city("Lisbon", 3, -9.14, 38.72), city("Sintra", 1, -9.38, 38.8)];

    const { places } = tripGeoJson(trip([], cities));

    // The cities alone run from -9.38 to 10.75, so that the middle is 0.685: Oslo is at its east, the two near Lisbon at its west.
    expect(places.features.map((feature) => feature.properties.side)).toEqual(["east", "west", "west"]);

    // A move out past them moves the middle: it is the middle of everything that the map is brought to.
    const far = tripGeoJson(trip([move(1, "flight", [[10.75, 59.91], [40, 40]])], cities));
    expect(far.places.features.map((feature) => feature.properties.side)).toEqual(["west", "west", "west"]); // from -9.38 to 40: the middle is 15.31
  });

  test("tripGeoJson_words_a_city_as_the_map_of_the_trips_does", () => {
    // The same words in both: a city that is on the list's map as "Lisbon · 4 nights" is that on its trip's.
    const [lisbon] = [city("Lisbon", 4, -9.14, 38.72)];
    const listed: TripListItem = { ...trip([], [lisbon!]), thumbnail: [] };

    expect(tripGeoJson(trip([], [lisbon!])).places.features[0]?.properties.label).toBe(tripsGeoJson({ trips: [listed] }).places.features[0]?.properties.label);
  });

  test("tripGeoJson_makes_a_dot_for_each_city_where_it_is_sized_by_its_nights_and_no_place", () => {
    const { places } = tripGeoJson(trip([], [city("Lisbon", 4, -9.14, 38.72), city("Sintra", 1, -9.38, 38.8)]));

    expect(places.features).toHaveLength(2);
    expect(places.features.map((feature) => feature.geometry)).toEqual([
      { type: "Point", coordinates: [-9.14, 38.72] }, // longitude first
      { type: "Point", coordinates: [-9.38, 38.8] },
    ]);
    // radius = 4 + 12 * sqrt(nights / max) with the most nights in any city, as the dots of a period and of the trips have it.
    expect(places.features[0]?.properties.radius).toBeCloseTo(16, 10);
    expect(places.features[1]?.properties.radius).toBeCloseTo(4 + 12 * Math.sqrt(1 / 4), 10);
    expect(places.features.map((feature) => feature.properties.id)).toEqual([0, 0]); // a city is no place: a tap on its dot opens nothing
  });

  test("tripGeoJson_draws_each_move_with_its_mode_and_leaves_a_flight_for_the_dashed_layer", () => {
    const { routes } = tripGeoJson(
      trip(
        [
          move(301, "drive", [[10.75, 59.91], [11.08, 60.19]]),
          move(302, "flight", [[11.08, 60.19], [-9.13, 38.78]]),
          move(304, "walk", [[-9.14, 38.72], [-9.13, 38.71], [-9.15, 38.7]]),
          move(305, "cycle", [[-9.14, 38.72], [-9.2, 38.69]]),
          move(306, null, [[-9.2, 38.69], [-9.3, 38.78]]), // a move whose mode could not be told is written out as null
          move(307, "drive", [[-9.3, 38.78]]), // a line of one position is none
        ],
        [],
      ),
    );

    expect(routes.features.map((feature) => feature.properties)).toEqual([
      { id: 301, mode: "drive" },
      { id: 302, mode: "flight" }, // the layers draw it dashed (the layer of the flights, which `layerSpecs` pins) and the others solid
      { id: 304, mode: "walk" },
      { id: 305, mode: "cycle" },
      { id: 306, mode: "unknown" },
    ]);
    expect(routes.features[1]?.geometry).toEqual({ type: "LineString", coordinates: [[11.08, 60.19], [-9.13, 38.78]] });
  });

  test("tripGeoJson_of_a_trip_with_no_move_or_city_is_two_empty_collections_and_of_no_nights_the_smallest_dot_that_is_still_named", () => {
    expect(tripGeoJson(trip([], []))).toEqual({
      routes: { type: "FeatureCollection", features: [] },
      places: { type: "FeatureCollection", features: [] },
    });

    const { places } = tripGeoJson(trip([], [city("Lisbon", 0, -9.14, 38.72)]));

    expect(places.features[0]?.properties).toEqual({ id: 0, radius: 4, label: "Lisbon · 0 nights", side: "west" });
  });
});

describe("editPointsGeoJson", () => {
  const POINTS: RawPoint[] = [
    [1_761_120_000_123_456, 10.001, 59.001, 0],
    [1_761_120_030_000_000, 10.002, 59.002, 1],
    [1_761_120_060_000_007, 10.003, 59.003, 0],
  ];

  test("editPointsGeoJson_is_a_point_for_each_raw_point_longitude_first_with_its_index_as_its_numeric_id", () => {
    const collection = editPointsGeoJson(POINTS);

    expect(collection.type).toBe("FeatureCollection");
    expect(collection.features.map((feature) => feature.id)).toEqual([0, 1, 2]); // the index into the points: what a selection is made of, and the map's feature state is keyed by
    expect(collection.features.map((feature) => feature.geometry)).toEqual([
      { type: "Point", coordinates: [10.001, 59.001] },
      { type: "Point", coordinates: [10.002, 59.002] },
      { type: "Point", coordinates: [10.003, 59.003] },
    ]);
  });

  test("editPointsGeoJson_carries_nothing_else_of_a_point_the_time_and_the_device_stay_in_the_points", () => {
    for (const feature of editPointsGeoJson(POINTS).features) expect(feature.properties).toEqual({});
  });

  test("editPointsGeoJson_of_no_points_is_an_empty_collection", () => {
    expect(editPointsGeoJson([])).toEqual({ type: "FeatureCollection", features: [] });
  });

  test("editPointsGeoJson_makes_the_ids_of_a_dense_day_as_they_are_counted", () => {
    const dense: RawPoint[] = Array.from({ length: 40_000 }, (_, i) => [1_761_120_000_000_000 + i * 1_000_000, 10 + i / 1e6, 59, 0]);

    const { features } = editPointsGeoJson(dense);

    expect(features).toHaveLength(40_000);
    expect(features[39_999]?.id).toBe(39_999);
    expect(features[39_999]?.geometry.coordinates).toEqual([10 + 39_999 / 1e6, 59]);
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

/** Evaluates a MapLibre expression for the properties of one feature, for the few operators the pin radius and the filters are made of; any other throws. */
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
    case "has":
      return Object.hasOwn(properties, values[0] as string);
    case "==":
      return values[0] === values[1];
    case "!=":
      return values[0] !== values[1];
    case "all":
      return values.every(Boolean);
    default:
      throw new Error(`The test cannot evaluate "${operator}"`);
  }
}

describe("layerSpecs", () => {
  const find = (view: RouteView, id: string, dark = false) => {
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

  test("layerSpecs_draw_the_edit_points_over_the_routes_and_under_the_places_and_the_stop_pins", () => {
    const ids = layerSpecs("day", false).map((spec) => spec.id);

    expect(LAYER_IDS.editPoints).toBe("sporer-edit-points");
    expect(SOURCE_IDS.editPoints).toBe("sporer-edit-points");
    for (const route of ROUTE_LAYERS) expect(ids.indexOf(route), route).toBeLessThan(ids.indexOf(LAYER_IDS.editPoints));
    expect(ids.indexOf(LAYER_IDS.editPoints)).toBeLessThan(ids.indexOf(LAYER_IDS.places));
    expect(ids.indexOf(LAYER_IDS.editPoints)).toBeLessThan(ids.indexOf(LAYER_IDS.stops));
  });

  test("layerSpecs_draw_an_edit_point_as_a_4px_dot_and_a_selected_one_7px_and_red_by_feature_state", () => {
    const dots = find("day", LAYER_IDS.editPoints);

    expect(dots.type).toBe("circle");
    expect((dots as { source: string }).source).toBe(SOURCE_IDS.editPoints);
    expect(EDIT_SELECTED_COLOR).toBe("#FF3B30");
    // The state of a feature is `selected` or it is not (the e2e tests have the real map evaluate them: the pixels of a selected point are red).
    const radius = paint(dots)["circle-radius"];
    const colour = paint(dots)["circle-color"];
    expect(radius).toEqual(["case", ["boolean", ["feature-state", "selected"], false], 7, 4]);
    expect(colour).toEqual(["case", ["boolean", ["feature-state", "selected"], false], EDIT_SELECTED_COLOR, "#1C1C1E"]);
    expect(layout(dots)["visibility"] ?? "visible").toBe("visible");
  });

  test("layerSpecs_draw_the_edit_points_in_the_ink_of_the_scheme_with_a_halo_of_the_other", () => {
    expect(paint(find("day", LAYER_IDS.editPoints, true))["circle-color"]).toEqual(["case", ["boolean", ["feature-state", "selected"], false], EDIT_SELECTED_COLOR, "#F2F2F7"]);
    expect(paint(find("day", LAYER_IDS.editPoints, false))["circle-stroke-color"]).toBe("#FFFFFF");
    expect(paint(find("day", LAYER_IDS.editPoints, true))["circle-stroke-color"]).toBe("#1C1C1E");
  });

  test("layerSpecs_show_the_edit_points_in_every_view_the_source_of_all_but_a_day_in_edit_mode_is_empty", () => {
    for (const view of ["day", "range", "trips", "trip"] as const) expect(layout(find(view, LAYER_IDS.editPoints))["visibility"] ?? "visible", view).toBe("visible");
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

  test("layerSpecs_trips_shows_the_dots_and_their_labels_and_no_route_layers", () => {
    const specs = layerSpecs("trips", false);
    const visibility = (id: string) => layout(specs.find((spec) => spec.id === id) ?? {})["visibility"] ?? "visible"; // a layer that says none is shown

    for (const id of ROUTE_LAYERS) expect(visibility(id), id).toBe("none"); // the list of trips draws no line between its cities
    for (const id of [LAYER_IDS.places, LAYER_IDS.placeLabelsWest, LAYER_IDS.placeLabelsEast]) expect(visibility(id), id).toBe("visible");
  });

  test("layerSpecs_trip_shows_bold_routes_and_city_dots", () => {
    const specs = layerSpecs("trip", false);
    const visibility = (id: string) => layout(specs.find((spec) => spec.id === id) ?? {})["visibility"] ?? "visible";

    for (const id of [LAYER_IDS.routeCasing, LAYER_IDS.dayRoute, LAYER_IDS.dayFlight]) expect(visibility(id), id).toBe("visible"); // bold, as a day's
    for (const id of [LAYER_IDS.rangeRoute, LAYER_IDS.rangeFlight]) expect(visibility(id), id).toBe("none");
    for (const id of [LAYER_IDS.places, LAYER_IDS.placeLabelsWest, LAYER_IDS.placeLabelsEast]) expect(visibility(id), id).toBe("visible");
    // The bold routes of a trip are the day's, to the layer: the same width, casing and dashes.
    expect(paint(find("trip", LAYER_IDS.dayRoute))["line-width"]).toBe(4);
    expect(paint(find("trip", LAYER_IDS.routeCasing))["line-color"]).toBe("#FFFFFF");
    expect(paint(find("trip", LAYER_IDS.dayFlight))["line-dasharray"]).toEqual([2, 2]);
  });

  test("layerSpecs_show_each_route_layer_in_the_views_that_draw_it_and_in_no_other", () => {
    const drawnIn: Record<string, RouteView[]> = {
      [LAYER_IDS.routeCasing]: ["day", "trip"],
      [LAYER_IDS.dayRoute]: ["day", "trip"],
      [LAYER_IDS.dayFlight]: ["day", "trip"],
      [LAYER_IDS.rangeRoute]: ["range"],
      [LAYER_IDS.rangeFlight]: ["range"],
    };
    for (const view of ["day", "range", "trips", "trip"] as const) {
      for (const [id, views] of Object.entries(drawnIn)) {
        expect(layout(find(view, id))["visibility"], `${view} ${id}`).toBe(views.includes(view) ? "visible" : "none");
      }
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

  test("layerSpecs_home_icon_layer_and_numbers_filter", () => {
    const house = find("day", LAYER_IDS.stopHome);
    const numbers = find("day", LAYER_IDS.stopNumbers);
    const drawn = (spec: object, properties: Record<string, unknown>) => evaluate((spec as { filter?: unknown }).filter, properties);

    // The house is a white icon on the pin, drawn from the image that the map adds (`sporer-home`), for the pins of home and no other.
    expect(LAYER_IDS.stopHome).toBe("sporer-stop-home");
    expect(house.type).toBe("symbol");
    expect((house as { source: string }).source).toBe(SOURCE_IDS.stops);
    expect(layout(house)["icon-image"]).toBe("sporer-home");
    expect(paint(house)["icon-color"]).toBe("#FFFFFF"); // an SDF image takes the colour of the layer
    expect(layout(house)["icon-allow-overlap"]).toBe(true); // as the numbers: no name is the reason for a pin to lose what it shows
    expect((house as { filter?: unknown }).filter).toEqual(["==", ["get", "home"], true]);
    expect(drawn(house, { home: true, label: "" })).toBe(true);
    expect(drawn(house, { label: "1" })).toBe(false); // a pin that says nothing of home is not home
    expect(drawn(house, { home: false, label: "1" })).toBe(false);

    // The numbers are the other pins': a house has no number over it.
    expect((numbers as { filter?: unknown }).filter).toEqual(["!=", ["get", "home"], true]);
    expect(drawn(numbers, { home: true, label: "" })).toBe(false);
    expect(drawn(numbers, { label: "1" })).toBe(true);
    expect(drawn(numbers, { home: false, label: "1 · 4" })).toBe(true);
  });

  test("layerSpecs_draw_the_house_over_the_pins_and_their_names_and_keep_the_numbers_last", () => {
    const ids = layerSpecs("day", false).map((spec) => spec.id);

    expect(ids.indexOf(LAYER_IDS.stops)).toBeLessThan(ids.indexOf(LAYER_IDS.stopHome)); // on the pin
    expect(ids.indexOf(LAYER_IDS.stopNames)).toBeLessThan(ids.indexOf(LAYER_IDS.stopHome)); // placed before the names, which are never the reason for it to go
    expect(ids.at(-1)).toBe(LAYER_IDS.stopNumbers);
    for (const view of ["day", "range", "trips", "trip"] as const) {
      expect(layout(find(view, LAYER_IDS.stopHome))["visibility"] ?? "visible", view).toBe("visible"); // like the pins: the source of a view with none is empty
    }
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

    expect(dots.type).toBe("circle");
    expect(paint(dots)["circle-radius"]).toEqual(["get", "radius"]);
    expect(paint(dots)["circle-color"]).toBe(PIN_COLOR);
    for (const id of [LAYER_IDS.placeLabelsWest, LAYER_IDS.placeLabelsEast]) {
      const labels = find("range", id);
      expect(labels.type, id).toBe("symbol");
      expect(layout(labels)["text-field"], id).toEqual(["get", "label"]);
      expect((labels as { source: string }).source, id).toBe(SOURCE_IDS.places);
    }
  });

  // A label points toward the inside of the drawing (P3-R20): two layers of the same labels, each for the dots of one side of it, each with its own
  // order of the places a label may be put at, the inward one first. MapLibre moves a label that collides to the next of them, and drops it when
  // none is free, and the dot stays.
  describe("the labels of the dots", () => {
    const west = () => find("trips", LAYER_IDS.placeLabelsWest);
    const east = () => find("trips", LAYER_IDS.placeLabelsEast);
    const labelledBy = (properties: Record<string, unknown>) =>
      [west(), east()].filter((spec) => evaluate((spec as { filter?: unknown }).filter, properties) === true).map((spec) => spec.id);

    test("layerSpecs_put_the_text_of_an_east_dot_on_its_left_and_the_text_of_a_west_dot_on_its_right_and_the_corners_of_that_side_after_that", () => {
      // The anchor is the side of the text that is next to the dot: "left" is a text on the right of the dot, "top-left" one below it on the right. None
      // is at the outer side or centred above or below the dot, where the edge of the screen would cut a label off at the outermost dots.
      expect(layout(west())["text-variable-anchor"]).toEqual(["left", "top-left", "bottom-left"]);
      expect(layout(east())["text-variable-anchor"]).toEqual(["right", "top-right", "bottom-right"]);
    });

    test("layerSpecs_label_each_labelled_dot_in_the_one_layer_of_its_side_and_no_dot_that_has_no_label", () => {
      expect(labelledBy({ id: 1, radius: 8, label: "Lisbon", side: "west" })).toEqual([LAYER_IDS.placeLabelsWest]);
      expect(labelledBy({ id: 1, radius: 8, label: "Copenhagen", side: "east" })).toEqual([LAYER_IDS.placeLabelsEast]);
      expect(labelledBy({ id: 1, radius: 8 })).toEqual([]);
      expect(labelledBy({ id: 1, radius: 8, side: "east" })).toEqual([]);
      // A labelled dot that says no side is one of the west: its text goes to its right, as every label did.
      expect(labelledBy({ id: 1, radius: 8, label: "Lisbon" })).toEqual([LAYER_IDS.placeLabelsWest]);
    });

    test("layerSpecs_set_both_layers_of_labels_alike_but_for_the_side_the_text_goes_to", () => {
      const { "text-variable-anchor": _w, ...restOfWest } = layout(west());
      const { "text-variable-anchor": _e, ...restOfEast } = layout(east());

      expect(restOfEast).toEqual(restOfWest); // the same text, size, offset from the dot (by its radius) and justification
      expect(layout(east())["text-radial-offset"]).toEqual(["+", ["/", ["get", "radius"], 12], 0.3]); // clear of the dot, which is as big as its radius
      expect(layout(east())["text-justify"]).toBe("auto"); // aligned toward the dot, as the text sits to either side of it
      expect(paint(east())).toEqual(paint(west()));
      expect(west().type).toBe("symbol");
      expect(east().type).toBe("symbol");
    });
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
    for (const view of ["day", "range", "trips", "trip"] as const) {
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
