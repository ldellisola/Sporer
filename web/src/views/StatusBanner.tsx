import { useStatus } from "../api/queries";
import { formatCount } from "../time/format";
import { Notice } from "./Notice";

/**
 * How far the processing of the history has come, while it has not come all the way: "Processing your history… 42 %"; and, whatever
 * the progress, what the worker last failed at, which wins because it is the one the owner can do something about. When there is
 * neither, the periods that the worker has set aside after trying them again and again ("Couldn't process 2 periods"): they are days
 * missing from the history, and nothing else would say so. Nothing when all is done and well, and nothing while the status is not
 * known: a status that cannot be had is no reason to report a problem with the processing. The status is asked for again every 30
 * seconds (see `statusQueryOptions`).
 */
export function StatusBanner() {
  const { data } = useStatus();
  if (data === undefined) return null;
  if (data.lastError) return <Notice tone="error">{`Processing problem: ${data.lastError}`}</Notice>;
  // Rounded down: a backfill at 99.9 is not done, and "100 %" would say it is.
  if (data.backfill.percent < 100) return <Notice>{`Processing your history… ${Math.floor(data.backfill.percent)} %`}</Notice>;
  if (data.failedRanges.length > 0) return <Notice>{`Couldn't process ${formatCount(data.failedRanges.length, "period")}`}</Notice>;
  return null;
}
