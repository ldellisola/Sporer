import type { Locator, Page } from "@playwright/test";

const isWide = (page: Page): boolean => page.viewportSize()!.width >= 900;

/**
 * Waits for the sheet to come to rest: the transition that moves it (a few hundred milliseconds) has finished. A card that is tapped while the
 * sheet is on its way is found too far down, and the page, which is as tall as the sheet before it is moved up, is scrolled to bring it up: the map
 * and the bar are then not where the shell has measured them. (The shell is `overflow: clip` now, which no script can scroll, so Playwright cannot
 * scroll it either: a row in a sheet that is still moving is reported as outside of the viewport and the click fails.) Wait for it after the sheet
 * has been moved, and after a navigation that brings a list back, before a row of it is clicked.
 *
 * After a navigation (a `goBack()`), pass `content`: what the view that comes back shows, such as the row that is clicked next. The sheet does not
 * move until the view has rendered, so a sheet that is looked at at once has no animation yet and is taken for being at rest, and the transition
 * that then begins moves the row from under the click. The wait is for the content first, which is the condition that does not depend on how long
 * the render takes, and then for the sheet: no animation on it for three frames in a row (the view that has just rendered starts its transition
 * in the frame after the commit, and one frame without one is not yet the end of it).
 *
 * A transition that is cancelled, or is restarted by another move of the sheet, rejects its `finished`: that is the sheet moving on and not a
 * failure, so each rejection is let go and what is left is looked at again, until the sheet has had none for those frames. On a wide screen the
 * panel is a fixed sidebar, which has none.
 */
export async function sheetAtRest(page: Page, content?: Locator): Promise<void> {
  if (content !== undefined) await content.first().waitFor({ state: "visible" });
  const details = page.getByRole(isWide(page) ? "complementary" : "region", { name: "Details" });
  await details.evaluate(async (sheet) => {
    let still = 0;
    while (still < 3) {
      const running = sheet.getAnimations();
      if (running.length > 0) {
        still = 0;
        await Promise.all(running.map((animation) => animation.finished.catch(() => undefined)));
      } else {
        still += 1;
      }
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
  });
}
