// Draws the PNG icons of the web app from public/icons/icon.svg: the apple touch icon (180) and the two icons of the manifest (192
// and 512). Run it when the SVG changes, and commit the result:
//
//   cd web && npm run icons
//
// Chromium (the one Playwright has) draws them, so that no image library is needed. It also checks that every PNG is opaque, because
// iOS fills transparency with black.
import { chromium } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const folder = fileURLToPath(new URL("../public/icons/", import.meta.url));
const svg = await readFile(`${folder}icon.svg`, "utf8");

const ICONS = [
  ["apple-touch-icon.png", 180],
  ["icon-192.png", 192],
  ["icon-512.png", 512],
];

const browser = await chromium.launch();
try {
  for (const [file, size] of ICONS) {
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    await page.setContent(`<!doctype html><style>html,body{margin:0}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`);
    const png = await page.screenshot({ clip: { x: 0, y: 0, width: size, height: size }, omitBackground: true });

    // The corners are the most likely place for a transparent pixel (a rounded or an inset background): read them and the middle back.
    const alphas = await page.evaluate(
      async ({ base64, size }) => {
        const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))], { type: "image/png" }));
        const context = new OffscreenCanvas(bitmap.width, bitmap.height).getContext("2d");
        context.drawImage(bitmap, 0, 0);
        const at = (x, y) => context.getImageData(x, y, 1, 1).data[3];
        return [at(0, 0), at(size - 1, 0), at(0, size - 1), at(size - 1, size - 1), at(size >> 1, size >> 1)];
      },
      { base64: png.toString("base64"), size },
    );
    if (alphas.some((alpha) => alpha !== 255)) throw new Error(`${file} is not opaque (alpha ${alphas.join(", ")})`);

    await writeFile(`${folder}${file}`, png);
    console.log(`${file}: ${size} x ${size}, ${png.length} bytes`);
    await page.close();
  }
} finally {
  await browser.close();
}
