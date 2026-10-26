import type { ReactNode } from "react";
import styles from "./Notice.module.css";

/**
 * A small note that floats over the map without getting in its way: something the owner should know. With `onRetry` it also has the
 * way to try again, for a note that says something could not be had: the note never blocks, and the page goes on without it.
 */
export function Notice({ tone = "info", onRetry, children }: { tone?: "info" | "error"; onRetry?: () => void; children: ReactNode }) {
  return (
    <p className={tone === "error" ? `${styles.notice} ${styles.error}` : styles.notice} role="status">
      {children}
      {onRetry !== undefined && (
        <>
          {" — "}
          <button type="button" className={styles.retry} onClick={onRetry}>
            Retry
          </button>
        </>
      )}
    </p>
  );
}
