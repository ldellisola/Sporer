import type { ReactNode } from "react";
import styles from "./Chips.module.css";

/** What the chip of a trip that has not come home yet says, on its card in the list and on its panel, and in the name of the card's button: one word, said once. */
export const ONGOING = "Ongoing";

/** The row of summary chips that opens a panel. A panel with no chip (nothing to summarise yet) has a row that takes no room. */
export function Chips({ children }: { children: ReactNode }) {
  return <div className={styles.chips}>{children}</div>;
}

/** One figure of the summary; `updating` is the note that points of the period still wait to be processed, which the figures may not yet include. */
export function Chip({ children, updating = false }: { children: string; updating?: boolean }) {
  return <span className={updating ? `${styles.chip} ${styles.updating}` : styles.chip}>{children}</span>;
}
