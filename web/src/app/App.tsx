import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { prefetchNeighbours, useDay } from "../api/queries";
import { MapView, type MapData, type MapPadding } from "../map/MapView";
import { BottomSheet, SHEET_PEEK, SHEET_TOP_CLEARANCE } from "../sheet/BottomSheet";
import { Sidebar, SIDEBAR_WIDTH } from "../sheet/Sidebar";
import { Empty, ErrorState, Loading } from "../views/States";
import { Notice } from "../views/Notice";
import { StatusBanner } from "../views/StatusBanner";
import { TopBar } from "../views/TopBar";
import { useKeptData } from "../views/useKeptData";
import styles from "./App.module.css";
import { useRoute, type Route } from "./router";
import { useBottomEdge } from "./useBottomEdge";
import { useMediaQuery } from "./useMediaQuery";

/** From this width the day's panel is a sidebar, below it a bottom sheet. */
const DESKTOP_QUERY = "(min-width: 900px)";

/** What is left between what covers the map and what the map is made to show: a pin is never right at the edge of a sheet. */
const AIR = 16;

// Until the panels of the views arrive (Tasks 9 to 12) the map draws nothing, and the panels are placeholders.
const NO_DATA: MapData = { routes: { type: "FeatureCollection", features: [] } };

// A placeholder for the day's panel, with the states every view has: loading, empty, and an error with a Retry that leaves the day
// that was on screen where it is.
function DayPanel({ date }: { date: string }) {
  const day = useDay(date);
  const shown = useKeptData(day.data);
  return (
    <>
      {day.isError && <ErrorState error={day.error} onRetry={() => void day.refetch()} />}
      {shown === undefined ? (
        !day.isError && <Loading />
      ) : (
        <>
          <p className={styles.summary}>{shown.segments.length === 1 ? "1 segment" : `${shown.segments.length} segments`}</p>
          {shown.date === date && shown.segments.length === 0 && <Empty message="No data for this day" />}
        </>
      )}
    </>
  );
}

function Panel({ route }: { route: Route }) {
  if (route.view === "day") return <DayPanel date={route.date} />;
  return <p className={styles.placeholder}>{`Coming soon: the ${route.view} view.`}</p>;
}

/**
 * The shell every view lives in: the map fills the screen, the top bar floats over it with the notes under it, and the panel of the
 * view is a bottom sheet on a phone and a sidebar from 900 px up. The map is padded by what covers it (see `padding`), so that
 * what it shows lies in the part that is free.
 */
export function App() {
  const route = useRoute();
  const queryClient = useQueryClient();
  const desktop = useMediaQuery(DESKTOP_QUERY);
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
  // the sidebar at the left. A new object only when a number changes, for the map hands it to its controls.
  const padding = useMemo<MapPadding>(
    () => ({
      top: barBottom + AIR,
      right: AIR,
      bottom: desktop ? AIR : sheetHeight + AIR,
      left: desktop ? SIDEBAR_WIDTH + AIR : AIR,
    }),
    [barBottom, desktop, sheetHeight],
  );

  const panel = <Panel route={route} />;
  return (
    <main className={styles.shell} data-layout={desktop ? "desktop" : "phone"}>
      <div className={styles.map}>
        <MapView
          data={NO_DATA}
          fitTo={null}
          padding={padding}
          onStyleError={() => setMapUnavailable(true)}
          onStyleLoad={() => setMapUnavailable(false)}
        />
      </div>
      <div className={styles.top}>
        <div ref={barRef} className={styles.bar}>
          <TopBar route={route} />
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
        <BottomSheet topClearance={Math.max(SHEET_TOP_CLEARANCE, barBottom + 8)} onHeightChange={setSheetHeight}>
          {panel}
        </BottomSheet>
      )}
    </main>
  );
}
