import { useEffect, useId, useRef, useState } from "react";
import { shownOf, useTrip } from "../api/queries";
import type { TripDay, TripResponse } from "../api/types";
import { takeHeadingFocus } from "../app/headingFocus";
import { navigate } from "../app/router";
import { shortDayLabel } from "../time/dates";
import { formatCount, formatDistance } from "../time/format";
import { Chip, Chips, ONGOING } from "./Chips";
import { EditActions, focusLost } from "./editForms";
import rows from "./Rows.module.css";
import { Empty, ErrorState, Loading } from "./States";
import styles from "./TripPanel.module.css";
import { DeleteTripConfirm, EditTripForm } from "./TripEdits";
import { useKeptData } from "./useKeptData";

export interface TripPanelProps {
  /** The trip the address asks for. A panel is made for one trip: another trip is another panel (the app keys it by this). */
  id: string;
}

/**
 * A day opens its Day view. The button is named by what the row says, in the order it says it: "Open Sat 12 Sep, Oslo → Lisbon, Oslo Airport,
 * Lisbon Airport, 55.7 km, 1 flight", so that its name holds all the text that is on it, and no two days have the same (the date is the day's).
 * The plane is a picture and not text of the row: it is hidden from the reader, and the name says the flights in words. A day with no places
 * to name has no line for them, and no empty piece in its name.
 */
function DayRow({ day }: { day: TripDay }) {
  const when = shortDayLabel(day.date);
  const highlights = day.highlights.join(", ");
  const distance = formatDistance(day.groundDistanceMeters);
  const flights = day.flights > 0 ? formatCount(day.flights, "flight") : "";
  const said = [when, day.description, highlights, distance, flights].filter((part) => part !== "");
  return (
    <li>
      <button
        type="button"
        className={`${rows.tap} ${rows.row} ${styles.day}`}
        aria-label={`Open ${said.join(", ")}`}
        onClick={() => navigate({ view: "day", date: day.date })}
      >
        <span className={styles.date}>{when}</span>
        <span className={styles.text}>
          <span className={styles.description}>{day.description}</span>
          {highlights !== "" && <span className={styles.highlights}>{highlights}</span>}
        </span>
        <span className={styles.figures}>
          <span>{distance}</span>
          {day.flights > 0 && (
            <span className={styles.flights} title={flights}>
              <span aria-hidden="true">✈</span>
              <span>{day.flights}</span>
            </span>
          )}
        </span>
      </button>
    </li>
  );
}

/** What an edit is doing to the trip: nothing, or the one form that is open (the forms are in the panel, and only one is open at a time). */
type Editing = "none" | "edit" | "delete";

/** What is on screen of a trip that is there: what can be done to it, its figures as chips ("Ongoing" among them), and its days one by one. */
function Trip({ trip }: { trip: TripResponse }) {
  const daysHeading = useId();
  const { stats } = trip;
  // An edit that took the owner to this trip (a new start date is a new address) asks for the focus to be on the heading of the panel: the form that had it is
  // gone. A trip that has no days has no heading, and the note that says so has it.
  const heading = useRef<HTMLHeadingElement>(null);
  const noDays = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (takeHeadingFocus()) (heading.current ?? noDays.current)?.focus();
  }, []);
  const [editing, setEditing] = useState<Editing>("none");
  // The focus was in the form that is closed, which is gone: it goes back to the button that opened it.
  const [openedBy, setOpenedBy] = useState<"edit" | "delete">();
  const close = () => {
    if (editing !== "none") setOpenedBy(editing);
    setEditing("none");
  };
  return (
    <>
      {editing === "none" && (
        <EditActions
          focus={openedBy}
          actions={[
            { key: "edit", label: "Edit", onClick: () => setEditing("edit") },
            { key: "delete", label: "Delete trip", onClick: () => setEditing("delete") },
          ]}
        />
      )}
      {editing === "edit" && <EditTripForm trip={trip} onClose={close} />}
      {editing === "delete" && <DeleteTripConfirm trip={trip} onClose={close} />}
      <Chips>
        {trip.ongoing && <Chip>{ONGOING}</Chip>}
        <Chip>{formatCount(stats.flights, "flight")}</Chip>
        <Chip>{formatCount(stats.cities, "city", "cities")}</Chip>
        <Chip>{formatCount(stats.places, "place")}</Chip>
        <Chip>{`${formatDistance(stats.groundDistanceMeters)} on the ground`}</Chip>
      </Chips>
      {trip.days.length === 0 ? (
        <Empty ref={noDays} tabIndex={-1} message="No days to show for this trip" />
      ) : (
        <div className={rows.section}>
          <h2 ref={heading} tabIndex={-1} id={daysHeading} className={`${rows.heading} ${styles.landing}`}>
            Day by day
          </h2>
          <ul className={rows.list} aria-labelledby={daysHeading}>
            {trip.days.map((day) => (
              <DayRow key={day.date} day={day} />
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

/**
 * The panel of a trip: what the owner can do to it (name it, give it other dates, delete it: see `TripEdits`), its figures as chips (flights, cities,
 * places, and the distance on the ground, which a flight is not part of, and "Ongoing" while it has not come home) and its days, one row for each, which
 * open the Day view. The trip is the one that the map draws, and the bar names, from the same query (one request).
 *
 * A trip that is no longer there (a 404) says so, with the way out to the list of trips and no Retry (asking again cannot help), and nothing of
 * what it showed before. A failure of another kind is an error with its Retry, and the trip stays under it if it was on screen
 * (`useKeptData`). What is kept is only ever the trip of this panel: another trip's days under this trip's name would be wrong, not just old.
 */
export function TripPanel({ id }: TripPanelProps) {
  const trip = useTrip(id);
  const { gone, shown: found } = shownOf(trip);
  const kept = useKeptData(found, !gone);
  const shown = kept?.id === id ? kept : undefined;
  // A trip that turns gone under a form or a question that has the focus (a 404 to a write, which has the trip asked for again): the focus was in what is
  // gone with it, and goes to the way out. A trip that was never there (a page opened on it) is a page like any other, and takes nothing.
  const toTrips = useRef<HTMLButtonElement>(null);
  const wasShown = useRef(false);
  useEffect(() => {
    if (gone && wasShown.current && focusLost()) toTrips.current?.focus();
    wasShown.current = shown !== undefined;
  }, [gone, shown]);
  return (
    <>
      {gone && (
        <>
          <Empty message="This trip no longer exists" />
          <button ref={toTrips} type="button" className={`${rows.tap} ${styles.toTrips}`} onClick={() => navigate({ view: "trips" })}>
            See all trips
          </button>
        </>
      )}
      {!gone && trip.isError && <ErrorState error={trip.error} onRetry={() => void trip.refetch()} />}
      {shown !== undefined ? <Trip key={shown.id} trip={shown} /> : !gone && !trip.isError && <Loading />}
    </>
  );
}
