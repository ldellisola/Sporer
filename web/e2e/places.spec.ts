import type { Locator, Page } from "@playwright/test";
import type { PlaceResponse, PlacesResponse } from "../src/api/types";
import { expect, test } from "./base";
import { fitOf, LABEL_AIR, type LonLat } from "./fit";
import cafe from "./fixtures/place-cafe.json" with { type: "json" };
import { mockApi, type Reply } from "./mockApi";
import { PIXEL_POLL, pixelAt, sameColour, type Rgb } from "./pixel";
import { sheetAtRest } from "./sheet";
import { fixTime } from "./today";

// The places on the map, and merge mode, which picks them there. One pixel to a CSS pixel, also on the phone: what is read is the colour of a dot.
test.use({ timezoneId: "Asia/Tokyo", deviceScaleFactor: 1 });

const isWide = (page: Page): boolean => page.viewportSize()!.width >= 900;
const details = (page: Page): Locator => page.getByRole(isWide(page) ? "complementary" : "region", { name: "Details" });
const grip = (page: Page): Locator => page.getByRole("button", { name: "Resize panel" });
const map = (page: Page): Locator => page.getByRole("region", { name: "Map view" });

/** On a phone the sheet starts at its peek: bring it up to full, where all of the panel can be read and reached. */
async function openSheet(page: Page): Promise<void> {
  if (isWide(page)) return;
  for (let i = 0; i < 2 && (await details(page).getAttribute("data-snap")) !== "full"; i++) await grip(page).click();
  await expect(details(page)).toHaveAttribute("data-snap", "full");
  await sheetAtRest(page);
}

/** A tap on the page: the finger on a phone, the mouse on a desktop. */
async function tap(page: Page, at: { x: number; y: number }): Promise<void> {
  if (isWide(page)) await page.mouse.click(at.x, at.y);
  else await page.touchscreen.tap(at.x, at.y);
}

const PIN: Rgb = [0xff, 0x37, 0x5f]; // a place's dot, and the pin of the place on show
const PICKED: Rgb = [0x0a, 0x84, 0xff]; // a place picked to be merged

/** The Café of the fixture (place 2), and two places some fifty metres from it, to either side: as the map draws them, a street apart. */
const CAFE = cafe as PlaceResponse;
const CAFE_AT: LonLat = [10.764, 59.914];
const BISTRO_AT: LonLat = [10.7647, 59.9143];
const BAKERY_AT: LonLat = [10.7633, 59.9137];
const PLACES: PlacesResponse = {
  places: [
    { id: 2, name: "Café", lon: CAFE_AT[0], lat: CAFE_AT[1], seconds: 8640, visits: 3 },
    { id: 7, name: "Bistro", lon: BISTRO_AT[0], lat: BISTRO_AT[1], seconds: 4000, visits: 3 },
    { id: 8, name: "Bakery", lon: BAKERY_AT[0], lat: BAKERY_AT[1], seconds: 3000, visits: 2 },
  ],
};

/** Waits until the pixel at `at` is `colour`: how it is known that the dot is drawn as it is to be, and that the camera has come to rest. */
async function expectColour(page: Page, at: { x: number; y: number }, colour: Rgb): Promise<void> {
  await expect.poll(async () => sameColour(await pixelAt(page, at.x, at.y), colour, 30), PIXEL_POLL).toBe(true);
}

test("places_view_shows_every_place_on_the_map_and_a_tap_on_a_dot_opens_its_place", async ({ page }) => {
  test.setTimeout(30_000 + PIXEL_POLL.timeout);
  await fixTime(page, "2026-12-01T12:00:00Z");
  await mockApi(page, {
    places: PLACES,
    "places/search": [
      { id: 2, name: "Café", address: "Storgata 12, Oslo", visits: 3 },
      { id: 7, name: "Bistro", address: null, visits: 3 },
    ],
    "places/7": { ...CAFE, id: 7, name: "Bistro", lat: BISTRO_AT[1], lon: BISTRO_AT[0] },
  });
  await page.goto("/day/2026-10-22");
  await page.getByRole("button", { name: "Places" }).click();

  await expect(page).toHaveURL(/\/places$/);
  await expect(page.getByRole("heading", { level: 1, name: "Places" })).toBeVisible();
  await expect(map(page)).toHaveAttribute("data-map-state", "ready");
  await sheetAtRest(page);
  // Every place is a dot, and the map is brought to all of them (they are named, so the fit leaves the air of the labels).
  const project = await fitOf(page, [CAFE_AT, BISTRO_AT, BAKERY_AT], LABEL_AIR);
  for (const at of [CAFE_AT, BISTRO_AT, BAKERY_AT]) await expectColour(page, project(at), PIN);
  await openSheet(page);
  await expect(details(page).getByRole("button", { name: /^Bistro/ })).toBeVisible(); // and the list of them, to search
  if (!isWide(page)) {
    await grip(page).click(); // full to peek, as the sheet goes round: the map is the page again, and is where it was
    await sheetAtRest(page);
  }

  await tap(page, project(BISTRO_AT));

  await expect(page).toHaveURL(/\/place\/7$/);
  await expect(details(page).getByRole("heading", { level: 1, name: "Bistro" })).toBeVisible();
});

test("merge_mode_picks_the_places_tapped_on_the_map_and_merges_them_all_at_once", { tag: "@smoke" }, async ({ page }) => {
  test.setTimeout(45_000 + 2 * PIXEL_POLL.timeout);
  await fixTime(page, "2026-12-01T12:00:00Z");
  let merged: { id: number; name: string | null }[] = [];
  const api = await mockApi(page, {
    places: PLACES,
    "places/2": (): Reply => ({ json: { ...CAFE, merged } }),
    "places/2/candidates": [],
    "POST places/2/merge": (request): Reply => {
      const { places } = request.postDataJSON() as { places: number[] };
      merged = PLACES.places.filter((place) => places.includes(place.id)).map(({ id, name }) => ({ id, name })).sort((a, b) => a.name!.localeCompare(b.name!));
      return { json: { ...CAFE, visits: 8, merged } };
    },
  });
  await page.goto("/place/2");
  await expect(map(page)).toHaveAttribute("data-map-state", "ready");
  await openSheet(page);

  await details(page).getByRole("button", { name: "Merge with…" }).click();

  // The sheet comes down to half, for the map. Recenter brings the place back to the middle of what is free now, where the places round it are tapped.
  await sheetAtRest(page);
  if (!isWide(page)) await expect(details(page)).toHaveAttribute("data-snap", "half");
  await map(page).getByRole("button", { name: "Recenter map" }).click();
  const project = await fitOf(page, [CAFE_AT], LABEL_AIR);
  await expectColour(page, project(CAFE_AT), PIN);
  await expectColour(page, project(BISTRO_AT), PIN);

  await tap(page, project(BISTRO_AT));
  await expect(details(page).getByText("Merge 1 place into Café?")).toBeVisible();
  await expectColour(page, project(BISTRO_AT), PICKED); // a tap picks it, and does not open it
  await tap(page, project(BAKERY_AT));
  await tap(page, project(CAFE_AT)); // the place itself: it is the one they go into
  await expect(page).toHaveURL(/\/place\/2$/);
  await expectColour(page, project(BAKERY_AT), PICKED);
  await expect(details(page).getByText("Merge 2 places into Café?")).toBeVisible();

  await openSheet(page);
  await expect(details(page).getByRole("list", { name: "Places to merge" }).getByRole("listitem")).toHaveText(
    [/^Bistro · \d+ m\s*Remove$/, /^Bakery · \d+ m\s*Remove$/],
    { useInnerText: true },
  );
  await details(page).getByRole("button", { name: "Merge", exact: true }).click();

  const mergedIn = details(page).getByRole("region", { name: "Merged places" });
  await expect(mergedIn.getByRole("listitem")).toHaveText(["Bakery Separate", "Bistro Separate"], { useInnerText: true });
  expect(api.writes).toEqual([{ method: "POST", path: "/api/places/2/merge", contentType: "application/json", body: { places: [7, 8], name: "Café" } }]);
  await expect(details(page).getByRole("button", { name: "Merge with…" })).toBeFocused();
});
