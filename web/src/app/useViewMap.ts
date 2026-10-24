import { useCallback, useMemo, useState } from "react";
import { useDay } from "../api/queries";
import { dayGeoJson, type FitFeatures } from "../map/layers";
import type { MapData } from "../map/MapView";
import { useKeptData } from "../views/useKeptData";
import { formatRoute, type Route } from "./router";

/** What a view that draws nothing (yet) hands the map. */
const NO_DATA: MapData = { routes: { type: "FeatureCollection", features: [] } };
const NO_FEATURES: FitFeatures = [];

export interface ViewMap {
  /** What the map draws. A collection in it is a new object only when the data behind it is new, as `MapView` wants. */
  data: MapData;
  /** What the map is brought to: a new array for each time it is to move, and null while there is nothing to bring it to. */
  fitTo: FitFeatures | null;
  /** The whole of what is drawn, which the map's Recenter brings back (a row tapped moves `fitTo`, not this); null when nothing is drawn. */
  home: FitFeatures | null;
  /** The panel's way to ask for the map to be brought to something (a row tapped): each call moves the map, the same row or not. */
  onFocus: (features: FitFeatures) => void;
}

/**
 * What one kind of view gives the shell for the map: what to draw, what is in it to fit the map to, and whether it is the data of the
 * route that is asked for (a day that is still loading shows the one before it, which is not).
 */
interface Drawn {
  data: MapData;
  features: FitFeatures;
  ready: boolean;
}

const NOTHING: Drawn = { data: NO_DATA, features: NO_FEATURES, ready: false };

/**
 * The map of a day: its routes and pins from the same query as its panel (the cache gives them the one request). What was drawn last
 * stays while the next day loads, and under an error, as the panel keeps its rows: `useKeptData`. It does not stay through another
 * view: a panel that is mounted when a day is shown again starts with nothing (it says "Loading…", or the error), and so does the map.
 * For the same reason the query gives no previous day of its own (`keepPrevious`), which would be the one from before the other view.
 * Nothing is asked for on a route that is not a day.
 */
function useDayMap(route: Route): Drawn {
  const date = route.view === "day" ? route.date : null;
  const day = useDay(date, false);
  const kept = useKeptData(day.data, date !== null);
  const drawn = useMemo(() => {
    if (kept === undefined) return NOTHING;
    const data = dayGeoJson(kept);
    return { data, features: [...data.routes.features, ...data.stops.features], ready: true };
  }, [kept]);
  if (date === null) return NOTHING;
  return { ...drawn, ready: drawn.ready && kept?.date === date };
}

/** Where the fit stands: for which route, whether it has been made, and what the map was last brought to. */
interface Fit {
  key: string;
  fitted: boolean;
  to: FitFeatures | null;
}

/**
 * What the map of the shell shows for the route: the data of the view (so far the day's; the other views draw nothing, and the later
 * ones are added next to `useDayMap`), and where the map is brought to.
 *
 * The map is brought to what is drawn once for each time a route is shown, at the first data of it that has anything to fit to: a
 * poll or a refetch of the same day never moves a map that the owner has panned, and a day that is shown again (stepped back to, or
 * come back to from another view) is fitted again. A day is fitted in the render that has its data, so one that was prefetched needs no
 * wait. The panel asks for the map to be moved to a row through `onFocus`, and that is a new array each time, which moves it again.
 * The route that is left takes what was asked for with it. What Recenter brings back is `home`, all of what is drawn.
 */
export function useViewMap(route: Route): ViewMap {
  const { data, features, ready } = useDayMap(route);
  const key = formatRoute(route);
  const [fit, setFit] = useState<Fit>({ key, fitted: false, to: null });

  // Adjusting state while rendering, as React documents it: this render is thrown away and made again with `fit` set.
  let current = fit;
  if (current.key !== key) current = { key, fitted: false, to: null };
  if (ready && !current.fitted && features.length > 0) current = { key, fitted: true, to: [...features] }; // always an array of its own
  if (current !== fit) setFit(current);

  const onFocus = useCallback((focused: FitFeatures) => setFit((last) => ({ ...last, to: [...focused] })), []);
  return { data, fitTo: current.to, home: features.length > 0 ? features : null, onFocus };
}
