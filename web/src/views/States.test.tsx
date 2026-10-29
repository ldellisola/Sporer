import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { ApiError } from "../api/client";
import { Empty, ErrorState, Loading } from "./States";

describe("States", () => {
  test("Loading_says_so_and_can_say_what_is_loading", () => {
    const { rerender } = render(<Loading />);
    expect(screen.getByText("Loading…")).toBeInTheDocument();

    rerender(<Loading message="Loading this week…" />);
    expect(screen.getByText("Loading this week…")).toBeInTheDocument();
  });

  test("Empty_shows_its_message", () => {
    render(<Empty message="No data for this day" />);

    expect(screen.getByText("No data for this day")).toBeInTheDocument();
  });

  test("ErrorState_says_it_could_not_load_and_offers_a_retry", () => {
    const onRetry = vi.fn();
    render(<ErrorState error={new ApiError(500, "/api/day/2026-10-22")} onRetry={onRetry} />);

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Couldn't load — Retry");
    expect(screen.getByText("GET /api/day/2026-10-22 failed with status 500")).toBeInTheDocument(); // what failed, for whoever looks
    expect(onRetry).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  test("ErrorState_says_what_failed_when_it_is_not_a_load_and_the_failure_is_named_by_its_method", () => {
    // A write that failed (a button that was pressed) is not "Couldn't load": the control says what it could not do.
    const onRetry = vi.fn();
    render(<ErrorState message="Couldn't retry" error={new ApiError(500, "/api/status/retry", "POST")} onRetry={onRetry} />);

    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't retry — Retry");
    expect(screen.getByText("POST /api/status/retry failed with status 500")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  test("ErrorState_shows_the_detail_of_an_ApiError_that_has_one_after_what_failed", () => {
    // The signed-out page has no way to sign in again but to close and reopen the app (client.ts): that is what the owner is told.
    const detail = "Signed out at the login: close and reopen the app to sign in.";
    render(<ErrorState error={new ApiError(0, "/api/day/2026-10-22", "GET", detail)} onRetry={() => undefined} />);

    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't load — Retry");
    expect(screen.getByText(`GET /api/day/2026-10-22 failed with status 0. ${detail}`)).toBeInTheDocument();
  });

  test("ErrorState_copes_with_an_error_that_is_not_an_Error", () => {
    render(<ErrorState error="boom" onRetry={() => undefined} />);

    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't load — Retry");
    expect(screen.getByText("boom")).toBeInTheDocument();
  });

  test("ErrorState_without_an_error_shows_no_detail", () => {
    render(<ErrorState error={null} onRetry={() => undefined} />);

    expect(screen.getByRole("alert")).toHaveTextContent(/^Couldn't load — Retry$/);
  });
});
