import { expect, test } from "vitest";

test("timezone_the_unit_tests_run_on_the_clock_of_Tokyo", () => {
  // A day's times must come out on the clock of the segment's zone, so the machine's zone must be neither Oslo's nor New York's.
  expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe("Asia/Tokyo");
  expect(new Date("2026-10-22T12:00:00Z").getHours()).toBe(21); // UTC+9
});
