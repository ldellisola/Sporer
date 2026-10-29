import { describe, expect, test } from "vitest";
import { deviceZone, whenOf } from "./device";

// The unit tests run on the clock of Tokyo (see globalSetup), which is the browser's zone here.

describe("device time", () => {
  test("deviceZone_is_the_zone_of_the_clock_this_device_has", () => {
    expect(deviceZone()).toBe("Asia/Tokyo");
  });

  test("whenOf_reads_an_instant_on_the_clock_of_this_device_with_the_weekday_and_the_year", () => {
    expect(whenOf("2026-10-24T08:15:00Z")).toBe("Sat 24 Oct 2026 17:15");
    expect(whenOf("2026-10-24T20:00:00Z")).toBe("Sun 25 Oct 2026 05:00"); // the date is the date there, not the date in UTC
  });
});
