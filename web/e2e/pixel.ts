import type { Page } from "@playwright/test";

export type Rgb = [red: number, green: number, blue: number];

/**
 * The colour of the pixel of the page at (`x`, `y`), in CSS pixels, as the browser draws it: a screenshot of that one pixel,
 * read back in the page (which can decode a PNG; this side has no library for it). What a WebGL canvas shows can be told no
 * other way.
 */
export async function pixelAt(page: Page, x: number, y: number): Promise<Rgb> {
  const png = await page.screenshot({ clip: { x, y, width: 1, height: 1 } });
  return page.evaluate(async (base64): Promise<Rgb> => {
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
    const context = new OffscreenCanvas(bitmap.width, bitmap.height).getContext("2d");
    if (context === null) throw new Error("No 2D canvas to read the screenshot with.");
    context.drawImage(bitmap, 0, 0);
    const [red = 0, green = 0, blue = 0] = context.getImageData(0, 0, 1, 1).data;
    return [red, green, blue];
  }, png.toString("base64"));
}

/**
 * How many pixels of the page within `clip` (CSS pixels) are dark, as the ink of the map's text is on the light style of the test: every channel
 * below `limit`. The glyphs themselves are of no use to a test (they are the map's font, at the size of a device); whether there is text where
 * it is looked for is. Read in the page, as `pixelAt` does.
 */
export async function inkIn(page: Page, clip: { x: number; y: number; width: number; height: number }, limit = 110): Promise<number> {
  const png = await page.screenshot({ clip });
  return page.evaluate(
    async ([base64, dark]): Promise<number> => {
      const bytes = Uint8Array.from(atob(base64 as string), (char) => char.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
      const context = new OffscreenCanvas(bitmap.width, bitmap.height).getContext("2d");
      if (context === null) throw new Error("No 2D canvas to read the screenshot with.");
      context.drawImage(bitmap, 0, 0);
      const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height);
      let count = 0;
      for (let i = 0; i < data.length; i += 4) if (data[i]! < (dark as number) && data[i + 1]! < (dark as number) && data[i + 2]! < (dark as number)) count += 1;
      return count;
    },
    [png.toString("base64"), limit] as const,
  );
}

/**
 * How long a poll of `pixelAt` may run (`expect.poll(..., PIXEL_POLL)`). One read is a screenshot, which waits for the page to be
 * painted, and a WebGL canvas is painted in software here. A read takes about 0.1 s, but it queues behind every frame that the GPU
 * process has still to draw: the first one after the map has come up waits for the map's first frames, which at the phone project's
 * 1170 × 2532 pixels take up to 2 s (about a third of that at one pixel per CSS pixel, `test.use({ deviceScaleFactor: 1 })`, for a test
 * that has nothing to do with density), and a runner that is busy with other work takes longer. A poll's default of 5 s is no more than
 * a slow read. It was never a late canvas: every poll that timed out would have found the colour that it waited for in its first read.
 * (A page whose clock is faked draws a hundred frames a second and keeps the GPU process busy for ten seconds or more: see today.ts.)
 */
export const PIXEL_POLL = { timeout: 20_000 };

/** Whether two colours are the same to within `tolerance` in each channel. */
export function sameColour(a: Rgb, b: Rgb, tolerance = 4): boolean {
  return a.every((channel, i) => Math.abs(channel - (b[i] ?? 0)) <= tolerance);
}
