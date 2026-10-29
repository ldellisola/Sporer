import { keepPreviousData, QueryClient, queryOptions, skipToken, useQuery } from "@tanstack/react-query";
import { addDays, MAX_RANGE_DAYS, step, periodDays, periodRange, today } from "../time/dates";
import { isPeriodRoute, type Route } from "../app/router";
import { ApiError, getJson, isNotFound } from "./client";
import type {
  ConfigResponse,
  DayPointsResponse,
  DayResponse,
  DeletedTrip,
  HeatResponse,
  HomesResponse,
  PlaceCandidate,
  PlaceResponse,
  PlaceSearchResult,
  RangeResponse,
  RemovedBatch,
  SettingsResponse,
  StatusResponse,
  TripResponse,
  TripsResponse,
} from "./types";

/** How long an answer counts as fresh, how often a period that is still being processed is asked for again, and how often today is. */
const STALE_MS = 30_000;
const POLL_MS = 30_000;
const TODAY_POLL_MS = 60_000;

/**
 * After an edit of the points of a day its rebuild is queued due at once, and the worker has it done within seconds: the day that is pending
 * then is asked for every 3 seconds, for up to two minutes after the edit, and after that as every pending day is (`POLL_MS`).
 */
const EDIT_POLL_MS = 3_000;
const EDIT_POLL_WINDOW_MS = 120_000;

/** When each day was last edited, by date, in the page's own time (`Date.now()`): what `pendingInterval` reads. It is the page's, as the cache is. */
const editedAt = new Map<string, number>();

/**
 * Notes that the points of `date` were edited just now (a removal or its Undo), so that the day, which is pending until the worker has
 * rebuilt it, is asked for every 3 seconds (`pendingInterval`). The days either side are noted too: a day spans into the zones of its
 * neighbours, so a point of it may be one of theirs, and the owner may step there at once.
 */
export function noteDayEdited(date: string): void {
  const now = Date.now();
  for (const edited of [addDays(date, -1), date, addDays(date, 1)]) editedAt.set(edited, now);
}

/** Forgets every day that was noted as edited; for the tests, which share the module. */
export function forgetEditedDays(): void {
  editedAt.clear();
}

/**
 * How long until a pending day is asked for again: every 3 seconds while it is within two minutes of an edit of its points (`edited` is the
 * time of the edit, in `Date.now()` terms, or undefined for a day that was not edited), else every 30 seconds. The one place that says it.
 */
export function pendingInterval(edited: number | undefined, now: number = Date.now()): number {
  return edited !== undefined && now - edited < EDIT_POLL_WINDOW_MS ? EDIT_POLL_MS : POLL_MS;
}

/**
 * How long until a day or a period (`from` to `to`, both dates included) is asked for again, or false for never. A period that is still
 * being processed ("pending") may change as its points are processed, so it is asked for every 30 seconds until it is "done"; a day that
 * was just edited, every 3 seconds for the first two minutes (`pendingInterval`: a period of one date is a day, and the edits are noted by date).
 * Today may change whatever its state says, for points keep arriving while the app is open (spec 4.2: today refreshes as new data is
 * processed), so a period that holds it (`now`, a date of the browser's own zone) is asked for every minute, and every 30 seconds when it is
 * pending as well, as soon as it is processed. A period that is over is asked for no more once it is done. Nothing is asked for while there
 * is no period. `state` is that of what has been answered so far, if anything: today that could not be loaded is tried again too, which is how
 * an app opened before the VPN was up finds its day.
 */
export function refreshInterval(from: string | null, to: string | null, state: string | undefined, now: string = today()): number | false {
  if (from === null || to === null) return false;
  if (state === "pending") return pendingInterval(from === to ? editedAt.get(from) : undefined); // one date: a day, which may have been edited
  return from <= now && now <= to ? TODAY_POLL_MS : false;
}

/**
 * A day. Nothing is asked for while `date` is null (the view on show is not a day): the query is skipped, so that however the days are
 * refetched no day that is not one is asked for. While the next day loads the previous one stays as `data` (a placeholder) unless
 * `keepPrevious` is false, for a caller that keeps the day it last had itself (`useKeptData`) and must not be given one from before
 * it left the day view: the placeholder is the data of the last query that had any, null dates included.
 */
export function dayQueryOptions(date: string | null, keepPrevious = true) {
  return queryOptions({
    queryKey: ["day", date] as const,
    queryFn: date === null ? skipToken : ({ signal }) => getJson<DayResponse>(`/api/day/${date}`, signal),
    staleTime: STALE_MS,
    placeholderData: keepPrevious ? keepPreviousData : undefined,
    refetchInterval: (query) => refreshInterval(date, date, query.state.data?.state),
  });
}

/**
 * The raw points of a day, for edit mode: `[time, lon, lat, device]` in time order, those removed earlier left out. Nothing is asked for while
 * `date` is null. No previous day's points stay for the day that loads: the dots of one day under another would be wrong, not just old.
 * They are heavy (some 40,000 on a dense day), so they are asked for only when the caller says so (`useDayPoints`): they are no part of any
 * view but edit mode, and after a removal or its Undo they are asked for again like every query that is on screen.
 */
export function dayPointsQueryOptions(date: string | null) {
  return queryOptions({
    queryKey: ["points", date] as const,
    queryFn: date === null ? skipToken : ({ signal }) => getJson<DayPointsResponse>(`/api/day/${date}/points`, signal),
    staleTime: STALE_MS,
    gcTime: 0, // not kept once nothing shows them: tens of thousands of points, and the points of a day that was edited since would be old
  });
}

/**
 * A period of days, as the week, month, year and range views show it. Nothing is asked for while `from` or `to` is null (the view on
 * show is not a period), and `keepPrevious` is what it is for a day: false for a caller that keeps the period it last had itself.
 */
export function rangeQueryOptions(from: string | null, to: string | null, keepPrevious = true) {
  return queryOptions({
    queryKey: ["range", from, to] as const,
    queryFn: from === null || to === null ? skipToken : ({ signal }) => getJson<RangeResponse>(`/api/range?from=${from}&to=${to}`, signal),
    staleTime: STALE_MS,
    placeholderData: keepPrevious ? keepPreviousData : undefined,
    refetchInterval: (query) => refreshInterval(from, to, query.state.data?.state),
  });
}

/**
 * The heat of a period. Nothing is asked for while `from` or `to` is null (the view on show has no period, as a place has none), and
 * `keepPrevious` is what it is for a day or a period: false for a caller that must not be given the heat of another period as its own,
 * as the map is not, because the glow of one period under the routes of another would be wrong, not just old.
 */
export function heatQueryOptions(from: string | null, to: string | null, keepPrevious = true) {
  return queryOptions({
    queryKey: ["heat", from, to] as const,
    queryFn: from === null || to === null ? skipToken : ({ signal }) => getJson<HeatResponse>(`/api/heat?from=${from}&to=${to}`, signal),
    staleTime: STALE_MS,
    placeholderData: keepPrevious ? keepPreviousData : undefined,
  });
}

/** A place. Nothing is asked for while `id` is null (the view on show is not a place): the query is skipped, as for a day or a period. */
export function placeQueryOptions(id: number | null) {
  return queryOptions({
    queryKey: ["place", id] as const,
    queryFn: id === null ? skipToken : ({ signal }) => getJson<PlaceResponse>(`/api/places/${id}`, signal),
    staleTime: STALE_MS,
    // No keepPreviousData: another place's name and visits under this place's heading would be wrong, not just old.
  });
}

/**
 * The places that the place `placeId` (as `GET /api/places/{id}` serves it) can be merged with: the nearest first when `q` is empty, else those
 * whose name or address has `q` in it. `q` is as it is to be sent: the caller trims it. The list that was on screen stays while another search is on
 * its way (`placeholderData`: the owner is typing, and the list does not blink to "Loading…" at every pause), which `isPlaceholderData` says. Nothing
 * is asked for while `placeId` is null (the picker is of the places in use, which is `placeSearchQueryOptions`).
 */
export function candidatesQueryOptions(placeId: number | null, q: string) {
  return queryOptions({
    queryKey: ["candidates", placeId, q] as const,
    queryFn:
      placeId === null
        ? skipToken
        : ({ signal }) =>
            getJson<PlaceCandidate[]>(`/api/places/${placeId}/candidates${q === "" ? "" : `?q=${encodeURIComponent(q)}`}`, signal),
    staleTime: STALE_MS,
    placeholderData: keepPreviousData,
  });
}

/**
 * The places in use with no place to start from (`GET /api/places/search`): the most visited first when `q` is empty, else those whose name or address
 * has `q` in it. Nothing is asked for while `q` is null (the picker is of the places near one, which is `candidatesQueryOptions`). `q` is as it is to be
 * sent: the caller trims it. The list that was on screen stays while another search is on its way, as for the candidates.
 */
export function placeSearchQueryOptions(q: string | null) {
  return queryOptions({
    queryKey: ["place-search", q] as const,
    queryFn:
      q === null
        ? skipToken
        : ({ signal }) => getJson<PlaceSearchResult[]>(`/api/places/search${q === "" ? "" : `?q=${encodeURIComponent(q)}`}`, signal),
    staleTime: STALE_MS,
    placeholderData: keepPreviousData,
  });
}

/** The home periods, detected and the owner's, in date order: what the Home section of Settings lists. */
export function homesQueryOptions() {
  return queryOptions({
    queryKey: ["homes"] as const,
    queryFn: ({ signal }) => getJson<HomesResponse>("/api/homes", signal),
    staleTime: STALE_MS,
  });
}

/** The settings: the distance that makes a trip, which the Trips section of Settings sets and the empty list of trips quotes. */
export function settingsQueryOptions() {
  return queryOptions({
    queryKey: ["settings"] as const,
    queryFn: ({ signal }) => getJson<SettingsResponse>("/api/settings", signal),
    staleTime: STALE_MS,
  });
}

/** The removals of points that were not restored, the one made last first: what the Removed points section of Settings lists, each with the batch that restores it. */
export function removedPointsQueryOptions() {
  return queryOptions({
    queryKey: ["removed-points"] as const,
    queryFn: ({ signal }) => getJson<RemovedBatch[]>("/api/points/removed", signal),
    staleTime: STALE_MS,
  });
}

/** The trips, newest first: what the trips list shows, and the order that ‹ and › on a trip step by. */
export function tripsQueryOptions() {
  return queryOptions({
    queryKey: ["trips"] as const,
    queryFn: ({ signal }) => getJson<TripsResponse>("/api/trips", signal),
    staleTime: STALE_MS,
  });
}

/** One trip, by the date of its first night. Nothing is asked for while `id` is null (the view on show is not a trip): the query is skipped, as for a place. */
export function tripQueryOptions(id: string | null) {
  return queryOptions({
    queryKey: ["trip", id] as const,
    queryFn: id === null ? skipToken : ({ signal }) => getJson<TripResponse>(`/api/trips/${id}`, signal),
    staleTime: STALE_MS,
    // No keepPreviousData: another trip's name and days under this trip's heading would be wrong, not just old.
  });
}

/** The trips the owner deleted and has not brought back, the one deleted last first: what Settings lists, each with the key that restores it. */
export function deletedTripsQueryOptions() {
  return queryOptions({
    queryKey: ["deleted-trips"] as const,
    queryFn: ({ signal }) => getJson<DeletedTrip[]>("/api/trips/deleted", signal),
    staleTime: STALE_MS,
  });
}

export function statusQueryOptions() {
  return queryOptions({
    queryKey: ["status"] as const,
    queryFn: ({ signal }) => getJson<StatusResponse>("/api/status", signal),
    staleTime: STALE_MS,
    refetchInterval: POLL_MS, // paused by TanStack Query while the page is in the background
  });
}

export function configQueryOptions() {
  return queryOptions({
    queryKey: ["config"] as const,
    queryFn: ({ signal }) => getJson<ConfigResponse>("/api/config", signal),
    staleTime: STALE_MS,
  });
}

export const useDay = (date: string | null, keepPrevious = true) => useQuery(dayQueryOptions(date, keepPrevious));

/** The points of a day for edit mode; nothing is asked for while `enabled` is false, or while there is no date. */
export const useDayPoints = (date: string | null, enabled = true) => useQuery({ ...dayPointsQueryOptions(date), enabled });

export const useRange = (from: string | null, to: string | null, keepPrevious = true) => useQuery(rangeQueryOptions(from, to, keepPrevious));

/** The heat of a period; nothing is asked for while `enabled` is false, or while there are no dates. */
export const useHeat = (from: string | null, to: string | null, enabled: boolean, keepPrevious = true) =>
  useQuery({ ...heatQueryOptions(from, to, keepPrevious), enabled });

export const usePlace = (id: number | null) => useQuery(placeQueryOptions(id));

/** The places near the place `placeId`; nothing is asked for while it is null. */
export const useCandidates = (placeId: number | null, q: string) => useQuery(candidatesQueryOptions(placeId, q));

/** The places in use by name or address, with no place to start from; nothing is asked for while `q` is null. */
export const usePlaceSearch = (q: string | null) => useQuery(placeSearchQueryOptions(q));

export const useHomes = () => useQuery(homesQueryOptions());

export const useSettings = () => useQuery(settingsQueryOptions());

export const useRemovedPoints = () => useQuery(removedPointsQueryOptions());

/**
 * What a query of a thing that can go (a place, a trip) shows, for the panel, the bar and the map alike so that they never disagree: `shown` is
 * the thing, and `gone` says it no longer exists (a 404, which asking again cannot change). A thing that is gone is shown as none, whatever the
 * query still holds of it from before; under any other failure it stays, and is what is shown under the error. The rule is here and nowhere else.
 */
export function shownOf<T>(query: { data?: T; error: Error | null }): { gone: boolean; shown: T | undefined } {
  const gone = isNotFound(query.error);
  return { gone, shown: gone ? undefined : query.data };
}

/**
 * The trips. `enabled` is false for a caller that has no use for them on the view on show (the map of the shell, which draws them on the
 * list of trips only): nothing is asked for on its account, and what the query holds is still what the callers that do want it are given.
 */
export const useTrips = (enabled = true) => useQuery({ ...tripsQueryOptions(), enabled });

export const useTrip = (id: string | null) => useQuery(tripQueryOptions(id));

export const useDeletedTrips = () => useQuery(deletedTripsQueryOptions());

/**
 * The trips either side of the trip `id` in `trips`, which is newest first: the older one is the next in the list and the newer one the
 * one before it. A side that has none (the trip is the first or the last, or is not in the list at all, as one that is gone) is null.
 */
export function tripNeighbours(trips: readonly { id: string }[], id: string): { older: string | null; newer: string | null } {
  const at = trips.findIndex((trip) => trip.id === id);
  if (at < 0) return { older: null, newer: null };
  return { older: trips[at + 1]?.id ?? null, newer: trips[at - 1]?.id ?? null };
}

export const useStatus = () => useQuery(statusQueryOptions());

export const useConfig = () => useQuery(configQueryOptions());

/**
 * Starts loading what ‹ and › are going to ask for, so that they find it in the cache: the period before the one `route` shows and the
 * one after it, or for a trip the trips either side of it in the list. The list is the one that is in the cache already (the top bar asks
 * for it, and a prefetch has no business waiting on it): without it nothing is known of a trip's neighbours, and nothing is loaded.
 * Never throws and never waits on a failure: a prefetch that fails is simply asked for again when the period or the trip is shown. A
 * route with no neighbours (a place, the trips) loads nothing, and a period the API would refuse (more than 400 days) is not asked for.
 */
export async function prefetchNeighbours(queryClient: QueryClient, route: Route): Promise<void> {
  if (route.view === "trip") return prefetchTripNeighbours(queryClient, route.id);
  if (!isPeriodRoute(route)) return;
  await Promise.all(
    ([-1, 1] as const).map((delta) => {
      const neighbour = step(route, delta);
      if (neighbour.view === "day") return queryClient.prefetchQuery(dayQueryOptions(neighbour.date));
      if (periodDays(neighbour) > MAX_RANGE_DAYS) return undefined;
      const { from, to } = periodRange(neighbour);
      return queryClient.prefetchQuery(rangeQueryOptions(from, to));
    }),
  );
}

async function prefetchTripNeighbours(queryClient: QueryClient, id: string): Promise<void> {
  const list = queryClient.getQueryData(tripsQueryOptions().queryKey);
  if (list === undefined) return;
  const { older, newer } = tripNeighbours(list.trips, id);
  await Promise.all([older, newer].map((neighbour) => (neighbour === null ? undefined : queryClient.prefetchQuery(tripQueryOptions(neighbour)))));
}

function shouldRetry(failureCount: number, error: Error): boolean {
  // A 400 or a 404 will be the same the next time. Anything else (a 500, a dropped connection) is tried once more; after
  // that the view shows its error with a Retry button instead of keeping the owner waiting.
  if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;
  return failureCount < 1;
}

export function createQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: shouldRetry } } });
}
