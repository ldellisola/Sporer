import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Toast } from "./Toast";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Toast", () => {
  test("Toast_says_its_message_as_a_status_and_has_no_button_unless_it_has_an_action", () => {
    render(<Toast message="Trip deleted" onDismiss={() => undefined} />);

    expect(screen.getByRole("status")).toHaveTextContent("Trip deleted");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  test("Toast_has_an_action_button_that_is_named_by_the_text_it_shows_and_calls_back_when_pressed", () => {
    const onAction = vi.fn();
    render(<Toast message="Removed 3 points" action={{ label: "Undo", onClick: onAction }} onDismiss={() => undefined} />);

    expect(screen.getByRole("status")).toHaveTextContent("Removed 3 points");
    expect(screen.getByRole("status")).toContainElement(screen.getByRole("button", { name: "Undo" })); // the name is the visible text, nothing else
    expect(onAction).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Undo" }));

    expect(onAction).toHaveBeenCalledTimes(1);
  });

  test("Toast_asks_to_be_dismissed_once_its_time_is_up_and_not_before", () => {
    const onDismiss = vi.fn();
    render(<Toast message="Removed 3 points" durationMs={10_000} onDismiss={onDismiss} />);

    act(() => vi.advanceTimersByTime(9_999));
    expect(onDismiss).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(1));
    expect(onDismiss).toHaveBeenCalledTimes(1);

    act(() => vi.advanceTimersByTime(60_000));
    expect(onDismiss).toHaveBeenCalledTimes(1); // once
  });

  test("Toast_stays_ten_seconds_unless_it_is_given_another_time", () => {
    const onDismiss = vi.fn();
    render(<Toast message="Removed 3 points" onDismiss={onDismiss} />);

    act(() => vi.advanceTimersByTime(9_999));
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  test("Toast_clears_its_timer_when_it_goes_so_that_a_toast_that_is_gone_dismisses_nothing", () => {
    const onDismiss = vi.fn();
    const { unmount } = render(<Toast message="Removed 3 points" durationMs={5_000} onDismiss={onDismiss} />);
    act(() => vi.advanceTimersByTime(4_000));

    unmount();

    expect(vi.getTimerCount()).toBe(0);
    act(() => vi.advanceTimersByTime(60_000));
    expect(onDismiss).not.toHaveBeenCalled();
  });

  test("Toast_calls_the_latest_onDismiss_without_starting_its_time_again_when_it_is_rendered_again", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = render(<Toast message="Removed 3 points" durationMs={5_000} onDismiss={first} />);
    act(() => vi.advanceTimersByTime(3_000));

    rerender(<Toast message="Removed 3 points" durationMs={5_000} onDismiss={second} />); // the panel rendered for another reason

    act(() => vi.advanceTimersByTime(2_000)); // 5 s since it came
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  test("Toast_does_not_dismiss_itself_when_the_action_is_pressed_that_is_the_panels_to_say", () => {
    const onDismiss = vi.fn();
    render(<Toast message="Removed 3 points" action={{ label: "Undo", onClick: () => undefined }} onDismiss={onDismiss} />);

    fireEvent.click(screen.getByRole("button", { name: "Undo" }));

    expect(onDismiss).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toBeInTheDocument();
  });
});
