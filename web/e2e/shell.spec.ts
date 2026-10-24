import { expect, test } from "./base";
import { mockApi } from "./mockApi";

// 22:30 UTC on the 22nd is 00:30 on the 23rd in Oslo: "today" must be the date of the browser's own zone.
test.use({ timezoneId: "Europe/Oslo" });

test("app_loads_and_redirects_to_today", async ({ page }) => {
  const api = await mockApi(page);
  await page.clock.setFixedTime(new Date("2026-10-22T22:30:00Z"));

  await page.goto("/");

  await expect(page).toHaveURL(/\/day\/2026-10-23$/);
  await expect(page.getByRole("heading", { name: "Sporer" })).toBeVisible();
  await expect(page.getByText("Friday 23 October")).toBeVisible();
  expect(api.requests).toContain("/api/day/2026-10-23");
});
