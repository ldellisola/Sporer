import { useEffect, useMemo, useRef } from "react";
import { useDay } from "../api/queries";
import type { DayResponse, GapSegment, MoveSegment, StaySegment } from "../api/types";
import { navigate } from "../app/router";
import type { PointEditing } from "../app/useEditPoints";
import { dayGeoJson, modeColor, placePoint, stopOrders, type FitFeatures, type RouteProperties, type Feature, type LineString } from "../map/layers";
import { dateOf } from "../time/dates";
import { formatCount, formatDistance, formatDuration, formatTime } from "../time/format";
import { Chip, Chips } from "./Chips";
import styles from "./DayPanel.module.css";
import { EditBar } from "./EditBar";
import forms from "./Forms.module.css";
import { HouseIcon } from "./HouseIcon";
import { UNNAMED } from "./placeNames";
import rows from "./Rows.module.css";
import { Shown } from "./Shown";
import { Empty, ErrorState, Loading } from "./States";
import { useKeptData } from "./useKeptData";

type RouteFeature = Feature<LineString, RouteProperties>;

export interface DayPanelProps {
  date: string;
  /** Asks for the map to be brought to these features: a row of the timeline was tapped. Each tap is one call, however often it is the same row. */
  onFocus: (features: FitFeatures) => void;
  /** Edit mode for the points of the day, which the shell holds (the map is edited on, and needs it too). Without it the day has no button to edit its points. */
  edit?: PointEditing;
}

const MODE_WORDS = { walk: "Walk", cycle: "Cycle", drive: "Drive", flight: "Flight", unknown: "Move" } as const;

const secondsOf = (segment: { start: string; end: string }): number => (Date.parse(segment.end) - Date.parse(segment.start)) / 1000;

/**
 * What a stay's row says of when it was. Both times, each on the clock of the zone it is in, when it was within the day; "until" its end
 * when it began before the day (its first time would be some other day's), "from" its start when it runs past the day, and "All day" when
 * it is both. The last stay of today is taken to run past the day: nothing after it is known, so it is where the owner still is.
 * A stay is on a day by the dates of its own times, as the server counts it: the day of the day's zone is not the day of a stay
 * somewhere else.
 */
function stayTimes(stay: StaySegment, day: DayResponse, ongoing: boolean): string {
  const before = dateOf(stay.start, stay.startTimeZone) < day.date;
  const past = ongoing || dateOf(stay.end, stay.endTimeZone) > day.date;
  if (before && past) return "All day";
  if (before) return `until ${formatTime(stay.end, stay.endTimeZone)}`;
  if (past) return `from ${formatTime(stay.start, stay.startTimeZone)}`;
  return `${formatTime(stay.start, stay.startTimeZone)} – ${formatTime(stay.end, stay.endTimeZone)}`;
}

/**
 * A row of the timeline that takes the map to its segment. The row is a button of its own, laid over the whole row (see the style
 * sheet), and is not the parent of what else in the row can be tapped: a button inside a button is not HTML, and a tap on the name
 * of a place would be a tap on the row too. Its `label` is its only name, so each row's is its own: a stop by its number, a move by
 * when it began, home, which has a house and no number, by the times the row gives. It holds what the row says of itself (the number and
 * the name of a stop, "home" and the name and the times of home, the mode and the distance of a move), so that whoever names a row by what
 * they read on it names its button.
 */
function FitButton({ label, onClick }: { label: string; onClick: () => void }) {
  return <button type="button" className={`${rows.tap} ${styles.fit}`} aria-label={label} onClick={onClick} />;
}

function StayRow({ stay, order, when, onFocus }: { stay: StaySegment; order: number | undefined; when: string; onFocus: DayPanelProps["onFocus"] }) {
  const { place } = stay;
  const name = place?.name ?? UNNAMED;
  const home = place !== null && stay.home; // home is a place: a stay that is at none is not it, whatever it says
  return (
    <li className={styles.row}>
      {home ? (
        // The house is where the number goes, on the pin as on the map: no number for home, and the others are counted without it (`stopOrders`).
        <span className={styles.pin}>
          <HouseIcon />
        </span>
      ) : order === undefined ? (
        <span className={styles.dot} aria-hidden="true" />
      ) : (
        <span className={styles.pin}>{order}</span>
      )}
      <div className={styles.text}>
        {place === null ? (
          <span className={styles.name}>{name}</span>
        ) : (
          <button type="button" className={`${styles.name} ${styles.link}`} onClick={() => navigate({ view: "place", id: place.id })}>
            {name}
          </button>
        )}
        <span className={styles.when}>{when}</span>
      </div>
      <span className={rows.duration}>{formatDuration(secondsOf(stay))}</span>
      {place !== null && (home || order !== undefined) && (
        <FitButton
          label={
            home
              ? `Show home, ${place.name ?? "unnamed place"}, ${when}, on the map`
              : `Show stop ${order}, ${place.name ?? "unnamed place"}, on the map`
          }
          onClick={() => onFocus([placePoint(place)])}
        />
      )}
    </li>
  );
}

function MoveRow({ move, route, onFocus }: { move: MoveSegment; route: RouteFeature | undefined; onFocus: DayPanelProps["onFocus"] }) {
  const mode = move.mode ?? "unknown";
  const says = `${MODE_WORDS[mode]} · ${formatDistance(move.distanceMeters)}`;
  return (
    <li className={`${styles.row} ${styles.quiet}`}>
      <span className={styles.bar} style={{ backgroundColor: modeColor(mode) }} aria-hidden="true" />
      <span className={styles.what}>{says}</span>
      <span className={rows.duration}>{formatDuration(secondsOf(move))}</span>
      {route !== undefined && (
        <FitButton label={`Show ${says} at ${formatTime(move.start, move.startTimeZone)} on the map`} onClick={() => onFocus([route])} />
      )}
    </li>
  );
}

/** Time with no data is said so, and not bridged: it has no line on the map either. */
function GapRow({ gap }: { gap: GapSegment }) {
  return (
    <li className={`${styles.row} ${styles.quiet}`}>
      <span className={styles.dot} aria-hidden="true" />
      <span className={styles.what}>No data</span>
      <span className={rows.duration}>{formatDuration(secondsOf(gap))}</span>
    </li>
  );
}

/**
 * What is on screen of a day: its chips and its timeline; `asked` says whether it is the day that the address asks for. A day with data has the button
 * that turns edit mode on (`edit`) beside its chips, in the header, and edit mode has the bar of it (`EditBar`) at the top in its place: the bar is
 * there for a day that has no data now as well (every point was removed), for edit mode has to be left. The button is for the day asked for: edit mode
 * is that of the day on the address, and not of the one that stays on screen while it loads. Done puts the focus back on the button, which the owner
 * pressed to begin, or, for a day that has no data now (every point was removed, and the rebuilt day is empty) and so has no button, on what the panel says
 * of it; edit mode that ends for another reason (the owner went to another day) leaves the focus where it is.
 */
function Day({ day, asked, loading, onFocus, edit }: { day: DayResponse; asked: boolean; loading: boolean; onFocus: DayPanelProps["onFocus"]; edit?: PointEditing }) {
  // The numbers are the map's: the pins are labelled from the same `stopOrders`, and the routes tapped are the lines it draws.
  const orders = useMemo(() => stopOrders(day), [day]);
  const routes = useMemo(() => new Map(dayGeoJson(day).routes.features.map((route) => [route.properties.id, route])), [day]);
  const empty = day.segments.length === 0;
  const isToday = dateOf(new Date().toISOString(), day.timeZone) === day.date;
  const last = day.segments.length - 1;
  const editing = edit?.active === true;
  const editButton = useRef<HTMLButtonElement>(null);
  const emptyNote = useRef<HTMLParagraphElement>(null);
  const refocus = useRef(false);
  useEffect(() => {
    if (editing || !refocus.current) return;
    refocus.current = false;
    (editButton.current ?? emptyNote.current)?.focus();
  });

  return (
    // What is shown while the day asked for is on its way is the day before: it stays, and says it is not the one asked for. Under an
    // error nothing is on its way, and the error says what the day shown is.
    <Shown busy={!asked && loading}>
      {edit !== undefined && editing && (
        <EditBar
          edit={edit}
          onDone={() => {
            refocus.current = true;
            edit.done();
          }}
        />
      )}
      <div className={styles.head}>
        <Chips>
          {!empty && (
            <>
              <Chip>{formatCount(day.summary.places, "place")}</Chip>
              <Chip>{formatDistance(day.summary.distanceMeters)}</Chip>
              <Chip>{`${formatDuration(day.summary.movingSeconds)} moving`}</Chip>
            </>
          )}
          {day.state === "pending" && <Chip updating>Updating…</Chip>}
        </Chips>
        {edit !== undefined && !editing && asked && !empty && (
          <button ref={editButton} type="button" className={`${forms.secondary} ${styles.edit}`} onClick={edit.start}>
            Edit points
          </button>
        )}
      </div>
      {empty ? (
        // An empty day that is not the one asked for says nothing of the one that is.
        asked ? <Empty ref={emptyNote} tabIndex={-1} message="No data for this day" /> : loading && <Loading />
      ) : (
        <ol className={styles.timeline}>
          {day.segments.map((segment, index) => {
            switch (segment.kind) {
              case "stay":
                return (
                  <StayRow
                    key={segment.id}
                    stay={segment}
                    order={orders.get(segment.id)}
                    when={stayTimes(segment, day, isToday && index === last)}
                    onFocus={onFocus}
                  />
                );
              case "move":
                return <MoveRow key={segment.id} move={segment} route={routes.get(segment.id)} onFocus={onFocus} />;
              case "gap":
                return <GapRow key={segment.id} gap={segment} />;
            }
          })}
        </ol>
      )}
    </Shown>
  );
}

/**
 * The panel of a day: its summary as chips (an "Updating…" among them while points of the day wait to be processed) and its timeline,
 * stays and moves and gaps in the order of the day. A tap on a stay or a move takes the map to it (`onFocus`); a tap on the name of a
 * place opens the place. The day is the one the map draws, from the same query, and the numbers of its stops are the map's.
 *
 * The day that was on screen stays under the one that is loading, and under an error with its Retry (see `useKeptData`). A day with data has the button
 * that turns on edit mode for its points, which the shell holds (`edit`): see `Day`.
 */
export function DayPanel({ date, onFocus, edit }: DayPanelProps) {
  const day = useDay(date);
  const shown = useKeptData(day.data);
  return (
    <>
      {day.isError && <ErrorState error={day.error} onRetry={() => void day.refetch()} />}
      {shown === undefined ? (
        !day.isError && <Loading />
      ) : (
        <Day day={shown} asked={shown.date === date} loading={!day.isError} onFocus={onFocus} edit={edit} />
      )}
    </>
  );
}
