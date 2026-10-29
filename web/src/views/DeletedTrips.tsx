import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { postJson } from "../api/client";
import { useWrite } from "../api/mutations";
import { deletedTripsQueryOptions, useDeletedTrips } from "../api/queries";
import type { DeletedTrip } from "../api/types";
import { focusLost } from "./editForms";
import forms from "./Forms.module.css";
import styles from "./DeletedTrips.module.css";
import rows from "./Rows.module.css";
import { Section } from "./SettingsSection";
import { ErrorState, Loading } from "./States";
import { Toast } from "./Toast";
import { useKeptData } from "./useKeptData";
import { WriteError } from "./WriteError";

/** The deleted trips while there is no list to read: one array, so that nothing made from it is made again for each render. */
const NO_TRIPS: readonly DeletedTrip[] = [];

/** What the focus is to go to when the list has no row left to take it: the note that says there is none. */
const NO_ROW = "";

/**
 * The trips the owner deleted, newest first, each with the button that brings it back (it is a trip again as detection finds it, with the name and
 * the dates the owner had given it). The button says it is working while the request is on its way, and no button of the list can be pressed then;
 * the trip is taken off the list when it is back, and what it did is a note that goes by itself after a while (`Toast`: the row that was pressed has
 * the focus no more). A failure is told with the trip's name: a refusal (the trip is not deleted any more: a 404) in the server's words with no Retry
 * (P4-R28), and any other with a Retry that sends the same trip again; the list stays under it, and the list that was there stays under a failure to ask for it again.
 *
 * The focus was on the button of the row that is gone, and goes to the button of the next row (the one before it for the last), and when none is left to
 * the note that says so; a failure leaves it on the button that was pressed, which was off, when the page has it. It moves only if the owner has not put it elsewhere.
 */
export function DeletedTrips() {
  const client = useQueryClient();
  const query = useDeletedTrips();
  const deleted = useKeptData(query.data);
  const list = deleted ?? NO_TRIPS;
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const none = useRef<HTMLParagraphElement>(null);
  const focusAfter = useRef<string | null>(null);
  const restore = useWrite((trip: DeletedTrip) => postJson(`/api/trips/deleted/${encodeURIComponent(trip.key)}/restore`));
  // A button that is off cannot take the focus, and all of them are while a restore is on its way: it waits for the answer and the list to be drawn as it is
  // to be, and is let go of once it has moved, when the owner has put the focus somewhere else, or when the button it was for is not there.
  useEffect(() => {
    const target = focusAfter.current;
    if (target === null) return;
    const button = target === NO_ROW ? none.current : buttons.current.get(target);
    if (button instanceof HTMLButtonElement && button.disabled) return;
    focusAfter.current = null;
    if (focusLost()) button?.focus();
  });
  const run = (trip: DeletedTrip) => {
    if (restore.isPending) return;
    const at = list.findIndex((candidate) => candidate.key === trip.key);
    const next = list[at + 1] ?? list[at - 1];
    restore.mutate(trip, {
      onSuccess: () => {
        focusAfter.current = next?.key ?? NO_ROW;
        client.setQueryData<DeletedTrip[]>(deletedTripsQueryOptions().queryKey, (old) => old?.filter((candidate) => candidate.key !== trip.key));
      },
      onError: () => {
        focusAfter.current = trip.key;
      },
    });
  };
  return (
    <Section title="Deleted trips">
      {query.isError && <ErrorState error={query.error} onRetry={() => void query.refetch()} />}
      {deleted === undefined ? (
        !query.isError && <Loading />
      ) : list.length === 0 ? (
        <p ref={none} tabIndex={-1} className={styles.none}>
          No deleted trips
        </p>
      ) : (
        <ul className={rows.list} aria-label="Deleted trips">
          {list.map((trip) => {
            const working = restore.isPending && restore.variables.key === trip.key;
            return (
              <li key={trip.key} className={styles.deleted}>
                <span className={styles.deletedLabel}>{trip.label}</span>
                <button
                  ref={(button) => {
                    if (button === null) buttons.current.delete(trip.key);
                    else buttons.current.set(trip.key, button);
                  }}
                  type="button"
                  className={forms.secondary}
                  aria-label={working ? undefined : `Restore ${trip.label}`}
                  disabled={restore.isPending}
                  onClick={() => run(trip)}
                >
                  {working ? "Restoring…" : "Restore"}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {restore.isError && (
        <WriteError
          what={`restore ${restore.variables.label}`}
          error={restore.error}
          onRetry={() => run(restore.variables)}
          gone="That trip is not deleted any more."
        />
      )}
      <Toast toast={restore.isSuccess ? { id: restore.submittedAt, message: `Restored ${restore.variables.label}` } : null} onDismiss={restore.reset} />
    </Section>
  );
}
