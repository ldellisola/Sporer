import { expect, test } from "./base";

// MapLibre is two thirds of the app's JavaScript and the longest task of a start. The panel's rows must not wait for it, so the
// bundle the page starts with must not need its chunk: the page asks for it itself once the app is up (MapView, see map/maplibre.ts).
// The build, and not a unit test, is where this can go wrong (the group of chunks that vite.config.ts makes, a stylesheet or an
// address that something imports from the page's own code), so it is the production build that is looked at.
test("the_page_starts_without_MapLibre_and_asks_for_it_once_the_app_is_up", async ({ page }) => {
  const html = await (await page.request.get("/")).text();
  expect(html).not.toMatch(/maplibre/i); // not preloaded, and its style sheet is not in the head: that comes with its chunk

  const entry = /<script[^>]*\ssrc="([^"]+)"/.exec(html)?.[1];
  expect(entry, "the module script of index.html").toBeDefined();
  const source = await (await page.request.get(entry!)).text();
  expect(source).not.toMatch(/\bfrom\s*["'`]\.\/maplibre-(?!entry)[^"'`]*["'`]/); // a static import of its chunk would run it first
  expect(source).toMatch(/import\(["'`]\.\/maplibre-entry-[^"'`]*["'`]\)/); // the way in that is left: a dynamic import
});
