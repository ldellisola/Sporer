import { useId } from "react";
import { useTrips } from "../api/queries";
import type { TripListItem } from "../api/types";
import { navigate } from "../app/router";
import { dateRangeLabel } from "../time/dates";
import { formatCount } from "../time/format";
import { Chip, ONGOING } from "./Chips";
import rows from "./Rows.module.css";
import { Empty, ErrorState, Loading } from "./States";
import { TripThumbnail } from "./TripThumbnail";
import styles from "./TripsPanel.module.css";
import { useKeptData } from "./useKeptData";

/** The cities of a trip as its card lists them: "Lisbon · Sintra". A trip with none that are known has none to list. */
const citiesOf = (trip: TripListItem): string => trip.cities.map((city) => city.name).join(" · ");

/**
 * A card opens its trip. The button is named by what the card says, in the order it says it: "Open Lisbon & Sintra, 12 – 16 Sep 2026 · 4 nights,
 * Lisbon · Sintra", so that the name holds all the text that is on it, each line as it is written (the dates and the nights are one line, with the
 * dot between them), and no two trips have the same (the name and the dates are the trip's). The picture is no part of the name.
 */
function TripCard({ trip }: { trip: TripListItem }) {
  const meta = `${dateRangeLabel(trip.localStartDate, trip.localEndDate)} · ${formatCount(trip.nights, "night")}`;
  const cities = citiesOf(trip);
  const said = [trip.name, trip.ongoing ? ONGOING : "", meta, cities].filter((part) => part !== "");
  return (
    <li>
      <button
        type="button"
        className={`${rows.tap} ${rows.row} ${styles.card}`}
        aria-label={`Open ${said.join(", ")}`}
        onClick={() => navigate({ view: "trip", id: trip.id })}
      >
        <TripThumbnail line={trip.thumbnail} />
        <span className={styles.text}>
          <span className={styles.head}>
            <span className={styles.name}>{trip.name}</span>
            {trip.ongoing && <Chip>{ONGOING}</Chip>}
          </span>
          <span className={styles.meta}>{meta}</span>
          {cities !== "" && <span className={styles.cities}>{cities}</span>}
        </span>
      </button>
    </li>
  );
}

/**
 * The panel of the list of trips: a card for each, newest first as the API has them, with the picture of where it went, its name, its dates,
 * its nights and its cities, and "Ongoing" on the one that has not come home. A card opens the trip. The list is the one that the map draws
 * the cities of, and the bar steps through, from the same query (one request).
 *
 * The list that was on screen stays under an error with its Retry (see `useKeptData`). There is one list and no other for it to give way to,
 * so nothing is ever on its way in place of the one that is shown, and it is never faded as the periods are (`Shown`).
 */
export function TripsPanel() {
  const trips = useTrips();
  const shown = useKeptData(trips.data);
  const heading = useId();
  return (
    <>
      <h2 id={heading} className={rows.heading}>
        Trips
      </h2>
      {trips.isError && <ErrorState error={trips.error} onRetry={() => void trips.refetch()} />}
      {shown === undefined ? (
        !trips.isError && <Loading />
      ) : shown.trips.length === 0 ? (
        <Empty message="No trips yet. A trip is a night spent 50 km or more from home." />
      ) : (
        <ul className={`${rows.list} ${styles.cards}`} aria-labelledby={heading}>
          {shown.trips.map((trip) => (
            <TripCard key={trip.id} trip={trip} />
          ))}
        </ul>
      )}
    </>
  );
}
