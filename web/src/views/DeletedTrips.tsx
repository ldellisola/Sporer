import { useQueryClient } from "@tanstack/react-query";
import { isNotFound, postJson } from "../api/client";
import { useWrite } from "../api/mutations";
import { deletedTripsQueryOptions, useDeletedTrips } from "../api/queries";
import type { DeletedTrip } from "../api/types";
import forms from "./Forms.module.css";
import styles from "./DeletedTrips.module.css";
import rows from "./Rows.module.css";
import { useNote } from "./SettingsNotes";
import { Section } from "./SettingsSection";
import { ErrorState, Loading } from "./States";
import { useKeptData } from "./useKeptData";
import { useRowFocus } from "./useRowFocus";
import { WriteError } from "./WriteError";

/** The deleted trips while there is no list to read: one array, so that nothing made from it is made again for each render. */
const NO_TRIPS: readonly DeletedTrip[] = [];

/**
 * The trips the owner deleted, newest first, each with the button that brings it back (it is a trip again as detection finds it, with the name and
 * the dates the owner had given it). The button says it is working while the request is on its way, and no button of the list can be pressed then;
 * the trip is taken off the list when it is back, and what it did is a note that goes by itself after a while (`useNote`: the row that was pressed has
 * the focus no more). A failure is told with the trip's name: a refusal (the trip is not deleted any more: a 404) in the server's words with no Retry
 * (P4-R28), and any other with a Retry that sends the same trip again; the list stays under it, and the list that was there stays under a failure to ask for it again.
 *
 * The focus was on the button of the row that is gone, and goes to the button of the next row (the one before it for the last), and when none is left to
 * the note that says so. That is also so when the row goes with the list that is asked for again after a 404 (the trip was restored somewhere else): the focus
 * waits for the row to be gone. Any other failure leaves the row, and the focus goes back to its button, which was off. It moves only if the owner has not put
 * it elsewhere.
 */
export function DeletedTrips() {
  const client = useQueryClient();
  const query = useDeletedTrips();
  const deleted = useKeptData(query.data);
  const list = deleted ?? NO_TRIPS;
  const focus = useRowFocus(list, (trip) => trip.key, query.isFetching);
  const restore = useWrite((trip: DeletedTrip) => postJson(`/api/trips/deleted/${encodeURIComponent(trip.key)}/restore`));
  useNote(restore.isSuccess ? { id: restore.submittedAt, message: `Restored ${restore.variables.label}` } : null, restore.reset);
  const run = (trip: DeletedTrip) => {
    if (restore.isPending) return;
    const row = focus.start(trip.key);
    restore.mutate(trip, {
      onSuccess: () => {
        row.leaves();
        client.setQueryData<DeletedTrip[]>(deletedTripsQueryOptions().queryKey, (old) => old?.filter((candidate) => candidate.key !== trip.key));
      },
      // A 404 has the list asked for again, which has not the row: the focus is to leave it then. Any other failure leaves the row where it is.
      onError: (error) => (isNotFound(error) ? row.leaves() : row.stays()),
    });
  };
  return (
    <Section title="Deleted trips">
      {query.isError && <ErrorState error={query.error} onRetry={() => void query.refetch()} />}
      {deleted === undefined ? (
        !query.isError && <Loading />
      ) : list.length === 0 ? (
        <p ref={focus.fallback} tabIndex={-1} className={rows.none}>
          No deleted trips
        </p>
      ) : (
        <ul className={rows.list} aria-label="Deleted trips">
          {list.map((trip) => {
            const working = restore.isPending && restore.variables.key === trip.key;
            return (
              <li key={trip.key} className={rows.item}>
                <span className={styles.deletedLabel}>{trip.label}</span>
                <button
                  ref={focus.control(trip.key)}
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
    </Section>
  );
}
