import { useState } from "react";

/**
 * The latest data that there was. A query that fails has none (TanStack Query shows its placeholder only while a query is
 * pending, and an error is not that), but the view that it was to replace should stay on screen under the error and its Retry
 * rather than go blank. A view passes the data of its query through this and shows what comes back.
 */
export function useKeptData<T>(data: T | undefined): T | undefined {
  const [kept, setKept] = useState(data);
  // Adjusting state while rendering, as React documents it: this render is thrown away and made again with `kept` set.
  if (data !== undefined && data !== kept) setKept(data);
  return data ?? kept;
}
