import { describe, expect, test } from "vitest";
import {
  formatCoordinates,
  formatGap,
  formatSpeedMps,
  localClock,
  localDate,
  neighbourText,
  segmentText,
  statusText,
  zoneName,
} from "./pointCardText";

describe("pointCardText", () => {
  test("formatGap_says_the_leading_unit_and_the_one_under_it_and_leaves_out_a_zero", () => {
    expect(formatGap(45)).toBe("45 s");
    expect(formatGap(0)).toBe("0 s");
    expect(formatGap(61)).toBe("1 min 1 s");
    expect(formatGap(120)).toBe("2 min");
    expect(formatGap(2 * 3600 + 3 * 60 + 40)).toBe("2 h 3 min");
    expect(formatGap(3 * 3600)).toBe("3 h");
    expect(formatGap(60.6)).toBe("1 min 1 s"); // whole seconds
  });

  test("formatSpeedMps_is_kilometres_an_hour_with_one_decimal", () => {
    expect(formatSpeedMps(20)).toBe("72.0 km/h");
    expect(formatSpeedMps(1.4)).toBe("5.0 km/h");
  });

  test("formatCoordinates_has_six_decimals", () => {
    expect(formatCoordinates(59.9123456789, 10.75)).toBe("59.912346, 10.750000");
  });

  test("the_local_clock_and_date_are_those_of_the_place", () => {
    expect(localClock("2026-10-22T08:46:12")).toBe("08:46:12");
    expect(localDate("2026-10-02T08:46:12")).toBe("2 Oct 2026");
  });

  test("zoneName_is_the_short_name_at_the_time_of_the_point_and_the_zone_itself_when_it_is_not_known", () => {
    const summer = Date.UTC(2026, 6, 1, 12) * 1000;
    const winter = Date.UTC(2026, 11, 1, 12) * 1000;
    expect(zoneName(summer, "Europe/Oslo")).toBe("CEST");
    expect(zoneName(winter, "Europe/Oslo")).toBe("CET");
    expect(zoneName(summer, "Not/AZone")).toBe("Not/AZone");
  });

  test("statusText_says_why_a_point_is_ignored", () => {
    expect(statusText({ status: "used", accuracyM: 5 })).toBe("Used by the timeline");
    expect(statusText({ status: "poorAccuracy", accuracyM: 1414.2 })).toBe("Ignored: the GPS accuracy was 1,414 m (more than 100 m)");
    expect(statusText({ status: "poorAccuracy", accuracyM: -1 })).toBe("Ignored: the GPS accuracy was not valid");
    expect(statusText({ status: "glitch", accuracyM: 5 })).toBe("Ignored: an out-and-back jump");
    expect(statusText({ status: "duplicate", accuracyM: 5 })).toBe("Ignored: a repeat of an earlier point");
    expect(statusText({ status: "removed", accuracyM: 5 })).toBe("Removed by you");
  });

  test("segmentText_says_where_in_the_day_the_point_is_with_the_times_on_the_clock_of_the_zone", () => {
    const times = { startUtc: "2026-10-22T06:00:00Z", endUtc: "2026-10-22T07:30:00Z" };
    expect(segmentText({ kind: "stay", ...times, place: { id: 3, name: "Café" } }, "Europe/Oslo")).toBe("In a stay at Café (08:00–09:30)");
    expect(segmentText({ kind: "stay", ...times, place: { id: 3, name: null } }, "Europe/Oslo")).toBe("In a stay at a place with no name (08:00–09:30)");
    expect(segmentText({ kind: "move", ...times, mode: "walk" }, "Europe/Oslo")).toBe("In a move by walk (08:00–09:30)");
    expect(segmentText({ kind: "move", ...times }, "Europe/Oslo")).toBe("In a move (08:00–09:30)");
    expect(segmentText({ kind: "gap", ...times }, "Europe/Oslo")).toBe("In a gap (08:00–09:30)");
    expect(segmentText(null, "Europe/Oslo")).toBeNull();
  });

  test("neighbourText_says_how_long_and_how_far_and_how_fast_and_that_there_is_none_at_the_end", () => {
    const near = { t: 1, gapSeconds: 61, distanceM: 1234, speedKmh: 72.04 };
    expect(neighbourText(near, "previous")).toBe("1 min 1 s and 1.2 km after the previous point (72.0 km/h)");
    expect(neighbourText({ ...near, gapSeconds: 45, distanceM: 80 }, "next")).toBe("45 s and 80 m before the next point (72.0 km/h)");
    expect(neighbourText(null, "previous")).toBe("No earlier point");
    expect(neighbourText(null, "next")).toBe("No later point");
  });
});
