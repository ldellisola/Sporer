import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { MapLibreMap } from "maplibre-gl";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { PointDetailResponse } from "../api/types";
import { stubEdits } from "../test/stubEdits";
import { PointCard } from "./PointCard";

const T = 1_792_656_072_123_456; // 2026-10-22T08:01:12Z
const POINT = { device: "phone", t: T, lon: 10.754321, lat: 59.912345 };
const DETAIL: PointDetailResponse = {
  device: "phone",
  t: T,
  timeUtc: "2026-10-22T08:01:12.123456Z",
  localTime: "2026-10-22T10:01:12",
  zone: "Europe/Oslo",
  lat: 59.912345,
  lon: 10.754321,
  accuracyM: 12.4,
  speedMps: 20,
  altitudeM: 23.6,
  motion: ["walking", "stationary"],
  status: "used",
  maxAccuracyM: 100,
  previous: { t: T - 61_000_000, gapSeconds: 61, distanceM: 1234, speedKmh: 72.04 },
  next: { t: T + 45_000_000, gapSeconds: 45, distanceM: 80, speedKmh: 6.4 },
  segment: { kind: "stay", startUtc: "2026-10-22T06:00:00Z", endUtc: "2026-10-22T09:30:00Z", place: { id: 3, name: "Café" } },
};
const WITHIN = { top: 80, right: 16, bottom: 120, left: 16 };

/** A map that puts a point at `at.current` and tells those who listen when it moves. */
function fakeMap() {
  const listeners = new Map<string, Set<() => void>>();
  const at = { current: { x: 200, y: 450 } };
  const canvas = document.body.appendChild(document.createElement("canvas")); // MapLibre's canvas takes the focus (it has a tabindex)
  canvas.tabIndex = 0;
  const map = {
    getCanvas: () => canvas,
    project: () => at.current,
    on: (event: string, listener: () => void) => void (listeners.get(event) ?? listeners.set(event, new Set()).get(event)!).add(listener),
    off: (event: string, listener: () => void) => void listeners.get(event)?.delete(listener),
  };
  return { map: map as unknown as MapLibreMap, canvas, at, emit: (event: string) => listeners.get(event)?.forEach((listener) => listener()), listening: (event: string) => listeners.get(event)?.size ?? 0 };
}

function mount(routes: Parameters<typeof stubEdits>[0], over: Partial<Parameters<typeof PointCard>[0]> = {}) {
  const api = stubEdits(routes);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onClose = vi.fn();
  const maps = fakeMap();
  const ui = (
    <QueryClientProvider client={client}>
      <div data-testid="host">
        <PointCard map={maps.map} point={POINT} within={WITHIN} onClose={onClose} {...over} />
      </div>
    </QueryClientProvider>
  );
  return { api, onClose, ...maps, ...render(ui) };
}

const DETAIL_ROUTE = "GET /api/points/detail";
const card = () => screen.getByRole("region", { name: "Point details" });

beforeEach(() => {
  // jsdom has no layout: the map is 390 by 700 and the card is 288 by 300.
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(390);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(700);
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(288);
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(298);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("PointCard", () => {
  test("PointCard_asks_for_the_point_by_its_device_and_exact_time_and_says_everything_about_it", async () => {
    const { api } = mount({ [DETAIL_ROUTE]: () => Response.json(DETAIL) });

    expect(card()).toHaveTextContent("Loading…");
    await screen.findByText("Used by the timeline");

    expect(api.calls).toHaveLength(1);
    expect(api.calls[0]).toMatchObject({ path: "/api/points/detail", search: `?device=phone&t=${T}` });
    const text = (card().textContent ?? "").replace(/\u00a0/g, " ");
    expect(text).toContain("10:01:12 CEST"); // the clock of the place, with seconds and the zone
    expect(text).toContain("22 Oct 2026");
    const rows = within(card());
    for (const [label, value] of [
      ["Device", "phone"],
      ["Coordinates", "59.912345, 10.754321"],
      ["Accuracy", "12 m"],
      ["Speed", "72.0 km/h"],
      ["Altitude", "24 m"],
      ["Motion", "walking, stationary"],
    ] as const) {
      expect(rows.getByText(label).nextElementSibling).toHaveTextContent(value);
    }
    expect(text).toContain("In a stay at Café (08:00–11:30)");
    expect(text).toContain("1 min 1 s and 1.2 km after the previous point (72.0 km/h)");
    expect(text).toContain("45 s and 80 m before the next point (6.4 km/h)");
  });

  test("PointCard_says_the_limit_that_the_server_judged_by", async () => {
    mount({ [DETAIL_ROUTE]: () => Response.json({ ...DETAIL, status: "poorAccuracy", accuracyM: 70, maxAccuracyM: 50 }) });

    await screen.findByText("Ignored: the GPS accuracy was 70 m (more than 50 m)");
  });

  test("PointCard_says_not_recorded_for_what_the_device_did_not_send_and_why_a_point_is_ignored", async () => {
    mount({ [DETAIL_ROUTE]: () => Response.json({ ...DETAIL, status: "poorAccuracy", accuracyM: 1414.2, speedMps: null, motion: null, segment: null, previous: null }) });

    await screen.findByText("Ignored: the GPS accuracy was 1,414 m (more than 100 m)");

    const rows = within(card());
    expect(rows.getByText("Speed").nextElementSibling).toHaveTextContent("not recorded");
    expect(rows.getByText("Motion").nextElementSibling).toHaveTextContent("not recorded");
    expect(card()).toHaveTextContent("No earlier point");
    expect(card()).not.toHaveTextContent("In a stay");
  });

  test("PointCard_is_a_region_named_point_details_that_does_not_take_the_focus_and_has_a_close_button", async () => {
    const { onClose } = mount({ [DETAIL_ROUTE]: () => Response.json(DETAIL) });
    await screen.findByText("Used by the timeline");

    expect(document.activeElement).toBe(document.body);
    fireEvent.click(screen.getByRole("button", { name: "Close point details" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("PointCard_closes_on_escape_unless_the_key_was_taken_or_it_was_typed_in_a_field", async () => {
    const { onClose } = mount({ [DETAIL_ROUTE]: () => Response.json(DETAIL) });
    await screen.findByText("Used by the timeline");

    fireEvent.keyDown(document.body, { key: "a" });
    expect(onClose).not.toHaveBeenCalled();
    const taken = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    taken.preventDefault();
    document.body.dispatchEvent(taken);
    expect(onClose).not.toHaveBeenCalled();
    const field = document.body.appendChild(document.createElement("input"));
    fireEvent.keyDown(field, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    field.remove();
  });

  test("PointCard_gives_the_focus_to_the_map_when_it_closes_with_the_focus_in_it_and_otherwise_leaves_it_where_it_is", async () => {
    const { canvas, onClose } = mount({ [DETAIL_ROUTE]: () => Response.json(DETAIL) });
    await screen.findByText("Used by the timeline");
    const cross = screen.getByRole("button", { name: "Close point details" });

    cross.focus(); // by Tab
    fireEvent.click(cross);
    expect(canvas).toHaveFocus();
    expect(onClose).toHaveBeenCalledTimes(1);

    cross.focus();
    fireEvent.keyDown(cross, { key: "Escape" });
    expect(canvas).toHaveFocus();
    expect(onClose).toHaveBeenCalledTimes(2);

    const elsewhere = document.body.appendChild(document.createElement("button"));
    elsewhere.focus(); // the focus is not in the card: Escape does not take it
    fireEvent.keyDown(elsewhere, { key: "Escape" });
    expect(elsewhere).toHaveFocus();
    expect(onClose).toHaveBeenCalledTimes(3);
    elsewhere.remove();
  });

  test("PointCard_has_no_pointer_while_its_point_is_out_of_sight", async () => {
    const { at, emit } = mount({ [DETAIL_ROUTE]: () => Response.json(DETAIL) });
    await screen.findByText("Used by the timeline");
    expect(card()).toHaveAttribute("data-side", "above");

    at.current = { x: 900, y: 450 };
    act(() => emit("move"));

    expect(card()).toHaveAttribute("data-side", "away");
  });

  test("PointCard_stops_listening_when_it_goes", async () => {
    const { onClose, unmount, listening } = mount({ [DETAIL_ROUTE]: () => Response.json(DETAIL) });
    await screen.findByText("Used by the timeline");
    expect(listening("move")).toBe(1);

    unmount();

    expect(listening("move")).toBe(0);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });

  test("PointCard_says_that_a_point_that_is_gone_is_gone_with_no_retry", async () => {
    mount({ [DETAIL_ROUTE]: () => new Response(null, { status: 404 }) });

    await screen.findByText("This point no longer exists");

    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  test("PointCard_shows_a_failed_load_with_a_retry_that_asks_again", async () => {
    let fail = true;
    const { api } = mount({ [DETAIL_ROUTE]: () => (fail ? new Response(null, { status: 500 }) : Response.json(DETAIL)) });
    await screen.findByRole("alert");
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't load the point");

    fail = false;
    const retry = screen.getByRole("button", { name: "Retry" });
    retry.focus();
    fireEvent.click(retry);
    expect(screen.getByRole("button", { name: "Close point details" })).toHaveFocus(); // Retry goes, and the focus does not fall to the page

    await screen.findByText("Used by the timeline");
    expect(api.calls).toHaveLength(2);
  });

  test("PointCard_is_above_the_point_and_follows_the_map_when_it_moves", async () => {
    const { at, emit } = mount({ [DETAIL_ROUTE]: () => Response.json(DETAIL) });
    await screen.findByText("Used by the timeline");

    // 288 wide and centred on x 200 would be 56 to 344, but the buttons of the map are at the right of the padding (16) and take 12 + 44 px and a gap of 8: the card ends at
    // 390 - 16 - 64 = 310, which is 22 to 310. 300 high and 12 from the point (y 450): 138.
    expect(card()).toHaveStyle({ left: "22px", top: "138px" });
    expect(card()).toHaveAttribute("data-side", "above");

    at.current = { x: 200, y: 200 };
    act(() => emit("move"));

    expect(card()).toHaveStyle({ top: "212px" }); // no room above (80 is the top): below the point
    expect(card()).toHaveAttribute("data-side", "below");
  });

  test("PointCard_is_not_shown_where_it_has_no_place_to_be_before_the_map_is_there", async () => {
    const { container } = mount({ [DETAIL_ROUTE]: () => Response.json(DETAIL) }, { map: null });
    await waitFor(() => expect(container.textContent).toContain("Used by the timeline"));

    expect(screen.queryByRole("region", { name: "Point details" })).toBeNull(); // hidden: it has no place to be
    expect(container.querySelector("[aria-label='Point details']")).toHaveStyle({ visibility: "hidden" });
  });
});
