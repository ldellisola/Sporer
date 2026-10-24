import { describe, expect, test } from "vitest";
import { formatDistance, formatDuration, formatTime } from "./format";

describe("formatTime", () => {
  test("formatTime_uses_segment_zone", () => {
    expect(formatTime("2026-10-22T06:46:00Z", "Europe/Oslo")).toBe("08:46");
    expect(formatTime("2026-10-22T06:46:00Z", "America/New_York")).toBe("02:46");
    expect(formatTime("2026-10-22T06:46:00Z", "UTC")).toBe("06:46");
    expect(formatTime("2026-10-22T06:46:00Z", "Asia/Kolkata")).toBe("12:16"); // a half-hour offset
    expect(formatTime("2026-01-22T06:46:00Z", "Europe/Oslo")).toBe("07:46"); // winter time
  });

  test("formatTime_is_24_hour_and_midnight_is_00", () => {
    expect(formatTime("2026-10-22T22:00:00Z", "Europe/Oslo")).toBe("00:00");
    expect(formatTime("2026-10-22T22:05:00Z", "Europe/Oslo")).toBe("00:05");
    expect(formatTime("2026-10-22T11:59:00Z", "UTC")).toBe("11:59");
    expect(formatTime("2026-10-22T12:00:00Z", "UTC")).toBe("12:00");
    expect(formatTime("2026-10-22T18:30:00Z", "UTC")).toBe("18:30");
    expect(formatTime("2026-10-22T23:59:59Z", "UTC")).toBe("23:59");
  });

  test("formatTime_on_dst_end_day", () => {
    // Oslo turns its clocks back at 01:00 UTC on 25 October 2026, so 02:30 happens twice that night.
    expect(formatTime("2026-10-25T00:30:00Z", "Europe/Oslo")).toBe("02:30");
    expect(formatTime("2026-10-25T01:30:00Z", "Europe/Oslo")).toBe("02:30");
    expect(formatTime("2026-10-25T02:30:00Z", "Europe/Oslo")).toBe("03:30");
    // ...and the day it starts (29 March 2026) has no 02:30 at all.
    expect(formatTime("2026-03-29T00:30:00Z", "Europe/Oslo")).toBe("01:30");
    expect(formatTime("2026-03-29T01:30:00Z", "Europe/Oslo")).toBe("03:30");
  });

  test("formatTime_falls_back_to_utc_for_a_zone_the_browser_does_not_know", () => {
    expect(formatTime("2026-10-22T06:46:00Z", "Mars/Olympus_Mons")).toBe("06:46");
  });
});

describe("formatDuration", () => {
  test("formatDuration_and_formatDistance", () => {
    expect(formatDuration(30720)).toBe("8h 32m");
    expect(formatDuration(1440)).toBe("24m");
    expect(formatDuration(45)).toBe("45s");
    expect(formatDistance(850)).toBe("850 m");
    expect(formatDistance(1100)).toBe("1.1 km");
    expect(formatDistance(412_000)).toBe("412 km");
  });

  test("formatDuration_edges", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(59)).toBe("59s");
    expect(formatDuration(60)).toBe("1m");
    expect(formatDuration(119)).toBe("1m"); // whole minutes, rounded down
    expect(formatDuration(3599)).toBe("59m");
    expect(formatDuration(3600)).toBe("1h 0m");
    expect(formatDuration(3661)).toBe("1h 1m");
    expect(formatDuration(86_400)).toBe("24h 0m");
    expect(formatDuration(44.9)).toBe("44s");
    expect(formatDuration(-5)).toBe("0s");
    expect(formatDuration(Number.NaN)).toBe("0s");
  });

  test("formatDistance_edges", () => {
    expect(formatDistance(0)).toBe("0 m");
    expect(formatDistance(0.4)).toBe("0 m");
    expect(formatDistance(999)).toBe("999 m");
    expect(formatDistance(999.6)).toBe("1.0 km"); // never "1000 m"
    expect(formatDistance(1000)).toBe("1.0 km");
    expect(formatDistance(12_345)).toBe("12.3 km");
    expect(formatDistance(99_949)).toBe("99.9 km");
    expect(formatDistance(99_950)).toBe("100 km"); // never "100.0 km"
    expect(formatDistance(100_400)).toBe("100 km");
    expect(formatDistance(412_499)).toBe("412 km");
    expect(formatDistance(41_203_000)).toBe("41,203 km");
    expect(formatDistance(-20)).toBe("0 m");
    expect(formatDistance(Number.NaN)).toBe("0 m");
  });
});
