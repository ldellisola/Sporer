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
 * How long a poll of `pixelAt` may run (`expect.poll(..., PIXEL_POLL)`). One read is a screenshot, which waits for the page to be
 * painted, and a WebGL canvas is painted in software here: with the processors busy a read took up to 6 s at the 1170 × 2532 pixels
 * of the phone project, and about a third of that at one pixel per CSS pixel (`test.use({ deviceScaleFactor: 1 })`, for a test that
 * has nothing to do with density). A poll's default of 5 s is no more than one such read, and that was the one timeout seen in a full
 * run. It was never a late canvas: with the timeout lifted, every poll found the colour that it waited for in its first read.
 */
export const PIXEL_POLL = { timeout: 20_000 };

/** Whether two colours are the same to within `tolerance` in each channel. */
export function sameColour(a: Rgb, b: Rgb, tolerance = 4): boolean {
  return a.every((channel, i) => Math.abs(channel - (b[i] ?? 0)) <= tolerance);
}
