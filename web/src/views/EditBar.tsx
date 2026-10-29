import { useEffect, useRef } from "react";
import { isRefusal } from "../api/client";
import type { PointEditing } from "../app/useEditPoints";
import { formatCount, formatInteger } from "../time/format";
import styles from "./EditBar.module.css";
import forms from "./Forms.module.css";
import { ErrorState } from "./States";
import { WriteError } from "./WriteError";

export interface EditBarProps {
  edit: PointEditing;
  /** Called when Done is pressed: the panel that has the bar ends edit mode, and says where the focus goes (back to the button that began it). */
  onDone: () => void;
}

/**
 * What the panel of a day shows in edit mode, at the top of it (where a sheet at its lowest still shows it): how many points are selected, and
 * Clear, Remove and Done; and under them what the owner needs to know: the points are on their way, could not be had (with a Retry), the day has
 * none, or how to select; and why a removal did not go through (`WriteError`: a refusal says it in the words of the server and has no Retry, which a
 * failure that may pass has), and Remove stays off after a refusal until the selection changes, with the focus on Clear if Remove had it. It is the map that is
 * selected on, and it keeps the focus: nothing here takes it as the bar appears.
 *
 * The count is said by a live region of its own (`aria-live`, and no `status`: a page has others, and they are told apart by what they say), so that
 * a screen reader hears the number as points are tapped. While the removal is on its way the selection is held still: it is the one that was sent.
 */
export function EditBar({ edit, onDone }: EditBarProps) {
  const { points, load, removal, selected } = edit;
  const count = selected.size;
  // The server refused it (every 4xx but a 408 and a 429): the same selection is refused again, so Remove is off until the selection changes, which clears the error.
  const refused = isRefusal(removal.error);
  const removeButton = useRef<HTMLButtonElement>(null);
  const clearButton = useRef<HTMLButtonElement>(null);
  // Remove is off after a refusal, and it may have the focus (or the page has it, for it was off while the request was on its way): Clear is the way back.
  useEffect(() => {
    if (!refused) return;
    const focused = document.activeElement;
    if (focused === removeButton.current || focused === null || focused === document.body) clearButton.current?.focus();
  }, [refused]);
  return (
    <div className={styles.bar} role="group" aria-label="Edit points">
      <div className={styles.row}>
        <span className={styles.count} aria-live="polite">
          {`${formatInteger(count)} selected`}
        </span>
        <div className={styles.buttons}>
          <button ref={clearButton} type="button" className={forms.secondary} disabled={count === 0 || removal.pending} onClick={edit.clear}>
            Clear
          </button>
          <button ref={removeButton} type="button" className={forms.primary} disabled={count === 0 || removal.pending || refused} onClick={removal.run}>
            {removal.pending ? "Removing…" : `Remove ${formatCount(count, "point")}`}
          </button>
          <button type="button" className={forms.secondary} onClick={onDone}>
            Done
          </button>
        </div>
      </div>
      {load.pending && <p className={styles.note}>Loading points…</p>}
      {load.error !== null && <ErrorState message="Couldn't load the points" error={load.error} onRetry={load.retry} />}
      {points !== undefined && points.points.length === 0 && <p className={styles.note}>No points on this day</p>}
      {points !== undefined && points.points.length > 0 && count === 0 && <p className={styles.note}>Tap a point, or use Select area on the map.</p>}
      {removal.error !== null && <WriteError what="remove" error={removal.error} onRetry={removal.run} gone="The day no longer exists." />}
    </div>
  );
}
