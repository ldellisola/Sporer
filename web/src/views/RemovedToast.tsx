import { useEffect, useRef } from "react";
import type { PointEditing } from "../app/useEditPoints";
import { formatCount } from "../time/format";
import { focusLost } from "./editForms";
import forms from "./Forms.module.css";
import styles from "./RemovedToast.module.css";
import { Toast, type ToastData } from "./Toast";
import { WriteError } from "./WriteError";

/** What the toast shows for what edit mode did last: null when it did nothing, or the owner has dismissed it. */
function toastOf({ toast, undo }: PointEditing): ToastData | null {
  if (toast === null) return null;
  switch (toast.kind) {
    case "removed":
      return {
        id: toast.id,
        message: `Removed ${formatCount(toast.count, "point")}`,
        // No Undo once one has failed: a refusal is refused again (P4-R28), and a failure that may pass has the Retry of the alert under the toast.
        action: undo.error === null ? { label: undo.pending ? "Undoing…" : "Undo", onClick: undo.run, disabled: undo.pending } : undefined,
        // It goes by itself when its time is up, unless an undo is on its way or has failed: that is told to the owner, who dismisses it.
        durationMs: undo.pending || undo.error !== null ? null : undefined,
      };
    case "none":
      return { id: toast.id, message: "Those points were removed already" };
    case "restored":
      return { id: toast.id, message: `Restored ${formatCount(toast.count, "point")}` };
  }
}

/** Puts the focus on the first button of `card` if it has been lost (it is on the page itself: what had it has gone), and leaves it where the owner put it otherwise. */
function focusIfLost(card: HTMLElement | null): void {
  if (focusLost()) card?.querySelector("button")?.focus();
}

/**
 * What the shell says of the removal of points, whatever the sheet is at and whichever view is on show (it is the shell's: see `Toast`): "Removed 3
 * points" with Undo for ten seconds, then "Restored 3 points" for an Undo that went through. An Undo that did not goes under the toast as an alert,
 * which the time does not take away: a refusal (a 404 for a batch that is restored already) says so in the words of the server with no Retry, and any
 * other failure has its Retry; both have Dismiss, and the toast has no Undo of its own while the alert is there. A removal that failed after the owner
 * had left the edit mode that sent it (P4-R32) is an alert of its own the same way: "Could not remove 3 points: …" in the words of the server for a
 * refusal, with no Retry, and for a failure that may pass "Couldn't remove 3 points" with a Retry that sends the same points again, and Dismiss.
 *
 * Nothing here takes the focus as it appears: the owner is on the map. The Undo button is gone once an undo has failed, and the focus with it if it was
 * there: it goes to the alert's first button (Retry, or Dismiss for a refusal); and so it does for a failed removal that is sent again and fails again.
 * "Removing 3 points…", while one is sent again, is said in the toast's live region, which is there before it is, so that a screen reader announces it.
 */
export function RemovedToast({ edit }: { edit: PointEditing }) {
  const { undo, failedRemoval } = edit;
  const undoAlert = useRef<HTMLDivElement>(null);
  const removalAlert = useRef<HTMLDivElement>(null);
  const undoFailed = undo.error !== null;
  useEffect(() => {
    if (undoFailed) focusIfLost(undoAlert.current);
  }, [undoFailed]);
  const retrying = failedRemoval?.retrying === true;
  const wasRetrying = useRef(false);
  useEffect(() => {
    if (wasRetrying.current && !retrying) focusIfLost(removalAlert.current); // the button that was pressed went while it was being sent
    wasRetrying.current = retrying;
  });
  return (
    <Toast toast={toastOf(edit)} onDismiss={edit.dismiss} progress={failedRemoval?.retrying ? `Removing ${formatCount(failedRemoval.count, "point")}…` : null}>
      {failedRemoval !== null && !retrying && (
        <div ref={removalAlert} className={styles.alert}>
          <WriteError
            what={`remove ${formatCount(failedRemoval.count, "point")}`}
            error={failedRemoval.error}
            onRetry={failedRemoval.retry}
            gone="The day no longer exists."
          />
          <button type="button" className={forms.secondary} onClick={failedRemoval.dismiss}>
            Dismiss
          </button>
        </div>
      )}
      {edit.toast !== null && undo.error !== null && (
        <div ref={undoAlert} className={styles.alert}>
          <WriteError what="undo" error={undo.error} onRetry={undo.run} gone="That removal has been undone already." />
          <button type="button" className={forms.secondary} onClick={edit.dismiss}>
            Dismiss
          </button>
        </div>
      )}
    </Toast>
  );
}
