import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { StatusResponse } from "../api/types";
import { StatusBanner } from "./StatusBanner";

function status(percent: number, lastError: string | null = null): StatusResponse {
  return {
    algorithmVersion: "test",
    backfill: { from: null, to: null, cursor: null, percent, paused: false },
    pendingRanges: 0,
    failedRanges: [],
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
