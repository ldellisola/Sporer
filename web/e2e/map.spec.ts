import type { Page } from "@playwright/test";
import { expect, test } from "./base";
import { mockApi } from "./mockApi";
import { PIXEL_POLL, pixelAt, sameColour, type Rgb } from "./pixel";

// The real MapLibre, on software WebGL, with a style that has nothing but a background: no tile, font or sprite is asked for,
// so no request leaves the machine (base.ts fails a test that makes one).

const map = (page: Page) => page.getByRole("region", { name: "Map view" });

/** A style of one colour, to tell by the pixels of the canvas which one the map has put on. */
const flatStyle = (colour: string) => ({
  version: 8,
  sources: {},
  layers: [{ id: "background", type: "background", paint: { "background-color": colour } }],
});

const LIGHT: Rgb = [0xdf, 0xe6, 0xea];
const DARK: Rgb = [0x1b, 0x27, 0x33];

/** A pixel in the middle of the map, which neither the card at the top left nor the buttons at the top right cover. */
async function centre(page: Page): Promise<[number, number]> {
  const { width, height } = page.viewportSize()!;
  return [Math.round(width / 2), Math.round(height / 2)];
}

async function showsColour(page: Page, expected: Rgb): Promise<boolean> {
  const [x, y] = await centre(page);
  return sameColour(await pixelAt(page, x, y), expected);
}

test("map_canvas_renders_with_attribution", async ({ page }) => {
  await mockApi(page);

  await page.goto("/day/2026-10-22");

  await expect(map(page)).toHaveAttribute("data-map-state", "ready");
  const canvas = map(page).locator("canvas.maplibregl-canvas");
  await expect(canvas).toBeVisible();
  const box = await canvas.boundingBox();
  expect(box!.width).toBeGreaterThan(300);
  expect(box!.height).toBeGreaterThan(300);
  // Compact: the credit folds away behind a button as soon as the map is moved, but it is there, and open, when the map first appears.
  await expect(map(page).locator(".maplibregl-ctrl-attrib")).toContainText("OpenStreetMap");
  await expect(map(page).getByRole("link", { name: "OpenStreetMap" })).toBeVisible();
  await expect(map(page).locator(".maplibregl-ctrl-attrib-button")).toBeVisible();
  await expect(map(page).getByRole("button", { name: "Recenter map" })).toBeDisabled(); // nothing on the map to go back to
});

// Ruling P2-R17: what covers the map (the bottom sheet on a phone, the sidebar on a desktop) must not cover the credit. The component
// hands its `padding` to the style sheet as `--map-padding-*` on the map's element (a unit test pins that); this is the other half,
// that the style sheet sets MapLibre's controls and the buttons in by them, in the browser, where the corners are real.
test("map_sets_attribution_and_buttons_inside_the_padding", async ({ page }) => {
  await mockApi(page);
  await page.goto("/day/2026-10-22");
  await expect(map(page)).toHaveAttribute("data-map-state", "ready");
  const attribution = map(page).locator(".maplibregl-ctrl-attrib");
  const recenter = map(page).getByRole("button", { name: "Recenter map" });
  const area = (await map(page).boundingBox())!;
  const edges = async () => {
    const credit = (await attribution.boundingBox())!;
    const button = (await recenter.boundingBox())!;
    return {
      creditBottom: area.y + area.height - (credit.y + credit.height), // its distance from the bottom of the map
      creditRight: area.x + area.width - (credit.x + credit.width),
      buttonTop: button.y - area.y,
      buttonRight: area.x + area.width - (button.x + button.width),
    };
  };

  // The shell pads the map by what covers it (see App.tsx); this test sets the padding itself, so it starts from none.
  await map(page).evaluate((element) => {
    for (const side of ["top", "right", "bottom", "left"]) element.style.setProperty(`--map-padding-${side}`, "0px");
  });

  const free = await edges(); // no padding: in the corners (MapLibre leaves a margin of 10px round its controls)
  expect(free.creditBottom).toBeLessThan(16);
  expect(free.creditRight).toBeLessThan(16);
  expect(free.buttonTop).toBeCloseTo(12, 0);
  expect(free.buttonRight).toBeCloseTo(12, 0);

  // The peek of a bottom sheet, a sidebar's width on the right, a bar on top.
  await map(page).evaluate((element) => {
    element.style.setProperty("--map-padding-bottom", "96px");
    element.style.setProperty("--map-padding-right", "40px");
    element.style.setProperty("--map-padding-top", "120px");
  });

  const padded = await edges();
  expect(padded.creditBottom - free.creditBottom).toBeCloseTo(96, 0);
  expect(padded.creditRight - free.creditRight).toBeCloseTo(40, 0);
  expect(padded.buttonTop - free.buttonTop).toBeCloseTo(120, 0);
  expect(padded.buttonRight - free.buttonRight).toBeCloseTo(40, 0);
  await expect(attribution).toBeInViewport(); // above the sheet, in view
  await expect(map(page).getByRole("link", { name: "OpenStreetMap" })).toBeVisible();
});

// The test is of the colour of the canvas and has no use for a canvas of 1170 × 2532 pixels, which the phone project paints in
// software (see PIXEL_POLL): one pixel to a CSS pixel.
test.describe("colour scheme", () => {
  test.use({ deviceScaleFactor: 1 });

  test("map_follows_the_system_colour_scheme", async ({ page }) => {
    // Three polls of PIXEL_POLL run one after the other, which is more than the 30 s that Playwright gives a test: it is the test's
    // budget that would run out first, whatever each poll is allowed. So the test gets the time of its polls on top of the default.
    test.setTimeout(30_000 + 3 * PIXEL_POLL.timeout);
    const asked: string[] = [];
    for (const [file, colour] of [["light", "#dfe6ea"], ["dark", "#1b2733"]] as const) {
      await page.route(`**/map-style-${file}.json`, (route) => {
        asked.push(file);
        return route.fulfill({ json: flatStyle(colour) });
      });
    }
    await mockApi(page, { config: { mapStyleLight: "/map-style-light.json", mapStyleDark: "/map-style-dark.json" } });
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/day/2026-10-22");
    await expect(map(page)).toHaveAttribute("data-map-state", "ready");
    await expect.poll(() => showsColour(page, LIGHT), PIXEL_POLL).toBe(true);
    expect(asked).toEqual(["light"]);

    await page.emulateMedia({ colorScheme: "dark" }); // the map follows, with no reload of the page
    await expect.poll(() => asked).toEqual(["light", "dark"]);
    await expect(map(page)).toHaveAttribute("data-map-state", "ready");
    await expect.poll(() => showsColour(page, DARK), PIXEL_POLL).toBe(true);

    await page.emulateMedia({ colorScheme: "light" });
    await expect.poll(() => asked).toEqual(["light", "dark", "light"]);
    await expect(map(page)).toHaveAttribute("data-map-state", "ready");
    await expect.poll(() => showsColour(page, LIGHT), PIXEL_POLL).toBe(true);
  });
});

// Review Focus 4: the map style cannot be had. The rest of the page goes on, the map stays, and the app is told.
const BROKEN_STYLES = [
  ["a_response_that_is_not_json", () => ({ status: 200, contentType: "application/json", body: "<html>blocked</html>" })],
  ["a_style_that_MapLibre_refuses", () => ({ json: { version: 8, sources: {}, layers: [{ id: "x", type: "nonsense" }] } })],
] as const;

for (const [name, response] of BROKEN_STYLES) {
  test(`map_survives_${name}`, async ({ page }) => {
    await page.route("**/map-style-broken.json", (route) => route.fulfill(response()));
    await mockApi(page, { config: { mapStyleLight: "/map-style-broken.json", mapStyleDark: "/map-style-broken.json" } });

    await page.goto("/day/2026-10-22");

    await expect(page.getByRole("status")).toHaveText("Map unavailable — Retry");
    await expect(map(page)).toHaveAttribute("data-map-state", "unavailable");
    await expect(map(page).locator("canvas.maplibregl-canvas")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Thursday 22 October" })).toBeVisible(); // the rest of the page goes on
    await expect(page.getByText("No data for this day")).toBeVisible(); // the rest of the app has its data
    await expect(map(page).getByRole("button", { name: "Recenter map" })).toBeVisible();
  });
}

// A network blip, or a VPN that is still connecting when the app is opened from the home screen (which has no reload button): the style
// cannot be had the first time. The note has a Retry, and the map is the real one once the style comes.
test.describe("a style that cannot be had the first time", () => {
  test.use({ deviceScaleFactor: 1 });

  test("map_comes_up_when_Retry_is_pressed_after_the_style_request_failed", async ({ page }) => {
    test.setTimeout(30_000 + PIXEL_POLL.timeout);
    let asked = 0;
    await page.route("**/map-style-flaky.json", (route) => {
      asked += 1;
      return asked === 1
        ? route.fulfill({ status: 200, contentType: "application/json", body: "<html>blocked</html>" }) // what a captive network answers with
        : route.fulfill({ json: flatStyle("#dfe6ea") });
    });
    await mockApi(page, { config: { mapStyleLight: "/map-style-flaky.json", mapStyleDark: "/map-style-flaky.json" } });
    await page.goto("/day/2026-10-22");
    const note = page.getByRole("status").filter({ hasText: "Map unavailable" });
    await expect(note).toBeVisible();
    await expect(map(page)).toHaveAttribute("data-map-state", "unavailable");
    expect(asked).toBe(1); // it does not try again by itself

    await note.getByRole("button", { name: "Retry" }).click();

    await expect(map(page)).toHaveAttribute("data-map-state", "ready");
    await expect(note).toHaveCount(0); // the note goes when the style has loaded
    expect(asked).toBe(2);
    await expect.poll(() => showsColour(page, LIGHT), PIXEL_POLL).toBe(true); // the style that came, and not the plain one it had meanwhile
  });
});
