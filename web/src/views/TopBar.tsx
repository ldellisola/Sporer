import { useCallback, useEffect, useMemo, useRef, type PointerEvent } from "react";
import { isNotFound } from "../api/client";
import { tripNeighbours, useTrip, useTrips } from "../api/queries";
import type { TripSummary } from "../api/types";
import { isPeriodRoute, navigate, type PeriodRoute, type Route } from "../app/router";
import { addDays, isDate, MAX_RANGE_DAYS, monthOf, periodDays, periodLabel, periodRange, step, today, weekStart } from "../time/dates";
import styles from "./TopBar.module.css";

type View = PeriodRoute["view"];
type RangeRoute = Extract<PeriodRoute, { view: "range" }>;

const SEGMENTS: readonly { view: View; label: string }[] = [
  { view: "day", label: "Day" },
  { view: "week", label: "Week" },
  { view: "month", label: "Month" },
  { view: "year", label: "Year" },
  { view: "range", label: "Range" },
];

/** A swipe along the date row steps the period when it is at least this far, and goes mostly sideways. */
const SWIPE_MIN_PX = 50;

/** How long a date left in a range field, with the focus still in it, waits for another edit before it is taken. */
const COMMIT_AFTER_MS = 600;

/**
 * The earliest date a range field takes. A native date field passes through years the owner does not mean on its way to the one
 * typed (0002, 0020, 0202, 2026), and each of them would otherwise be a range, and a request.
 */
const EARLIEST = "1900-01-01";

/**
 * The date a period is anchored on when the bar switches to another view: the day that was shown last when it lies in the period
 * that is shown, else today when today does, else the first day of the period (a week's Monday, a month's or a year's first day).
 * A place, the trips and a trip have no period: the day shown last, else today. The address says no more than the period, so the last
 * day is the app's to remember (`useLastDay`), and it is what brings a month or a year back to the day that was looked at.
 */
function anchorOf(route: Route, lastDay: string | null): string {
  if (!isPeriodRoute(route)) return lastDay ?? today();
  const { from, to } = periodRange(route);
  if (lastDay !== null && lastDay >= from && lastDay <= to) return lastDay;
  const now = today();
  return now >= from && now <= to ? now : from;
}

/** The route of `view` that holds the anchor date; a range holds the whole period that was shown, so that its fields start filled in. */
function switchView(route: Route, view: View, lastDay: string | null): PeriodRoute {
  const anchor = anchorOf(route, lastDay);
  switch (view) {
    case "day":
      return { view, date: anchor };
    case "week":
      return { view, start: weekStart(anchor) };
    case "month":
      return { view, month: monthOf(anchor) };
    case "year":
      return { view, year: Number(anchor.slice(0, 4)) };
    case "range": {
      const { from, to } = isPeriodRoute(route) ? periodRange(route) : { from: anchor, to: anchor };
      return { view, from, to };
    }
  }
}

/**
 * The range after one of its ends was set to `value`, or null when that is no date to take. The range stays one that can be
 * asked for: a start after the end takes the end along (and the other way round), and the other end gives way when the range
 * would be longer than the API allows.
 */
function editRange(route: RangeRoute, edge: "from" | "to", value: string): RangeRoute | null {
  if (!isDate(value) || value < EARLIEST) return null;
  let { from, to } = route;
  if (edge === "from") {
    from = value;
    if (to < from) to = from;
    if (periodDays({ view: "range", from, to }) > MAX_RANGE_DAYS) to = addDays(from, MAX_RANGE_DAYS - 1);
  } else {
    to = value;
    if (from > to) from = to;
    if (periodDays({ view: "range", from, to }) > MAX_RANGE_DAYS) from = addDays(to, 1 - MAX_RANGE_DAYS);
  }
  return { view: "range", from, to };
}

/** Whether `typed` set as one end of the range leaves the other end alone: it is a date, and the range stays as it is with it. */
function isPlainEdit(route: RangeRoute, edge: "from" | "to", typed: string): boolean {
  const next = editRange(route, edge, typed);
  return next !== null && (edge === "from" ? next.to === route.to : next.from === route.from);
}

// Where the arrow keys are not the bar's: fields that are typed into, and the map, which pans with them when it has the focus.
const OWNS_ARROWS = 'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="region"][aria-label="Map view"]';

/** Whether a key press is meant for something that has the arrow keys for itself. */
const ownsArrows = (target: EventTarget | null): boolean => target instanceof Element && target.closest(OWNS_ARROWS) !== null;

/**
 * Calls `onStep` with -1 for ← and 1 for →, unless the focus is in a field or on the map (see `OWNS_ARROWS`). Nothing is listened for
 * while `onStep` is null: a bar that has nothing to step does not take the keys from the page.
 */
function useArrowKeys(onStep: ((delta: -1 | 1) => void) | null): void {
  useEffect(() => {
    if (onStep === null) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      // Alt and ⌘ with an arrow are the browser's (back, forward); a held key would ask for a day every few milliseconds.
      if (event.repeat || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || ownsArrows(event.target)) return;
      event.preventDefault();
      onStep(event.key === "ArrowLeft" ? -1 : 1);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onStep]);
}

interface DateFieldProps {
  label: string;
  /** The date of the route. */
  value: string;
  /** The date of the route at the other end of the range: a draft was typed against it, so it goes when this changes too. */
  other: string;
  /** Takes a date typed into the field; whether it was one to take. */
  onCommit: (typed: string) => boolean;
  /** Whether a date typed into the field is one to take as it is, without the other end of the range having to give way. */
  isPlain: (typed: string) => boolean;
}

/**
 * A native date field that the owner can type into and pick from. What is typed is a draft, held in the field, and not each part of
 * the date: the browser reports every one (the 2 of 28 is the 2nd) and each would be a range, a history entry and a request, and
 * would drag the other end of the range along. A draft is taken when the field is left or Enter is pressed, and also, when it is
 * fine as it is (the range stays a range of 400 days at most), once it has been left alone for a moment with the focus still in
 * the field: a date picked from the calendar of a desktop browser leaves the focus there, and nothing else would take it. One that
 * is not fine waits to be left, and is then made to fit (see `editRange`). The field is not controlled: one that React set back to
 * the last good date would wipe the part being typed. It takes the date of the route when that is another one than it shows, which
 * is when something else moved the route (an arrow, Back), and the draft it had is dropped with the pause that was running; a date that
 * is no date to take is put back to the route's. The draft goes as well when only the other end of the range moved (Back to a range
 * that has the same start and another end): it was fine against the end it was typed against, and may not be against the new one.
 */
function DateField({ label, value, other, onCommit, isPlain }: DateFieldProps) {
  const input = useRef<HTMLInputElement>(null);
  const pause = useRef<number | undefined>(undefined);
  // The latest of the props, for the pause that ends after them: a route that moved meanwhile is the one to take the date into.
  const latest = useRef({ value, onCommit, isPlain });
  useEffect(() => {
    latest.current = { value, onCommit, isPlain };
  });

  const stop = () => {
    window.clearTimeout(pause.current);
    pause.current = undefined;
  };
  const commit = () => {
    stop();
    const typed = input.current?.value;
    if (typed !== undefined && !latest.current.onCommit(typed) && input.current !== null) input.current.value = latest.current.value;
  };
  const onChange = () => {
    stop();
    if (input.current !== null && isPlain(input.current.value)) pause.current = window.setTimeout(commit, COMMIT_AFTER_MS);
  };

  // Whenever either end of the range moves the pause is dropped here. The route is read from the address, so a change of it renders
  // and runs this at once, before any timer can fire: a date that ends its pause is always one that was checked against the range it
  // ends in, and needs no second look.
  useEffect(() => {
    stop();
    if (input.current !== null && input.current.value !== value) input.current.value = value;
  }, [value, other]);
  useEffect(() => stop, []);

  return (
    <label className={styles.field}>
      {label}
      <input
        ref={input}
        type="date"
        defaultValue={value}
        min={EARLIEST}
        onChange={onChange}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit();
        }}
      />
    </label>
  );
}

/** What the title row says of a trip while its page is on the way, and a trip is not there to name: neutral, and not a name that is not known. */
const TRIP_LOADING = "Loading trip…";

/** What the title row calls a trip that has no name to show: one that is gone (a 404), and one whose page could not be had. */
const TRIP_UNNAMED = "Trip";

/** The list of trips as long as there is none to read: one array, so that nothing made from it is made again for each render. */
const NO_TRIPS: readonly TripSummary[] = [];

/** The suitcase of the Trips button, drawn in place: it takes the colour of the button's text. */
function Suitcase() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="3.5" y="7.5" width="17" height="12" rx="2.5" />
      <path d="M9 7.5V6a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 15 6v1.5" />
      <path d="M8.5 7.5v12M15.5 7.5v12" />
    </svg>
  );
}

/**
 * The row of a trip, in place of the date row: ‹ the older trip, the trip's name and dates, the newer trip ›. The trips are in the order of
 * the API's list, newest first, so the older one is the next in it, and the arrows have nowhere to go while the list is not there (loading,
 * or it could not be had) or the trip is not in it, and at the ends of it. The keys do the same as the arrows. The name is the one of the
 * trip's page, which the panel asks for as well (one request): while that is on the way the row says so, and for a trip that is gone it
 * is just "Trip", as it is for one whose page could not be had.
 */
function TripRow({ id }: { id: string }) {
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
  useArrowKeys(stepTrip);

  // A trip that the server no longer has is not shown under what the query still holds of it from before.
  const shown = isNotFound(trip.error) ? undefined : trip.data;
  const name = shown !== undefined ? shown.name : trip.isError ? TRIP_UNNAMED : TRIP_LOADING;
  return (
    <div className={styles.titleRow}>
      <button type="button" className={styles.arrow} aria-label="Older trip" disabled={older === null} onClick={() => stepTrip(-1)}>
        ‹
      </button>
      <div className={styles.tripTitle} aria-live="polite">
        <h1 className={styles.label}>{name}</h1>
        {shown !== undefined && <p className={styles.dates}>{periodLabel({ view: "range", from: shown.localStartDate, to: shown.localEndDate })}</p>}
      </div>
      <button type="button" className={styles.arrow} aria-label="Newer trip" disabled={newer === null} onClick={() => stepTrip(1)}>
        ›
      </button>
    </div>
  );
}

/**
 * The card that floats at the top of the map: the views as a segmented control with the Trips button after it, for a range its two
 * dates, and the period with ‹ › to step it. Switching view keeps the date (see `anchorOf`; `lastDay` is the day shown last). Stepping is
 * also a swipe along the period, or ← and → on the keyboard unless the focus is in a field or on the map. A place has no period to step: its
 * bar has the views to go to, and none is shown as current. The trips are the same: the list has a title in the place of the period, and a
 * trip its name and dates, with ‹ › to step to the trips either side of it (see `TripRow`); the Trips button is the one that is pressed.
 */
export function TopBar({ route, lastDay = null }: { route: Route; lastDay?: string | null }) {
  const period = isPeriodRoute(route) ? route : null;
  const swipeStart = useRef<{ x: number; y: number } | null>(null);

  const stepPeriod = useMemo(() => (period === null ? null : (delta: -1 | 1) => navigate(step(period, delta))), [period]);
  useArrowKeys(stepPeriod);

  const stepBy = (delta: -1 | 1) => stepPeriod?.(delta);
  /** Takes a date typed into one end of the range; whether it was one to take. */
  const setRange = (edge: "from" | "to", typed: string): boolean => {
    const next = route.view === "range" ? editRange(route, edge, typed) : null;
    if (next === null) return false;
    navigate(next);
    return true;
  };

  const onPointerDown = (event: PointerEvent) => {
    if (event.isPrimary) swipeStart.current = { x: event.clientX, y: event.clientY };
  };
  const onPointerUp = (event: PointerEvent) => {
    const start = swipeStart.current;
    swipeStart.current = null;
    if (start === null) return;
    const across = event.clientX - start.x;
    const down = event.clientY - start.y;
    if (Math.abs(across) >= SWIPE_MIN_PX && Math.abs(across) > 2 * Math.abs(down)) stepBy(across < 0 ? 1 : -1); // a finger to the left brings the next
  };

  return (
    <header className={styles.bar}>
      <div className={styles.head}>
        <div className={styles.segments} role="group" aria-label="View">
          {SEGMENTS.map(({ view, label }) => (
            <button
              key={view}
              type="button"
              className={styles.segment}
              aria-pressed={route.view === view}
              onClick={() => navigate(switchView(route, view, lastDay))}
            >
              {label}
            </button>
          ))}
        </div>
        <button
          type="button"
          className={styles.trips}
          aria-label="Trips"
          aria-pressed={route.view === "trips" || route.view === "trip"}
          onClick={() => navigate({ view: "trips" })}
        >
          <Suitcase />
        </button>
      </div>
      {route.view === "range" && (
        <div className={styles.fields} role="group" aria-label="Date range">
          <DateField
            label="From"
            value={route.from}
            other={route.to}
            onCommit={(typed) => setRange("from", typed)}
            isPlain={(typed) => isPlainEdit(route, "from", typed)}
          />
          <DateField
            label="To"
            value={route.to}
            other={route.from}
            onCommit={(typed) => setRange("to", typed)}
            isPlain={(typed) => isPlainEdit(route, "to", typed)}
          />
        </div>
      )}
      {period !== null && (
        <div
          className={styles.dateRow}
          onPointerDown={onPointerDown}
          onPointerUp={onPointerUp}
          onPointerCancel={() => (swipeStart.current = null)}
        >
          <button type="button" className={styles.arrow} aria-label={`Previous ${period.view}`} onClick={() => stepBy(-1)}>
            ‹
          </button>
          <h1 className={styles.label} aria-live="polite">
            {periodLabel(period)}
          </h1>
          <button type="button" className={styles.arrow} aria-label={`Next ${period.view}`} onClick={() => stepBy(1)}>
            ›
          </button>
        </div>
      )}
      {route.view === "trips" && (
        <div className={styles.titleRow}>
          <h1 className={styles.label}>Trips</h1>
        </div>
      )}
      {route.view === "trip" && <TripRow id={route.id} />}
    </header>
  );
}
