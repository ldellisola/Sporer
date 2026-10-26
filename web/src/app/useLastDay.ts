import { useState } from "react";
import type { Route } from "./router";

/**
 * The day that was shown last, in memory only (a reload starts from the address, which is all there is to start from). It is what a
 * coarser view is switched back to a finer one from: week, month or year to the day that was being looked at, and not to the first
 * day of the period. Null until a day has been shown.
 */
export function useLastDay(route: Route): string | null {
  const [last, setLast] = useState<string | null>(route.view === "day" ? route.date : null);
  // Adjusting state while rendering, as React documents it: this render is thrown away and made again with `last` set.
  if (route.view === "day" && route.date !== last) setLast(route.date);
  return route.view === "day" ? route.date : last;
}
