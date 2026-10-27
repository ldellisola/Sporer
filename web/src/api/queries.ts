import { keepPreviousData, QueryClient, queryOptions, skipToken, useQuery } from "@tanstack/react-query";
import { MAX_RANGE_DAYS, step, periodDays, periodRange, today } from "../time/dates";
import { isPeriodRoute, type Route } from "../app/router";
import { ApiError, getJson, isNotFound } from "./client";
import type {
  ConfigResponse,
  DayResponse,
  HeatResponse,
  PlaceResponse,
  RangeResponse,
  StatusResponse,
  TripResponse,
  TripsResponse,
} from "./types";

/** How long an answer counts as fresh, how often a period that is still being processed is asked for again, and how often today is. */
const STALE_MS = 30_000;
const POLL_MS = 30_000;
const TODAY_POLL_MS = 60_000;

/**
 * How long until a day or a period (`from` to `to`, both dates included) is asked for again, or false for never. A period that is still
 * being processed ("pending") may change as its points are processed, so it is asked for every 30 seconds until it is "done". Today may
 * change whatever its state says, for points keep arriving while the app is open (spec 4.2: today refreshes as new data is processed),
 * so a period that holds it (`now`, a date of the browser's own zone) is asked for every minute, and every 30 seconds when it is pending
 * as well, as soon as it is processed. A period that is over is asked for no more once it is done. Nothing is asked for while there is no
 * period. `state` is that of what has been answered so far, if anything: today that could not be loaded is tried again too, which is how
 * an app opened before the VPN was up finds its day.
 */
export function refreshInterval(from: string | null, to: string | null, state: string | undefined, now: string = today()): number | false {
  if (from === null || to === null) return false;
  if (state === "pending") return POLL_MS;
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

export const useRange = (from: string | null, to: string | null, keepPrevious = true) => useQuery(rangeQueryOptions(from, to, keepPrevious));

/** The heat of a period; nothing is asked for while `enabled` is false, or while there are no dates. */
export const useHeat = (from: string | null, to: string | null, enabled: boolean, keepPrevious = true) =>
  useQuery({ ...heatQueryOptions(from, to, keepPrevious), enabled });

export const usePlace = (id: number | null) => useQuery(placeQueryOptions(id));

/**
 * What a place query shows, for the panel and for the map alike so that they never disagree: `shown` is its place, and `gone` says the
 * place no longer exists (a 404, which asking again cannot change). A place that is gone is shown as none, whatever the query still holds
 * of it from before; under any other failure the place stays, and is what is shown under the error.
 */
export function placeOf(query: { data?: PlaceResponse; error: Error | null }): { gone: boolean; shown: PlaceResponse | undefined } {
  const gone = isNotFound(query.error);
  return { gone, shown: gone ? undefined : query.data };
}

/**
 * The trips. `enabled` is false for a caller that has no use for them on the view on show (the map of the shell, which draws them on the
 * list of trips only): nothing is asked for on its account, and what the query holds is still what the callers that do want it are given.
 */
export const useTrips = (enabled = true) => useQuery({ ...tripsQueryOptions(), enabled });

export const useTrip = (id: string | null) => useQuery(tripQueryOptions(id));

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
