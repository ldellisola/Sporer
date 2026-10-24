import { useDay } from "../api/queries";
import { periodLabel } from "../time/dates";
import styles from "./App.module.css";
import { useRoute } from "./router";

// A placeholder until the shell and the views arrive (Tasks 8 to 12): it shows the route and, for a day, how much came back.
function DayLine({ date }: { date: string }) {
  const day = useDay(date);
  if (day.isError) return <p className={styles.line}>Couldn't load this day.</p>;
  if (day.data === undefined) return <p className={styles.line}>Loading…</p>;
  return <p className={styles.line}>{day.data.segments.length} segments</p>;
}

export function App() {
  const route = useRoute();
  return (
    <main className={styles.shell}>
      <h1 className={styles.title}>Sporer</h1>
      <p className={styles.line}>{route.view === "place" ? `Place ${route.id}` : periodLabel(route)}</p>
      {route.view === "day" && <DayLine date={route.date} />}
    </main>
  );
}
