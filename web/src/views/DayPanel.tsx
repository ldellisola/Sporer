import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { deleteJson, isNotFound, putJson } from "../api/client";
import { useWrite } from "../api/mutations";
import { dayQueryOptions, noteDayEdited, useDay } from "../api/queries";
import type { DayResponse, GapSegment, Mode, MoveModeResponse, MoveSegment, StaySegment } from "../api/types";
import type { EditAnchors } from "../app/editAnchors";
import { navigate } from "../app/router";
import type { PointEditing } from "../app/useEditPoints";
import { dayGeoJson, MODE_WORDS, modeColor, placePoint, routeMode, stopOrders, type FitFeatures, type RouteProperties, type Feature, type LineString } from "../map/layers";
import { dateOf } from "../time/dates";
import { formatCount, formatDistance, formatDuration, formatTime } from "../time/format";
import { Chip, Chips } from "./Chips";
import styles from "./DayPanel.module.css";
import { EditBar } from "./EditBar";
import forms from "./Forms.module.css";
import { HouseIcon } from "./HouseIcon";
import { ModeButton, ModeMenu, type MenuFocus } from "./ModeMenu";
import { UNNAMED } from "./placeNames";
import rows from "./Rows.module.css";
import { Shown } from "./Shown";
import { Empty, ErrorState, Loading } from "./States";
import { useKeptData } from "./useKeptData";
import { WriteError } from "./WriteError";

type RouteFeature = Feature<LineString, RouteProperties>;

export interface DayPanelProps {
  date: string;
  /** Asks for the map to be brought to these features: a row of the timeline was tapped. Each tap is one call, however often it is the same row. */
  onFocus: (features: FitFeatures) => void;
  /** Edit mode for the points of the day, which the shell holds (the map is edited on, and needs it too). Without it the day has no button to edit its points. */
  edit?: PointEditing;
  /** Where the shell reaches the bar and the button of edit mode (see `EditAnchors`): it puts the focus on one, and sizes the sheet's peek by the bar's row. */
  anchors?: EditAnchors;
}

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

/**
 * The key of the row of each move, by the id of the move: when the move began, so that its row stays the same row when a rebuild of the day gives the
 * move a new id (its menu stays open, and the focus stays on its button, which a change of the mode has the day rebuilt for); its id for a move that
 * began when one before it did, which no day should have.
 */
function moveKeys(day: DayResponse): Map<number, string> {
  const keys = new Map<number, string>();
  const starts = new Set<string>();
  for (const segment of day.segments) {
    if (segment.kind !== "move") continue;
    keys.set(segment.id, starts.has(segment.start) ? `move #${segment.id}` : `move ${segment.start}`);
    starts.add(segment.start);
  }
  return keys;
}

/** The owner's change of the mode of a move of the day `date`: to `mode`, or back to the mode that was detected (null). */
interface ModeChange {
  date: string;
  move: MoveSegment;
  mode: Mode | null;
}

/** What a change of mode that failed could not do, as the verb that follows "Couldn't": "set the mode to Train", "go back to the detected mode". */
const changeWhat = ({ mode }: ModeChange): string => (mode === null ? "go back to the detected mode" : `set the mode to ${MODE_WORDS[mode]}`);

/** The day with what the server answered a change of mode with: the move has that mode, and says that the owner set it. */
const withMode = (day: DayResponse, answer: MoveModeResponse): DayResponse => ({
  ...day,
  segments: day.segments.map((segment) =>
    segment.kind === "move" && segment.id === answer.id ? { ...segment, mode: answer.mode, modeEdited: answer.modeEdited } : segment,
  ),
});

/** What a change of mode that was answered with a 404 says when the server gives no words of its own: the move is not stored any more. */
const GONE_MOVE = "The move had been rebuilt meanwhile, and the day is reloaded.";

/**
 * The owner's changes of the mode of a move (`PUT` and `DELETE /api/moves/{id}/mode`), one at a time: `run` makes one unless one is on its way, and
 * `variables` says which is on its way, or failed last. A change that goes through is shown at once as the server answered it, and has every query
 * asked for again (`useWrite`): the day, and the periods and the trips that draw the move. The server rebuilds the stretch of the move after it, so the
 * day is pending for a few seconds, and is asked for every 3 seconds until it is done (`noteDayEdited`). Going back to the detected mode has no answer
 * to show: the server leaves the stored move as it was (the mode the owner set, "set by you") until the stretch is rebuilt, and the day that is asked for
 * again has the detected mode once it is. A 404 is a move that is not stored any more (a rebuild gives the
 * moves of a day new ids): `useWrite` has the day asked for again, and the day says what happened, for the row goes with the old day.
 */
function useModeChange() {
  const client = useQueryClient();
  const change = useWrite(async ({ move, mode }: ModeChange): Promise<MoveModeResponse | undefined> => {
    const path = `/api/moves/${move.id}/mode`;
    if (mode !== null) return putJson<MoveModeResponse>(path, { mode });
    await deleteJson(path);
    return undefined;
  });
  const run = (variables: ModeChange): void => {
    if (change.isPending) return;
    change.mutate(variables, {
      onSuccess: (answer) => {
        noteDayEdited(variables.date);
        if (answer !== undefined) client.setQueryData(dayQueryOptions(variables.date).queryKey, (old) => old && withMode(old, answer));
      },
    });
  };
  return { ...change, run };
}

interface MoveRowProps {
  move: MoveSegment;
  route: RouteFeature | undefined;
  onFocus: DayPanelProps["onFocus"];
  /** The owner chose a mode for the move in its menu, or "As detected" (null). */
  onChoose: (mode: Mode | null) => void;
  /** Whether a change of this move's mode is on its way: the row says so in place of "set by you". */
  saving: boolean;
  /** Whether a change of the mode of any move is on its way: no menu opens until it is done. */
  busy: boolean;
  /** What the row says under it of a change of its mode that failed, with its Retry, or nothing. */
  failure: ReactNode;
}

/**
 * A move: a bar in the colour of its mode, the word of its mode and its distance ("Walk · 1.1 km"), and how long it took. The word is the button of the
 * menu that sets the mode by hand (`ModeMenu`), which opens under the row; it is above the button that covers the row, and not inside it, as the name of
 * a place is in a stay's row. A mode the owner set says so ("· set by you"), which the button of the row says too, as it says what else the row says.
 * A mode this app does not know (a server newer than the app) is a "Move" in grey, as a move whose mode the server could not tell is.
 */
function MoveRow({ move, route, onFocus, onChoose, saving, busy, failure }: MoveRowProps) {
  const mode = routeMode(move.mode);
  const word = MODE_WORDS[mode];
  const edited = move.modeEdited === true; // an older server leaves it out: not set by the owner
  const distance = formatDistance(move.distanceMeters);
  const when = formatTime(move.start, move.startTimeZone);
  const says = `${word} · ${distance}${edited ? " · set by you" : ""}`;
  const [menu, setMenu] = useState<MenuFocus | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const buttonId = useId();
  const menuId = useId();
  const close = useCallback((refocus: boolean) => {
    setMenu(null);
    if (refocus) button.current?.focus();
  }, []);
  // Every choice is saved, the mode the row says already too: the row may say what the server no longer has. After "As detected" the stored move keeps
  // the mode the owner set, and says so, until the stretch is rebuilt, while the edit itself is gone: choosing that mode again must store it again. The
  // server takes the same mode twice without harm.
  const choose = (choice: Mode | null) => {
    close(true);
    onChoose(choice);
  };
  return (
    <li>
      <div className={`${styles.row} ${styles.quiet}`}>
        <span className={styles.bar} style={{ backgroundColor: modeColor(mode) }} aria-hidden="true" />
        <span className={styles.what}>
          <ModeButton
            ref={button}
            id={buttonId}
            word={word}
            label={`${word}, mode of the move at ${when}${edited ? ", set by you" : ""}`}
            menuId={menuId}
            open={menu !== null}
            busy={busy}
            onOpen={setMenu}
            onClose={() => setMenu(null)}
          />
          {` · ${distance}`}
          {saving ? <span className={styles.mine}> · saving…</span> : edited && <span className={styles.mine}> · set by you</span>}
        </span>
        <span className={rows.duration}>{formatDuration(secondsOf(move))}</span>
        {route !== undefined && <FitButton label={`Show ${says} at ${when} on the map`} onClick={() => onFocus([route])} />}
      </div>
      {menu !== null && (
        <ModeMenu id={menuId} labelledBy={buttonId} button={button} mode={mode} edited={edited} focus={menu} onChoose={choose} onClose={close} />
      )}
      {failure}
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
function Day({ day, asked, loading, onFocus, edit, anchors }: { day: DayResponse; asked: boolean; loading: boolean; onFocus: DayPanelProps["onFocus"]; edit?: PointEditing; anchors?: EditAnchors }) {
  // The numbers are the map's: the pins are labelled from the same `stopOrders`, and the routes tapped are the lines it draws.
  const orders = useMemo(() => stopOrders(day), [day]);
  const routes = useMemo(() => new Map(dayGeoJson(day).routes.features.map((route) => [route.properties.id, route])), [day]);
  const keys = useMemo(() => moveKeys(day), [day]);
  const empty = day.segments.length === 0;
  const isToday = dateOf(new Date().toISOString(), day.timeZone) === day.date;
  const last = day.segments.length - 1;
  const editing = edit?.active === true;
  const ownEditButton = useRef<HTMLButtonElement>(null);
  const editButton = anchors?.start ?? ownEditButton;
  const emptyNote = useRef<HTMLParagraphElement>(null);
  const refocus = useRef(false);
  useEffect(() => {
    if (editing || !refocus.current) return;
    refocus.current = false;
    (editButton.current ?? emptyNote.current)?.focus();
  });

  // The mode of a move set by hand, one change at a time, and what it failed with (see `useModeChange`).
  const modes = useModeChange();
  const goneMove = modes.isError && isNotFound(modes.error) && modes.variables.date === day.date ? modes.variables : null;

  return (
    // What is shown while the day asked for is on its way is the day before: it stays, and says it is not the one asked for. Under an
    // error nothing is on its way, and the error says what the day shown is.
    <Shown busy={!asked && loading}>
      {edit !== undefined && editing && (
        <EditBar
          edit={edit}
          anchors={anchors}
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
      {goneMove !== null && <WriteError what={changeWhat(goneMove)} error={modes.error} onRetry={() => modes.run(goneMove)} gone={GONE_MOVE} />}
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
                return (
                  <MoveRow
                    key={keys.get(segment.id)}
                    move={segment}
                    route={routes.get(segment.id)}
                    onFocus={onFocus}
                    onChoose={(mode) => modes.run({ date: day.date, move: segment, mode })}
                    saving={modes.isPending && modes.variables.move.id === segment.id}
                    busy={modes.isPending}
                    failure={
                      modes.isError && !isNotFound(modes.error) && modes.variables.move.id === segment.id ? (
                        <div className={styles.note}>
                          <WriteError what={changeWhat(modes.variables)} error={modes.error} onRetry={() => modes.run(modes.variables)} />
                        </div>
                      ) : null
                    }
                  />
                );
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
 * place opens the place, and one on the mode of a move opens the menu that sets it (`MoveRow`). The day is the one the map draws, from the
 * same query, and the numbers of its stops are the map's.
 *
 * The day that was on screen stays under the one that is loading, and under an error with its Retry (see `useKeptData`). A day with data has the button
 * that turns on edit mode for its points, which the shell holds (`edit`): see `Day`.
 */
export function DayPanel({ date, onFocus, edit, anchors }: DayPanelProps) {
  const day = useDay(date);
  const shown = useKeptData(day.data);
  return (
    <>
      {day.isError && <ErrorState error={day.error} onRetry={() => void day.refetch()} />}
      {shown === undefined ? (
        !day.isError && <Loading />
      ) : (
        <Day day={shown} asked={shown.date === date} loading={!day.isError} onFocus={onFocus} edit={edit} anchors={anchors} />
      )}
    </>
  );
}
