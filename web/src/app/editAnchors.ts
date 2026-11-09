import type { RefObject } from "react";

/**
 * Where the shell reaches into the panel of a day for edit mode: the buttons that the focus goes to when what had it is gone (the toast's Undo, once it has
 * been pressed), and the row of the edit bar, which the sheet's peek is as tall as. The panel puts them on its elements, and the shell, which has the toast and
 * the sheet, reads them.
 */
export interface EditAnchors {
  /** The Done of the edit bar: there while edit mode is on. */
  done: RefObject<HTMLButtonElement | null>;
  /** The button that turns edit mode on, in the header of the day: there while it is off. */
  start: RefObject<HTMLButtonElement | null>;
  /** Told of the row of the edit bar when it appears, and with null when it goes. */
  row: (element: HTMLElement | null) => void;
}
