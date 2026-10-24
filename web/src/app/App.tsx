import { useState } from "react";
import { useDay } from "../api/queries";
import { MapView, type MapData } from "../map/MapView";
import { periodLabel } from "../time/dates";
import styles from "./App.module.css";
import { useRoute } from "./router";

// A placeholder until the shell and the views arrive (Tasks 8 to 12): the map fills the screen, empty, and over it a card shows
// the route and, for a day, how much came back.
const NO_DATA: MapData = { routes: { type: "FeatureCollection", features: [] } };

function DayLine({ date }: { date: string }) {
  const day = useDay(date);
  if (day.isError) return <p className={styles.line}>Couldn't load this day.</p>;
  if (day.data === undefined) return <p className={styles.line}>Loading…</p>;
  return <p className={styles.line}>{day.data.segments.length} segments</p>;
}

export function App() {
  const route = useRoute();
  const [mapUnavailable, setMapUnavailable] = useState(false);
  return (
    <div className={styles.shell}>
      <div className={styles.map}>
        <MapView data={NO_DATA} fitTo={null} onStyleError={() => setMapUnavailable(true)} />
      </div>
      <main className={styles.card}>
        <h1 className={styles.title}>Sporer</h1>
        <p className={styles.line}>{route.view === "place" ? `Place ${route.id}` : periodLabel(route)}</p>
        {route.view === "day" && <DayLine date={route.date} />}
        {mapUnavailable && (
          <p className={styles.line} role="status">
            Map unavailable
          </p>
        )}
      </main>
    </div>
  );
}
