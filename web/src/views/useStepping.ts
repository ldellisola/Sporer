import { useEffect, useRef, type PointerEvent } from "react";

// How the owner steps what the bar shows (a period, a trip) without its arrows: the arrow keys and a swipe along the row. The two rows
// of the bar that have arrows (the date row and the trip's row) take both from here, so that they cannot come to differ.

/** A swipe along a row steps when it is at least this far, and goes mostly sideways. */
const SWIPE_MIN_PX = 50;

// Where the arrow keys are not the bar's: fields that are typed into, and the map, which pans with them when it has the focus.
const OWNS_ARROWS = 'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="region"][aria-label="Map view"]';

/** Whether a key press is meant for something that has the arrow keys for itself. */
const ownsArrows = (target: EventTarget | null): boolean => target instanceof Element && target.closest(OWNS_ARROWS) !== null;

/**
 * Calls `onStep` with -1 for ← and 1 for →, unless the focus is in a field or on the map (see `OWNS_ARROWS`). Nothing is listened for
 * while `onStep` is null: a bar that has nothing to step does not take the keys from the page.
 */
export function useArrowKeys(onStep: ((delta: -1 | 1) => void) | null): void {
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

/** The handlers that make a row a swipe to step along: give them to the row, with `touch-action: pan-y` so that the browser leaves the sideways move to the app. */
export interface SwipeHandlers {
  onPointerDown: (event: PointerEvent) => void;
  onPointerUp: (event: PointerEvent) => void;
  onPointerCancel: () => void;
}

/**
 * A swipe along a row steps it: `onStep` is called with 1 for a finger moving to the left (which brings the next) and -1 for one moving
 * to the right, when the move is at least `SWIPE_MIN_PX` and goes mostly sideways (a drag down it is a scroll, and is not taken). A press
 * the browser takes over (a cancel), and a release that was not pressed here, are no swipe. A null `onStep` takes the swipes and does nothing.
 */
export function useSwipe(onStep: ((delta: -1 | 1) => void) | null): SwipeHandlers {
  const start = useRef<{ x: number; y: number } | null>(null);
  return {
    onPointerDown: (event) => {
      if (event.isPrimary) start.current = { x: event.clientX, y: event.clientY };
    },
    onPointerUp: (event) => {
      const from = start.current;
      start.current = null;
      if (from === null) return;
      const across = event.clientX - from.x;
      const down = event.clientY - from.y;
      if (Math.abs(across) >= SWIPE_MIN_PX && Math.abs(across) > 2 * Math.abs(down)) onStep?.(across < 0 ? 1 : -1); // a finger to the left brings the next
    },
    onPointerCancel: () => {
      start.current = null;
    },
  };
}
