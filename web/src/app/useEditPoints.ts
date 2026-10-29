import { useRef, useState } from "react";
import { deleteJson, postJson } from "../api/client";
import { useWrite } from "../api/mutations";
import { noteDayEdited, useDayPoints } from "../api/queries";
import type { DayPointsResponse, PointRef, RawPoint, RemovePointsResponse } from "../api/types";
import type { Route } from "./router";

// Edit mode for the points of a day: the one small place that holds it, so that the panel, the map and the toast share it. It is state of the
// shell and not of the address: leaving the day, or changing its date, ends it, and a day that is come back to is not in edit mode.

/** What the toast says of what was done: points removed (with the batch to undo it by), nothing removed (the points were gone already), or restored. */
export type PointsToast =
  | { id: number; kind: "removed"; count: number; batch: string; date: string }
  | { id: number; kind: "none" }
  | { id: number; kind: "restored"; count: number };

/** A write of the owner's that is on its way, has failed (an `ApiError`, or whatever `fetch` threw) or is not about: the control shows it. */
export interface PointsWrite {
  run: () => void;
  pending: boolean;
  error: Error | null;
}

export interface PointEditing {
  /** Whether edit mode is on: for the day on show, and for no other. */
  active: boolean;
  /** Turns it on for the day on show; nothing on a view that is not a day. */
  start: () => void;
  /** Turns it off, with the selection and the area. */
  done: () => void;
  /** The raw points of the day, while edit mode is on and they have come. */
  points: DayPointsResponse | undefined;
  /** How loading them is going: on its way, failed, and the way to ask again. */
  load: { pending: boolean; error: Error | null; retry: () => void };
  /**
   * The selected points, by index into `points.points`. A new set for each change, which is never changed after. When the points change it is made for the
   * new list: the points that are still there, by device and time, and not those that are gone. It does not change while a removal is on its way.
   */
  selected: ReadonlySet<number>;
  /** Selects the point if it was not, and takes it off if it was. */
  toggle: (index: number) => void;
  /** Adds the points to the selection (an area does not toggle). */
  select: (indices: readonly number[]) => void;
  clear: () => void;
  /** Whether a drag over the map draws a rectangle to select the points in (the map's "Select area"): on until it is turned off. */
  area: boolean;
  setArea: (on: boolean) => void;
  /** The removal of the selected points: sent once, while it is on its way nothing is sent again. `reset` forgets a failure. */
  removal: PointsWrite & { reset: () => void };
  /** The undo of the last removal that the toast offers. */
  undo: PointsWrite;
  /** What the toast says, or null when there is none. It outlives edit mode: the owner who left it can still undo. */
  toast: PointsToast | null;
  /** Takes the toast away, with the failure of an undo that it was showing. */
  dismiss: () => void;
}

/** `Omit` for each member of a union, which `Omit` itself is not: the members have other keys. */
type Without<T, K extends string> = T extends unknown ? Omit<T, K> : never;

interface Selection {
  /** The points the indices are of: another list is other points. */
  of: DayPointsResponse | undefined;
  set: ReadonlySet<number>;
}

const EMPTY: ReadonlySet<number> = new Set();
const NONE: Selection = { of: undefined, set: EMPTY };

/** What a point is, which the server tells it by and an index into a list does not say: its device and its exact time. */
const keyOf = (points: DayPointsResponse, [t, , , device]: RawPoint): string => `${points.devices[device]}\u0000${t}`;

/**
 * The selection made for another list of points: the points of it that are in `points` still (by device and time), at their indices there, and none of
 * those that are gone. A point that is new, or that came back, is not selected: the owner did not select it.
 */
function remap({ of, set }: Selection, points: DayPointsResponse | undefined): ReadonlySet<number> {
  if (of === undefined || points === undefined || set.size === 0) return EMPTY;
  const keys = new Set([...set].map((index) => keyOf(of, of.points[index]!)));
  const kept = new Set<number>();
  points.points.forEach((point, index) => {
    if (keys.has(keyOf(points, point))) kept.add(index);
  });
  return kept.size === 0 ? EMPTY : kept;
}

/**
 * Edit mode for the points of the day that `route` is (and for no other view): whether it is on, the points, the selection, the area, the removal
 * of what is selected and the Undo of it. The points are asked for only while it is on, and are not kept once it is off (they are heavy). The
 * selection is of the points that are loaded: when they change it is made again for the new list (`remap`), since the indices of one list are not those of another. A removal
 * and an Undo are the shell's, not a panel's, so that one that is on its way when the owner leaves edit mode still says what it did; each
 * has the day rebuilt, which is pending for a while (`noteDayEdited`: asked for every 3 seconds).
 */
export function useEditPoints(route: Route): PointEditing {
  const date = route.view === "day" ? route.date : null;
  // The date that edit mode is on for, and nothing else: a state of the address it is not (see above).
  const [editing, setEditing] = useState<{ date: string; area: boolean } | null>(null);
  // Adjusting state while rendering, as React documents it: this render is thrown away and made again with it ended.
  if (editing !== null && editing.date !== date) setEditing(null);
  const active = editing !== null && editing.date === date;
  const query = useDayPoints(active ? date : null);
  const points = active ? query.data : undefined;
  const [selection, setSelection] = useState<Selection>(NONE);
  // Adjusting state while rendering again: other points have the selection made for them, once, so that a point that went between two lists is not brought back by a third.
  let current = selection;
  if (current.of !== points) {
    current = { of: points, set: remap(current, points) };
    setSelection(current);
  }
  const selected = current.set;

  const [toast, setToast] = useState<PointsToast | null>(null);
  const toasts = useRef(0);
  const nextToast = (toast: Without<PointsToast, "id">): PointsToast => ({ ...toast, id: (toasts.current += 1) }) as PointsToast;

  const remove = useWrite(async ({ day, refs }: { day: string; refs: PointRef[] }) => {
    const answer = await postJson<RemovePointsResponse>("/api/points/remove", { points: refs });
    noteDayEdited(day); // before the write is let go of, which has what is on screen asked for again: the day is pending by then
    return answer;
  });
  const undo = useWrite(async (removed: Extract<PointsToast, { kind: "removed" }>) => {
    await deleteJson(`/api/points/removed/${encodeURIComponent(removed.batch)}`);
    noteDayEdited(removed.date);
  });

  const change = (apply: (base: ReadonlySet<number>) => ReadonlySet<number>): void => {
    if (!active || points === undefined || remove.isPending) return; // while it is on its way the selection is the one that was sent: a tap would only be cleared with it
    if (remove.isError) remove.reset(); // what the failure said was of the selection that was
    setSelection((last) => ({ of: points, set: apply(last.of === points ? last.set : remap(last, points)) }));
  };

  /** Forgets the failure of a removal, which is of the selection and the day that it was: not for one that is on its way, which the reset would make the shell forget. */
  const forgetFailure = (): void => {
    if (!remove.isPending) remove.reset();
  };

  const runRemoval = (): void => {
    if (!active || date === null || points === undefined || selected.size === 0 || remove.isPending) return;
    // In the order of the day, which is the order of the points: the server has no use for any, but a body that is the same for the same selection is a body to look at.
    const refs = [...selected].sort((a, b) => a - b).map((index): PointRef => {
      const [t, , , device] = points.points[index]!;
      return { device: points.devices[device]!, t };
    });
    remove.mutate(
      { day: date, refs },
      {
        onSuccess: ({ batch, count }) => {
          setSelection(NONE);
          undo.reset();
          setToast(batch === null ? nextToast({ kind: "none" }) : nextToast({ kind: "removed", count, batch, date }));
        },
      },
    );
  };

  const runUndo = (): void => {
    if (toast?.kind !== "removed" || undo.isPending) return;
    const removed = toast;
    undo.mutate(removed, { onSuccess: () => setToast(nextToast({ kind: "restored", count: removed.count })) });
  };

  return {
    active,
    start: () => {
      if (date === null) return;
      forgetFailure();
      setEditing({ date, area: false });
      setSelection(NONE);
    },
    done: () => {
      forgetFailure();
      setEditing(null);
      setSelection(NONE);
    },
    points,
    load: { pending: active && query.isPending, error: active ? query.error : null, retry: () => void query.refetch() },
    selected,
    toggle: (index) =>
      change((base) => {
        const next = new Set(base);
        if (!next.delete(index)) next.add(index);
        return next;
      }),
    select: (indices) => change((base) => new Set([...base, ...indices])),
    clear: () => change(() => EMPTY),
    area: active && editing.area,
    setArea: (on) => setEditing((last) => (last === null ? last : { ...last, area: on })),
    removal: { run: runRemoval, pending: remove.isPending, error: remove.error, reset: remove.reset },
    undo: { run: runUndo, pending: undo.isPending, error: undo.error },
    toast,
    dismiss: () => {
      setToast(null);
      undo.reset();
    },
  };
}
