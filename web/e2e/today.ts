import type { Page } from "@playwright/test";

/**
 * Makes the page's `Date` stand still at `iso`: `new Date()`, `Date.now()` and `Date()` give that moment, any other date is as it was.
 * The page's date and nothing else. Not `page.clock`, the obvious tool and a trap here: it also replaces the page's
 * `requestAnimationFrame`, `performance.now` and timers. A fake `requestAnimationFrame` fires on a timer, at any rate, where the
 * browser's own waits for the last frame to be on screen, and MapLibre draws a frame for each call. A page under `page.clock` drew
 * about a hundred frames in the second after its map came up (the camera moving to what the view shows, 600 ms) where the same page
 * with its own frames draws a few. Software WebGL needs a few tenths of a second of all four processors for a frame of the phone's
 * 1170 × 2532 pixels, so the frames queued up in the GPU process, which kept every processor busy for seconds on them (the longer for
 * each further page that did it): its own page, and the next test's too, waited behind them for their frames, for the animation
 * frames that Playwright's actionability checks wait on, and for their screenshots. That was the 30 s timeouts of tests that did
 * nothing to the clock themselves.
 */
export async function fixTime(page: Page, iso: string): Promise<void> {
  await page.addInitScript((fixed) => {
    globalThis.Date = new Proxy(Date, {
      construct: (target, args, newTarget) => Reflect.construct(target, args.length === 0 ? [fixed] : args, newTarget),
      apply: (target) => new target(fixed).toString(),
      get: (target, property, receiver) => (property === "now" ? () => fixed : Reflect.get(target, property, receiver)),
    });
  }, new Date(iso).getTime());
}
