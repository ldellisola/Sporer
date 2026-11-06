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

/** What is said, with the no-break spaces between a number and its unit as plain ones, to read. */
const plain = (text: string | null): string | null => (text === null ? null : text.replace(/\u00a0/g, " "));

const AT = "2026-10-22T08:30:00"; // the local time of a point

describe("pointCardText", () => {
  test("formatGap_says_the_leading_unit_and_the_one_under_it_and_leaves_out_a_zero", () => {
    expect(plain(formatGap(45))).toBe("45 s");
    expect(plain(formatGap(0))).toBe("0 s");
    expect(plain(formatGap(61))).toBe("1 min 1 s");
    expect(plain(formatGap(120))).toBe("2 min");
    expect(plain(formatGap(2 * 3600 + 3 * 60 + 40))).toBe("2 h 3 min");
    expect(plain(formatGap(3 * 3600))).toBe("3 h");
    expect(plain(formatGap(60.6))).toBe("1 min 1 s"); // whole seconds
  });

  test("a_number_and_its_unit_are_not_parted_by_a_line_break", () => {
    for (const text of [formatGap(61), formatSpeedMps(20), statusText({ status: "poorAccuracy", accuracyM: 1414, maxAccuracyM: 100 }), neighbourText({ t: 1, gapSeconds: 61, distanceM: 1234, speedKmh: 72 }, "next")]) {
      expect(text).not.toMatch(/\d (m|km|s|min|h|km\/h)\b/);
      expect(text).toMatch(/\d\u00a0(m|km|s|min|h|km\/h)\b/);
    }
  });

  test("formatSpeedMps_is_kilometres_an_hour_with_one_decimal", () => {
    expect(plain(formatSpeedMps(20))).toBe("72.0 km/h");
    expect(plain(formatSpeedMps(1.4))).toBe("5.0 km/h");
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
    expect(plain(statusText({ status: "used", accuracyM: 5, maxAccuracyM: 100 }))).toBe("Used by the timeline");
    expect(plain(statusText({ status: "poorAccuracy", accuracyM: 1414.2, maxAccuracyM: 100 }))).toBe("Ignored: the GPS accuracy was 1,414 m (more than 100 m)");
    expect(plain(statusText({ status: "poorAccuracy", accuracyM: -1, maxAccuracyM: 100 }))).toBe("Ignored: the GPS accuracy was not valid");
    // The limit is the server's, whatever it is set to; and a value that rounds to the limit says so with a decimal and not "100 m (more than 100 m)".
    expect(plain(statusText({ status: "poorAccuracy", accuracyM: 70, maxAccuracyM: 50 }))).toBe("Ignored: the GPS accuracy was 70 m (more than 50 m)");
    expect(plain(statusText({ status: "poorAccuracy", accuracyM: 100.4, maxAccuracyM: 100 }))).toBe("Ignored: the GPS accuracy was 100.4 m (more than 100 m)");
    expect(plain(statusText({ status: "glitch", accuracyM: 5, maxAccuracyM: 100 }))).toBe("Ignored: an out-and-back jump");
    expect(plain(statusText({ status: "duplicate", accuracyM: 5, maxAccuracyM: 100 }))).toBe("Ignored: a repeat of an earlier point");
    expect(plain(statusText({ status: "removed", accuracyM: 5, maxAccuracyM: 100 }))).toBe("Removed by you");
  });

  test("segmentText_gives_the_date_of_an_end_that_is_on_another_date_than_the_point", () => {
    const gap = { kind: "gap" as const, startUtc: "2026-11-04T07:00:00Z", endUtc: "2026-11-07T15:00:00Z" };
    expect(plain(segmentText(gap, "Europe/Oslo", "2026-11-05T12:00:00"))).toBe("In a gap (Wed 4 Nov 08:00–Sat 7 Nov 16:00)");
    expect(plain(segmentText(gap, "Europe/Oslo", "2026-11-04T09:00:00"))).toBe("In a gap (08:00–Sat 7 Nov 16:00)");
    // The dates are those of the zone, not the browser's: 23:30 UTC is the next day in Oslo.
    const stay = { kind: "stay" as const, startUtc: "2026-11-03T23:30:00Z", endUtc: "2026-11-04T08:15:00Z", place: { id: 3, name: "Home" } };
    expect(plain(segmentText(stay, "Europe/Oslo", "2026-11-04T01:00:00"))).toBe("In a stay at Home (00:30–09:15)");
  });

  test("segmentText_does_not_take_a_name_that_every_object_has_for_a_mode", () => {
    const mode = "toString" as never;
    expect(plain(segmentText({ kind: "move", startUtc: "2026-10-22T06:00:00Z", endUtc: "2026-10-22T07:30:00Z", mode }, "Europe/Oslo", AT))).toBe("In a move (08:00–09:30)");
  });

  test("formatSpeedMps_groups_thousands", () => {
    expect(plain(formatSpeedMps(10_000))).toBe("36,000.0 km/h");
  });

  test("segmentText_says_where_in_the_day_the_point_is_with_the_times_on_the_clock_of_the_zone", () => {
    const times = { startUtc: "2026-10-22T06:00:00Z", endUtc: "2026-10-22T07:30:00Z" };
    expect(plain(segmentText({ kind: "stay", ...times, place: { id: 3, name: "Café" } }, "Europe/Oslo", AT))).toBe("In a stay at Café (08:00–09:30)");
    expect(plain(segmentText({ kind: "stay", ...times, place: { id: 3, name: null } }, "Europe/Oslo", AT))).toBe("In a stay at a place with no name (08:00–09:30)");
    expect(plain(segmentText({ kind: "move", ...times, mode: "walk" }, "Europe/Oslo", AT))).toBe("In a move: Walk (08:00–09:30)");
    expect(plain(segmentText({ kind: "move", ...times }, "Europe/Oslo", AT))).toBe("In a move (08:00–09:30)");
    expect(plain(segmentText({ kind: "move", ...times, mode: "unknown" }, "Europe/Oslo", AT))).toBe("In a move (08:00–09:30)");
    expect(plain(segmentText({ kind: "gap", ...times }, "Europe/Oslo", AT))).toBe("In a gap (08:00–09:30)");
    expect(segmentText(null, "Europe/Oslo", AT)).toBeNull();
  });

  test("neighbourText_says_how_long_and_how_far_and_how_fast_and_that_there_is_none_at_the_end", () => {
    const near = { t: 1, gapSeconds: 61, distanceM: 1234, speedKmh: 72.04 };
    expect(plain(neighbourText(near, "previous"))).toBe("1 min 1 s and 1.2 km after the previous point (72.0 km/h)");
    expect(plain(neighbourText({ ...near, gapSeconds: 45, distanceM: 80 }, "next"))).toBe("45 s and 80 m before the next point (72.0 km/h)");
    expect(plain(neighbourText(null, "previous"))).toBe("No earlier point");
    expect(plain(neighbourText(null, "next"))).toBe("No later point");
  });
});
