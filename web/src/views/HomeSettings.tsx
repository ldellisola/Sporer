import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { deleteJson, isNotFound, postJson } from "../api/client";
import { useWrite } from "../api/mutations";
import { homesQueryOptions, useHomes } from "../api/queries";
import type { AddHomeRequest, HomePeriod, HomesResponse } from "../api/types";
import { dateRangeLabel } from "../time/dates";
import { focusLost } from "./editForms";
import forms from "./Forms.module.css";
import styles from "./HomeSettings.module.css";
import { UNNAMED } from "./placeNames";
import rows from "./Rows.module.css";
import { SetHome } from "./SetHome";
import { useNote } from "./SettingsNotes";
import { Section } from "./SettingsSection";
import { Empty, ErrorState, Loading } from "./States";
import { useKeptData } from "./useKeptData";
import { useRowFocus } from "./useRowFocus";
import { WriteError } from "./WriteError";

/** The home periods while there is no list to read: one array, so that nothing made from it is made again for each render. */
const NO_PERIODS: readonly HomePeriod[] = [];

const nameOf = (period: HomePeriod): string => period.placeName ?? UNNAMED;

/** The nights of a period as the owner reads them: "1 Apr – 31 Aug 2026", "12 Sep 2026" for one night, and "From 1 Sep 2026" for a home that goes on. */
const datesOf = (period: HomePeriod): string =>
  period.to === null ? `From ${dateRangeLabel(period.from, period.from)}` : dateRangeLabel(period.from, period.to);

/** What a period is, for what says it: "Lisbon flat, 1 Apr – 31 Aug 2026". */
const describePeriod = (period: HomePeriod): string => `${nameOf(period)}, ${datesOf(period)}`;

/**
 * The home periods in date order, those that detection found ("Detected") and those the owner set ("Set by you"), each with its place and its nights. A
 * period the owner set has a button that takes it back (what detection found for those dates is the home again): a detected period has none, for the next
 * refresh would find it again, and is replaced by setting a home for its dates. Under the list is **Set home**, which opens the form that does it
 * (`SetHome`) in the section, and is pressed again, or Cancel or Escape, to close it, with the focus back on the button.
 *
 * The button says it is working while the request is on its way, and no button of the list can be pressed then; the period is taken off the list when it is
 * removed, and what was done is a note that goes by itself after a while (`useNote`). A failure is told with the period: a refusal (it is not there any more:
 * a 404) in the server's words with no Retry (P4-R28), and any other with a Retry that sends the same one again; the list stays under it, and the list that
 * was there stays under a failure to ask for it again. Setting a home is the section's write too (the form is gone when it is answered), so it is said here.
 *
 * The focus was on the button of the row that is gone, and goes where it does for the deleted trips (`useRowFocus`), among the periods that have a button: to
 * the next one's (the one before it for the last), and when none is left to Set home.
 */
export function HomeSettings() {
  const client = useQueryClient();
  const query = useHomes();
  const homes = useKeptData(query.data);
  const periods = homes?.periods ?? NO_PERIODS;
  const mine = periods.filter((period) => period.source === "user");
  const [open, setOpen] = useState(false);
  const setHomeButton = useRef<HTMLButtonElement | null>(null);
  const focus = useRowFocus(mine, (period) => period.id, query.isFetching);
  const remove = useWrite((period: HomePeriod) => deleteJson(`/api/homes/${period.id}`));
  const add = useWrite((home: AddHomeRequest) => postJson<HomePeriod>("/api/homes", home));
  useNote(remove.isSuccess ? { id: remove.submittedAt, message: `Removed the home at ${nameOf(remove.variables)}` } : null, remove.reset);
  useNote(add.isSuccess ? { id: add.submittedAt, message: `Home set to ${nameOf(add.data)}` } : null, add.reset);
  // The focus was in the form that is closed, and goes back to the button that opened it. The button is off while a save is on its way (and the form is
  // closed by its answer), so the focus waits for it, and moves only if it has been lost: where the owner has put it is theirs.
  const returning = useRef(false);
  useEffect(() => {
    const button = setHomeButton.current;
    if (!returning.current || button === null || button.disabled) return;
    returning.current = false;
    if (focusLost()) button.focus();
  });
  const close = () => {
    returning.current = true;
    setOpen(false);
  };
  const run = (period: HomePeriod) => {
    if (remove.isPending) return;
    const row = focus.start(period.id);
    remove.mutate(period, {
      onSuccess: () => {
        row.leaves();
        client.setQueryData<HomesResponse>(homesQueryOptions().queryKey, (old) => old && { periods: old.periods.filter((candidate) => candidate.id !== period.id) });
      },
      // A 404 has the list asked for again, which has not the row: the focus is to leave it then. Any other failure leaves the row where it is.
      onError: (error) => (isNotFound(error) ? row.leaves() : row.stays()),
    });
  };
  return (
    <Section title="Home">
      {query.isError && <ErrorState error={query.error} onRetry={() => void query.refetch()} />}
      {homes === undefined ? (
        !query.isError && <Loading />
      ) : periods.length === 0 ? (
        <Empty message="No home yet" />
      ) : (
        <ul className={rows.list} aria-label="Home periods">
          {periods.map((period) => {
            const working = remove.isPending && remove.variables.id === period.id;
            return (
              <li key={period.id} className={`${rows.item} ${styles.period}`}>
                <div className={rows.itemText}>
                  <span className={styles.place}>{nameOf(period)}</span>
                  <span className={styles.dates}>{datesOf(period)}</span>
                  <span className={styles.source}>{period.source === "user" ? "Set by you" : "Detected"}</span>
                </div>
                {period.source === "user" && (
                  <button
                    ref={focus.control(period.id)}
                    type="button"
                    className={forms.secondary}
                    aria-label={working ? undefined : `Remove ${describePeriod(period)}`}
                    disabled={remove.isPending}
                    onClick={() => run(period)}
                  >
                    {working ? "Removing…" : "Remove"}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {remove.isError && (
        <WriteError
          what={`remove ${describePeriod(remove.variables)}`}
          error={remove.error}
          onRetry={() => run(remove.variables)}
          gone="That home is not there any more."
        />
      )}
      <div className={styles.set}>
        <button
          ref={(button) => {
            setHomeButton.current = button;
            focus.fallback(button);
          }}
          type="button"
          className={forms.secondary}
          aria-expanded={open}
          disabled={add.isPending}
          onClick={() => {
            if (open) return close();
            add.reset(); // what the last one said is of a form that is gone
            returning.current = false;
            setOpen(true);
          }}
        >
          Set home
        </button>
      </div>
      {open && <SetHome add={add} onClose={close} />}
    </Section>
  );
}
