import type { ReactNode } from "react";
import styles from "./Shown.module.css";

/**
 * The panel's content for the period it is for, or for the one that was on screen before it while this one is on its way: then the
 * content stays, fainter, and is said to be busy (`aria-busy`), and when the period asked for has come (or has failed, which leaves
 * nothing on its way) it is as it was. It is the content that is wrapped, and not the states (loading, error, empty) that stand in
 * for it.
 */
export function Shown({ busy, children }: { busy: boolean; children: ReactNode }) {
  return (
    <div className={styles.shown} aria-busy={busy}>
      {children}
    </div>
  );
}
