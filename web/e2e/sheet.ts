import type { Page } from "@playwright/test";

const isWide = (page: Page): boolean => page.viewportSize()!.width >= 900;

/**
 * Waits for the sheet to come to rest: the transition that moves it (a few hundred milliseconds) has finished. A card that is tapped while the
 * sheet is on its way is found too far down, and the page, which is as tall as the sheet before it is moved up, is scrolled to bring it up: the map
 * and the bar are then not where the shell has measured them. (The shell is `overflow: clip` now, which no script can scroll, so Playwright cannot
 * scroll it either: a row in a sheet that is still moving is reported as outside of the viewport and the click fails.) Wait for it after the sheet
 * has been moved, and after a navigation that brings a list back, before a row of it is clicked.
 *
 * A transition that is cancelled, or is restarted by another move of the sheet, rejects its `finished`: that is the sheet moving on and not a
 * failure, so each rejection is let go and what is left is looked at again, until the sheet has no animation on it. A frame between the looks keeps
 * the loop from spinning on an animation that has finished and is still listed. On a wide screen the panel is a fixed sidebar, which has none.
 */
export async function sheetAtRest(page: Page): Promise<void> {
  const details = page.getByRole(isWide(page) ? "complementary" : "region", { name: "Details" });
  await details.evaluate(async (sheet) => {
    while (sheet.getAnimations().length > 0) {
      await Promise.all(sheet.getAnimations().map((animation) => animation.finished.catch(() => undefined)));
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
  });
}
