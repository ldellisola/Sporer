import { useCallback, useMemo, useState } from "react";
import { placeOf, useDay, useHeat, usePlace, useRange, useTrips } from "../api/queries";
import type { DayResponse, PlaceResponse, RangeResponse, TripsResponse } from "../api/types";
import { dayGeoJson, heatGeoJson, placeGeoJson, rangeGeoJson, tripsGeoJson, type FitFeatures, type HeatCollection } from "../map/layers";
import type { MapData } from "../map/MapView";
import { periodRange } from "../time/dates";
import { useKeptData } from "../views/useKeptData";
import { formatRoute, isPeriodRoute, type Route } from "./router";

/** What a view that draws nothing (yet) hands the map. */
const NO_DATA: MapData = { routes: { type: "FeatureCollection", features: [] } };
const NO_FEATURES: FitFeatures = [];

/** The heat of the period on show, for the map's heat button and for the note that says it could not be had. */
export interface HeatState {
  /** Whether the view has a period to show the heat of (a place, the trips and a trip have none), so whether the map has a button for it. */
  available: boolean;
  /**
   * Whether the heat of the period asked for could not be had, while it is asked for and the period has none to draw. The map is drawn
   * without it, routes and all. A refetch that fails over the heat the period already has is not this: the glow stays, and nothing says it
   * could not be had.
   */
  failed: boolean;
  /** Asks for the heat again. */
  retry: () => void;
}

export interface ViewMap {
  /** What the map draws. A collection in it is a new object only when the data behind it is new, as `MapView` wants. */
  data: MapData;
  /** What the map is brought to: a new array for each time it is to move, and null while there is nothing to bring it to. */
  fitTo: FitFeatures | null;
  /** The whole of what is drawn, which the map's Recenter brings back (a row tapped moves `fitTo`, not this); null when nothing is drawn. */
  home: FitFeatures | null;
  /** The panel's way to ask for the map to be brought to something (a row tapped): each call moves the map, the same row or not. */
  onFocus: (features: FitFeatures) => void;
  heat: HeatState;
}

/**
 * What a view gives the shell for the map: what to draw, what is in it to fit the map to, and whether it is the data of the route that
 * is asked for (a day or a period that is still loading shows the one before it, which is not).
 */
interface Drawn {
  data: MapData;
  features: FitFeatures;
  ready: boolean;
}

const NOTHING: Drawn = { data: NO_DATA, features: NO_FEATURES, ready: false };

/** What a response is drawn as: the collections for the map, and the features of them that the map is brought to. */
type Drawing = Omit<Drawn, "ready">;

/** A day: its routes and pins, all of which the map is brought to. */
function drawDay(day: DayResponse): Drawing {
  const data = dayGeoJson(day);
  return { data, features: [...data.routes.features, ...data.stops.features] };
}

/** A period (a week, a month, a year, a range): its faint routes and its dots, all of which the map is brought to. */
function drawPeriod(range: RangeResponse): Drawing {
  const data = rangeGeoJson(range);
  return { data, features: [...data.routes.features, ...data.places.features] };
}

/**
 * What the map of a view draws from the response of the query behind its panel (the cache gives them the one request). What was drawn
 * last stays while the next response loads, and under an error, as the panel keeps its rows: `useKeptData`. It does not stay through
 * another kind of view (`active` is false there): a panel that is mounted when a day or a period is shown again starts with nothing (it
 * says "Loading…", or the error), and so does the map. For the same reason the query gives no previous response of its own
 * (`keepPrevious` is false for the callers), which would be the one from before the other view. The map has what is asked for
 * (`isAsked`) when the response is the one for the date or the dates of the route, and not the one that is kept under it.
 */
function useDrawn<T>(response: T | undefined, active: boolean, draw: (response: T) => Drawing, isAsked: (response: T) => boolean): Drawn {
  const kept = useKeptData(response, active);
  const drawing = useMemo(() => (kept === undefined ? undefined : draw(kept)), [kept, draw]);
  if (kept === undefined || drawing === undefined) return NOTHING;
  return { ...drawing, ready: isAsked(kept) };
}

/** The map of a day. Nothing is asked for on a route that is not a day. */
function useDayMap(route: Route): Drawn {
  const date = route.view === "day" ? route.date : null;
  const day = useDay(date, false);
  return useDrawn(day.data, date !== null, drawDay, (response) => response.date === date);
}

/** The map of a week, a month, a year or a range. Nothing is asked for on a route that is not one of them: a day, a place or a trip. */
function usePeriodMap(route: Route): Drawn {
  const period = route.view === "day" || !isPeriodRoute(route) ? null : periodRange(route);
  const range = useRange(period?.from ?? null, period?.to ?? null, false);
  return useDrawn(range.data, period !== null, drawPeriod, (response) => response.from === period?.from && response.to === period.to);
}

/** A place: its one pin, which the map is brought to. */
function drawPlace(place: PlaceResponse): Drawing {
  const data = placeGeoJson(place);
  return { data, features: data.stops.features };
}

/**
 * The map of a place. Nothing is asked for on a route that is not a place. The query keeps no other place for the one that loads, so
 * what it has is the place that is asked for, and it is drawn as soon as it has it (there is no `useDrawn` here: nothing is carried over
 * from a place to another, or from another kind of view, and under an error the query keeps what it had, as the panel shows what it had).
 * A place that is gone (a 404) is drawn as nothing, as the panel says it no longer exists in place of what it showed.
 */
function usePlaceMap(route: Route): Drawn {
  const { shown: found } = placeOf(usePlace(route.view === "place" ? route.id : null));
  return useMemo(() => (found === undefined ? NOTHING : { ...drawPlace(found), ready: true }), [found]);
}

/** The trips: a dot for each city that was slept in, drawn with the trips' own layers (no routes), all of which the map is brought to. */
function drawTrips(trips: TripsResponse): Drawing {
  const { routes, places } = tripsGeoJson(trips);
  return { data: { routes, places, view: "trips" }, features: places.features };
}

/**
 * The map of the trips: the cities of all of them, from the list that the panel of the trips asks for as well (one request). Nothing is
 * asked for on a route that is not the trips; it is the list that is drawn as soon as it is there, and what was drawn stays under an error,
 * as the panel keeps its list, and goes with the view (see `useDrawn`).
 */
function useTripsMap(route: Route): Drawn {
  const active = route.view === "trips";
  const trips = useTrips(active);
  return useDrawn(trips.data, active, drawTrips, () => true); // there is one list: what is kept is the list asked for
}

/**
 * The heat of the period of the route: a day is a period of its one date, and a place, the trips and a trip have none. Asked for only while the heat is `on`.
 * What is given to draw is the heat of the period that is asked for, and only while the routes drawn are that period's too (`ready`):
 * the glow of one day or period is never under the routes of another. That is why the query keeps no previous period's heat for the
 * one that loads (`keepPrevious` is false), and why the routes of the period before, which stay while the next loads, have none. While
 * the heat of the period loads, or has failed, the routes are drawn without it. A failure is told only when there is no heat of the
 * period to show (`failed`): a poll or a refetch that fails over the heat the query has leaves what it has.
 */
function useHeatMap(route: Route, on: boolean, ready: boolean): { heat: HeatCollection | undefined; state: HeatState } {
  const period = isPeriodRoute(route) ? periodRange(route) : null;
  const asked = on && period !== null;
  const query = useHeat(period?.from ?? null, period?.to ?? null, asked, false);
  const collection = useMemo(() => (query.data === undefined ? undefined : heatGeoJson(query.data)), [query.data]);
  const { refetch } = query;
  const retry = useCallback(() => void refetch(), [refetch]);
  return {
    heat: asked && ready ? collection : undefined, // a query that was turned off still has what it had: not to be drawn
    state: { available: period !== null, failed: asked && query.isError && query.data === undefined, retry },
  };
}

/** Where the fit stands: for which route, whether it has been made, and what the map was last brought to. */
interface Fit {
  key: string;
  fitted: boolean;
  to: FitFeatures | null;
}

/**
 * What the map of the shell shows for the route: the data of the view (the day's, or the period's of a week, a month, a year or a
 * range, or the pin of a place, or the cities of the trips; a trip nothing yet), the heat of its period when `heatOn` (see `useHeatMap`;
 * a place, the trips and a trip have none), and where the map is brought to.
 *
 * The map is brought to what is drawn once for each time a route is shown, at the first data of it that has anything to fit to: a
 * poll or a refetch of the same day or period never moves a map that the owner has panned, and a route that is shown again (stepped
 * back to, or come back to from another view) is fitted again. It is fitted in the render that has its data, so one that was
 * prefetched needs no wait. The panel asks for the map to be moved to a row through `onFocus`, and that is a new array each time,
 * which moves it again. The route that is left takes what was asked for with it. What Recenter brings back is `home`, all of what is
 * drawn.
 */
export function useViewMap(route: Route, heatOn: boolean): ViewMap {
  const day = useDayMap(route);
  const period = usePeriodMap(route);
  const place = usePlaceMap(route);
  const trips = useTripsMap(route);
  // A trip has no map of its own yet: it draws nothing, which is what `NOTHING` is.
  const { data: routes, features, ready } =
    route.view === "day" ? day : route.view === "place" ? place : route.view === "trips" ? trips : isPeriodRoute(route) ? period : NOTHING;
  const { heat, state } = useHeatMap(route, heatOn, ready);
  const data = useMemo(() => (heat === undefined ? routes : { ...routes, heat }), [routes, heat]);
  const key = formatRoute(route);
  const [fit, setFit] = useState<Fit>({ key, fitted: false, to: null });

  // Adjusting state while rendering, as React documents it: this render is thrown away and made again with `fit` set.
  let current = fit;
  if (current.key !== key) current = { key, fitted: false, to: null };
  if (ready && !current.fitted && features.length > 0) current = { key, fitted: true, to: [...features] }; // always an array of its own
  if (current !== fit) setFit(current);

  const onFocus = useCallback((focused: FitFeatures) => setFit((last) => ({ ...last, to: [...focused] })), []);
  return { data, fitTo: current.to, home: features.length > 0 ? features : null, onFocus, heat: state };
}
