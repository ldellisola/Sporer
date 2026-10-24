import { useEffect, useId, useMemo, useRef, useState, type Ref } from "react";
import { useRange } from "../api/queries";
import type { RangeDay, RangePlace, RangeResponse } from "../api/types";
import { navigate } from "../app/router";
import { addDays, periodDays, shortDayLabel, today } from "../time/dates";
import { formatCount, formatDistance, formatDuration } from "../time/format";
import { Chip, Chips } from "./Chips";
import styles from "./RangePanel.module.css";
import rows from "./Rows.module.css";
import { Shown } from "./Shown";
import { Empty, ErrorState, Loading } from "./States";
import { useKeptData } from "./useKeptData";

export interface RangePanelProps {
  /** The first and the last date of the period, both shown: a week, a month, a year or a range of the owner's choosing. */
  from: string;
  to: string;
}

/**
 * A period of this many dates or fewer (a week, a month, a range that short) lists every one of its dates, up to today. A longer one
 * (a year, a range of months) lists the dates that the API has: three hundred rows of "No movement" would bury the days that there are.
 */
const EVERY_DATE_UP_TO = 31;

/** How many places "Where your time went" lists before it offers the rest: the ones the time went to, and not the long tail of them. */
const TOP_PLACES = 10;

const nameOf = (place: RangePlace): string => place.name ?? place.city ?? "Unnamed place";

/** A place of the ranking: what its row says, the share of the bar, and the name of its button. */
interface Ranked {
  place: RangePlace;
  name: string;
  /** The percentage of the bar that is filled: the time of this place as a share of the time of the top one. */
  share: number;
  label: string;
}

/**
 * The places most time first, each with the share its bar is filled to and the name of its button: "Open Home". A name that two places
 * have (two cafés, two places that are unnamed) also says where it stands in the ranking, so that no two buttons are called the same.
 */
function rank(places: readonly RangePlace[]): Ranked[] {
  const ranked = [...places].sort((a, b) => b.seconds - a.seconds); // a stable sort: equal times keep the order the API gave them
  const top = ranked[0]?.seconds ?? 0;
  const named = new Map<string, number>();
  for (const place of ranked) named.set(nameOf(place), (named.get(nameOf(place)) ?? 0) + 1);
  return ranked.map((place, index) => {
    const name = nameOf(place);
    return {
      place,
      name,
      share: top > 0 ? (place.seconds * 100) / top : 0,
      label: named.get(name) === 1 ? `Open ${name}` : `Open ${name}, number ${index + 1}`,
    };
  });
}

/** A date of the list, and what the API has of it: nothing, for a date with no segment starting on it. */
interface Listed {
  date: string;
  day: RangeDay | undefined;
}

/**
 * The dates the list shows (see `EVERY_DATE_UP_TO`), of the period the response is for, which is not always the one asked for.
 * A day that the API has is always listed. A date it has no day for is listed as a day without movement only up to `today` (a date of
 * this browser's zone): a date after it has not been, so it is no day without movement. The API's days can run past today here when a
 * day was in a zone ahead of this one, and then it has movement and is listed.
 */
function listDays(range: RangeResponse, today: string): Listed[] {
  const count = periodDays({ view: "range", from: range.from, to: range.to });
  if (count > EVERY_DATE_UP_TO) return range.days.map((day) => ({ date: day.date, day }));
  const byDate = new Map(range.days.map((day) => [day.date, day]));
  return Array.from({ length: count }, (_, i) => {
    const date = addDays(range.from, i);
    return { date, day: byDate.get(date) };
  }).filter(({ date, day }) => day !== undefined || date <= today);
}

function PlaceRow({ ranked, ref }: { ranked: Ranked; ref?: Ref<HTMLButtonElement> }) {
  const { place, name, share, label } = ranked;
  return (
    <li>
      <button
        ref={ref}
        type="button"
        className={`${rows.tap} ${styles.row} ${styles.place}`}
        aria-label={label}
        onClick={() => navigate({ view: "place", id: place.id })}
      >
        <span className={styles.name}>{name}</span>
        <span className={styles.track} aria-hidden="true">
          <span className={styles.fill} style={{ width: `${share}%` }} />
        </span>
        <span className={`${rows.duration} ${styles.time}`}>{formatDuration(place.seconds)}</span>
      </button>
    </li>
  );
}

/**
 * A day opens its day, whether or not anything was recorded on it: a date with nothing is a day to look at too (it may say why).
 * The button is named by what the row calls the day ("Open Thu 22 Oct"), so that the name holds the text that is on it.
 */
function DayRow({ date, day }: Listed) {
  const when = shortDayLabel(date);
  return (
    <li>
      <button
        type="button"
        className={day === undefined ? `${rows.tap} ${styles.row} ${styles.day} ${styles.still}` : `${rows.tap} ${styles.row} ${styles.day}`}
        aria-label={`Open ${when}`}
        onClick={() => navigate({ view: "day", date })}
      >
        <span className={styles.date}>{when}</span>
        <span className={styles.stats}>
          {day === undefined ? "No movement" : `${formatDistance(day.distanceMeters)} · ${formatCount(day.places, "place")}`}
        </span>
      </button>
    </li>
  );
}

/**
 * What is on screen of a period: its chips, where the time went, and its days; `asked` says whether it is the period that the address
 * asks for. What was opened (the rest of the places) is closed again for another period, and stays as it was opened for as long as the
 * period is this one, however often it is polled. It is the state that is let go of and not the panel that is made again: a panel
 * that is made again for each period would take the focus of a place row that both periods have (← and → step the period) to the page,
 * and the fade that un-dims what was shown while the period loaded.
 */
function Period({ range, asked, loading }: { range: RangeResponse; asked: boolean; loading: boolean }) {
  const ranked = useMemo(() => rank(range.places), [range.places]);
  const date = today(); // read on every render, so that a panel that is left open over midnight lists the new day
  const days = useMemo(() => listDays(range, date), [range, date]);
  const periodKey = `${range.from}..${range.to}`;
  const [openedFor, setOpenedFor] = useState<string | null>(null); // the period whose rest of the places is shown
  // Adjusting state while rendering, as React documents it: this render is thrown away and made again with `openedFor` set. Once the
  // period is another it is closed, and a period that is stepped back to starts closed too.
  if (openedFor !== null && openedFor !== periodKey) setOpenedFor(null);
  const all = openedFor === periodKey;
  const firstOfTheRest = useRef<HTMLButtonElement>(null);
  const placesHeading = useId();
  const daysHeading = useId();
  const empty = range.places.length === 0 && range.moves.length === 0 && range.days.length === 0;
  const places = all ? ranked : ranked.slice(0, TOP_PLACES);

  // The button that opened the rest is gone with the click, and the focus with it: it goes to where the rest begins.
  useEffect(() => {
    if (all) firstOfTheRest.current?.focus();
  }, [all]);

  return (
    // What is shown while the period asked for is on its way is the period before: it stays, and says it is not the one asked for.
    // Under an error nothing is on its way, and the error says what the period shown is.
    <Shown busy={!asked && loading}>
      <Chips>
        {!empty && (
          <>
            <Chip>{formatCount(range.summary.places, "place")}</Chip>
            <Chip>{formatDistance(range.summary.distanceMeters)}</Chip>
            <Chip>{formatCount(range.summary.moves, "move")}</Chip>
          </>
        )}
        {range.state === "pending" && <Chip updating>Updating…</Chip>}
      </Chips>
      {empty ? (
        // An empty period that is not the one asked for says nothing of the one that is.
        asked ? <Empty message="No data for this period" /> : loading && <Loading />
      ) : (
        <>
          {ranked.length > 0 && (
            <div className={styles.section}>
              <h2 id={placesHeading} className={styles.heading}>
                Where your time went
              </h2>
              <ol className={styles.list} aria-labelledby={placesHeading}>
                {places.map((one, index) => (
                  <PlaceRow key={one.place.id} ranked={one} ref={all && index === TOP_PLACES ? firstOfTheRest : undefined} />
                ))}
              </ol>
              {places.length < ranked.length && (
                <button type="button" className={`${rows.tap} ${styles.row} ${styles.more}`} onClick={() => setOpenedFor(periodKey)}>
                  {`Show all ${formatCount(ranked.length, "place")}`}
                </button>
              )}
            </div>
          )}
          {days.length > 0 && (
            <div className={styles.section}>
              <h2 id={daysHeading} className={styles.heading}>
                Days
              </h2>
              <ul className={styles.list} aria-labelledby={daysHeading}>
                {days.map((one) => (
                  <DayRow key={one.date} {...one} />
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </Shown>
  );
}

/**
 * The panel of a week, a month, a year or a range of days: its summary as chips (an "Updating…" among them while points of the period
 * wait to be processed), where the time went (the places, most time first, with bars that are shares of the top one), and the days of
 * the period to open. A place opens the place and a day opens the day. The period is the one the map draws, from the same query.
 *
 * The period that was on screen stays under the one that is loading, and under an error with its Retry (see `useKeptData`).
 */
export function RangePanel({ from, to }: RangePanelProps) {
  const range = useRange(from, to);
  const shown = useKeptData(range.data);
  return (
    <>
      {range.isError && <ErrorState error={range.error} onRetry={() => void range.refetch()} />}
      {shown === undefined ? (
        !range.isError && <Loading />
      ) : (
        <Period range={shown} asked={shown.from === from && shown.to === to} loading={!range.isError} />
      )}
    </>
  );
}
