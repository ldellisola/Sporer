import type { ReactNode } from "react";
import styles from "./States.module.css";

// What every view shows while it has nothing to show: it is loading, there is nothing in it, or the load failed. They know
// nothing of what is being loaded; the view says it in `message`, and what to do about a failure in `onRetry`.

/** A view that has no data yet and is waiting for it. */
export function Loading({ message = "Loading…" }: { message?: string }) {
  return <p className={styles.state}>{message}</p>;
}

/** A view whose data came and holds nothing: "No data for this day". */
export function Empty({ message }: { message: string }) {
  return <p className={styles.state}>{message}</p>;
}

/**
 * The view of what was asked for, or of what was on screen before it while that is on its way: then it stays, fainter, and is said to be
 * busy (`aria-busy`), and when what was asked for has come (or has failed, which leaves nothing on its way) it is as it was.
 */
export function Shown({ busy, children }: { busy: boolean; children: ReactNode }) {
  return (
    <div className={styles.shown} aria-busy={busy}>
      {children}
    </div>
  );
}

function describe(error: unknown): string | null {
  if (error === null || error === undefined) return null;
  return error instanceof Error ? error.message : String(error);
}

/**
 * A load that failed, with the way to try again. It is a line of its own, so that whatever the view still has (the period that was
 * on screen before) can stay under it: an error never leaves a blank screen.
 */
export function ErrorState({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const detail = describe(error);
  return (
    <div className={styles.error} role="alert">
      <p className={styles.headline}>Couldn't load — <button type="button" className={styles.retry} onClick={onRetry}>Retry</button></p>
      {detail !== null && <p className={styles.detail}>{detail}</p>}
    </div>
  );
}
