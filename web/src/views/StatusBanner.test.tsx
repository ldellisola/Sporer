import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { FailedRange, StatusResponse } from "../api/types";
import { StatusBanner } from "./StatusBanner";

function failed(count: number): FailedRange[] {
  return Array.from({ length: count }, (_, i) => ({ from: `2026-09-0${i + 1}`, to: `2026-09-0${i + 1}`, attempts: 5, lastError: "a point that cannot be placed" }));
}

function status(percent: number, lastError: string | null = null, failedRanges: FailedRange[] = []): StatusResponse {
  return {
    algorithmVersion: "test",
    backfill: { from: null, to: null, cursor: null, percent, paused: false },
    pendingRanges: failedRanges.length,
    failedRanges,
    lastRunAt: null,
    lastError,
    places: { total: 0, unnamed: 0, failed: 0 },
    warnings: [],
  };
}

/** Answers `/api/status` with whatever `answer` gives at the time; returns how many times it was asked. */
function stubStatus(answer: () => StatusResponse | Response): { asked: () => number } {
  let asked = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      asked += 1;
      const body = answer();
      return body instanceof Response ? body : Response.json(body);
    }),
  );
  return { asked: () => asked };
}

function renderBanner() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <StatusBanner />
    </QueryClientProvider>,
  );
}

/** Lets the request in flight and the notification that follows it finish. */
const settle = () => act(() => vi.advanceTimersByTimeAsync(1));

afterEach(() => {
  vi.useRealTimers();
});

describe("StatusBanner", () => {
  test("StatusBanner_shows_progress_and_errors", async () => {
    stubStatus(() => status(42.9));
    const view = renderBanner();
    // Whole percent, rounded down: 99.9 must never read as done.
    expect(await screen.findByRole("status")).toHaveTextContent("Processing your history… 42 %");
    view.unmount();

    stubStatus(() => status(99.9));
    renderBanner();
    expect(await screen.findByRole("status")).toHaveTextContent("Processing your history… 99 %");
    expect(screen.queryByText(/100/)).not.toBeInTheDocument();
  });

  test("StatusBanner_shows_the_error_of_the_worker_and_the_error_wins_over_progress", async () => {
    stubStatus(() => status(42, "relation does not exist"));

    renderBanner();

    const note = await screen.findByRole("status");
    expect(note).toHaveTextContent("Processing problem: relation does not exist");
    expect(note).not.toHaveTextContent("Processing your history");
  });

  test("StatusBanner_shows_the_error_of_a_finished_backfill_too", async () => {
    stubStatus(() => status(100, "a range keeps failing"));

    renderBanner();

    expect(await screen.findByRole("status")).toHaveTextContent("Processing problem: a range keeps failing");
  });

  // Ranges the worker has set aside after trying again and again are days that are missing from the history, which nothing else says.
  test.each([
    [1, "Couldn't process 1 period"],
    [2, "Couldn't process 2 periods"],
    [12, "Couldn't process 12 periods"],
  ])("StatusBanner_says_how_many_periods_were_set_aside_when_it_has_nothing_else_to_say_%i", async (count, text) => {
    stubStatus(() => status(100, null, failed(count)));

    renderBanner();

    const note = await screen.findByRole("status");
    expect(note).toHaveTextContent(text);
    expect(note).not.toHaveTextContent("Retry"); // a note, with nothing the owner could press
    expect(screen.queryByRole("alert")).not.toBeInTheDocument(); // and nothing that blocks
  });

  test("StatusBanner_gives_the_error_of_the_worker_and_the_progress_precedence_over_the_set_aside_periods", async () => {
    stubStatus(() => status(100, "relation does not exist", failed(2)));
    const withError = renderBanner();
    expect(await screen.findByRole("status")).toHaveTextContent("Processing problem: relation does not exist");
    expect(screen.getByRole("status")).not.toHaveTextContent("Couldn't process");
    withError.unmount();

    stubStatus(() => status(42, null, failed(2)));
    renderBanner();
    expect(await screen.findByRole("status")).toHaveTextContent("Processing your history… 42 %");
    expect(screen.getByRole("status")).not.toHaveTextContent("Couldn't process");
  });

  test("StatusBanner_is_hidden_when_no_period_was_set_aside_and_all_is_processed", async () => {
    stubStatus(() => status(100, null, []));

    const { container } = renderBanner();
    await act(async () => undefined);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    await act(async () => undefined);

    expect(container).toBeEmptyDOMElement();
  });

  test("StatusBanner_is_hidden_when_the_history_is_processed_and_nothing_is_wrong", async () => {
    const stub = stubStatus(() => status(100));

    const { container } = renderBanner();
    await vi.waitFor(() => expect(stub.asked()).toBe(1));
    await act(async () => undefined);

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(container).toBeEmptyDOMElement();
  });

  test("StatusBanner_is_hidden_while_the_status_is_not_known_and_when_it_cannot_be_had", async () => {
    const stub = stubStatus(() => new Response("down", { status: 503 }));

    const { container } = renderBanner();
    expect(container).toBeEmptyDOMElement(); // nothing is claimed before the answer is in
    await vi.waitFor(() => expect(stub.asked()).toBe(1));
    await act(async () => undefined);

    expect(container).toBeEmptyDOMElement(); // and an owner whose status cannot be had is not told of a problem with it
  });

  test("StatusBanner_follows_the_status_as_it_is_asked_for_again_every_30_seconds", async () => {
    vi.useFakeTimers();
    let percent = 10;
    const stub = stubStatus(() => status(percent));
    renderBanner();
    await settle();
    expect(screen.getByRole("status")).toHaveTextContent("Processing your history… 10 %");

    percent = 55;
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    await settle();
    expect(stub.asked()).toBe(2);
    expect(screen.getByRole("status")).toHaveTextContent("Processing your history… 55 %");

    percent = 100;
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    await settle();
    expect(screen.queryByRole("status")).not.toBeInTheDocument(); // done: the banner goes
  });
});
