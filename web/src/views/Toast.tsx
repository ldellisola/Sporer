import { useEffect, useEffectEvent } from "react";
import styles from "./Toast.module.css";

/** How long a toast stays before it asks to go, unless it is given another time. */
const TOAST_MS = 10_000;

export interface ToastProps {
  /** What it says: "Removed 3 points". */
  message: string;
  /** What can be done about it, if anything: the label is the button's name, and the callback is what a press does ("Undo"). */
  action?: { label: string; onClick: () => void };
  /** How long it stays, in milliseconds, before `onDismiss` is called. */
  durationMs?: number;
  /** Called once when its time is up: the panel that shows the toast stops showing it. A press of the action does not call it. */
  onDismiss: () => void;
}

/**
 * A small note at the bottom of a panel that says what has just been done, with at most one thing to do about it (Undo). It is a status,
 * so that a screen reader says it without the focus moving, and goes by itself when its time is up: the panel owns it, shows it while it
 * has one, and is told through `onDismiss` when to stop. A panel that has another toast to show makes a new one (`key`), whose time
 * starts at that moment; rendering the same one again does not start it over, and the timer goes with the toast, so one that was
 * taken away never dismisses what came after it.
 */
export function Toast({ message, action, durationMs = TOAST_MS, onDismiss }: ToastProps) {
  // The latest `onDismiss`, which a render of the panel makes new each time, without a timer that starts again for it.
  const dismiss = useEffectEvent(onDismiss);
  useEffect(() => {
    const timer = window.setTimeout(() => dismiss(), durationMs);
    return () => window.clearTimeout(timer);
  }, [durationMs]);

  return (
    <div className={styles.toast} role="status">
      <span className={styles.message}>{message}</span>
      {action !== undefined && (
        <button type="button" className={styles.action} onClick={action.onClick}>
          {action.label}
        </button>
      )}
    </div>
  );
}
