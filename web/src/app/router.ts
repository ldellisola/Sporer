import { useEffect, useMemo, useSyncExternalStore } from "react";
import { isDate, isMonth, today as todayInBrowser, weekStart } from "../time/dates";

// The URL is the only view state, and there are only six kinds of it, so this is all the router there is:
//   /day/2026-10-22   /week/2026-10-19   /month/2026-10   /year/2026   /range/2026-10-19..2026-10-25   /place/42
// The server answers each of them with index.html (see Program.cs).

export type Route =
  | { view: "day"; date: string }
  | { view: "week"; start: string }
  | { view: "month"; month: string }
  | { view: "year"; year: number }
  | { view: "range"; from: string; to: string }
  | { view: "place"; id: number };

/** A route that covers a stretch of time: every one but a place. */
export type PeriodRoute = Exclude<Route, { view: "place" }>;

const YEAR_PATTERN = /^\d{4}$/;
const ID_PATTERN = /^\d+$/;

/**
 * The route a path stands for, or `null` when it stands for none: an unknown path, a date that does not exist, a range that
 * ends before it starts. `/` is today's day (`today` is a date, `yyyy-MM-dd`). A week is a week whichever of its days the
 * path names, so it comes back as its Monday. One trailing slash is ignored.
 */
export function parseRoute(pathname: string, today: string): Route | null {
  if (pathname === "/") return { view: "day", date: today };
  if (!pathname.startsWith("/")) return null;

  const trimmed = pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  const segments = trimmed.split("/"); // "", view, argument
  if (segments.length !== 3) return null;
  const [, view, arg] = segments as [string, string, string];

  switch (view) {
    case "day":
      return isDate(arg) ? { view: "day", date: arg } : null;
    case "week":
      return isDate(arg) ? { view: "week", start: weekStart(arg) } : null;
    case "month":
      return isMonth(arg) ? { view: "month", month: arg } : null;
    case "year": {
      const year = Number(arg);
      return YEAR_PATTERN.test(arg) && year >= 1 ? { view: "year", year } : null;
    }
    case "range": {
      const ends = arg.split("..");
      if (ends.length !== 2) return null;
      const [from, to] = ends as [string, string];
      // Dates of one fixed width, so that order in text is order in time.
      return isDate(from) && isDate(to) && from <= to ? { view: "range", from, to } : null;
    }
    case "place": {
      const id = Number(arg);
      return ID_PATTERN.test(arg) && Number.isSafeInteger(id) && id >= 1 ? { view: "place", id } : null;
    }
    default:
      return null;
  }
}

/** Like `parseRoute`, but a path that stands for no route stands for today's day. */
export function resolveRoute(pathname: string, today: string): Route {
  return parseRoute(pathname, today) ?? { view: "day", date: today };
}

/** The path of a route: what `parseRoute` reads back as the same route (for a week, given its Monday). */
export function formatRoute(route: Route): string {
  switch (route.view) {
    case "day":
      return `/day/${route.date}`;
    case "week":
      return `/week/${route.start}`;
    case "month":
      return `/month/${route.month}`;
    case "year":
      return `/year/${String(route.year).padStart(4, "0")}`;
    case "range":
      return `/range/${route.from}..${route.to}`;
    case "place":
      return `/place/${route.id}`;
  }
}

// The browser tells of back and forward (popstate) but not of pushState and replaceState; `navigate` does, with this event.
const NAVIGATE_EVENT = "sporer:navigate";

function subscribe(onChange: () => void): () => void {
  window.addEventListener("popstate", onChange);
  window.addEventListener(NAVIGATE_EVENT, onChange);
  return () => {
    window.removeEventListener("popstate", onChange);
    window.removeEventListener(NAVIGATE_EVENT, onChange);
  };
}

const getPathname = (): string => window.location.pathname;

/**
 * Goes to a route: a new history entry, or with `replace` the current one rewritten. Going where the address already is
 * adds nothing. Only the path is kept: the routes carry all there is to a view.
 */
export function navigate(route: Route, opts: { replace?: boolean } = {}): void {
  const path = formatRoute(route);
  if (window.location.pathname === path) return;
  if (opts.replace) window.history.replaceState(null, "", path);
  else window.history.pushState(null, "", path);
  window.dispatchEvent(new Event(NAVIGATE_EVENT));
}

/**
 * The route the address shows. An address that is no route (`/`, an unknown path, an impossible date) shows today's day in
 * the browser's zone, and is replaced by it in the address bar, so that back does not return to it. So is a week that is
 * named by a day other than its Monday.
 */
export function useRoute(): Route {
  const pathname = useSyncExternalStore(subscribe, getPathname);
  const route = useMemo(() => resolveRoute(pathname, todayInBrowser()), [pathname]);
  useEffect(() => {
    if (formatRoute(route) !== pathname) navigate(route, { replace: true });
  }, [route, pathname]);
  return route;
}
