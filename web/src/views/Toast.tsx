import { useEffect, useEffectEvent, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import styles from "./Toast.module.css";

/** How long a toast stays before it asks to go, unless it is given another time. */
const TOAST_MS = 10_000;

/** What a toast says and does. */
export interface ToastData {
  /** Tells one toast from the next: another `id` is another toast, which shows at once and has its whole time. The same `id` is the same toast, however often it is rendered. */
  id: string | number;
  /** What it says: "Removed 3 points". */
  message: string;
  /** What can be done about it, if anything: the label is the button's name, and the callback is what a press does ("Undo"). `disabled` is while that is on its way. */
  action?: { label: string; onClick: () => void; disabled?: boolean };
  /** How long it stays, in milliseconds, before `onDismiss` is called; null for as long as the panel keeps it. Ten seconds when it is not given. */
  durationMs?: number | null;
}

export interface ToastProps {
  /** What it shows, or null when there is nothing to say: the place for it stays, empty (see `Toast`). */
  toast: ToastData | null;
  /** Called once when the time of the toast is up: the panel that shows it stops showing it. A press of the action does not call it. */
  onDismiss: () => void;
  /** A line for what is on its way ("Removing 3 points…"): no time, no action, and gone when it is null. It is said in the live region with the toast, which is there before it is. */
  progress?: string | null;
  /** What else is shown with it, in the same place under it, and is no status: an alert that says why something could not be done. */
  children?: ReactNode;
}

/** The column that every toast is put in: made when the first one is shown, and again if the page has lost it. */
let column: HTMLElement | null = null;

/**
 * The one fixed column in the body of the page that the toasts of every panel (the day's, the settings') are put in, one under the next, in the order they
 * were made: two shown at once are two cards in one column, and not two boxes at the same place. Made when it is first wanted, so that nothing has to
 * provide it, and a toast has no other place than this to be in.
 */
function toastColumn(): HTMLElement {
  if (column === null || !column.isConnected) {
    column = document.createElement("div");
    column.className = styles.column;
    document.body.append(column);
  }
  return column;
}

/**
 * The card of a toast: its message, and at most one thing to do about it. Its time starts when it is made, and stops while it is held, by the
 * pointer over it or the focus in it (WCAG 2.2.1: what goes by itself must not go while it is being read or reached for): what was left of it is
 * all that it has when it is let go. The timer goes with the card, so one that was taken away never dismisses what came after it.
 */
function ToastCard({ toast, onDismiss }: { toast: ToastData; onDismiss: () => void }) {
  const { message, action } = toast;
  const duration = toast.durationMs === undefined ? TOAST_MS : toast.durationMs;
  // The latest `onDismiss`, which a render of the panel makes new each time, without a timer that starts again for it.
  const dismiss = useEffectEvent(onDismiss);
  const [pointer, setPointer] = useState(false);
  const [focus, setFocus] = useState(false);
  const held = pointer || focus;
  const left = useRef(duration);
  useEffect(() => {
    if (duration === null || held) return;
    const started = performance.now();
    const timer = window.setTimeout(() => dismiss(), left.current ?? duration);
    return () => {
      window.clearTimeout(timer);
      left.current = Math.max(0, (left.current ?? duration) - (performance.now() - started));
    };
  }, [duration, held]);

  return (
    <div
      className={styles.toast}
      onPointerEnter={() => setPointer(true)}
      onPointerLeave={() => setPointer(false)}
      onFocus={() => setFocus(true)}
      onBlur={(event) => setFocus(event.currentTarget.contains(event.relatedTarget))}
    >
      <span className={styles.message}>{message}</span>
      {action !== undefined && (
        <button type="button" className={styles.action} disabled={action.disabled} onClick={action.onClick}>
          {action.label}
        </button>
      )}
    </div>
  );
}

/**
 * A small note over the map that says what has just been done, with at most one thing to do about it (Undo), and goes by itself when its
 * time is up. It is in the one fixed column that every toast of the page is put in (`toastColumn`), so that two that are shown together stack and do not
 * overlap: the column is fixed to the viewport, above the peek of the bottom sheet and the home indicator (and beside the sidebar on a wide screen), so that
 * a toast is seen at every height of the sheet and is no part of a panel that may be collapsed or scrolled; and it is in the page's body, for a sheet is
 * moved by a transform, which would make it the box that a fixed one is placed in. The panel owns the toast, and is told through `onDismiss` when to
 * stop showing it.
 *
 * The status it says it in is there whether it has anything to say or not, and the message is put into it: a screen reader announces a live
 * region when what is in it changes, and does not when it is made with its text. A panel that has another toast to show gives it another `id`.
 */
export function Toast({ toast, onDismiss, progress = null, children }: ToastProps) {
  return createPortal(
    <>
      <div role="status" className={styles.live}>
        {toast !== null && <ToastCard key={toast.id} toast={toast} onDismiss={onDismiss} />}
        {progress !== null && (
          <div className={styles.toast}>
            <span className={styles.message}>{progress}</span>
          </div>
        )}
      </div>
      {children}
    </>,
    toastColumn(),
  );
}
