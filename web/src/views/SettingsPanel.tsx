import { useId, type ReactNode } from "react";
import { postJson } from "../api/client";
import { useWrite } from "../api/mutations";
import { useStatus } from "../api/queries";
import type { FailedRange, RetryFailedResponse, StatusResponse } from "../api/types";
import { dateLabel, dateOf } from "../time/dates";
import { formatCount, formatTime } from "../time/format";
import forms from "./Forms.module.css";
import rows from "./Rows.module.css";
import styles from "./SettingsPanel.module.css";
import { ErrorState, Loading } from "./States";
import { Toast } from "./Toast";
import { useKeptData } from "./useKeptData";

/** A section of the panel: a heading over what it holds, and the region that a reader can go to by it. */
function Section({ title, children }: { title: string; children: ReactNode }) {
  const heading = useId();
  return (
    <section className={rows.section} aria-labelledby={heading}>
      <h2 id={heading} className={rows.heading}>
        {title}
      </h2>
      {children}
    </section>
  );
}

/** The zone of this device: the processing has no zone of its own, and the owner reads when it ran on the clock they have. */
const deviceZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** The date and the time of an instant on the clock of this device: "Sat 24 Oct 2026 17:15". */
function whenOf(isoUtc: string): string {
  const zone = deviceZone();
  return `${dateLabel(dateOf(isoUtc, zone))} ${formatTime(isoUtc, zone)}`;
}

/** The stretch a failed range covers: "Sun 13 Sep 2026 05:00 – Mon 14 Sep 2026 05:00", and the date once when both ends are on it. */
function rangeLabel(range: FailedRange): string {
  const zone = deviceZone();
  if (dateOf(range.from, zone) === dateOf(range.to, zone)) return `${whenOf(range.from)} – ${formatTime(range.to, zone)}`;
  return `${whenOf(range.from)} – ${whenOf(range.to)}`;
}

/** How far the backfill has come, in whole percent rounded down (99.9 is not done), and that it is paused when it is. */
function backfillLabel({ percent, paused }: StatusResponse["backfill"]): string {
  return `${Math.floor(percent)} %${paused ? ", paused" : ""}`;
}

function Fact({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className={styles.fact}>
      <dt>{term}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** A period that failed: when it is, how many times it was tried, and the error of the last time. */
function FailedPeriod({ range }: { range: FailedRange }) {
  return (
    <li className={styles.failed}>
      <span className={styles.when}>{rangeLabel(range)}</span>
      <span className={styles.attempts}>{formatCount(range.attempts, "attempt")}</span>
      {range.lastError !== null && range.lastError !== "" && <span className={styles.error}>{range.lastError}</span>}
    </li>
  );
}

/** What pressing Retry failed said it did, for the note that stays a while: it is the server's own count of ranges it made due. */
const retriedNote = ({ retried }: RetryFailedResponse): string =>
  retried === 0 ? "Nothing was waiting to be retried" : `Retrying ${formatCount(retried, "period")}`;

/**
 * The failed periods and the button that makes them due at once, instead of when their wait is over (the worker takes them up on its next
 * pass). The button is there only while something has failed; it says it is working while the request is on its way, and a failure of it
 * is told with its own Retry, with the list still there. What it did is a note that goes by itself after a while (`Toast`): the list may well
 * look the same until the worker has had its turn.
 */
function Failed({ ranges }: { ranges: readonly FailedRange[] }) {
  const retry = useWrite(() => postJson<RetryFailedResponse>("/api/status/retry"));
  return (
    <>
      {ranges.length === 0 ? (
        <p className={styles.none}>Nothing has failed</p>
      ) : (
        <>
          <ul className={styles.failedList} aria-label="Failed periods">
            {/* By place in the list: two rows can cover the same span, the rows have no id, and an item holds no state to lose. */}
            {ranges.map((range, index) => (
              <FailedPeriod key={index} range={range} />
            ))}
          </ul>
          <button type="button" className={`${forms.secondary} ${styles.action}`} disabled={retry.isPending} onClick={() => retry.mutate()}>
            {retry.isPending ? "Retrying…" : "Retry failed"}
          </button>
        </>
      )}
      {retry.isError && <ErrorState message="Couldn't retry" error={retry.error} onRetry={() => retry.mutate()} />}
      {retry.isSuccess && <Toast key={retry.submittedAt} message={retriedNote(retry.data)} onDismiss={retry.reset} />}
    </>
  );
}

/** What is known of the processing: how far the backfill is, when the worker last ran, what waits and what failed. */
function ProcessingStatus({ status }: { status: StatusResponse }) {
  return (
    <>
      <dl className={styles.facts}>
        <Fact term="Backfill">{backfillLabel(status.backfill)}</Fact>
        <Fact term="Last processed">{status.lastRunAt === null ? "Not yet" : whenOf(status.lastRunAt)}</Fact>
        <Fact term="Waiting to be processed">{formatCount(status.pendingRanges, "period")}</Fact>
      </dl>
      {status.lastError !== null && status.lastError !== "" && <p className={styles.lastError}>{`Last error: ${status.lastError}`}</p>}
      <Failed ranges={status.failedRanges} />
    </>
  );
}

/**
 * How the processing of the history is doing, from the status that the banner over the map reads (one request). The status that was on
 * screen stays under an error with its Retry, as the lists of the other panels do (`useKeptData`).
 */
function Processing() {
  const query = useStatus();
  const status = useKeptData(query.data);
  return (
    <Section title="Processing">
      {query.isError && <ErrorState error={query.error} onRetry={() => void query.refetch()} />}
      {status !== undefined ? <ProcessingStatus status={status} /> : !query.isError && <Loading />}
    </Section>
  );
}

/** A link to the page of whoever is credited, in a tab of its own. */
function Credit({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a className={styles.link} href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

/**
 * The credit that the map carries (OpenStreetMap's licence asks for it, and the tiles and their schema are others' work), in full and with
 * its links, and the version of the algorithm that made the timeline that is on screen. The credit needs no request; the version is there
 * once the status is.
 */
function About() {
  const version = useStatus().data?.algorithmVersion;
  return (
    <Section title="About">
      <p className={styles.credit}>
        Map data © <Credit href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</Credit>. Map tiles by{" "}
        <Credit href="https://openfreemap.org">OpenFreeMap</Credit>, with the <Credit href="https://openmaptiles.org">OpenMapTiles</Credit> schema.
      </p>
      {version !== undefined && (
        <dl className={styles.facts}>
          <Fact term="Algorithm version">{version ?? "Not yet processed"}</Fact>
        </dl>
      )}
    </Section>
  );
}

/**
 * The panel of the settings: one section for each thing the owner can set or see, in the order of the plan: Home, Trips, Deleted trips,
 * Removed points (the editing tasks add them above), then Processing and About. The map is left as it was (see `useViewMap`).
 */
export function SettingsPanel() {
  return (
    <>
      <Processing />
      <About />
    </>
  );
}
