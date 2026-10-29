import type { Locator, Page, Request } from "@playwright/test";
import type { DayResponse, PlaceCandidate, PlaceResponse } from "../src/api/types";
import { expect, test } from "./base";
import osloDay from "./fixtures/day-oslo-new-york.json" with { type: "json" };
import cafe from "./fixtures/place-cafe.json" with { type: "json" };
import { mockApi, type Overrides, type Reply } from "./mockApi";
import { sheetAtRest } from "./sheet";
import { fixTime } from "./today";

// The browser is in Tokyo, which the places are not in. One pixel to a CSS pixel, also on the phone: nothing here is about density.
test.use({ timezoneId: "Asia/Tokyo", deviceScaleFactor: 1 });

/** Fixes the date of "today" (the 1st of December in Tokyo, where the browser is), which no date of the fixtures is. */
const fixToday = (page: Page): Promise<void> => fixTime(page, "2026-12-01T12:00:00Z");

const isWide = (page: Page): boolean => page.viewportSize()!.width >= 900;
const details = (page: Page): Locator => page.getByRole(isWide(page) ? "complementary" : "region", { name: "Details" });
const grip = (page: Page): Locator => page.getByRole("button", { name: "Resize panel" });
const map = (page: Page): Locator => page.getByRole("region", { name: "Map view" });
const back = (page: Page): Locator => details(page).getByRole("button", { name: "Back" });

/** On a phone the sheet starts at its peek: bring it up to full, where all of the panel can be read and reached. */
async function openSheet(page: Page): Promise<void> {
  if (isWide(page)) return;
  for (let i = 0; i < 2 && (await details(page).getAttribute("data-snap")) !== "full"; i++) await grip(page).click();
  await expect(details(page)).toHaveAttribute("data-snap", "full");
  await sheetAtRest(page);
}

/** The café of the fixture (the place 2) and the places around it. Every one is in the day of the 22nd: the Office is its third stay. */
const CAFE = cafe as PlaceResponse;
const OFFICE_VISITS = 5;
const OFFICE_SECONDS = 9_000;
const BAKERY: PlaceCandidate = { id: 6, name: "Bakery", address: "Storgata 20, Oslo", distanceM: 90, visits: 1 };
const OFFICE: PlaceCandidate = { id: 3, name: "Office", address: "Karl Johans gate 1, Oslo", distanceM: 310, visits: OFFICE_VISITS };

/**
 * A server that keeps what was written to it, so that the place and the day read it back as the real one would: the café, which is the place
 * 2 and that the owner renames, the Office and the Bakery, which are merged into it and separated from it again (`mergedIn` are the ones that
 * are to begin with), and what each is called in the day.
 */
function placeServer(mergedIn: number[] = []): {
  overrides: Overrides;
  mergedIn: () => number[];
  rename: (request: Request) => Reply;
  /** The server has the place merged no more, whatever the page thinks: what a 404 on a separate says. */
  forget: (id: number) => void;
} {
  let cafeName: string | null = CAFE.name;
  const around = [BAKERY, OFFICE];

  const detail = (): PlaceResponse => ({
    ...CAFE,
    name: cafeName,
    visits: CAFE.visits + (mergedIn.includes(OFFICE.id) ? OFFICE_VISITS : 0),
    totalSeconds: CAFE.totalSeconds + (mergedIn.includes(OFFICE.id) ? OFFICE_SECONDS : 0),
    merged: around.filter((place) => mergedIn.includes(place.id)).map((place) => ({ id: place.id, name: place.name })), // by name, as the server has them
  });

  // The day, as the server serves it: a stay at a place that was merged is at the one it was merged into.
  const day = (): DayResponse => {
    const served = osloDay as unknown as DayResponse;
    return {
      ...served,
      segments: served.segments.map((segment) => {
        if (segment.kind !== "stay" || segment.place === null) return segment;
        const id = mergedIn.includes(segment.place.id) ? 2 : segment.place.id;
        return id === 2 ? { ...segment, place: { ...segment.place, id, name: cafeName } } : segment;
      }),
    };
  };

  const rename = (request: Request): Reply => {
    cafeName = (request.postDataJSON() as { name: string | null }).name ?? CAFE.name;
    return { json: detail() };
  };

  const overrides: Overrides = {
    "day/2026-10-22": (): Reply => ({ json: day() }),
    "places/2": (): Reply => ({ json: detail() }),
    "places/2/candidates": (request): Reply => {
      const q = new URL(request.url()).searchParams.get("q")?.toLowerCase() ?? "";
      const found = around
        .filter((place) => !mergedIn.includes(place.id)) // a place that is merged in is no candidate
        .filter((place) => q === "" || [place.name, place.address].some((part) => part?.toLowerCase().includes(q)));
      return { json: found };
    },
    "PUT places/2/name": rename,
    "POST places/2/merge": (request): Reply => {
      const { place, name } = request.postDataJSON() as { place: number; name: string | null };
      mergedIn = [...mergedIn, place];
      if (name !== null) cafeName = name;
      return { json: detail() };
    },
    "DELETE places/2/merged/*": (request): Reply => {
      const other = Number(new URL(request.url()).pathname.split("/").pop());
      mergedIn = mergedIn.filter((id) => id !== other);
      return { status: 204 };
    },
  };
  return { overrides, mergedIn: () => mergedIn, rename, forget: (id) => (mergedIn = mergedIn.filter((merged) => merged !== id)) };
}

/** The stays of the day that are at the café (by the name it has now): as many buttons of that name, each opening the place. */
const staysAt = (page: Page, name: string): Locator => details(page).getByRole("button", { name, exact: true });

/** Opens the day of the 22nd with the sheet up, and from it the place of the café (the name of a stay is a button). */
async function openTheCafeFromTheDay(page: Page, name: string): Promise<void> {
  await expect(map(page)).toHaveAttribute("data-map-state", "ready");
  await openSheet(page);
  await staysAt(page, name).first().click();
  await expect(page).toHaveURL(/\/place\/2$/);
  await expect(details(page).getByRole("heading", { level: 1, name })).toBeVisible();
  await sheetAtRest(page);
}

test("rename_a_place_then_merge_another_into_it_and_both_show_in_the_place_and_the_day", { tag: "@smoke" }, async ({ page }) => {
  await fixToday(page);
  const server = placeServer();
  const api = await mockApi(page, server.overrides);
  await page.goto("/day/2026-10-22");
  await openTheCafeFromTheDay(page, "Café");

  // Rename: the field has the name that is shown, and what is saved is the place's name from then on, in the place and in the day.
  await details(page).getByRole("button", { name: "Rename" }).click();
  const field = details(page).getByRole("textbox", { name: "Name" });
  await expect(field).toHaveValue("Café");
  await expect(field).toBeFocused();
  await field.fill("  Corner Café ");
  await details(page).getByRole("button", { name: "Save" }).click();

  await expect(details(page).getByRole("heading", { level: 1, name: "Corner Café" })).toBeVisible();
  await expect(field).toHaveCount(0);
  expect(api.writes).toEqual([{ method: "PUT", path: "/api/places/2/name", contentType: "application/json", body: { name: "Corner Café" } }]);

  await back(page).click();
  await expect(page).toHaveURL(/\/day\/2026-10-22$/);
  await sheetAtRest(page, staysAt(page, "Corner Café")); // the day comes back, asked for again, with the new name, and the sheet moves with it
  await expect(staysAt(page, "Corner Café")).toHaveCount(1);
  await expect(staysAt(page, "Café")).toHaveCount(0);
  await expect(staysAt(page, "Office")).toHaveCount(1);

  // Merge: search for the Office, pick it, and keep the name of this place.
  await staysAt(page, "Corner Café").click();
  await expect(page).toHaveURL(/\/place\/2$/);
  await sheetAtRest(page);
  await details(page).getByRole("button", { name: "Merge with…" }).click();
  const search = details(page).getByRole("searchbox", { name: "Search places" });
  await expect(search).toBeFocused();
  await expect(details(page).getByRole("list", { name: "Places" }).getByRole("listitem")).toHaveText(
    ["Bakery Storgata 20, Oslo 90 m 1 visit", "Office Karl Johans gate 1, Oslo 310 m 5 visits"], // the nearest first
    { useInnerText: true },
  );
  await search.fill("off");
  await expect(details(page).getByRole("list", { name: "Places" }).getByRole("listitem")).toHaveText(["Office Karl Johans gate 1, Oslo 310 m 5 visits"], {
    useInnerText: true,
  });
  await details(page).getByRole("button", { name: "Office, Karl Johans gate 1, Oslo, 310 m, 5 visits" }).click();

  await expect(details(page).getByText("Merge Office into Corner Café?")).toBeVisible();
  const keep = details(page).getByRole("group", { name: "Name to keep" });
  await expect(keep.getByRole("radio", { name: "Corner Café" })).toBeChecked();
  await details(page).getByRole("button", { name: "Merge", exact: true }).click();

  // The place: the Office is among the places merged in, and what was spent there is added to the café's.
  const merged = details(page).getByRole("region", { name: "Merged places" });
  await expect(merged.getByRole("listitem")).toHaveText(["Office Separate"], { useInnerText: true });
  await expect(details(page).locator("dl > div")).toHaveText(
    ["Total time 4h 54m", "Visits 8", "First visit Tue 29 Sep 2026", "Last visit Thu 22 Oct 2026"],
    { useInnerText: true },
  );
  await expect(details(page).getByRole("heading", { level: 1, name: "Corner Café" })).toBeVisible();
  expect(api.writes.at(-1)).toEqual({ method: "POST", path: "/api/places/2/merge", contentType: "application/json", body: { place: 3, name: "Corner Café" } });

  // The day: both of its stays are at the one place now.
  await back(page).click();
  await expect(page).toHaveURL(/\/day\/2026-10-22$/);
  await sheetAtRest(page, staysAt(page, "Corner Café").first());
  await expect(staysAt(page, "Corner Café")).toHaveCount(2);
  await expect(staysAt(page, "Office")).toHaveCount(0);
  expect(server.mergedIn()).toEqual([3]);
});

test("separate_gives_a_merged_place_back_its_name_in_the_place_and_the_day", async ({ page }) => {
  await fixToday(page);
  const server = placeServer();
  const api = await mockApi(page, server.overrides);
  await page.goto("/day/2026-10-22");
  await openTheCafeFromTheDay(page, "Café");
  await details(page).getByRole("button", { name: "Merge with…" }).click();
  await details(page).getByRole("button", { name: /^Office/ }).click();
  await details(page).getByRole("button", { name: "Merge", exact: true }).click();
  const merged = details(page).getByRole("region", { name: "Merged places" });
  await expect(merged.getByRole("listitem")).toHaveText(["Office Separate"], { useInnerText: true });

  await merged.getByRole("button", { name: "Separate Office" }).click();

  await expect(details(page).getByRole("heading", { level: 2, name: "Merged places" })).toHaveCount(0);
  await expect(details(page).locator("dl > div").nth(1)).toHaveText("Visits 3", { useInnerText: true }); // the café's own again
  expect(api.writes.at(-1)).toEqual({ method: "DELETE", path: "/api/places/2/merged/3", contentType: "application/json", body: null });
  await back(page).click();
  await sheetAtRest(page, staysAt(page, "Office"));
  await expect(staysAt(page, "Office")).toHaveCount(1);
  await expect(staysAt(page, "Café")).toHaveCount(1);
});

test("rename_cancel_and_escape_close_the_field_and_write_nothing", async ({ page }) => {
  await fixToday(page);
  const api = await mockApi(page, placeServer().overrides);
  await page.goto("/place/2");
  await expect(map(page)).toHaveAttribute("data-map-state", "ready");
  await openSheet(page);

  await details(page).getByRole("button", { name: "Rename" }).click();
  await details(page).getByRole("textbox", { name: "Name" }).fill("Something else");
  await details(page).getByRole("button", { name: "Cancel" }).click();
  await expect(details(page).getByRole("textbox")).toHaveCount(0);
  await expect(details(page).getByRole("heading", { level: 1, name: "Café" })).toBeVisible();

  await details(page).getByRole("button", { name: "Rename" }).click();
  await details(page).getByRole("textbox", { name: "Name" }).press("Escape");

  await expect(details(page).getByRole("textbox")).toHaveCount(0);
  expect(api.writes).toEqual([]);
});

test("rename_that_fails_says_so_with_a_retry_that_sends_it_again", async ({ page }) => {
  await fixToday(page);
  const server = placeServer();
  let answers = 0;
  const api = await mockApi(page, {
    ...server.overrides,
    "PUT places/2/name": (request): Reply => (++answers === 1 ? { status: 500, json: { title: "Internal Server Error" } } : server.rename(request)),
  });
  await page.goto("/place/2");
  await openSheet(page);
  await details(page).getByRole("button", { name: "Rename" }).click();
  await details(page).getByRole("textbox", { name: "Name" }).fill("Corner Café");

  await details(page).getByRole("button", { name: "Save" }).click();

  const alert = details(page).getByRole("alert");
  await expect(alert).toContainText("Couldn't rename");
  await expect(alert).toContainText("PUT /api/places/2/name failed with status 500");
  await expect(details(page).getByRole("textbox", { name: "Name" })).toHaveValue("Corner Café"); // the form and what was typed are still there
  await expect(details(page).getByRole("heading", { level: 1, name: "Café" })).toBeVisible();

  await alert.getByRole("button", { name: "Retry" }).click();

  await expect(details(page).getByRole("heading", { level: 1, name: "Corner Café" })).toBeVisible();
  await expect(alert).toHaveCount(0);
  expect(api.writes.map((write) => write.body)).toEqual([{ name: "Corner Café" }, { name: "Corner Café" }]);
});

test("merge_that_the_server_refuses_with_a_409_says_it_in_the_words_of_the_server_with_no_retry_and_goes_back_to_the_picker", async ({ page }) => {
  await fixToday(page);
  const server = placeServer();
  const SAME_PLACE = "The place is the one it is to be merged into, or is merged into it already.";
  const TOO_DEEP = "The place has places merged into it that are 32 merges deep already: one more would be more than the 32 that can be followed.";
  let message: string | null = SAME_PLACE;
  const api = await mockApi(page, {
    ...server.overrides,
    "POST places/2/merge": (): Reply => ({
      status: 409,
      json: { statusCode: 409, message: "One or more errors occurred!", errors: message === null ? {} : { place: [message] } },
    }),
  });
  await page.goto("/place/2");
  await openSheet(page);
  await details(page).getByRole("button", { name: "Merge with…" }).click();
  await details(page).getByRole("button", { name: /^Office/ }).click();

  await details(page).getByRole("button", { name: "Merge", exact: true }).click();

  // Whatever the server says is what is shown; the page does not read it to choose a message of its own. The same merge would be refused again: no Retry.
  const alert = details(page).getByRole("alert");
  await expect(alert).toContainText("Could not merge");
  await expect(alert).toContainText(SAME_PLACE);
  await expect(alert.getByRole("button", { name: "Retry" })).toHaveCount(0);
  await expect(details(page).getByRole("button", { name: "Retry" })).toHaveCount(0);
  await expect(details(page).getByRole("button", { name: "Merge", exact: true })).toBeDisabled();
  await expect(details(page).getByText("Merge Office into Café?")).toBeVisible();

  // Another place can be chosen, and what it is refused with is said in the server's words too.
  message = TOO_DEEP;
  await alert.getByRole("button", { name: "Choose another place" }).click();
  await expect(details(page).getByRole("searchbox", { name: "Search places" })).toBeFocused();
  await details(page).getByRole("button", { name: /^Bakery/ }).click();
  await details(page).getByRole("button", { name: "Merge", exact: true }).click();
  await expect(alert).toContainText(`Could not merge: ${TOO_DEEP}`);
  await expect(alert).not.toContainText(SAME_PLACE);
  expect(api.writes.map((write) => write.body)).toEqual([{ place: 3, name: "Café" }, { place: 6, name: "Café" }]);

  message = null; // a refusal with nothing to say
  await alert.getByRole("button", { name: "Choose another place" }).click();
  await details(page).getByRole("button", { name: /^Bakery/ }).click();
  await details(page).getByRole("button", { name: "Merge", exact: true }).click();
  await expect(alert).toContainText("Could not merge: The server refused it.");

  // Cancel gives the buttons back, with the focus on the one that opened it.
  await details(page).getByRole("button", { name: "Cancel" }).click();
  await expect(details(page).getByRole("button", { name: "Merge with…" })).toBeFocused();
});

test("merge_confirm_takes_the_focus_so_that_escape_closes_it_and_the_focus_goes_back_to_the_button", async ({ page }) => {
  await fixToday(page);
  const api = await mockApi(page, placeServer().overrides);
  await page.goto("/place/2");
  await openSheet(page);
  await details(page).getByRole("button", { name: "Merge with…" }).click();
  await expect(details(page).getByRole("searchbox", { name: "Search places" })).toBeFocused();

  await details(page).getByRole("button", { name: /^Office/ }).click();

  await expect(details(page).getByText("Merge Office into Café?")).toBeFocused();
  await page.keyboard.press("Escape"); // goes to what has the focus, as it does for the owner

  await expect(details(page).getByText("Merge Office into Café?")).toHaveCount(0);
  await expect(details(page).getByRole("button", { name: "Merge with…" })).toBeFocused();
  expect(api.writes).toEqual([]);
});

test("rename_gives_the_focus_back_to_its_button_after_cancel_escape_and_save", async ({ page }) => {
  await fixToday(page);
  await mockApi(page, placeServer().overrides);
  await page.goto("/place/2");
  await openSheet(page);
  const renameButton = details(page).getByRole("button", { name: "Rename" });
  const field = details(page).getByRole("textbox", { name: "Name" });

  await renameButton.click();
  await details(page).getByRole("button", { name: "Cancel" }).click();
  await expect(renameButton).toBeFocused();

  await renameButton.click();
  await expect(field).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(renameButton).toBeFocused();

  await renameButton.click();
  await field.fill("Corner Café");
  await page.keyboard.press("Enter");
  await expect(details(page).getByRole("heading", { level: 1, name: "Corner Café" })).toBeVisible();
  await expect(renameButton).toBeFocused();
});

test("separate_of_a_place_that_is_no_longer_merged_says_so_with_no_retry_and_the_list_catches_up", async ({ page }) => {
  await fixToday(page);
  const server = placeServer([3, 6]);
  const api = await mockApi(page, {
    ...server.overrides,
    "DELETE places/2/merged/3": (): Reply => {
      server.forget(3); // merged no more, as it was found out elsewhere: the server says so
      return { status: 404, json: { title: "Not Found" } };
    },
  });
  await page.goto("/place/2");
  await openSheet(page);
  const merged = details(page).getByRole("region", { name: "Merged places" });
  await expect(merged.getByRole("listitem")).toHaveText(["Bakery Separate", "Office Separate"], { useInnerText: true });

  await merged.getByRole("button", { name: "Separate Office" }).click();

  await expect(merged.getByRole("alert")).toContainText("Could not separate: It is not merged into this place any more.");
  await expect(merged.getByRole("button", { name: "Retry" })).toHaveCount(0);
  await expect(merged.getByRole("listitem")).toHaveText(["Bakery Separate"], { useInnerText: true }); // the place was asked for again: the row that is gone goes
  expect(api.writes).toHaveLength(1);
});

test("separate_gives_the_focus_to_the_next_row_and_when_the_section_goes_to_the_name", async ({ page }) => {
  await fixToday(page);
  await mockApi(page, placeServer([3, 6]).overrides);
  await page.goto("/place/2");
  await openSheet(page);
  const merged = details(page).getByRole("region", { name: "Merged places" });

  await merged.getByRole("button", { name: "Separate Bakery" }).click();
  await expect(merged.getByRole("button", { name: "Separate Office" })).toBeFocused();

  await merged.getByRole("button", { name: "Separate Office" }).click();
  await expect(details(page).getByRole("heading", { level: 2, name: "Merged places" })).toHaveCount(0);
  await expect(details(page).getByRole("heading", { level: 1, name: "Café" })).toBeFocused();
});
