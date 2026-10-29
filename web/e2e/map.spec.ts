import type { Page } from "@playwright/test";
import { expect, test } from "./base";
import { openCredit } from "./credit";
import { mockApi } from "./mockApi";
import { PIXEL_POLL, pixelAt, sameColour, type Rgb } from "./pixel";

// The real MapLibre, on software WebGL, with a style that has nothing but a background: no tile, font or sprite is asked for,
// so no request leaves the machine (base.ts fails a test that makes one).

const map = (page: Page) => page.getByRole("region", { name: "Map view" });

const isWide = (page: Page): boolean => page.viewportSize()!.width >= 900;

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
  // Compact: the credit folds away behind a button (see the test below), but it is there, and open, when the map first appears.
  await expect(map(page).locator(".maplibregl-ctrl-attrib")).toHaveClass(/maplibregl-compact-show/);
  await expect(map(page).locator(".maplibregl-ctrl-attrib")).toContainText("OpenStreetMap");
  await expect(map(page).getByRole("link", { name: "OpenStreetMap" })).toBeVisible();
  await expect(map(page).locator(".maplibregl-ctrl-attrib-button")).toBeVisible();
  await expect(map(page).getByRole("button", { name: "Recenter map" })).toBeDisabled(); // nothing on the map to go back to
});

// The credit stays (the OpenStreetMap licence asks for it) but is not to stand out: small text on a faint background when it is open, which it
// is when the map appears, and a button (ⓘ) once it has folded, by itself after five seconds or at the first tap on the map. The suite fakes
// the date and nothing else (see fixTime), so the five seconds are waited for. The unit tests have the rest: the first zoom or tap, the
// moves of the app's own, the timer.
test("map_folds_its_credit_to_the_info_button_by_itself_and_the_button_shows_it_again", async ({ page }) => {
  await mockApi(page);
  await page.goto("/day/2026-10-22");
  await expect(map(page)).toHaveAttribute("data-map-state", "ready");
  const credit = map(page).locator(".maplibregl-ctrl-attrib");
  const button = credit.locator(".maplibregl-ctrl-attrib-button");
  const link = map(page).getByRole("link", { name: "OpenStreetMap" });
  await expect(credit).toHaveClass(/maplibregl-compact-show/);
  await expect(link).toBeVisible();

  await expect(link).toBeHidden({ timeout: 7_000 }); // folded, with no touch of the map
  await expect(credit).not.toHaveClass(/maplibregl-compact-show/);
  await expect(button).toBeVisible();
  const folded = (await button.boundingBox())!;
  expect(folded.width).toBeGreaterThanOrEqual(24); // a button to tap
  expect(folded.height).toBeGreaterThanOrEqual(24);

  await button.click();

  await expect(credit).toHaveClass(/maplibregl-compact-show/);
  await expect(link).toBeVisible();
  await expect(credit).toContainText("OpenStreetMap");
});

test.describe("the credit when it is open", () => {
  for (const [scheme, background] of [["light", "rgba(255, 255, 255, 0.5)"], ["dark", "rgba(44, 44, 46, 0.65)"]] as const) {
    test(`map_credit_is_small_and_faint_in_the_${scheme}_scheme`, async ({ page }) => {
      await mockApi(page);
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto("/day/2026-10-22");
      await expect(map(page)).toHaveAttribute("data-map-state", "ready");
      await openCredit(page); // open and steady, whatever the time that this takes (it folds by itself five seconds after the map appears)
      const credit = map(page).locator(".maplibregl-ctrl-attrib");

      await expect(credit).toHaveClass(/maplibregl-compact-show/);
      await expect(map(page).getByRole("link", { name: "OpenStreetMap" })).toBeVisible(); // open, with its text: not the folded circle
      await expect(credit).toHaveCSS("font-size", "10px");
      await expect(credit).toHaveCSS("background-color", background);
      await expect(credit).toHaveCSS("backdrop-filter", "blur(8px)"); // what is under the small text is blurred
      const box = (await credit.boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(24); // not lower than its ⓘ button, which is at its corner
      expect(box.height).toBeLessThan(30); // one line, as the style of the tests credits only OpenStreetMap: a strip, not a box
      expect(box.width).toBeGreaterThan(3 * box.height); // and a strip is wide: the folded button is a circle of 24px
      const button = (await credit.locator(".maplibregl-ctrl-attrib-button").boundingBox())!;
      expect(button.width).toBeGreaterThanOrEqual(24);
      expect(button.height).toBeGreaterThanOrEqual(24);
    });
  }
});

// Ruling P2-R17: what covers the map (the bottom sheet on a phone, the sidebar on a desktop) must not cover the credit. The component
// hands its `padding` to the style sheet as `--map-padding-*` on the map's element (a unit test pins that); this is the other half,
// that the style sheet sets MapLibre's controls and the buttons in by them, in the browser, where the corners are real.
test("map_sets_attribution_and_buttons_inside_the_padding", async ({ page }) => {
  await mockApi(page);
  await page.goto("/day/2026-10-22");
  await expect(map(page)).toHaveAttribute("data-map-state", "ready");
  await openCredit(page); // the open credit is what is measured (it folds by itself five seconds after the map appears)
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

// The system goes dark while the network is down: the style of the dark scheme cannot be had. The map that works stays on screen (it is
// not swapped for a blank one), the note says that only the switch failed, and Retry brings the dark style.
test.describe("a switch of the colour scheme that fails", () => {
  test.use({ deviceScaleFactor: 1 });

  test("map_keeps_its_style_and_says_the_switch_failed_until_Retry_brings_the_other_one", async ({ page }) => {
    test.setTimeout(30_000 + 3 * PIXEL_POLL.timeout);
    let darkAsked = 0;
    await page.route("**/map-style-light.json", (route) => route.fulfill({ json: flatStyle("#dfe6ea") }));
    await page.route("**/map-style-dark.json", (route) => {
      darkAsked += 1;
      return darkAsked === 1
        ? route.fulfill({ status: 200, contentType: "application/json", body: "<html>blocked</html>" })
        : route.fulfill({ json: flatStyle("#1b2733") });
    });
    await mockApi(page, { config: { mapStyleLight: "/map-style-light.json", mapStyleDark: "/map-style-dark.json" } });
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/day/2026-10-22");
    await expect(map(page)).toHaveAttribute("data-map-state", "ready");
    await expect.poll(() => showsColour(page, LIGHT), PIXEL_POLL).toBe(true);

    await page.emulateMedia({ colorScheme: "dark" });

    const note = page.getByRole("status").filter({ hasText: "Couldn't switch the map style" });
    await expect(note).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: "Map unavailable" })).toHaveCount(0); // there is a basemap
    await expect(map(page)).toHaveAttribute("data-map-state", "unavailable");
    expect(darkAsked).toBe(1); // it does not try again by itself
    await expect.poll(() => showsColour(page, LIGHT), PIXEL_POLL).toBe(true); // the map that worked is still what is drawn

    await note.getByRole("button", { name: "Retry" }).click();

    await expect(map(page)).toHaveAttribute("data-map-state", "ready");
    await expect(note).toHaveCount(0);
    expect(darkAsked).toBe(2);
    await expect.poll(() => showsColour(page, DARK), PIXEL_POLL).toBe(true);
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

    await expect(page.getByRole("status").filter({ hasText: "Map unavailable" })).toHaveText("Map unavailable — Retry"); // the toast's status is there too, and says nothing
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

    // The credit is on the blank map too. A tap on it must not start the fold of the credit of the map that Retry brings: it is open when that appears.
    const credit = map(page).locator(".maplibregl-ctrl-attrib");
    await expect(credit).toHaveClass(/maplibregl-compact-show/);
    const [x, y] = await centre(page);
    await page.mouse.click(x, y);
    await page.waitForTimeout(500); // a fold, if there were one, is made by the tap at once
    await expect(credit).toHaveClass(/maplibregl-compact-show/);
    // A drag of the blank map folds it, as it does on any map, and MapLibre never opens it again: it is opened for the map that Retry brings.
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 60, y + 40, { steps: 5 });
    await page.mouse.up();
    await expect(credit).not.toHaveClass(/maplibregl-compact-show/);
    // ⓘ opens it and closes it again (it takes the `open` of the <details> with it, and a closed <details> draws nothing): Retry opens it for the real map.
    const info = credit.locator(".maplibregl-ctrl-attrib-button");
    await info.click();
    await expect(credit).toHaveClass(/maplibregl-compact-show/);
    await info.click();
    await expect(credit).not.toHaveClass(/maplibregl-compact-show/);
    await expect(credit).not.toHaveAttribute("open");

    await note.getByRole("button", { name: "Retry" }).click();

    await expect(map(page)).toHaveAttribute("data-map-state", "ready");
    await expect(note).toHaveCount(0); // the note goes when the style has loaded
    expect(asked).toBe(2);
    await expect(credit).toHaveClass(/maplibregl-compact-show/);
    await expect(map(page).getByRole("link", { name: "OpenStreetMap" })).toBeVisible();
    await expect.poll(() => showsColour(page, LIGHT), PIXEL_POLL).toBe(true); // the style that came, and not the plain one it had meanwhile
  });
});

// A style of the old kind writes its labels as functions of the zoom, which `toEnglishLabels` turns into expressions (a unit test pins
// what they are). MapLibre has the last word on whether it takes them: it refuses a style with an expression that does not parse, and
// the map would then say it is unavailable.
test("map_takes_a_style_whose_labels_were_legacy_functions", async ({ page }) => {
  const nothing = { type: "geojson", data: { type: "FeatureCollection", features: [] } };
  const label = (id: string, textField: unknown) => ({ id, type: "symbol", source: "places", layout: { "text-field": textField, "text-font": ["Noto Sans Regular"] } });
  await page.route("**/map-style-legacy.json", (route) =>
    route.fulfill({
      json: {
        version: 8,
        glyphs: "/glyphs/{fontstack}/{range}.pbf", // never asked for: there is nothing to label
        sources: { places: nothing },
        layers: [
          { id: "background", type: "background", paint: { "background-color": "#dfe6ea" } },
          label("zoomed", { base: 1.2, stops: [[0, ""], [6, "{name}"], [10, "{name:latin}\n{name:nonlatin}"], [14, "{ref}"]] }),
          label("by-property", { property: "rank", type: "interval", stops: [[1, "{name}"], [5, "{name:latin}"]] }),
          label("identity", { property: "name", type: "identity" }),
          label("plain", "{name_int}"),
        ],
      },
    }),
  );
  await mockApi(page, { config: { mapStyleLight: "/map-style-legacy.json", mapStyleDark: "/map-style-legacy.json" } });

  await page.goto("/day/2026-10-22");

  await expect(map(page)).toHaveAttribute("data-map-state", "ready");
  await expect(page.getByRole("status").filter({ hasText: "Map unavailable" })).toHaveCount(0);
});

// A phone on its side has the Dynamic Island at one of its sides, and the page is drawn under it (viewport-fit=cover). The shell pads the
// map by it, so the map's buttons, its credit and what it is brought to are clear of it. `--safe-left` and `--safe-right` are `env()`,
// which a desktop browser has none of: they are injected, and the page told that its window changed, as a turned phone does.
test("map_keeps_its_buttons_and_credit_clear_of_the_side_the_device_keeps", async ({ page }) => {
  await mockApi(page);
  await page.goto("/day/2026-10-22");
  await expect(map(page)).toHaveAttribute("data-map-state", "ready");
  await openCredit(page); // the open credit is what is measured (it folds by itself five seconds after the map appears)
  const area = (await map(page).boundingBox())!;
  const recenter = map(page).getByRole("button", { name: "Recenter map" });
  const credit = map(page).locator(".maplibregl-ctrl-attrib");
  const rightEdges = async () => ({
    button: area.x + area.width - ((await recenter.boundingBox())!.x + (await recenter.boundingBox())!.width),
    credit: area.x + area.width - ((await credit.boundingBox())!.x + (await credit.boundingBox())!.width),
  });
  const padding = (side: string) => map(page).evaluate((element, name) => parseFloat(element.style.getPropertyValue(`--map-padding-${name}`)), side);
  const before = await rightEdges();
  const [leftBefore, rightBefore] = [await padding("left"), await padding("right")];

  await page.addStyleTag({ content: ":root { --safe-left: 44px; --safe-right: 59px; }" });
  await page.evaluate(() => window.dispatchEvent(new Event("resize")));

  await expect.poll(() => padding("right")).toBe(rightBefore + 59);
  const after = await rightEdges();
  expect(after.button - before.button).toBeCloseTo(59, 0);
  expect(after.credit - before.credit).toBeCloseTo(59, 0);
  await expect(map(page).getByRole("link", { name: "OpenStreetMap" })).toBeVisible();
  // The side that is the sidebar's on a wide window has the inset inside the sidebar's own width, and is not padded again.
  expect(await padding("left")).toBe(isWide(page) ? leftBefore : leftBefore + 44);
});
