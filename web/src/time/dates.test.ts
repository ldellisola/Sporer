import { afterEach, describe, expect, test, vi } from "vitest";
import type { PeriodRoute } from "../app/router";
import { addDays, monthOf, periodLabel, periodRange, step, today, weekStart } from "./dates";

afterEach(() => {
  vi.useRealTimers();
});

describe("date arithmetic", () => {
  test("addDays_weekStart_and_monthOf_work_on_plain_dates", () => {
    expect(addDays("2026-10-22", 1)).toBe("2026-10-23");
    expect(addDays("2026-10-22", -22)).toBe("2026-09-30");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2028-02-29", 1)).toBe("2028-03-01");
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
    expect(addDays("2026-10-22", 0)).toBe("2026-10-22");
    expect(addDays("2026-10-22", 365)).toBe("2027-10-22");

    expect(weekStart("2026-10-22")).toBe("2026-10-19"); // Thursday
    expect(weekStart("2026-10-19")).toBe("2026-10-19"); // Monday
    expect(weekStart("2026-10-25")).toBe("2026-10-19"); // Sunday
    expect(weekStart("2026-01-01")).toBe("2025-12-29");

    expect(monthOf("2026-10-22")).toBe("2026-10");
    expect(monthOf("2026-01-01")).toBe("2026-01");
    expect(monthOf("2028-02-29")).toBe("2028-02");
  });

  test("addDays_is_not_thrown_by_daylight_saving_changes", () => {
    // Clocks change on these dates in some zone or other; a plain date has no clock, so a day is always one date.
    for (const start of ["2026-03-07", "2026-03-28", "2026-10-24", "2026-10-31", "2026-04-04", "2026-09-26"]) {
      expect(addDays(addDays(start, 1), -1)).toBe(start);
      expect(addDays(start, 2)).toBe(addDays(addDays(start, 1), 1));
    }
    expect(addDays("2026-10-24", 1)).toBe("2026-10-25");
    expect(addDays("2026-10-24", 2)).toBe("2026-10-26");
    expect(addDays("2026-03-28", 2)).toBe("2026-03-30");
  });

  test("today_is_the_date_in_the_given_zone_or_the_browsers", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-24T23:30:00Z"));

    expect(today("UTC")).toBe("2026-10-24");
    expect(today("Europe/Oslo")).toBe("2026-10-25"); // already after midnight there
    expect(today("America/New_York")).toBe("2026-10-24");
    expect(today("Pacific/Kiritimati")).toBe("2026-10-25"); // UTC+14
    expect(today("Pacific/Pago_Pago")).toBe("2026-10-24"); // UTC-11

    // Without a zone it is the zone of the machine the code runs on.
    const here = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    expect(today()).toBe(`${here.getFullYear()}-${pad(here.getMonth() + 1)}-${pad(here.getDate())}`);
  });
});

describe("periods", () => {
  test("periodRange_covers_iso_week_and_month", () => {
    expect(periodRange({ view: "day", date: "2026-10-22" })).toEqual({ from: "2026-10-22", to: "2026-10-22" });
    expect(periodRange({ view: "week", start: "2026-10-19" })).toEqual({ from: "2026-10-19", to: "2026-10-25" });
    expect(periodRange({ view: "week", start: "2025-12-29" })).toEqual({ from: "2025-12-29", to: "2026-01-04" });
    expect(periodRange({ view: "month", month: "2026-02" })).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(periodRange({ view: "month", month: "2028-02" })).toEqual({ from: "2028-02-01", to: "2028-02-29" });
    expect(periodRange({ view: "month", month: "2026-10" })).toEqual({ from: "2026-10-01", to: "2026-10-31" });
    expect(periodRange({ view: "month", month: "2026-12" })).toEqual({ from: "2026-12-01", to: "2026-12-31" });
    expect(periodRange({ view: "year", year: 2026 })).toEqual({ from: "2026-01-01", to: "2026-12-31" });
    expect(periodRange({ view: "range", from: "2026-09-12", to: "2026-09-19" })).toEqual({
      from: "2026-09-12",
      to: "2026-09-19",
    });
  });

  test("step_moves_by_period", () => {
    // Day: one day, over months, years and a leap day.
    expect(step({ view: "day", date: "2026-10-22" }, 1)).toEqual({ view: "day", date: "2026-10-23" });
    expect(step({ view: "day", date: "2026-10-22" }, -1)).toEqual({ view: "day", date: "2026-10-21" });
    expect(step({ view: "day", date: "2026-03-01" }, -1)).toEqual({ view: "day", date: "2026-02-28" });
    expect(step({ view: "day", date: "2028-02-28" }, 1)).toEqual({ view: "day", date: "2028-02-29" });
    expect(step({ view: "day", date: "2026-12-31" }, 1)).toEqual({ view: "day", date: "2027-01-01" });

    // Week: seven days, and the start stays a Monday.
    expect(step({ view: "week", start: "2026-10-19" }, 1)).toEqual({ view: "week", start: "2026-10-26" });
    expect(step({ view: "week", start: "2026-10-19" }, -1)).toEqual({ view: "week", start: "2026-10-12" });
    expect(step({ view: "week", start: "2025-12-29" }, 1)).toEqual({ view: "week", start: "2026-01-05" });

    // Month: one calendar month, whatever the lengths.
    expect(step({ view: "month", month: "2026-01" }, -1)).toEqual({ view: "month", month: "2025-12" });
    expect(step({ view: "month", month: "2026-12" }, 1)).toEqual({ view: "month", month: "2027-01" });
    expect(step({ view: "month", month: "2026-03" }, -1)).toEqual({ view: "month", month: "2026-02" });
    expect(step({ view: "month", month: "2026-01" }, 1)).toEqual({ view: "month", month: "2026-02" });

    // Year.
    expect(step({ view: "year", year: 2026 }, -1)).toEqual({ view: "year", year: 2025 });
    expect(step({ view: "year", year: 2026 }, 1)).toEqual({ view: "year", year: 2027 });

    // Range: shifted by its own length, both ends counted: 3 days → the next 3 days, 8 days → the next 8.
    expect(step({ view: "range", from: "2026-10-19", to: "2026-10-21" }, 1)).toEqual({
      view: "range",
      from: "2026-10-22",
      to: "2026-10-24",
    });
    expect(step({ view: "range", from: "2026-10-19", to: "2026-10-21" }, -1)).toEqual({
      view: "range",
      from: "2026-10-16",
      to: "2026-10-18",
    });
    expect(step({ view: "range", from: "2026-09-12", to: "2026-09-19" }, 1)).toEqual({
      view: "range",
      from: "2026-09-20",
      to: "2026-09-27",
    });
    expect(step({ view: "range", from: "2026-10-22", to: "2026-10-22" }, 1)).toEqual({
      view: "range",
      from: "2026-10-23",
      to: "2026-10-23",
    });
    expect(step({ view: "range", from: "2026-12-30", to: "2027-01-02" }, 1)).toEqual({
      view: "range",
      from: "2027-01-03",
      to: "2027-01-06",
    });
  });

  test("step_and_back_returns_to_the_start", () => {
    const routes: PeriodRoute[] = [
      { view: "day", date: "2028-03-01" },
      { view: "week", start: "2026-10-19" },
      { view: "month", month: "2026-03" },
      { view: "year", year: 2026 },
      { view: "range", from: "2026-09-12", to: "2026-09-19" },
    ];
    for (const route of routes) {
      expect(step(step(route, 1), -1)).toEqual(route);
      expect(step(step(route, -1), 1)).toEqual(route);
    }
  });

  test("periodLabel_names_each_view_in_english", () => {
    expect(periodLabel({ view: "day", date: "2026-10-22" })).toBe("Thursday 22 October");
    expect(periodLabel({ view: "day", date: "2026-10-25" })).toBe("Sunday 25 October");
    expect(periodLabel({ view: "day", date: "2028-02-29" })).toBe("Tuesday 29 February");

    expect(periodLabel({ view: "week", start: "2026-10-19" })).toBe("19 – 25 Oct 2026");
    expect(periodLabel({ view: "week", start: "2026-09-28" })).toBe("28 Sep – 4 Oct 2026"); // over a month end
    expect(periodLabel({ view: "week", start: "2025-12-29" })).toBe("29 Dec 2025 – 4 Jan 2026"); // over a year end

    expect(periodLabel({ view: "month", month: "2026-10" })).toBe("October 2026");
    expect(periodLabel({ view: "month", month: "2026-02" })).toBe("February 2026");
    expect(periodLabel({ view: "year", year: 2026 })).toBe("2026");

    expect(periodLabel({ view: "range", from: "2026-09-12", to: "2026-09-19" })).toBe("12 Sep – 19 Sep 2026");
    expect(periodLabel({ view: "range", from: "2026-09-12", to: "2026-10-03" })).toBe("12 Sep – 3 Oct 2026");
    expect(periodLabel({ view: "range", from: "2025-12-30", to: "2026-01-02" })).toBe("30 Dec 2025 – 2 Jan 2026");
    expect(periodLabel({ view: "range", from: "2026-09-12", to: "2026-09-12" })).toBe("12 Sep 2026");
  });
});
