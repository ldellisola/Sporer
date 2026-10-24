import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { prefetchNeighbours } from "../api/queries";
import type { FitFeatures } from "../map/layers";
import { MapView, type MapPadding } from "../map/MapView";
import { BottomSheet, SHEET_PEEK, SHEET_TOP_CLEARANCE, sheetHalfHeight, type BottomSheetHandle } from "../sheet/BottomSheet";
import { Sidebar, SIDEBAR_WIDTH } from "../sheet/Sidebar";
import { periodRange } from "../time/dates";
import { DayPanel } from "../views/DayPanel";
import { Notice } from "../views/Notice";
import { RangePanel } from "../views/RangePanel";
import { StatusBanner } from "../views/StatusBanner";
import { TopBar } from "../views/TopBar";
import styles from "./App.module.css";
import { useRoute, type Route } from "./router";
import { useBottomEdge } from "./useBottomEdge";
import { useLastDay } from "./useLastDay";
import { useMediaQuery } from "./useMediaQuery";
import { useViewMap } from "./useViewMap";
import { useViewportHeight } from "./useViewportHeight";

/** From this width the day's panel is a sidebar, below it a bottom sheet. */
const DESKTOP_QUERY = "(min-width: 900px)";

/** What is left between what covers the map and what the map is made to show: a pin is never right at the edge of a sheet. */
const AIR = 16;

/**
 * The panel of the view of the route. The day has its own, and the week, the month, the year and the range share one (the period
 * they cover is what differs); the place is a placeholder until its panel arrives. `onFocus` is how a panel asks for the map to be
 * brought to something (a row tapped): the map is the shell's, and the one.
 */
function Panel({ route, onFocus }: { route: Route; onFocus: (features: FitFeatures) => void }) {
  if (route.view === "day") return <DayPanel date={route.date} onFocus={onFocus} />;
  if (route.view === "place") return <p className={styles.placeholder}>Coming soon: the place view.</p>;
  const { from, to } = periodRange(route);
  return <RangePanel from={from} to={to} />;
}

/**
 * The shell every view lives in: the map fills the screen, the top bar floats over it with the notes under it, and the panel of the
 * view is a bottom sheet on a phone and a sidebar from 900 px up. The map is padded by what covers it (see `padding`), so that
 * what it shows lies in the part that is free. What the map draws and where it is brought to come from the route (`useViewMap`),
 * and a panel asks the shell to move it (`onFocus`).
 */
export function App() {
  const route = useRoute();
  const queryClient = useQueryClient();
  const desktop = useMediaQuery(DESKTOP_QUERY);
  const viewportHeight = useViewportHeight();
  const lastDay = useLastDay(route);
  const map = useViewMap(route);
  const sheetRef = useRef<BottomSheetHandle>(null);
  const [mapUnavailable, setMapUnavailable] = useState(false);
  const [sheetHeight, setSheetHeight] = useState(SHEET_PEEK);
  const barRef = useRef<HTMLDivElement>(null);
  const barBottom = useBottomEdge(barRef);

  // The periods either side are fetched ahead of time, so that ‹ and › find them at hand. Best effort: it is not waited for, and a
  // failure of it (a date there is no neighbour of) is nobody's concern; the period is asked for again when it is shown.
  useEffect(() => {
    void prefetchNeighbours(queryClient, route).catch(() => undefined);
  }, [queryClient, route]);

  // What covers the map, and some air round it: the bar at the top (as measured), on a phone the sheet at the bottom, on a desktop
  // the sidebar at the left. The sheet counts up to half the screen and no further: above that it is a page to read, which covers the
  // map and the credit under it (the credit is part of the map it credits), and padding for all of it would leave the map no room to
  // fit anything into, and put its buttons and credit under the bar. A new object only when a number changes, for the map hands it
  // to its controls.
  const sheetCovers = Math.min(sheetHeight, sheetHalfHeight(viewportHeight));
  const padding = useMemo<MapPadding>(
    () => ({
      top: barBottom + AIR,
      right: AIR,
      bottom: desktop ? AIR : sheetCovers + AIR,
      left: desktop ? SIDEBAR_WIDTH + AIR : AIR,
    }),
    [barBottom, desktop, sheetCovers],
  );

  // A panel asks for the map to be moved to something (a row tapped). On a phone the sheet may be over the map by then, up to the whole
  // screen: it is brought down to half, where the map shows what it was moved to (the map is padded for half at the most, so that is
  // where it fits things). A sheet at half or at its peek stays; on a desktop there is no sheet.
  const { onFocus: moveMap } = map;
  const onFocus = useCallback(
    (features: FitFeatures) => {
      moveMap(features);
      sheetRef.current?.lowerTo("half");
    },
    [moveMap],
  );
  const panel = <Panel route={route} onFocus={onFocus} />;
  return (
    <main className={styles.shell} data-layout={desktop ? "desktop" : "phone"}>
      <div className={styles.map}>
        <MapView
          data={map.data}
          fitTo={map.fitTo}
          home={map.home}
          padding={padding}
          onStyleError={() => setMapUnavailable(true)}
          onStyleLoad={() => setMapUnavailable(false)}
        />
      </div>
      <div className={styles.top}>
        <div ref={barRef} className={styles.bar}>
          <TopBar route={route} lastDay={lastDay} />
        </div>
        <div className={styles.notices}>
          <StatusBanner />
          {mapUnavailable && <Notice>Map unavailable</Notice>}
        </div>
      </div>
      {desktop ? (
        <Sidebar>{panel}</Sidebar>
      ) : (
        // The sheet at its highest stops short of the bar, which is taller with the range fields and lower under a notch.
        <BottomSheet ref={sheetRef} topClearance={Math.max(SHEET_TOP_CLEARANCE, barBottom + 8)} onHeightChange={setSheetHeight}>
          {panel}
        </BottomSheet>
      )}
    </main>
  );
}
