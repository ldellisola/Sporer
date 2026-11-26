import { navigate } from "../app/router";
import styles from "./PlacesPanel.module.css";
import { PlacePicker } from "./PlacePicker";
import rows from "./Rows.module.css";

/**
 * The panel of the places: every place is on the map, and here they are as a list to search, the most visited first (`GET /api/places/search`, as the
 * picker of a home has them). A row, like a dot of the map, opens its place, where Merge with… picks the places near it to merge into it. The field does not
 * take the focus: the list is the page, and on a phone a keyboard would cover the map that the places are on.
 */
export function PlacesPanel() {
  return (
    <>
      <h2 className={`${rows.heading} ${styles.landing}`}>Places</h2>
      <p className={styles.hint}>Tap a place on the map or in the list to open it.</p>
      <PlacePicker autoFocus={false} onPick={(place) => navigate({ view: "place", id: place.id })} />
    </>
  );
}
