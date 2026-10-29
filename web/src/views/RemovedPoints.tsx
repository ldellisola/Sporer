import { useQueryClient } from "@tanstack/react-query";
import { deleteJson, isNotFound } from "../api/client";
import { useWrite } from "../api/mutations";
import { removedPointsQueryOptions, useRemovedPoints } from "../api/queries";
import type { RemovedBatch } from "../api/types";
import { datesLabel, dateOf } from "../time/dates";
import { deviceZone, whenOf } from "../time/device";
import { formatCount } from "../time/format";
import forms from "./Forms.module.css";
import styles from "./RemovedPoints.module.css";
import rows from "./Rows.module.css";
import { useNote } from "./SettingsNotes";
import { Section } from "./SettingsSection";
import { ErrorState, Loading } from "./States";
import { useKeptData } from "./useKeptData";
import { useRowFocus } from "./useRowFocus";
import { WriteError } from "./WriteError";

/** The removals while there is no list to read: one array, so that nothing made from it is made again for each render. */
const NO_BATCHES: readonly RemovedBatch[] = [];

/**
 * The days a removal's points are on, as the owner reads them: "12 – 13 Oct 2026". A removal that the server lists on no day (its points are on none that has
 * a segment) is told by the dates of its first and last point on the clock of this device.
 */
function daysOf(batch: RemovedBatch): string {
  if (batch.localDates.length > 0) return datesLabel(batch.localDates);
  const zone = deviceZone();
  return datesLabel([dateOf(batch.from, zone), dateOf(batch.to, zone)].filter((date, at, all) => all.indexOf(date) === at));
}

/** What a removal is, in a few words, for what says it: "37 points from 12 – 13 Oct 2026". */
const describeBatch = (batch: RemovedBatch): string => `${formatCount(batch.count, "point")} from ${daysOf(batch)}`;

/**
 * The removals of points the owner has made and not restored, the one made last first, each with the days its points are on, how many there are, and when
 * it was made, and the button that puts them back (the points were never deleted: they come back into the days they were on, which are asked for again). The
 * button says it is working while the request is on its way, and no button of the list can be pressed then; the removal is taken off the list when it is
 * restored, and what it did is a note that goes by itself after a while (`useNote`: the row that was pressed has the focus no more). A failure is told with
 * what the removal was: a refusal (the removal is restored already: a 404) in the server's words with no Retry (P4-R28), and any other with a Retry that sends
 * the same batch again; the list stays under it, and the list that was there stays under a failure to ask for it again.
 *
 * The focus was on the button of the row that is gone, and goes where it does for the deleted trips (`useRowFocus`): the next row's button, the one before
 * it for the last, and the note that says there is none.
 */
export function RemovedPoints() {
  const client = useQueryClient();
  const query = useRemovedPoints();
  const removed = useKeptData(query.data);
  const list = removed ?? NO_BATCHES;
  const focus = useRowFocus(list, (batch) => batch.batch, query.isFetching);
  const restore = useWrite((batch: RemovedBatch) => deleteJson(`/api/points/removed/${encodeURIComponent(batch.batch)}`));
  useNote(restore.isSuccess ? { id: restore.submittedAt, message: `Restored ${formatCount(restore.variables.count, "point")}` } : null, restore.reset);
  const run = (batch: RemovedBatch) => {
    if (restore.isPending) return;
    const row = focus.start(batch.batch);
    restore.mutate(batch, {
      onSuccess: () => {
        row.leaves();
        client.setQueryData<RemovedBatch[]>(removedPointsQueryOptions().queryKey, (old) => old?.filter((candidate) => candidate.batch !== batch.batch));
      },
      // A 404 has the list asked for again, which has not the row: the focus is to leave it then. Any other failure leaves the row where it is.
      onError: (error) => (isNotFound(error) ? row.leaves() : row.stays()),
    });
  };
  return (
    <Section title="Removed points">
      {query.isError && <ErrorState error={query.error} onRetry={() => void query.refetch()} />}
      {removed === undefined ? (
        !query.isError && <Loading />
      ) : list.length === 0 ? (
        <p ref={focus.fallback} tabIndex={-1} className={styles.none}>
          No removed points
        </p>
      ) : (
        <ul className={rows.list} aria-label="Removed points">
          {list.map((batch) => {
            const working = restore.isPending && restore.variables.batch === batch.batch;
            const when = `removed ${whenOf(batch.removedAt)}`;
            return (
              <li key={batch.batch} className={styles.removed}>
                <div className={styles.text}>
                  <span className={styles.dates}>{daysOf(batch)}</span>
                  <span className={styles.meta}>{`${formatCount(batch.count, "point")} · ${when}`}</span>
                </div>
                <button
                  ref={focus.control(batch.batch)}
                  type="button"
                  className={forms.secondary}
                  aria-label={working ? undefined : `Restore ${describeBatch(batch)}, ${when}`}
                  disabled={restore.isPending}
                  onClick={() => run(batch)}
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
          what={`restore ${describeBatch(restore.variables)}`}
          error={restore.error}
          onRetry={() => run(restore.variables)}
          gone="These points are not removed any more."
        />
      )}
    </Section>
  );
}
