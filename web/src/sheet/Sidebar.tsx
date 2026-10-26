import type { ReactNode } from "react";
import styles from "./Sidebar.module.css";

/** The width of the sidebar in pixels, which the map is padded by. The style sheet reads it from `--sidebar-width` (tokens.css): keep them one number. */
export const SIDEBAR_WIDTH = 320;

/** The panel of a wide window: a fixed column down the left edge, with the map taking the rest. It holds what the bottom sheet holds. */
export function Sidebar({ children, label = "Details" }: { children: ReactNode; label?: string }) {
  return (
    <aside className={styles.sidebar} aria-label={label}>
      {children}
    </aside>
  );
}
