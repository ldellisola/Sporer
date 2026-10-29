import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { DeletedTrip, FailedRange, StatusResponse } from "../api/types";
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
 * with `retry`; `GET /api/trips/deleted` with `deleted` and `POST /api/trips/deleted/{key}/restore` with `restore`, which is given the path;
 * returns the calls that were made and the knobs.
 */
function stubApi(initial: StatusResponse | Response, retry: () => Response | Promise<Response> = () => Response.json({ retried: 1 })) {
  const state = {
    status: initial,
    retry,
    deleted: [] as DeletedTrip[] | Response | (() => Promise<Response>),
    restore: (_key: string): Response | Promise<Response> => new Response(null, { status: 204 }),
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
      if (path === "/api/trips/deleted") {
        if (typeof state.deleted === "function") return state.deleted();
        return state.deleted instanceof Response ? state.deleted.clone() : Response.json(state.deleted);
      }
      const restoring = /^\/api\/trips\/deleted\/([^/]+)\/restore$/.exec(path);
      if (restoring !== null) return state.restore(decodeURIComponent(restoring[1]!));
      if (path === "/api/status") return state.status instanceof Response ? state.status.clone() : Response.json(state.status);
      throw new Error(`unexpected request ${path}`);
    }),
  );
  return {
    state,
    calls,
    retries: () => calls.filter((call) => call.path === "/api/status/retry"),
    restores: () => calls.filter((call) => call.path.endsWith("/restore")),
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
/** What the notes over the map say: each section that has one has a status of its own, which is empty until it has something to say. */
const notes = (): string[] => screen.getAllByRole("status").map((status) => status.textContent ?? "");

beforeEach(() => {
  window.history.replaceState(null, "", "/settings");
});

afterEach(() => {
  vi.useRealTimers();
});

describe("SettingsPanel", () => {
  test("SettingsPanel_has_the_deleted_trips_section_then_the_processing_section_and_the_about_section_in_that_order", async () => {
    stubApi(status());

    mount();

    await screen.findByText("2026-10-algo-3");
    expect(screen.getAllByRole("heading").map((heading) => heading.textContent)).toEqual(["Deleted trips", "Processing", "About"]);
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

    await waitFor(() => expect(notes()).toContain("Retrying 1 period")); // the status was there, empty, before: the note is put into it
    expect(screen.queryByRole("button", { name: "Retrying…" })).not.toBeInTheDocument();
    // The write invalidated what is on screen: the status was asked for again, and its failed periods are gone.
    await within(processing()).findByText("Nothing has failed");
    expect(api.calls.filter((call) => call.path === "/api/status").length).toBeGreaterThanOrEqual(2);
  });

  test("SettingsPanel_says_there_was_nothing_to_retry_when_the_server_had_nothing_failed", async () => {
    stubApi(status({ failedRanges: [failedRange()] }), () => Response.json({ retried: 0 }));
    mount();

    fireEvent.click(await screen.findByRole("button", { name: "Retry failed" }));

    await waitFor(() => expect(notes()).toContain("Nothing was waiting to be retried"));
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
  const LISBON: DeletedTrip = { key: "2026-09-12", label: "Lisbon · 12 – 16 Sep 2026", deletedAt: "2026-10-24T08:15:00Z" };
  const COPENHAGEN: DeletedTrip = { key: "2026-08-01", label: "Copenhagen · 1 – 3 Aug 2026", deletedAt: "2026-10-23T10:00:00Z" };
  const PORTO: DeletedTrip = { key: "2026-05-02", label: "Porto · 2 – 4 May 2026", deletedAt: "2026-10-22T10:00:00Z" };
  const deletedSection = () => screen.getByRole("region", { name: "Deleted trips" });
  const rowsOf = () => within(within(deletedSection()).getByRole("list", { name: "Deleted trips" })).getAllByRole("listitem");
  const restoreButton = (label: string) => within(deletedSection()).getByRole("button", { name: `Restore ${label}` });

  test("SettingsPanel_lists_the_deleted_trips_by_their_labels_newest_first_each_with_a_restore_button_named_by_it", async () => {
    const api = stubApi(status());
    api.state.deleted = [LISBON, COPENHAGEN];

    mount();

    await within(deletedSection()).findByRole("list", { name: "Deleted trips" });
    expect(rowsOf().map((row) => row.textContent)).toEqual(["Lisbon · 12 – 16 Sep 2026Restore", "Copenhagen · 1 – 3 Aug 2026Restore"]);
    // The name holds the text that is on the button, and says which trip it is for: the buttons of the list are not all "Restore".
    expect(restoreButton(LISBON.label)).toHaveTextContent("Restore");
    expect(restoreButton(COPENHAGEN.label)).toBeEnabled();
    expect(api.calls.filter((call) => call.path === "/api/trips/deleted")).toHaveLength(1);
  });

  test("SettingsPanel_says_none_are_deleted_when_none_are_and_says_it_is_loading_before_that", async () => {
    stubApi(status());

    mount();

    expect(within(deletedSection()).getByText("Loading…")).toBeInTheDocument();
    expect(await within(deletedSection()).findByText("No deleted trips")).toBeInTheDocument();
    expect(within(deletedSection()).queryByRole("button")).not.toBeInTheDocument();
    expect(within(deletedSection()).queryByRole("list")).not.toBeInTheDocument();
  });

  test("SettingsPanel_shows_an_error_when_the_deleted_trips_cannot_be_had_with_a_retry_that_asks_again_and_the_rest_of_the_panel", async () => {
    const api = stubApi(status());
    api.state.deleted = new Response("{}", { status: 503 });
    mount();

    const alert = await within(deletedSection()).findByRole("alert");
    expect(alert).toHaveTextContent("Couldn't load — Retry");
    await within(processing()).findByText("Nothing has failed"); // the other sections are not held up by it

    api.state.deleted = [LISBON];
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));

    expect(await within(deletedSection()).findByRole("button", { name: `Restore ${LISBON.label}` })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  test("SettingsPanel_keeps_the_deleted_trips_it_had_under_an_error_when_they_are_asked_for_again", async () => {
    const api = stubApi(status());
    api.state.deleted = [LISBON];
    const view = mount();
    await within(deletedSection()).findByText(LISBON.label);

    api.state.deleted = new Response("{}", { status: 500 });
    await act(async () => {
      await view.client.refetchQueries({ queryKey: ["deleted-trips"] });
    });

    expect(await within(deletedSection()).findByRole("alert")).toHaveTextContent("Couldn't load — Retry");
    expect(within(deletedSection()).getByText(LISBON.label)).toBeInTheDocument(); // what was there stays under it
  });

  test("SettingsPanel_restores_a_trip_by_its_key_shows_it_is_on_its_way_and_takes_it_off_the_list_and_says_it_is_back", async () => {
    const api = stubApi(status());
    api.state.deleted = [LISBON, COPENHAGEN];
    let answer: (response: Response) => void = () => undefined;
    api.state.restore = () => new Promise<Response>((resolve) => (answer = resolve));
    mount();
    await within(deletedSection()).findByText(LISBON.label);

    fireEvent.click(restoreButton(LISBON.label));

    // On its way: the row says so, and no button of the list can be pressed (the answer would change the list under a finger).
    expect(await within(deletedSection()).findByRole("button", { name: "Restoring…" })).toBeDisabled();
    expect(restoreButton(COPENHAGEN.label)).toBeDisabled();
    expect(api.restores()).toEqual([{ path: "/api/trips/deleted/2026-09-12/restore", method: "POST", contentType: "application/json", body: {} }]);

    api.state.deleted = [COPENHAGEN]; // by the time it is asked again
    await act(async () => answer(new Response(null, { status: 204 })));

    await waitFor(() => expect(rowsOf().map((row) => row.textContent)).toEqual(["Copenhagen · 1 – 3 Aug 2026Restore"]));
    expect(notes()).toContain("Restored Lisbon · 12 – 16 Sep 2026"); // said in a status, for the row that had the focus is gone
    expect(restoreButton(COPENHAGEN.label)).toBeEnabled();
    expect(api.calls.filter((call) => call.path === "/api/trips/deleted").length).toBeGreaterThanOrEqual(2); // and what is on screen was asked for again
  });

  test("SettingsPanel_puts_the_focus_on_the_next_restore_button_the_one_before_it_for_the_last_and_the_note_when_none_is_left", async () => {
    const api = stubApi(status());
    api.state.deleted = [LISBON, COPENHAGEN, PORTO];
    mount();
    await within(deletedSection()).findByText(LISBON.label);

    // A row in the middle: the next.
    api.state.deleted = [LISBON, PORTO];
    fireEvent.click(restoreButton(COPENHAGEN.label));
    await waitFor(() => expect(restoreButton(PORTO.label)).toHaveFocus());

    // The last: the one before.
    api.state.deleted = [LISBON];
    fireEvent.click(restoreButton(PORTO.label));
    await waitFor(() => expect(restoreButton(LISBON.label)).toHaveFocus());

    // The only one: the note that says there is none, where the list was. The list that is asked for again has not come: the row is off it at once.
    api.state.deleted = () => new Promise<Response>(() => undefined);
    fireEvent.click(restoreButton(LISBON.label));
    const none = await within(deletedSection()).findByText("No deleted trips");
    await waitFor(() => expect(none).toHaveFocus());
  });

  test("SettingsPanel_says_a_refused_restore_in_the_words_of_the_server_with_no_retry_and_names_the_trip", async () => {
    const api = stubApi(status());
    api.state.deleted = [LISBON];
    api.state.restore = () => new Response("{}", { status: 404 });
    mount();
    await within(deletedSection()).findByText(LISBON.label);

    api.state.deleted = []; // restored in another window: a 404 has the list asked for again
    fireEvent.click(restoreButton(LISBON.label));

    const alert = await within(deletedSection()).findByRole("alert");
    expect(alert).toHaveTextContent("Could not restore Lisbon · 12 – 16 Sep 2026: That trip is not deleted any more.");
    expect(within(alert).queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
    await within(deletedSection()).findByText("No deleted trips"); // the row went with the list that was asked for again
    expect(api.restores()).toHaveLength(1);
  });

  test("SettingsPanel_offers_a_retry_for_a_restore_that_failed_and_sends_the_same_trip_again", async () => {
    const api = stubApi(status());
    api.state.deleted = [LISBON, COPENHAGEN];
    api.state.restore = () => new Response("{}", { status: 502 });
    mount();
    await within(deletedSection()).findByText(LISBON.label);
    restoreButton(COPENHAGEN.label).focus();

    fireEvent.click(restoreButton(COPENHAGEN.label));

    const alert = await within(deletedSection()).findByRole("alert");
    expect(alert).toHaveTextContent("Couldn't restore Copenhagen · 1 – 3 Aug 2026 — Retry");
    expect(rowsOf()).toHaveLength(2); // the list is all there
    expect(restoreButton(COPENHAGEN.label)).toBeEnabled();

    api.state.restore = () => new Response(null, { status: 204 });
    api.state.deleted = [LISBON];
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(rowsOf()).toHaveLength(1));
    expect(api.restores().map((call) => call.path)).toEqual(["/api/trips/deleted/2026-08-01/restore", "/api/trips/deleted/2026-08-01/restore"]);
    expect(within(deletedSection()).queryByRole("alert")).not.toBeInTheDocument();
  });

  test("SettingsPanel_puts_the_focus_back_on_the_restore_button_that_failed_when_nothing_has_it", async () => {
    // A button that is turned off while it is pressed may take the focus with it (and a tap does not focus it in Safari).
    const api = stubApi(status());
    api.state.deleted = [LISBON];
    api.state.restore = () => new Response("{}", { status: 503 });
    mount();
    await within(deletedSection()).findByText(LISBON.label);
    (document.activeElement as HTMLElement | null)?.blur();

    fireEvent.click(restoreButton(LISBON.label));

    await within(deletedSection()).findByRole("alert");
    await waitFor(() => expect(restoreButton(LISBON.label)).toHaveFocus());
  });
});
