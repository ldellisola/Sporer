import { useEffect, useMemo, useSyncExternalStore } from "react";
import { addDays, isDate, isMonth, MAX_RANGE_DAYS, periodDays, today as todayInBrowser, weekStart } from "../time/dates";

// The URL is the only view state, and there are only nine kinds of it, so this is all the router there is:
//   /day/2026-10-22   /week/2026-10-19   /month/2026-10   /year/2026   /range/2026-10-19..2026-10-25   /place/42
//   /trips   /trip/2026-09-12   /settings
// The server answers each of them with index.html (see Program.cs).

export type Route =
  | { view: "day"; date: string }
  | { view: "week"; start: string }
  | { view: "month"; month: string }
  | { view: "year"; year: number }
  | { view: "range"; from: string; to: string }
  | { view: "place"; id: number }
  | { view: "trips" }
  /** A trip, by its id: the date of its first away night, which is what the API names it by. */
  | { view: "trip"; id: string }
  /** The one page of the owner's settings, with no argument. */
  | { view: "settings" };

/** A route that covers a stretch of time: the day, the week, the month, the year and the range. A place, the trips, a trip and the settings do not. */
export type PeriodRoute = Extract<Route, { view: "day" | "week" | "month" | "year" | "range" }>;

const PERIOD_VIEWS: ReadonlySet<string> = new Set<PeriodRoute["view"]>(["day", "week", "month", "year", "range"]);

/**
 * Whether a route covers a stretch of time, which is what everything made from dates (the range and heat requests, the neighbours to
 * step to, the label of the period) is for. Where the code means "this route has no period" it asks this, and does not name the kinds of
 * route that have none: a kind of route that is added later has no period until it is listed here, so it is never handed to what works
 * out dates from one.
 */
export function isPeriodRoute(route: Route): route is PeriodRoute {
  return PERIOD_VIEWS.has(route.view);
}

const YEAR_PATTERN = /^\d{4}$/;
const ID_PATTERN = /^\d+$/;

/**
 * The route a path stands for, or `null` when it stands for none: an unknown path, a date that does not exist, a range that
 * ends before it starts. `/` is today's day (`today` is a date, `yyyy-MM-dd`). A week is a week whichever of its days the
 * path names, so it comes back as its Monday. A range of more days than the API answers for (`MAX_RANGE_DAYS`) comes back as
 * its first that many, so that no view is ever asked for one that can only be refused. One trailing slash is ignored.
 */
export function parseRoute(pathname: string, today: string): Route | null {
  if (pathname === "/") return { view: "day", date: today };
  if (!pathname.startsWith("/")) return null;

  const trimmed = pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  const segments = trimmed.split("/"); // "", view, argument
  if (segments.length === 2) {
    // The list of trips and the settings are the views that have no argument.
    if (segments[1] === "trips") return { view: "trips" };
    return segments[1] === "settings" ? { view: "settings" } : null;
  }
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
      if (!isDate(from) || !isDate(to) || from > to) return null;
      const longest = periodDays({ view: "range", from, to }) > MAX_RANGE_DAYS;
      return { view: "range", from, to: longest ? addDays(from, MAX_RANGE_DAYS - 1) : to };
    }
    case "place": {
      const id = Number(arg);
      return ID_PATTERN.test(arg) && Number.isSafeInteger(id) && id >= 1 ? { view: "place", id } : null;
    }
    case "trip":
      return isDate(arg) ? { view: "trip", id: arg } : null;
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
    case "trips":
      return "/trips";
    case "trip":
      return `/trip/${route.id}`;
    case "settings":
      return "/settings";
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
 * What `navigate` writes into the `history.state` of each entry it pushes: the mark of an entry that was reached from a view of the app
 * (see `reachedInApp`). The browser keeps the state of an entry for as long as the entry is there, a reload included.
 */
const PUSHED_STATE = { sporer: "pushed" } as const;

/**
 * Goes to a route: a new history entry, or with `replace` the current one rewritten. Going where the address already is
 * adds nothing. Only the path is kept: the routes carry all there is to a view. A new entry is marked as one that the app made, and
 * a rewritten entry stays what it was (opened by the owner, or made by the app), because rewriting does not change how it was reached.
 */
export function navigate(route: Route, opts: { replace?: boolean } = {}): void {
  const path = formatRoute(route);
  if (window.location.pathname === path) return;
  if (opts.replace) window.history.replaceState(window.history.state, "", path);
  else window.history.pushState(PUSHED_STATE, "", path);
  window.dispatchEvent(new Event(NAVIGATE_EVENT));
}

/**
 * Whether the entry on show was reached from a view of the app, so that there is one of the app's behind it: it was made by `navigate`.
 * A page that was opened (a deep link, a bookmark, a fresh tab, a typed address) is not, and what is behind it may be another site or
 * nothing. `history.length` could not tell: it counts the first page of the tab, and the sites before it.
 */
export function reachedInApp(): boolean {
  const state: unknown = window.history.state;
  return typeof state === "object" && state !== null && (state as { sporer?: unknown }).sporer === PUSHED_STATE.sporer;
}

/**
 * What a back control does: back in the history when the view was reached from one of the app's, so that it is the view the owner came
 * from (a day, a month, a range), else today's day, which is where the app starts. The day replaces the page that was opened and does not
 * follow it: Back from today's day then goes where the owner was before, and not to the view that was just left.
 */
export function goBack(): void {
  if (reachedInApp()) window.history.back();
  else navigate({ view: "day", date: todayInBrowser() }, { replace: true });
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
