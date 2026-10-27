import {
  addDays as addDaysTo,
  addMonths,
  differenceInCalendarDays,
  endOfMonth,
  format,
  startOfWeek,
} from "date-fns";
import type { PeriodRoute } from "../app/router";

// Dates here are plain calendar dates, `yyyy-MM-dd` (months `yyyy-MM`), without a zone: they are what the URLs and the API
// speak. date-fns works on `Date` objects, so each one is held at local noon while it is worked on. Noon exists in every zone
// and no daylight-saving change comes near it, so adding days or months can never slip a date, wherever the code runs.

/** The most days a range may cover, both ends counted: what the API answers for a range or a heat request, and a longer one is a 400. */
export const MAX_RANGE_DAYS = 400;

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_PATTERN = /^(\d{4})-(\d{2})$/;

function dateAt(year: number, month: number, day: number): Date | null {
  if (year < 1) return null;
  const date = new Date(2000, 0, 1, 12);
  date.setFullYear(year, month - 1, day); // unlike the Date constructor, never reads a year below 100 as 19xx
  // A day that the month does not have (30 February) rolls over into the next month; that is how it is told.
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date : null;
}

function parseDate(text: string): Date | null {
  const match = DATE_PATTERN.exec(text);
  return match ? dateAt(Number(match[1]), Number(match[2]), Number(match[3])) : null;
}

function parse(text: string): Date {
  const date = parseDate(text);
  if (date === null) throw new RangeError(`Not a calendar date written yyyy-MM-dd: "${text}"`);
  return date;
}

const toDate = (date: Date): string => format(date, "yyyy-MM-dd");

/** Whether `text` is a real calendar date written exactly `yyyy-MM-dd` (30 February is not, 29 February of 2028 is). */
export function isDate(text: string): boolean {
  return parseDate(text) !== null;
}

/** Whether `text` is a month written exactly `yyyy-MM`. */
export function isMonth(text: string): boolean {
  const match = MONTH_PATTERN.exec(text);
  return match !== null && Number(match[2]) >= 1 && Number(match[2]) <= 12 && Number(match[1]) >= 1;
}

const firstOf = (month: string): Date => parse(`${month}-01`);

function dateIn(instant: Date, zone: string | undefined): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${part("year").padStart(4, "0")}-${part("month")}-${part("day")}`;
}

/** Today's date in `zone` (an IANA name), or in the zone of the browser when there is none. */
export function today(zone?: string): string {
  return dateIn(new Date(), zone);
}

/**
 * The calendar date of an instant (`isoUtc`, ISO-8601 with a `Z`) on the clock of `zone`, an IANA name: the day that a time of a
 * segment falls on where it happened, which is how the server tells which days a segment is on. A zone this browser has never heard
 * of reads as UTC (as `formatTime` does), and does not take the screen down with it.
 */
export function dateOf(isoUtc: string, zone: string): string {
  const instant = new Date(isoUtc);
  try {
    return dateIn(instant, zone);
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    return dateIn(instant, "UTC");
  }
}

/** The date `n` days after `date` (before it, when `n` is negative). */
export function addDays(date: string, n: number): string {
  return toDate(addDaysTo(parse(date), n));
}

/** The Monday of the week `date` lies in (weeks run Monday to Sunday). */
export function weekStart(date: string): string {
  return toDate(startOfWeek(parse(date), { weekStartsOn: 1 }));
}

/** The month `date` lies in, `yyyy-MM`. */
export function monthOf(date: string): string {
  return format(parse(date), "yyyy-MM");
}

/** The first and the last date (both included) that a period covers. */
export function periodRange(route: PeriodRoute): { from: string; to: string } {
  switch (route.view) {
    case "day":
      return { from: route.date, to: route.date };
    case "week":
      return { from: route.start, to: addDays(route.start, 6) };
    case "month":
      return { from: `${route.month}-01`, to: toDate(endOfMonth(firstOf(route.month))) };
    case "year": {
      const year = String(route.year).padStart(4, "0");
      return { from: `${year}-01-01`, to: `${year}-12-31` };
    }
    case "range":
      return { from: route.from, to: route.to };
  }
}

/** How many dates a period covers, both ends counted: 1 for a day, 7 for a week. */
export function periodDays(route: PeriodRoute): number {
  const { from, to } = periodRange(route);
  return differenceInCalendarDays(parse(to), parse(from)) + 1;
}

/**
 * The period before (`-1`) or after (`1`) this one: a day, a week (7 days), a month or a year further, and a range as far as
 * it is long, so that a range of 3 days steps to the next 3 days.
 */
export function step(route: PeriodRoute, delta: -1 | 1): PeriodRoute {
  switch (route.view) {
    case "day":
      return { view: "day", date: addDays(route.date, delta) };
    case "week":
      return { view: "week", start: addDays(route.start, 7 * delta) };
    case "month":
      return { view: "month", month: format(addMonths(firstOf(route.month), delta), "yyyy-MM") };
    case "year":
      return { view: "year", year: route.year + delta };
    case "range": {
      const shift = periodDays(route) * delta;
      return { view: "range", from: addDays(route.from, shift), to: addDays(route.to, shift) };
    }
  }
}

/** A day as a row of a list says it: "Thu 22 Oct" (the weekday and the date; the month, for a list that runs over several). */
export function shortDayLabel(date: string): string {
  return format(parse(date), "EEE d MMM");
}

/** A date as a list that runs over years says it: "Thu 22 Oct 2026" (`shortDayLabel` with the year). */
export function dateLabel(date: string): string {
  return format(parse(date), "EEE d MMM yyyy");
}

/**
 * Two dates as one span: "12 – 18 Sep 2026", and "28 Sep – 4 Oct 2026" over a month end, "29 Dec 2025 – 4 Jan 2026" over a year end, and
 * "12 Sep 2026" for one date. A span within one month says the month once, unless `collapseMonth` is false ("12 Sep – 18 Sep 2026", how
 * the range view writes the two dates that the owner picked). The weeks, the trip's row and the trips' cards write theirs the short way.
 */
export function dateRangeLabel(from: string, to: string, collapseMonth = true): string {
  const start = parse(from);
  const end = parse(to);
  if (from === to) return format(start, "d MMM yyyy");
  if (start.getFullYear() !== end.getFullYear()) return `${format(start, "d MMM yyyy")} – ${format(end, "d MMM yyyy")}`;
  if (collapseMonth && start.getMonth() === end.getMonth()) return `${format(start, "d")} – ${format(end, "d MMM yyyy")}`;
  return `${format(start, "d MMM")} – ${format(end, "d MMM yyyy")}`;
}

/**
 * What the top bar shows for a period: "Thursday 22 October", "19 – 25 Oct 2026" (a week; a month end or a year end in it is
 * spelled out: "28 Sep – 4 Oct 2026"), "October 2026", "2026", "12 Sep – 19 Sep 2026" (a range).
 */
export function periodLabel(route: PeriodRoute): string {
  switch (route.view) {
    case "day":
      return format(parse(route.date), "EEEE d MMMM");
    case "week":
      return dateRangeLabel(route.start, addDays(route.start, 6), true);
    case "month":
      return format(firstOf(route.month), "MMMM yyyy");
    case "year":
      return String(route.year);
    case "range":
      return dateRangeLabel(route.from, route.to, false);
  }
}
