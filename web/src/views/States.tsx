import type { Ref } from "react";
import { RetryButton } from "./RetryButton";
import styles from "./States.module.css";

// What every view shows while it has nothing to show: it is loading, there is nothing in it, or the load failed. They know
// nothing of what is being loaded; the view says it in `message`, and what to do about a failure in `onRetry`.

/** A view that has no data yet and is waiting for it. */
export function Loading({ message = "Loading…" }: { message?: string }) {
  return <p className={styles.state}>{message}</p>;
}

/**
 * A view whose data came and holds nothing: "No data for this day". A panel that has to put the focus somewhere when what had it is gone gives it a `ref`
 * and `tabIndex={-1}`: the note is what a screen reader then reads, and has no ring (it is no control).
 */
export function Empty({ message, ref, tabIndex }: { message: string; ref?: Ref<HTMLParagraphElement>; tabIndex?: number }) {
  return (
    <p ref={ref} tabIndex={tabIndex} className={styles.state}>
      {message}
    </p>
  );
}

function describe(error: unknown): string | null {
  if (error === null || error === undefined) return null;
  return error instanceof Error ? error.message : String(error);
}

/**
 * A load that failed, with the way to try again. It is a line of its own, so that whatever the view still has (the period that was
 * on screen before) can stay under it: an error never leaves a blank screen. A control that makes a write says what it could not do in
 * `message` ("Couldn't retry"), where a view says nothing and it is "Couldn't load".
 */
export function ErrorState({ error, onRetry, message = "Couldn't load" }: { error: unknown; onRetry: () => void; message?: string }) {
  const detail = describe(error);
  return (
    <div className={styles.error} role="alert">
      <p className={styles.headline}>
        {message} — <RetryButton onClick={onRetry} />
      </p>
      {detail !== null && <p className={styles.detail}>{detail}</p>}
    </div>
  );
}
