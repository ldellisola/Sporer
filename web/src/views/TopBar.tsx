import { useEffect, useRef, type PointerEvent } from "react";
import { MAX_RANGE_DAYS } from "../api/queries";
import { navigate, type PeriodRoute, type Route } from "../app/router";
import { addDays, isDate, monthOf, periodDays, periodLabel, periodRange, step, today, weekStart } from "../time/dates";
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

/**
 * The earliest date a range field takes. A native date field passes through years the owner does not mean on its way to the one
 * typed (0002, 0020, 0202, 2026), and each of them would otherwise be a range, and a request.
 */
const EARLIEST = "1900-01-01";

/**
 * The date a period is anchored on when the bar switches to another view: the first day of the period it shows (a week's
 * Monday, a month's or a year's first day), and today when it shows none (a place). The address says no more than that.
 */
function anchorOf(route: Route): string {
  switch (route.view) {
    case "day":
      return route.date;
    case "week":
      return route.start;
    case "month":
      return `${route.month}-01`;
    case "year":
      return `${String(route.year).padStart(4, "0")}-01-01`;
    case "range":
      return route.from;
    case "place":
      return today();
  }
}

/** The route of `view` that holds the anchor date; a range holds the whole period that was shown, so that its fields start filled in. */
function switchView(route: Route, view: View): PeriodRoute {
  const anchor = anchorOf(route);
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
      const { from, to } = route.view === "place" ? { from: anchor, to: anchor } : periodRange(route);
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

const TYPING = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';

/** Whether a key press is meant for something the owner is typing into, whose arrow keys are its own. */
const isTyping = (target: EventTarget | null): boolean => target instanceof Element && target.closest(TYPING) !== null;

/**
 * A native date field that the owner can type into and pick from. It is not controlled: a field that React sets back to the last
 * good date would wipe the part of the date being typed (a cleared day, a year half written) with every key. It takes the date
 * of the route when that is another one than it shows, which is when the route was changed by something else (an arrow).
 */
function DateField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (input.current !== null && input.current.value !== value) input.current.value = value;
  }, [value]);
  return (
    <label className={styles.field}>
      {label}
      <input ref={input} type="date" defaultValue={value} min={EARLIEST} onChange={(event) => onChange(event.currentTarget.value)} />
    </label>
  );
}

/**
 * The card that floats at the top of the map: the views as a segmented control, for a range its two dates, and the period with
 * ‹ › to step it. Switching view keeps the date (see `anchorOf`). Stepping is also a swipe along the period, or ← and → on the
 * keyboard unless the focus is in a field. A place has no period to step: its bar has the views to go to, and none is shown as current.
 */
export function TopBar({ route }: { route: Route }) {
  const period = route.view === "place" ? null : route;
  const swipeStart = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (period === null) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      // Alt and ⌘ with an arrow are the browser's (back, forward); a held key would ask for a day every few milliseconds.
      if (event.repeat || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || isTyping(event.target)) return;
      event.preventDefault();
      navigate(step(period, event.key === "ArrowLeft" ? -1 : 1));
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [period]);

  const stepBy = (delta: -1 | 1) => {
    if (period !== null) navigate(step(period, delta));
  };
  const setRange = (edge: "from" | "to", value: string) => {
    const next = route.view === "range" ? editRange(route, edge, value) : null;
    if (next !== null) navigate(next);
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
      <div className={styles.segments} role="group" aria-label="View">
        {SEGMENTS.map(({ view, label }) => (
          <button
            key={view}
            type="button"
            className={styles.segment}
            aria-pressed={route.view === view}
            onClick={() => navigate(switchView(route, view))}
          >
            {label}
          </button>
        ))}
      </div>
      {route.view === "range" && (
        <div className={styles.fields} role="group" aria-label="Date range">
          <DateField label="From" value={route.from} onChange={(value) => setRange("from", value)} />
          <DateField label="To" value={route.to} onChange={(value) => setRange("to", value)} />
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
    </header>
  );
}
