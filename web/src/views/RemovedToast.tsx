import type { PointEditing } from "../app/useEditPoints";
import { formatCount } from "../time/format";
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
        action: { label: undo.pending ? "Undoing…" : "Undo", onClick: undo.run, disabled: undo.pending },
        // It goes by itself when its time is up, unless an undo is on its way or has failed: that is told to the owner, who dismisses it.
        durationMs: undo.pending || undo.error !== null ? null : undefined,
      };
    case "none":
      return { id: toast.id, message: "Those points were removed already" };
    case "restored":
      return { id: toast.id, message: `Restored ${formatCount(toast.count, "point")}` };
  }
}

/**
 * What the shell says of the removal of points, whatever the sheet is at and whichever view is on show (it is the shell's: see `Toast`): "Removed 3
 * points" with Undo for ten seconds, then "Restored 3 points" for an Undo that went through. An Undo that did not goes under the toast as an alert,
 * which the time does not take away: a refusal (a 404 for a batch that is restored already) says so in the words of the server with no Retry, and any
 * other failure has its Retry; both have Dismiss. Nothing here takes the focus: the owner is on the map.
 */
export function RemovedToast({ edit }: { edit: PointEditing }) {
  const { undo } = edit;
  return (
    <Toast toast={toastOf(edit)} onDismiss={edit.dismiss}>
      {edit.toast !== null && undo.error !== null && (
        <div className={styles.alert}>
          <WriteError what="undo" error={undo.error} onRetry={undo.run} gone="That removal has been undone already." />
          <button type="button" className={forms.secondary} onClick={edit.dismiss}>
            Dismiss
          </button>
        </div>
      )}
    </Toast>
  );
}
