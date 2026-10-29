import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { DeletedTrip, FailedRange, HomesResponse, RemovedBatch, SettingsResponse, StatusResponse } from "../api/types";
import { SettingsPanel } from "./SettingsPanel";

// The unit tests run on the clock of Tokyo (see globalSetup), which is the browser's zone here: an instant is read there.

const failedRange = (over: Partial<FailedRange> = {}): FailedRange => ({
  from: "2026-09-12T20:00:00Z", // 05:00 on the 13th in Tokyo
  to: "2026-09-13T20:00:00Z",
  attempts: 5,
  lastError: "a point that cannot be placed",
  ...over,
});

function status(over: Partial<StatusResponse> = {}): StatusResponse {
  return {
    algorithmVersion: "2026-10-algo-3",
    backfill: { from: null, to: null, cursor: null, percent: 100, paused: false },
    pendingRanges: 0,
    failedRanges: [],
    lastRunAt: "2026-10-24T08:15:00Z", // 17:15 on the 24th in Tokyo
    lastError: null,
    places: { total: 0, unnamed: 0, failed: 0 },
    warnings: [],
    ...over,
  };
}

interface Call {
  path: string;
  method: string;
  contentType: string | null;
  body: unknown;
}

/**
 * Answers `GET /api/status` with whatever `current` is (a test changes it to change what the next request finds) and `POST /api/status/retry`
 * with `retry`; `GET /api/trips/deleted` with `deleted`, `GET /api/homes` with `homes`, `GET /api/settings` with `settings` and `GET /api/points/removed` with
 * `removed` (those sections have their own tests: see DeletedTrips.test.tsx, HomeSettings.test.tsx, TripDistance.test.tsx and RemovedPoints.test.tsx);
 * returns the calls that were made and the knobs.
 */
function stubApi(initial: StatusResponse | Response, retry: () => Response | Promise<Response> = () => Response.json({ retried: 1 })) {
  const state = {
    status: initial,
    retry,
    deleted: [] as DeletedTrip[] | Response,
    homes: { periods: [] } as HomesResponse | Response,
    settings: { tripMinDistanceKm: 50, tripMinDistanceKmDefault: 50 } as SettingsResponse | Response,
    removed: [] as RemovedBatch[] | Response,
  };
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      calls.push({
        path,
        method: init?.method ?? "GET",
        contentType: headers.get("Content-Type"),
        body: typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : init?.body,
      });
      if (path === "/api/status/retry") return state.retry();
      if (/^\/api\/trips\/deleted\/[^/]+\/restore$/.test(path)) return new Response(null, { status: 204 });
      if (path === "/api/trips/deleted") return state.deleted instanceof Response ? state.deleted.clone() : Response.json(state.deleted);
      if (path === "/api/homes") return state.homes instanceof Response ? state.homes.clone() : Response.json(state.homes);
      if (path === "/api/settings") return state.settings instanceof Response ? state.settings.clone() : Response.json(state.settings);
      if (path === "/api/points/removed") return state.removed instanceof Response ? state.removed.clone() : Response.json(state.removed);
      if (path === "/api/status") return state.status instanceof Response ? state.status.clone() : Response.json(state.status);
      throw new Error(`unexpected request ${path}`);
    }),
  );
  return {
    state,
    calls,
    retries: () => calls.filter((call) => call.path === "/api/status/retry"),
  };
}

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <SettingsPanel />
      </QueryClientProvider>,
    ),
  };
}

const processing = () => screen.getByRole("region", { name: "Processing" });
/** The figures of the processing section, each as the term and what it says, which is how a reader takes them in. */
const facts = (): string[] => [...processing().querySelectorAll("dl > div")].map((row) => row.textContent ?? "");
const about = () => screen.getByRole("region", { name: "About" });
/** What the note over the map says: the panel has one status for all its sections, which is empty until something is said in it. */
const note = (): string => screen.getByRole("status").textContent ?? "";
const deletedSection = () => screen.getByRole("region", { name: "Deleted trips" });

beforeEach(() => {
  window.history.replaceState(null, "", "/settings");
});

afterEach(() => {
  vi.useRealTimers();
});

describe("SettingsPanel", () => {
  test("SettingsPanel_has_the_sections_in_the_order_of_the_plan_each_a_region_named_by_its_heading", async () => {
    stubApi(status());

    mount();

    await screen.findByText("2026-10-algo-3");
    expect(screen.getAllByRole("heading").map((heading) => heading.textContent)).toEqual([
      "Home",
      "Trips",
      "Deleted trips",
      "Removed points",
      "Processing",
      "About",
    ]);
    for (const name of ["Home", "Trips", "Deleted trips", "Removed points", "Processing", "About"]) {
      expect(screen.getByRole("region", { name })).toBeInTheDocument();
    }
  });

  test("SettingsPanel_asks_each_section_for_what_it_shows_once", async () => {
    const api = stubApi(status());

    mount();
    await screen.findByText("2026-10-algo-3");
    await within(screen.getByRole("region", { name: "Removed points" })).findByText("No removed points");
    await within(screen.getByRole("region", { name: "Home" })).findByText("No home yet");
    await screen.findByRole("spinbutton");

    expect(api.calls.map((call) => call.path).sort()).toEqual(["/api/homes", "/api/points/removed", "/api/settings", "/api/status", "/api/trips/deleted"]);
  });

  test("SettingsPanel_has_one_status_for_all_its_sections_and_what_a_section_says_is_said_in_it", async () => {
    const api = stubApi(status({ failedRanges: [failedRange()] }));
    api.state.deleted = [{ key: "2026-09-12", label: "Lisbon · 12 – 16 Sep 2026", deletedAt: "2026-10-24T08:15:00Z" }];
    mount();
    // The panel has one live region, there before anything is said in it: a screen reader announces what is put into a status, and not one that is made with its text.
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(note()).toBe("");

    fireEvent.click(await screen.findByRole("button", { name: "Retry failed" }));
    await waitFor(() => expect(note()).toBe("Retrying 1 period"));
    expect(screen.getAllByRole("status")).toHaveLength(1);

    // Another section says something while that is on show: it is said in the same status, and replaces it (two sections do not talk at once).
    api.state.deleted = [];
    fireEvent.click(await within(deletedSection()).findByRole("button", { name: "Restore Lisbon · 12 – 16 Sep 2026" }));
    await waitFor(() => expect(note()).toBe("Restored Lisbon · 12 – 16 Sep 2026"));
    expect(screen.getAllByRole("status")).toHaveLength(1);
  });

  test("SettingsPanel_says_it_is_loading_the_status_and_shows_the_credits_at_once", async () => {
    stubApi(status());

    mount();

    expect(within(processing()).getByText("Loading…")).toBeInTheDocument();
    expect(within(about()).getByRole("link", { name: "OpenStreetMap contributors" })).toBeInTheDocument(); // the credits need no request
    await screen.findByText("2026-10-algo-3");
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
  });
});

describe("SettingsPanel processing", () => {
  test("SettingsPanel_shows_how_far_the_backfill_has_come_when_it_last_ran_and_what_waits", async () => {
    stubApi(status({ backfill: { from: "2024-01-01T00:00:00Z", to: "2026-10-24T00:00:00Z", cursor: "2025-06-01T00:00:00Z", percent: 42.9, paused: false }, pendingRanges: 3 }));

    mount();

    await within(processing()).findByText("Backfill");
    expect(facts()).toEqual([
      "Backfill42 %", // rounded down: 99.9 must never read as done
      "Last processedSat 24 Oct 2026 17:15",
      "Waiting to be processed3 periods",
    ]);
  });

  test("SettingsPanel_says_a_finished_backfill_is_100_a_paused_one_is_paused_and_nothing_has_run_yet", async () => {
    const api = stubApi(status({ lastRunAt: null, pendingRanges: 1 }));
    const view = mount();
    await within(processing()).findByText("Backfill");

    expect(facts()).toEqual(["Backfill100 %", "Last processedNot yet", "Waiting to be processed1 period"]);

    api.state.status = status({ backfill: { from: "2024-01-01T00:00:00Z", to: "2026-10-24T00:00:00Z", cursor: "2025-06-01T00:00:00Z", percent: 99.9, paused: true } });
    await act(async () => {
      await view.client.invalidateQueries();
    });

    await waitFor(() => expect(facts()[0]).toBe("Backfill99 %, paused"));
  });

  test("SettingsPanel_lists_the_failed_periods_with_their_error_and_has_a_retry_failed_button", async () => {
    stubApi(
      status({
        pendingRanges: 3,
        failedRanges: [
          failedRange(),
          failedRange({ from: "2026-10-01T02:00:00Z", to: "2026-10-01T05:00:00Z", attempts: 1, lastError: null }), // on one date in Tokyo (11:00 – 14:00 on the 1st)
        ],
      }),
    );

    mount();

    const failed = await within(processing()).findByRole("list", { name: "Failed periods" });
    const [first, second] = within(failed).getAllByRole("listitem");
    expect(first).toHaveTextContent("Sun 13 Sep 2026 05:00 – Mon 14 Sep 2026 05:00");
    expect(first).toHaveTextContent("5 attempts");
    expect(first).toHaveTextContent("a point that cannot be placed");
    expect(second).toHaveTextContent("Thu 1 Oct 2026 11:00 – 14:00"); // one date: said once
    expect(second).toHaveTextContent("1 attempt");
    expect(second).not.toHaveTextContent("attempts");
    expect(within(processing()).getByRole("button", { name: "Retry failed" })).toBeEnabled();
  });

  test("SettingsPanel_lists_two_failed_periods_that_cover_the_same_span_each_once_and_without_a_warning", async () => {
    // Two rows of the status can have the same span (the DTO has no id): a list keyed by the span would warn and could drop one.
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    stubApi(status({ failedRanges: [failedRange({ lastError: "first" }), failedRange({ lastError: "second" })] }));

    mount();

    const failed = await within(processing()).findByRole("list", { name: "Failed periods" });
    const items = within(failed).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("first");
    expect(items[1]).toHaveTextContent("second");
    expect(errors).not.toHaveBeenCalled();
  });

  test("SettingsPanel_says_nothing_failed_and_offers_no_retry_when_nothing_has", async () => {
    stubApi(status());

    mount();

    await within(processing()).findByText("Nothing has failed");
    expect(within(processing()).queryByRole("list", { name: "Failed periods" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry failed" })).not.toBeInTheDocument();
  });

  test("SettingsPanel_shows_the_error_the_worker_last_recorded", async () => {
    stubApi(status({ lastError: "connection refused" }));

    mount();

    expect(await within(processing()).findByText("Last error: connection refused")).toBeInTheDocument();
  });

  test("SettingsPanel_retry_failed_posts_an_empty_json_object_shows_it_is_working_and_says_what_it_did", async () => {
    const api = stubApi(status({ pendingRanges: 1, failedRanges: [failedRange()] }));
    let answer: (response: Response) => void = () => undefined;
    api.state.retry = () => new Promise<Response>((resolve) => (answer = resolve));
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Retry failed" }));

    // On its way: the button says so and cannot be pressed again.
    const busy = await screen.findByRole("button", { name: "Retrying…" });
    expect(busy).toBeDisabled();
    expect(api.retries()).toEqual([{ path: "/api/status/retry", method: "POST", contentType: "application/json", body: {} }]);

    api.state.status = status({ pendingRanges: 1, failedRanges: [] }); // by the time it is asked again the worker has taken it up
    await act(async () => answer(Response.json({ retried: 1 })));

    await waitFor(() => expect(note()).toBe("Retrying 1 period")); // the status was there, empty, before: the note is put into it
    expect(screen.queryByRole("button", { name: "Retrying…" })).not.toBeInTheDocument();
    // The write invalidated what is on screen: the status was asked for again, and its failed periods are gone.
    await within(processing()).findByText("Nothing has failed");
    expect(api.calls.filter((call) => call.path === "/api/status").length).toBeGreaterThanOrEqual(2);
  });

  test("SettingsPanel_says_there_was_nothing_to_retry_when_the_server_had_nothing_failed", async () => {
    stubApi(status({ failedRanges: [failedRange()] }), () => Response.json({ retried: 0 }));
    mount();

    fireEvent.click(await screen.findByRole("button", { name: "Retry failed" }));

    await waitFor(() => expect(note()).toBe("Nothing was waiting to be retried"));
  });

  test("SettingsPanel_forgets_what_retry_did_when_its_note_has_been_there_ten_seconds", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true }); // the clock runs, so that what waits for a request is found, and can be jumped over
    stubApi(status({ failedRanges: [failedRange()] }), () => Response.json({ retried: 2 }));
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Retry failed" }));
    await screen.findByText("Retrying 2 periods");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(screen.queryByText("Retrying 2 periods")).not.toBeInTheDocument();
  });

  test("SettingsPanel_shows_the_failure_of_retry_with_a_retry_that_asks_again", async () => {
    const api = stubApi(status({ failedRanges: [failedRange()] }), () => new Response("{}", { status: 500 }));
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Retry failed" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Couldn't retry — Retry");
    expect(alert).toHaveTextContent("POST /api/status/retry failed with status 500");
    expect(screen.getByRole("button", { name: "Retry failed" })).toBeEnabled(); // and the panel is all there
    expect(within(processing()).getByRole("list", { name: "Failed periods" })).toBeInTheDocument();

    api.state.retry = () => Response.json({ retried: 1 });
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));

    await screen.findByText("Retrying 1 period");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(api.retries()).toHaveLength(2);
  });

  test("SettingsPanel_shows_an_error_when_the_status_cannot_be_had_with_a_retry_and_keeps_the_credits", async () => {
    const api = stubApi(new Response("{}", { status: 503 }));
    mount();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Couldn't load — Retry");
    expect(within(about()).getByRole("link", { name: "OpenMapTiles" })).toBeInTheDocument(); // the panel is never blank

    api.state.status = status();
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));

    await within(processing()).findByText("Nothing has failed");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  test("SettingsPanel_keeps_the_status_it_had_under_an_error_when_it_is_asked_for_again", async () => {
    const api = stubApi(status({ pendingRanges: 4 }));
    const view = mount();
    await within(processing()).findByText("4 periods");

    api.state.status = new Response("{}", { status: 500 });
    await act(async () => {
      await view.client.refetchQueries({ queryKey: ["status"] });
    });

    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't load — Retry");
    expect(within(processing()).getByText("4 periods")).toBeInTheDocument(); // what was there stays under it
  });
});

describe("SettingsPanel about", () => {
  test("SettingsPanel_credits_openstreetmap_openfreemap_and_openmaptiles_with_links_that_open_in_a_new_tab", async () => {
    stubApi(status());
    mount();
    await screen.findByText("2026-10-algo-3");

    const links: [string, string][] = [
      ["OpenStreetMap contributors", "https://www.openstreetmap.org/copyright"],
      ["OpenFreeMap", "https://openfreemap.org"],
      ["OpenMapTiles", "https://openmaptiles.org"],
    ];
    for (const [name, href] of links) {
      const link = within(about()).getByRole("link", { name });
      expect(link, name).toHaveAttribute("href", href);
      expect(link, name).toHaveAttribute("target", "_blank");
      expect(link, name).toHaveAttribute("rel", "noopener noreferrer");
    }
    expect(within(about()).getAllByRole("link")).toHaveLength(3);
  });

  test("SettingsPanel_shows_the_algorithm_version_and_says_when_there_is_none_yet", async () => {
    const api = stubApi(status());
    const view = mount();

    expect(await within(about()).findByText("2026-10-algo-3")).toBeInTheDocument();
    expect(within(about()).getByText("Algorithm version")).toBeInTheDocument();

    api.state.status = status({ algorithmVersion: null });
    await act(async () => {
      await view.client.invalidateQueries();
    });

    await waitFor(() => expect(within(about()).getByText("Not yet processed")).toBeInTheDocument());
  });
});

describe("SettingsPanel deleted trips", () => {
  test("SettingsPanel_has_the_deleted_trips_in_a_section_of_their_own_that_does_not_hold_up_the_others", async () => {
    const api = stubApi(status());
    api.state.deleted = new Response("{}", { status: 503 });

    mount();

    expect(await within(deletedSection()).findByRole("alert")).toHaveTextContent("Couldn't load — Retry");
    await within(processing()).findByText("Nothing has failed"); // the other sections are not held up by it
    expect(within(about()).getByRole("link", { name: "OpenStreetMap contributors" })).toBeInTheDocument();
  });
});
