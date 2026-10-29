import { useId, type ReactNode } from "react";
import rows from "./Rows.module.css";

/** A section of the settings: a heading over what it holds, and the region that a reader can go to by it. */
export function Section({ title, children }: { title: string; children: ReactNode }) {
  const heading = useId();
  return (
    <section className={rows.section} aria-labelledby={heading}>
      <h2 id={heading} className={rows.heading}>
        {title}
      </h2>
      {children}
    </section>
  );
}
