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
 * The focus is mended where it has been lost with a button of the bar: a button that has it and is turned off, or is not there any more, takes it with it, and for a
 * keyboard that is the place in the bar. These are the changes at which it is looked at, and no others: a removal is answered (the Remove that was pressed is off while
 * it is sent); the points to select are gone (Clear and Remove with them); a refusal turns Remove off; and the alert goes after its Retry was pressed with the focus on
 * it (the load went through or, for a first load, is asked for again). Then, if the focus is on the page (or is still on a Remove that is off, which a browser that
 * keeps the focus on a disabled button does), it goes to Clear if that is on, else to Done. Clear's own press, with the focus on it, moves it to Done: the selection is
 * empty and Clear is off. A focus that the owner has put elsewhere (the map, a toast) is left, and so is one that is on the page and was never in the bar: a tap on
 * the map leaves it there on iOS, so a count that falls to nothing is not one of the changes.
 */
export function EditBar({ edit, onDone }: EditBarProps) {
  const { points, load, removal, selected } = edit;
  const count = selected.size;
  // The server refused it (every 4xx but a 408 and a 429): the same selection is refused again, so Remove is off until the selection changes, which clears the error.
  const refused = isRefusal(removal.error);
  const removeButton = useRef<HTMLButtonElement>(null);
  const clearButton = useRef<HTMLButtonElement>(null);
  const doneButton = useRef<HTMLButtonElement>(null);
  const alertBox = useRef<HTMLDivElement>(null);
  // Whether the Retry of the alert had the focus when it was pressed: the alert goes when the load does, and the focus is lost with it (a tap does not focus a button in Safari).
  const retryHadFocus = useRef(false);
  // Whether there is anything to select: while the points load, when they could not be had and when the day has none there is not, and the row is for saying so.
  const selectable = points !== undefined && points.points.length > 0;
  // The load that failed, which is what the alert in the row says.
  const failure = load.error;
  const failed = failure !== null;
  // Where the focus goes when it is lost with a button of the bar (see above): a removal that was answered (the one that was pressed is off while it is sent, and after a
  // refusal until the selection changes), points that are gone (Clear and Remove with them), Remove off after a refusal, which may have had it, or the alert that had the
  // Retry that was pressed gone. Clear is the way back, and where there is nothing to clear (a removal that went through) Done is the button that is on. Only what has just
  // changed is looked at, and only a focus that is lost is moved.
  const before = useRef({ pending: removal.pending, selectable, refused, failed });
  useEffect(() => {
    const was = before.current;
    before.current = { pending: removal.pending, selectable, refused, failed };
    const answered = was.pending && !removal.pending;
    const emptied = was.selectable && !selectable;
    const turnedOff = !was.refused && refused;
    const recovered = was.failed && !failed && retryHadFocus.current;
    if (was.failed && !failed) retryHadFocus.current = false;
    if (!answered && !emptied && !turnedOff && !recovered) return;
    const remove = removeButton.current;
    const onOffRemove = remove !== null && remove.disabled && document.activeElement === remove;
    if (!focusLost() && !onOffRemove) return;
    const clear = clearButton.current;
    (clear !== null && !clear.disabled ? clear : doneButton.current)?.focus();
  }, [removal.pending, selectable, refused, failed]);
  const retryLoad = (): void => {
    retryHadFocus.current = alertBox.current?.contains(document.activeElement) === true;
    load.retry();
  };
  // Clear, pressed from the keyboard, is off once the selection is empty and has the focus with it: Done, which is always there, is where it goes.
  const clearSelection = (): void => {
    const hadFocus = document.activeElement === clearButton.current;
    edit.clear();
    if (hadFocus) doneButton.current?.focus();
  };
  // A load that failed takes the place of the count in the row, which is what a sheet at its lowest shows. Where there are no points yet (the first load) there is nothing
  // to count and the region of the count is not there; where there are (they were asked for again), it stays, off the screen, and the buttons stay with it.
  const selectedCount = `${formatInteger(count)} selected`;
  const said = points === undefined ? (load.pending ? "Loading points…" : selectedCount) : points.points.length === 0 ? "No points on this day" : selectedCount;
  return (
    <div className={styles.bar} role="group" aria-label="Edit points">
      <div className={styles.row}>
        {failure !== null && (
          <div ref={alertBox} className={styles.problem} role="alert">
            <p className={states.headline}>
              {LOAD_FAILED} — <RetryButton onClick={retryLoad} />
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
              <button ref={clearButton} type="button" className={forms.secondary} disabled={count === 0 || removal.pending} onClick={clearSelection}>
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
