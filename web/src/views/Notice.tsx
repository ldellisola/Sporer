import type { ReactNode } from "react";
import styles from "./Notice.module.css";

/** A small note that floats over the map without getting in its way: something the owner should know, not something to act on. */
export function Notice({ tone = "info", children }: { tone?: "info" | "error"; children: ReactNode }) {
  return (
    <p className={tone === "error" ? `${styles.notice} ${styles.error}` : styles.notice} role="status">
      {children}
    </p>
  );
}
