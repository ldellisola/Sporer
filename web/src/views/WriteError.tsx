import type { ReactNode } from "react";
import { isRefusal } from "../api/client";
import { ErrorState } from "./States";
import states from "./States.module.css";
import styles from "./WriteError.module.css";

export interface WriteErrorProps {
  /** What the control was doing, as the verb that follows "Couldn't": "rename", "merge", "separate". */
  what: string;
  /** What the write failed with (`useWrite`'s `error`). */
  error: unknown;
  /** What a Retry does: the write again. It is offered only for a failure that may pass (a 5xx, a request that got no answer). */
  onRetry: () => void;
  /** What a 404 says when the server gave no words of its own, as a sentence: what is gone ("This place no longer exists."). */
  gone?: string;
  /** What else can be done about a refusal, as buttons ("Choose another place"): they are shown under the message, and not for any other failure. */
  refusedActions?: ReactNode;
}

/** What a refusal says when the server gave no message of its own. */
const GENERIC: Record<number, string> = { 400: "The server did not accept it.", 404: "It no longer exists.", 409: "The server refused it." };

/**
 * The line under a control whose write failed, in one of two ways (P4-R28). A refusal (400, 404, 409: see `isRefusal`) is the server saying
 * no to the request itself, so sending it again would only be refused again: the line says "Could not rename: …" with the server's own
 * message (`ApiError.detail`, shown as it is and never read to choose what to say), or a generic line when it gave none, and has no Retry. A
 * control that has something else to offer passes it as `refusedActions`. Any other failure (a 5xx, no answer) may pass, and is
 * "Couldn't rename — Retry", with what failed under it, as the lists and the panels say it (`ErrorState`).
 *
 * A 404 also has the screen asked for again (`useWrite`), so that what is gone goes away; this line says what happened.
 */
export function WriteError({ what, error, onRetry, gone, refusedActions }: WriteErrorProps) {
  if (!isRefusal(error)) return <ErrorState message={`Couldn't ${what}`} error={error} onRetry={onRetry} />;
  const reason = error.detail ?? (error.status === 404 ? gone : undefined) ?? GENERIC[error.status];
  return (
    <div className={states.error} role="alert">
      <p className={states.headline}>
        Could not {what}: <span className={styles.reason}>{reason}</span>
      </p>
      {refusedActions !== undefined && <div className={styles.actions}>{refusedActions}</div>}
    </div>
  );
}
