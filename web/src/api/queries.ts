import { keepPreviousData, QueryClient, queryOptions, skipToken, useQuery } from "@tanstack/react-query";
import { MAX_RANGE_DAYS, step, periodDays, periodRange } from "../time/dates";
import type { Route } from "../app/router";
import { ApiError, getJson } from "./client";
import type {
  ConfigResponse,
  DayResponse,
  HeatResponse,
  PlaceResponse,
  RangeResponse,
  StatusResponse,
} from "./types";

/** How long an answer counts as fresh, and how often a period that is still being processed is asked for again. */
const STALE_MS = 30_000;
const POLL_MS = 30_000;

// A day or a range that is "pending" may still change as its points are processed: ask again until it is "done". While
// the next period loads, the previous one stays on screen (keepPreviousData), so stepping never blanks the view.
const pollWhilePending = (query: { state: { data: { state: string } | undefined } }): number | false =>
  query.state.data?.state === "pending" ? POLL_MS : false;

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
    refetchInterval: pollWhilePending,
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
    refetchInterval: pollWhilePending,
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

export function placeQueryOptions(id: number) {
  return queryOptions({
    queryKey: ["place", id] as const,
    queryFn: ({ signal }) => getJson<PlaceResponse>(`/api/places/${id}`, signal),
    staleTime: STALE_MS,
    // No keepPreviousData: another place's name and visits under this place's heading would be wrong, not just old.
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

export const usePlace = (id: number) => useQuery(placeQueryOptions(id));

export const useStatus = () => useQuery(statusQueryOptions());

export const useConfig = () => useQuery(configQueryOptions());

/**
 * Starts loading the period before and the one after `route`, so that ‹ and › find their data in the cache. Never throws and
 * never waits on a failure: a prefetch that fails is simply asked for again when the period is shown. A place has no
 * neighbours, and a period the API would refuse (more than 400 days) is not asked for.
 */
export async function prefetchNeighbours(queryClient: QueryClient, route: Route): Promise<void> {
  if (route.view === "place") return;
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

function shouldRetry(failureCount: number, error: Error): boolean {
  // A 400 or a 404 will be the same the next time. Anything else (a 500, a dropped connection) is tried once more; after
  // that the view shows its error with a Retry button instead of keeping the owner waiting.
  if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;
  return failureCount < 1;
}

export function createQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: shouldRetry } } });
}
