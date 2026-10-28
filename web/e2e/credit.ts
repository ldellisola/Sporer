import { expect, type Page } from "@playwright/test";

/**
 * Leaves the map's credit open and steady, for a test that looks at its text or measures its box after a time that it cannot know: the
 * credit is open when the map appears and folds by itself five seconds after, or at the first tap on the map, and its ⓘ button opens it
 * again. A tap on the middle of the map (which nothing covers) folds it at once, or finds it folded by the timer, and takes the timer away;
 * ⓘ then opens it, and nothing folds it until the map is dragged. Call it once the map is `ready`, which is when the five seconds begin.
 */
export async function openCredit(page: Page): Promise<void> {
  const { width, height } = page.viewportSize()!;
  await page.mouse.click(Math.round(width / 2), Math.round(height / 2));
  const credit = page.getByRole("region", { name: "Map view" }).locator(".maplibregl-ctrl-attrib");
  await expect(credit).not.toHaveClass(/maplibregl-compact-show/); // folded by the tap (or by the timer, if that came first)
  await credit.locator(".maplibregl-ctrl-attrib-button").click();
  await expect(credit).toHaveClass(/maplibregl-compact-show/);
}
