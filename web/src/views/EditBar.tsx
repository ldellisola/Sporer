import { useEffect, useRef } from "react";
import { isRefusal } from "../api/client";
import type { PointEditing } from "../app/useEditPoints";
import { formatCount, formatInteger } from "../time/format";
import styles from "./EditBar.module.css";
import forms from "./Forms.module.css";
import { RetryButton } from "./RetryButton";
import { ErrorState } from "./States";
import states from "./States.module.css";
import { WriteError } from "./WriteError";

const LOAD_FAILED = "Couldn't load the points";

export interface EditBarProps {
  edit: PointEditing;
  /** Called when Done is pressed: the panel that has the bar ends edit mode, and says where the focus goes (back to the button that began it). */
  onDone: () => void;
}

/**
 * What the panel of a day shows in edit mode, at the top of it, where a sheet at its lowest (the peek that edit mode lowers it to) shows the row of the bar
 * and nothing under it: so the row says all that the owner must see. Where the points are not there to be selected it says why, in the place of the
 * count: they are on their way, they could not be had (with a Retry), or the day has none; and then the only button is Done. Where they are, it is the
 * count, and Clear, Remove and Done. Under the row is what can be missed: how to select, what failed (the line that says which request), and why a
 * removal did not go through (`WriteError`: a refusal says it in the words of the server and has no Retry, which a failure that may pass has); Remove stays off
 * after a refusal until the selection changes, with the focus on Clear if Remove had it. It is the map that is selected on, and it keeps the focus: nothing
 * here takes it as the bar appears.
 *
 * What the row says is in a live region of its own (`aria-live`, and no `status`: a page has others, and they are told apart by what they say), which is
 * there from the first and whose words change, so that a screen reader hears the number as points are tapped. The words of a load that failed are an alert, as
 * everywhere (`ErrorState`), and are in the row too. While the removal is on its way the selection is held still: it is the one that was sent.
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
  // Whether there is anything to select: while the points load, when they could not be had and when the day has none there is not, and the row is for saying so.
  const selectable = points !== undefined && points.points.length > 0;
  // The failure of the first load takes the place of the count in the row. A later one (the points were asked for again) leaves the points that are on screen
  // where they are, and is said under the row, as the failures of the lists are.
  const firstError = points === undefined ? load.error : null;
  const laterError = points === undefined ? null : load.error;
  const selectedCount = `${formatInteger(count)} selected`;
  const said = points === undefined ? (load.pending ? "Loading points…" : selectedCount) : points.points.length === 0 ? "No points on this day" : selectedCount;
  return (
    <div className={styles.bar} role="group" aria-label="Edit points">
      <div className={styles.row}>
        {firstError !== null ? (
          <div className={styles.problem} role="alert">
            <p className={states.headline}>
              {LOAD_FAILED} — <RetryButton onClick={load.retry} />
            </p>
          </div>
        ) : (
          <span className={styles.count} aria-live="polite">
            {said}
          </span>
        )}
        <div className={styles.buttons}>
          {selectable && (
            <>
              <button ref={clearButton} type="button" className={forms.secondary} disabled={count === 0 || removal.pending} onClick={edit.clear}>
                Clear
              </button>
              <button ref={removeButton} type="button" className={forms.primary} disabled={count === 0 || removal.pending || refused} onClick={removal.run}>
                {removal.pending ? "Removing…" : `Remove ${formatCount(count, "point")}`}
              </button>
            </>
          )}
          <button type="button" className={forms.secondary} onClick={onDone}>
            Done
          </button>
        </div>
      </div>
      {firstError !== null && <p className={styles.note}>{firstError.message}</p>}
      {laterError !== null && <ErrorState message={LOAD_FAILED} error={laterError} onRetry={load.retry} />}
      {selectable && count === 0 && <p className={styles.note}>Tap a point, or use Select area on the map.</p>}
      {removal.error !== null && <WriteError what="remove" error={removal.error} onRetry={removal.run} gone="The day no longer exists." />}
    </div>
  );
}
