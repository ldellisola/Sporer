import { useEffect, useRef } from "react";
import { isRefusal } from "../api/client";
import type { PointEditing } from "../app/useEditPoints";
import { formatCount, formatInteger } from "../time/format";
import styles from "./EditBar.module.css";
import { focusLost } from "./editForms";
import forms from "./Forms.module.css";
import { RetryButton } from "./RetryButton";
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
 * count, and Clear, Remove and Done; and where they are asked for again (after a removal or an Undo) and that failed, the words and the Retry of the failure
 * are in the place of the count in the same row, with the buttons as they were. Under the row is what can be missed: how to select, what failed (the line
 * that says which request), and why a removal did not go through (`WriteError`: a refusal says it in the words of the server and has no Retry, which a failure
 * that may pass has); Remove stays off after a refusal until the selection changes. It is the map that is selected on, and it keeps the focus: nothing
 * here takes it as the bar appears.
 *
 * What the row says is in a live region of its own (`aria-live`, and no `status`: a page has others, and they are told apart by what they say), which is
 * there from the first and whose words change, so that a screen reader hears the number as points are tapped. The words of a load that failed are an alert, as
 * everywhere, and take the place of that region in the row while there is nothing to count (a first load): where there is (a later one) the region stays in the
 * page, off the screen and not off the reader (`heardOnly`), so that the count that is tapped meanwhile is heard and the one that comes back is not said again.
 * While the removal is on its way the selection is held still: it is the one that was sent.
 *
 * The focus is never left on the page itself. A button that has the focus and is turned off, or is not there any more, takes it with it, and for a keyboard that is
 * a loss of the place in the bar: so when a removal is answered, or the points to select are gone, and the focus is on the page (or is still on a Remove that
 * is off, which a browser that keeps the focus on a disabled button does), it goes to Clear if that is on, and to Done if it is not: after a removal that went
 * through the selection is empty, and after a refusal Remove is off until it is changed. Where the owner has put the focus (the map, a toast) it is left.
 */
export function EditBar({ edit, onDone }: EditBarProps) {
  const { points, load, removal, selected } = edit;
  const count = selected.size;
  // The server refused it (every 4xx but a 408 and a 429): the same selection is refused again, so Remove is off until the selection changes, which clears the error.
  const refused = isRefusal(removal.error);
  const removeButton = useRef<HTMLButtonElement>(null);
  const clearButton = useRef<HTMLButtonElement>(null);
  const doneButton = useRef<HTMLButtonElement>(null);
  // Whether there is anything to select: while the points load, when they could not be had and when the day has none there is not, and the row is for saying so.
  const selectable = points !== undefined && points.points.length > 0;
  // Where the focus goes when it is lost with a button of the bar (see above): a removal that was answered (the one that was pressed is off while it is sent, and after a
  // refusal until the selection changes), points that are gone (Clear and Remove with them), or Remove off after a refusal, which may have had it. Clear is the way back, and where
  // there is nothing to clear (a removal that went through) Done is the button that is on. Only what has just changed is looked at, and only a focus that is lost is moved.
  const before = useRef({ pending: removal.pending, selectable, refused });
  useEffect(() => {
    const was = before.current;
    before.current = { pending: removal.pending, selectable, refused };
    const answered = was.pending && !removal.pending;
    const emptied = was.selectable && !selectable;
    const turnedOff = !was.refused && refused;
    if (!answered && !emptied && !turnedOff) return;
    const remove = removeButton.current;
    const onOffRemove = remove !== null && remove.disabled && document.activeElement === remove;
    if (!focusLost() && !onOffRemove) return;
    const clear = clearButton.current;
    (clear !== null && !clear.disabled ? clear : doneButton.current)?.focus();
  }, [removal.pending, selectable, refused]);
  // A load that failed takes the place of the count in the row, which is what a sheet at its lowest shows. Where there are no points yet (the first load) there is nothing
  // to count and the region of the count is not there; where there are (they were asked for again), it stays, off the screen, and the buttons stay with it.
  const failure = load.error;
  const selectedCount = `${formatInteger(count)} selected`;
  const said = points === undefined ? (load.pending ? "Loading points…" : selectedCount) : points.points.length === 0 ? "No points on this day" : selectedCount;
  return (
    <div className={styles.bar} role="group" aria-label="Edit points">
      <div className={styles.row}>
        {failure !== null && (
          <div className={styles.problem} role="alert">
            <p className={states.headline}>
              {LOAD_FAILED} — <RetryButton onClick={load.retry} />
            </p>
          </div>
        )}
        {(failure === null || points !== undefined) && (
          <span className={failure === null ? styles.count : `${styles.count} ${styles.heardOnly}`} aria-live="polite">
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
          <button ref={doneButton} type="button" className={forms.secondary} onClick={onDone}>
            Done
          </button>
        </div>
      </div>
      {failure !== null && <p className={styles.note}>{failure.message}</p>}
      {selectable && count === 0 && <p className={styles.note}>Tap a point, or use Select area on the map.</p>}
      {removal.error !== null && <WriteError what="remove" error={removal.error} onRetry={removal.run} gone="The day no longer exists." />}
    </div>
  );
}
