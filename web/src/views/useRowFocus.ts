import { useEffect, useRef } from "react";
import { focusLost } from "./editForms";

/** Where the focus is to go: to the control of the row `to`, or to the fallback (`null`), once the row `after` is off the list, if there is one that is to be. */
interface Move<Key> {
  to: Key | null;
  after?: Key;
}

/** What a list's row does about the focus when the write that was made for it is answered, from the moment the owner pressed its control. */
export interface RowFocus {
  /** The row is going: the write was done, or the server says there is no such thing (a 404, which has the list asked for again, and the row goes with it). */
  leaves: () => void;
  /** The row stays (the write failed, or the 404 will not take it): the control it was pressed on was turned off, and the focus goes back to it. */
  stays: () => void;
}

/**
 * Where the focus goes when what the owner pressed in a row of a list takes the row off it (a trip that is restored, a home that is removed): the row's
 * control, which had the focus, is gone with it. Each row's control is given `control(key)` as its `ref` (it is a button, which cannot take the focus while
 * it is turned off, and every control of the list is while a write is on its way), and what is to have the focus when no row is left, `fallback`: a note
 * that says there are none, or the control that adds one.
 *
 * `start(key)` is called when the control is pressed, to remember which rows are on either side of it, and gives what to call when the write has been
 * answered. When the row goes (`leaves`) the focus is for the control of the next row (the one before it for the last), and for the fallback when none is
 * left; it waits for the row to be gone from `rows` (a 404 has the list asked for again, which has not come yet, while `fetching` is true) and for the
 * control to be turned on again, and is let go of when it has moved, when the owner has put the focus elsewhere (it is theirs), when the row stayed after
 * all (the list that came still has it: it does not jump later, when the row goes for some other reason), and when there is no control to move to.
 * A row that stays (`stays`) has the focus back on its own control, which was off, unless the owner has put it elsewhere.
 */
export function useRowFocus<Row, Key>(rows: readonly Row[], keyOf: (row: Row) => Key, fetching: boolean) {
  const controls = useRef(new Map<Key, HTMLButtonElement>());
  const fallbackRef = useRef<HTMLElement | null>(null);
  const moving = useRef<Move<Key> | null>(null);
  useEffect(() => {
    const move = moving.current;
    if (move === null) return;
    if (move.after !== undefined && rows.some((row) => keyOf(row) === move.after)) {
      // The row is not gone yet. While the list that a 404 asked for again is on its way it may yet go; once that has come it stays, and the focus is not to
      // jump when it goes some other time.
      if (!fetching) moving.current = null;
      return;
    }
    const target = move.to === null ? fallbackRef.current : controls.current.get(move.to);
    if (target instanceof HTMLButtonElement && target.disabled) return;
    moving.current = null;
    if (focusLost()) target?.focus();
  });
  return {
    /** The `ref` of the control of the row `key`. */
    control: (key: Key) => (button: HTMLButtonElement | null) => {
      if (button === null) controls.current.delete(key);
      else controls.current.set(key, button);
    },
    /** The `ref` of what has the focus when no row is left to take it. */
    fallback: (element: HTMLElement | null) => {
      fallbackRef.current = element;
    },
    start: (key: Key): RowFocus => {
      const at = rows.findIndex((row) => keyOf(row) === key);
      const next = rows[at + 1] ?? rows[at - 1];
      const to = next === undefined ? null : keyOf(next);
      return {
        leaves: () => {
          moving.current = { to, after: key };
        },
        stays: () => {
          moving.current = { to: key };
        },
      };
    },
  };
}
