import { useState } from "react";

/**
 * The latest data that there was. A query that fails has none (TanStack Query shows its placeholder only while a query is
 * pending, and an error is not that), but the view that it was to replace should stay on screen under the error and its Retry
 * rather than go blank. A view passes the data of its query through this and shows what comes back.
 *
 * `keep` is false for a view that is not on show: what was kept is dropped, and not brought back, so that the next time the view is
 * shown it starts as a view that was never there, as a panel that is mounted afresh does.
 */
export function useKeptData<T>(data: T | undefined, keep = true): T | undefined {
  const [kept, setKept] = useState(data);
  // Adjusting state while rendering, as React documents it: this render is thrown away and made again with `kept` set.
  if (!keep) {
    if (kept !== undefined) setKept(undefined);
    return undefined;
  }
  if (data !== undefined && data !== kept) setKept(data);
  return data ?? kept;
}
