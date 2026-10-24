import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { ApiError } from "../api/client";
import { Empty, ErrorState, Loading, Shown } from "./States";

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

  test("Shown_holds_what_it_is_given_and_says_when_it_is_busy", () => {
    const { container, rerender } = render(<Shown busy={false}>the week</Shown>);
    expect(screen.getByText("the week")).toBeInTheDocument();
    expect(container.firstElementChild).toHaveAttribute("aria-busy", "false");

    rerender(<Shown busy>the week</Shown>); // another week is on its way: this one stays, and is not the one asked for

    expect(screen.getByText("the week")).toBeInTheDocument();
    expect(container.firstElementChild).toHaveAttribute("aria-busy", "true");
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
