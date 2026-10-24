import { useId, useMemo } from "react";
import { useRange } from "../api/queries";
import type { RangeDay, RangePlace, RangeResponse } from "../api/types";
import { navigate } from "../app/router";
import { addDays, periodDays, periodLabel, shortDayLabel } from "../time/dates";
import { formatCount, formatDistance, formatDuration } from "../time/format";
import { Chip, Chips } from "./Chips";
import styles from "./RangePanel.module.css";
import { Empty, ErrorState, Loading, Shown } from "./States";
import { useKeptData } from "./useKeptData";

export interface RangePanelProps {
  /** The first and the last date of the period, both shown: a week, a month, a year or a range of the owner's choosing. */
  from: string;
  to: string;
}

/**
 * A period of this many dates or fewer (a week, a month, a range that short) lists every one of its dates. A longer one (a year, a
 * range of months) lists the dates that the API has: three hundred rows of "No movement" would bury the days that there are.
 */
const EVERY_DATE_UP_TO = 31;

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

/** The dates the list shows (see `EVERY_DATE_UP_TO`), of the period the response is for, which is not always the one asked for. */
function listDays(range: RangeResponse): Listed[] {
  const count = periodDays({ view: "range", from: range.from, to: range.to });
  if (count > EVERY_DATE_UP_TO) return range.days.map((day) => ({ date: day.date, day }));
  const byDate = new Map(range.days.map((day) => [day.date, day]));
  return Array.from({ length: count }, (_, i) => {
    const date = addDays(range.from, i);
    return { date, day: byDate.get(date) };
  });
}

function PlaceRow({ ranked }: { ranked: Ranked }) {
  const { place, name, share, label } = ranked;
  return (
    <li>
      <button type="button" className={`${styles.row} ${styles.place}`} aria-label={label} onClick={() => navigate({ view: "place", id: place.id })}>
        <span className={styles.name}>{name}</span>
        <span className={styles.track} aria-hidden="true">
          <span className={styles.fill} style={{ width: `${share}%` }} />
        </span>
        <span className={styles.duration}>{formatDuration(place.seconds)}</span>
      </button>
    </li>
  );
}

/** A day opens its day, whether or not anything was recorded on it: a date with nothing is a day to look at too (it may say why). */
function DayRow({ date, day }: Listed) {
  return (
    <li>
      <button
        type="button"
        className={day === undefined ? `${styles.row} ${styles.day} ${styles.still}` : `${styles.row} ${styles.day}`}
        aria-label={`Open ${periodLabel({ view: "day", date })}`}
        onClick={() => navigate({ view: "day", date })}
      >
        <span className={styles.date}>{shortDayLabel(date)}</span>
        <span className={styles.stats}>
          {day === undefined ? "No movement" : `${formatDistance(day.distanceMeters)} · ${formatCount(day.places, "place")}`}
        </span>
      </button>
    </li>
  );
}

/** What is on screen of a period: its chips, where the time went, and its days; `asked` says whether it is the period that the address asks for. */
function Period({ range, asked, loading }: { range: RangeResponse; asked: boolean; loading: boolean }) {
  const ranked = useMemo(() => rank(range.places), [range.places]);
  const days = useMemo(() => listDays(range), [range]);
  const placesHeading = useId();
  const daysHeading = useId();
  const empty = range.places.length === 0 && range.moves.length === 0 && range.days.length === 0;

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
            <>
              <h2 id={placesHeading} className={styles.heading}>
                Where your time went
              </h2>
              <ol className={styles.list} aria-labelledby={placesHeading}>
                {ranked.map((one) => (
                  <PlaceRow key={one.place.id} ranked={one} />
                ))}
              </ol>
            </>
          )}
          {days.length > 0 && (
            <>
              <h2 id={daysHeading} className={styles.heading}>
                Days
              </h2>
              <ul className={styles.list} aria-labelledby={daysHeading}>
                {days.map((one) => (
                  <DayRow key={one.date} {...one} />
                ))}
              </ul>
            </>
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
