import { useId } from "react";
import { useFadeRoutes } from "../app/useStoredFlag";
import styles from "./MapSettings.module.css";
import { Section } from "./SettingsSection";

/**
 * How the map draws what it shows. One switch for now: whether the routes of a week, a month, a year or a range are faded (as they are by default, so
 * that many of them read as a texture) or drawn as strongly as a day's. It is the device's own choice, kept as the heat button's is (`useStoredFlag`,
 * through `useFadeRoutes`), and the map reads the same flag: it applies at once, with no request.
 */
export function MapSettings() {
  const [fade, setFade] = useFadeRoutes();
  const noteId = useId();
  return (
    <Section title="Map">
      <label className={styles.row}>
        <input type="checkbox" className={styles.box} checked={fade} aria-describedby={noteId} onChange={(event) => setFade(event.target.checked)} />
        <span>Fade routes in weeks, months and years</span>
      </label>
      <p id={noteId} className={styles.note}>
        Off draws them as strongly as a day's.
      </p>
    </Section>
  );
}
