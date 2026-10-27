import { useCallback, useMemo } from "react";
import { isNotFound } from "../api/client";
import { tripNeighbours, useTrip, useTrips } from "../api/queries";
import type { TripSummary } from "../api/types";
import { navigate } from "../app/router";
import { dateRangeLabel } from "../time/dates";
import styles from "./TopBar.module.css";
import { useArrowKeys, useSwipe } from "./useStepping";

/** What the title row says of a trip while its page is on the way, and a trip is not there to name: neutral, and not a name that is not known. */
const TRIP_LOADING = "Loading trip…";

/** What the title row calls a trip that has no name to show: one that is gone (a 404), and one whose page could not be had. */
const TRIP_UNNAMED = "Trip";

/** The list of trips as long as there is none to read: one array, so that nothing made from it is made again for each render. */
const NO_TRIPS: readonly TripSummary[] = [];

/**
 * The row of a trip, in place of the date row: ‹ the older trip, the trip's name and dates, the newer trip ›. The trips are in the order of
 * the API's list, newest first, so the older one is the next in it, and the arrows have nowhere to go while the list is not there (loading,
 * or it could not be had) or the trip is not in it, and at the ends of it. The keys and a swipe along the row do the same as the arrows
 * (`useStepping`, which the date row uses too), and the keys are not taken from the page while there is no trip either side to step to. The
 * name is the one of the trip's page, which the panel asks for as well (one request): while that is on the way the row says so, and for a
 * trip that is gone it is just "Trip", as it is for one whose page could not be had.
 */
export function TripRow({ id }: { id: string }) {
  const trips = useTrips();
  const trip = useTrip(id);
  const list = trips.data?.trips ?? NO_TRIPS;
  const { older, newer } = useMemo(() => tripNeighbours(list, id), [list, id]);
  const stepTrip = useCallback(
    (delta: -1 | 1) => {
      const to = delta < 0 ? older : newer;
      if (to !== null) navigate({ view: "trip", id: to });
    },
    [older, newer],
  );
  useArrowKeys(older === null && newer === null ? null : stepTrip);
  const swipe = useSwipe(stepTrip);

  // A trip that the server no longer has is not shown under what the query still holds of it from before.
  const shown = isNotFound(trip.error) ? undefined : trip.data;
  const name = shown !== undefined ? shown.name : trip.isError ? TRIP_UNNAMED : TRIP_LOADING;
  return (
    <div className={`${styles.titleRow} ${styles.swipe}`} {...swipe}>
      <button type="button" className={styles.arrow} aria-label="Older trip" disabled={older === null} onClick={() => stepTrip(-1)}>
        ‹
      </button>
      <div className={styles.tripTitle} aria-live="polite">
        <h1 className={styles.label}>{name}</h1>
        {shown !== undefined && <p className={styles.dates}>{dateRangeLabel(shown.localStartDate, shown.localEndDate)}</p>}
      </div>
      <button type="button" className={styles.arrow} aria-label="Newer trip" disabled={newer === null} onClick={() => stepTrip(1)}>
        ›
      </button>
    </div>
  );
}
