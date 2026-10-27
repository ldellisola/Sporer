import { useId } from "react";
import { shownOf, usePlace } from "../api/queries";
import type { PlaceResponse, PlaceVisit } from "../api/types";
import { goBack, navigate } from "../app/router";
import { dateLabel, dateOf } from "../time/dates";
import { formatDuration, formatInteger, formatTime } from "../time/format";
import styles from "./PlacePanel.module.css";
import rows from "./Rows.module.css";
import { Empty, ErrorState, Loading } from "./States";

export interface PlacePanelProps {
  /** The place the address asks for. A panel is made for one place: another place is another panel (the app keys it by this). */
  id: number;
}

/** What the line under the name says of where the place is: the address (which names the city) or else the city, and the country. */
function whereIs(place: PlaceResponse): string | null {
  const parts = [place.address || place.city, place.country].filter((part): part is string => part !== null && part !== "");
  return parts.length === 0 ? null : parts.join(", ");
}

/** The way out, which every state of the panel has: the view the owner came from, or today if the place was opened as a page (`goBack`). */
function BackButton() {
  return (
    <button type="button" className={`${rows.tap} ${styles.back}`} onClick={() => goBack()}>
      <span aria-hidden="true">‹</span> Back
    </button>
  );
}

/** A figure of the place and what it is. The term is read first, and the figure is shown first: that is the mockup's stat. */
function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.stat}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

/**
 * A visit opens its day: the local date it began on, as the API says it (`date`), which is not always the date of it on the clock of
 * this device. Both times are on the clock of the zone it began in. The button is named by what the row says, so that its name holds
 * the text that is on it, and no two rows have the same.
 */
function VisitRow({ visit }: { visit: PlaceVisit }) {
  const day = dateLabel(visit.date);
  const times = `${formatTime(visit.start, visit.timeZone)} – ${formatTime(visit.end, visit.timeZone)}`;
  const length = formatDuration((Date.parse(visit.end) - Date.parse(visit.start)) / 1000);
  return (
    <li>
      <button
        type="button"
        className={`${rows.tap} ${rows.row} ${styles.visit}`}
        aria-label={`Open ${day}, ${times}, ${length}`}
        onClick={() => navigate({ view: "day", date: visit.date })}
      >
        <span className={styles.day}>{day}</span>
        <span className={styles.times}>{times}</span>
        <span className={`${rows.duration} ${styles.length}`}>{length}</span>
      </button>
    </li>
  );
}

/** What is on screen of a place that is there: its name and where it is, its figures, and its latest visits. */
function Place({ place }: { place: PlaceResponse }) {
  const visitsHeading = useId();
  const where = whereIs(place);
  // The response has no zone of the place, only of each visit. A place is where it is, so its visits are in one zone: the one the latest
  // began in. The first and the last visit are dates of that clock (the zone of the instant, and not of this device, which may be
  // anywhere); with no visit to take the zone from, UTC.
  const zone = place.recentVisits[0]?.timeZone ?? "UTC";
  return (
    <>
      <h1 className={styles.name}>{place.name ?? "Unnamed place"}</h1>
      {where !== null && <p className={styles.where}>{where}</p>}
      <dl className={styles.stats}>
        <Stat label="Total time" value={formatDuration(place.totalSeconds)} />
        <Stat label="Visits" value={formatInteger(place.visits)} />
        <Stat label="First visit" value={dateLabel(dateOf(place.firstVisit, zone))} />
        <Stat label="Last visit" value={dateLabel(dateOf(place.lastVisit, zone))} />
      </dl>
      {place.recentVisits.length > 0 && (
        <div className={rows.section}>
          <h2 id={visitsHeading} className={rows.heading}>
            Recent visits
          </h2>
          <ul className={rows.list} aria-labelledby={visitsHeading}>
            {place.recentVisits.map((visit) => (
              <VisitRow key={visit.start} visit={visit} />
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

/**
 * The panel of a place: its name and address, how long the owner spent there in all, how many visits, the dates of the first and the
 * last, and the latest visits, each of which opens its day. Whatever it shows, it has the way back.
 *
 * A place that is no longer there (a 404) says so, with no Retry (asking again cannot help) and nothing of what it showed before: a
 * failure of another kind is an error with its Retry, and the place stays under it if it was on screen. Nothing of another place is
 * ever shown for this one (the query keeps none). The place is the one the map draws, from the same query.
 */
export function PlacePanel({ id }: PlacePanelProps) {
  const place = usePlace(id);
  const { gone, shown } = shownOf(place);
  return (
    <>
      <BackButton />
      {gone && <Empty message="This place no longer exists" />}
      {!gone && place.isError && <ErrorState error={place.error} onRetry={() => void place.refetch()} />}
      {shown !== undefined ? <Place place={shown} /> : !gone && !place.isError && <Loading />}
    </>
  );
}
