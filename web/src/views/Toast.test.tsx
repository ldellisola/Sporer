import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Toast, type ToastData } from "./Toast";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

const removed = (over: Partial<ToastData> = {}): ToastData => ({ id: 1, message: "Removed 3 points", ...over });

describe("Toast", () => {
  test("Toast_keeps_an_empty_status_mounted_while_it_has_nothing_to_say_so_that_what_it_says_next_is_announced", () => {
    const { rerender } = render(<Toast toast={null} onDismiss={() => undefined} />);

    const status = screen.getByRole("status");
    expect(status).toBeEmptyDOMElement(); // a live region is announced when what is in it changes, so it is there before the message is
    expect(screen.queryByRole("button")).not.toBeInTheDocument();

    rerender(<Toast toast={removed()} onDismiss={() => undefined} />);

    expect(screen.getByRole("status")).toBe(status); // the same element: the message is put into it, and it is not made with the message
    expect(status).toHaveTextContent("Removed 3 points");

    rerender(<Toast toast={null} onDismiss={() => undefined} />);

    expect(screen.getByRole("status")).toBe(status);
    expect(status).toBeEmptyDOMElement();
  });

  test("Toast_says_its_message_as_a_status_and_has_no_button_unless_it_has_an_action", () => {
    render(<Toast toast={{ id: 1, message: "Trip deleted" }} onDismiss={() => undefined} />);

    expect(screen.getByRole("status")).toHaveTextContent("Trip deleted");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  test("Toast_has_an_action_button_that_is_named_by_the_text_it_shows_and_calls_back_when_pressed", () => {
    const onAction = vi.fn();
    render(<Toast toast={removed({ action: { label: "Undo", onClick: onAction } })} onDismiss={() => undefined} />);

    expect(screen.getByRole("status")).toHaveTextContent("Removed 3 points");
    expect(screen.getByRole("status")).toContainElement(screen.getByRole("button", { name: "Undo" })); // the name is the visible text, nothing else
    expect(onAction).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Undo" }));

    expect(onAction).toHaveBeenCalledTimes(1);
  });

  test("Toast_has_an_action_that_is_off_while_what_it_does_is_on_its_way", () => {
    const onAction = vi.fn();
    render(<Toast toast={removed({ action: { label: "Undoing…", onClick: onAction, disabled: true } })} onDismiss={() => undefined} />);

    expect(screen.getByRole("button", { name: "Undoing…" })).toBeDisabled();
  });

  test("Toast_is_fixed_to_the_viewport_outside_of_whatever_panel_has_it_where_a_sheet_that_moves_cannot_take_it_along", () => {
    const { container } = render(
      <div role="region" aria-label="Details" style={{ transform: "translateY(300px)" }}>
        <Toast toast={removed()} onDismiss={() => undefined} />
      </div>,
    );

    const status = screen.getByRole("status");
    expect(screen.getByRole("region", { name: "Details" })).not.toContainElement(status); // a fixed box inside a transformed one is placed by it
    expect(container).not.toContainElement(status);
    expect(status.parentElement?.parentElement).toBe(document.body);
  });

  test("Toast_asks_to_be_dismissed_once_its_time_is_up_and_not_before", () => {
    const onDismiss = vi.fn();
    render(<Toast toast={removed({ durationMs: 10_000 })} onDismiss={onDismiss} />);

    act(() => vi.advanceTimersByTime(9_999));
    expect(onDismiss).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(1));
    expect(onDismiss).toHaveBeenCalledTimes(1);

    act(() => vi.advanceTimersByTime(60_000));
    expect(onDismiss).toHaveBeenCalledTimes(1); // once
  });

  test("Toast_stays_ten_seconds_unless_it_is_given_another_time", () => {
    const onDismiss = vi.fn();
    render(<Toast toast={removed()} onDismiss={onDismiss} />);

    act(() => vi.advanceTimersByTime(9_999));
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  test("Toast_with_no_time_stays_until_something_else_takes_it_away", () => {
    const onDismiss = vi.fn();
    render(<Toast toast={removed({ durationMs: null })} onDismiss={onDismiss} />);

    act(() => vi.advanceTimersByTime(24 * 60 * 60_000));

    expect(onDismiss).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent("Removed 3 points");
  });

  test("Toast_clears_its_timer_when_it_goes_so_that_a_toast_that_is_gone_dismisses_nothing", () => {
    const onDismiss = vi.fn();
    const { rerender, unmount } = render(<Toast toast={removed({ durationMs: 5_000 })} onDismiss={onDismiss} />);
    act(() => vi.advanceTimersByTime(4_000));

    rerender(<Toast toast={null} onDismiss={onDismiss} />); // the panel took it away

    expect(vi.getTimerCount()).toBe(0);
    act(() => vi.advanceTimersByTime(60_000));
    expect(onDismiss).not.toHaveBeenCalled();

    rerender(<Toast toast={removed({ id: 2, durationMs: 5_000 })} onDismiss={onDismiss} />);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  test("Toast_calls_the_latest_onDismiss_without_starting_its_time_again_when_it_is_rendered_again", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = render(<Toast toast={removed({ durationMs: 5_000 })} onDismiss={first} />);
    act(() => vi.advanceTimersByTime(3_000));

    rerender(<Toast toast={removed({ durationMs: 5_000 })} onDismiss={second} />); // the panel rendered for another reason

    act(() => vi.advanceTimersByTime(2_000)); // 5 s since it came
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  test("Toast_starts_its_time_again_for_another_toast_which_is_one_with_another_id", () => {
    const onDismiss = vi.fn();
    const { rerender } = render(<Toast toast={removed({ id: 1, durationMs: 5_000 })} onDismiss={onDismiss} />);
    act(() => vi.advanceTimersByTime(4_000));

    rerender(<Toast toast={removed({ id: 2, message: "Removed 5 points", durationMs: 5_000 })} onDismiss={onDismiss} />);

    expect(screen.getByRole("status")).toHaveTextContent("Removed 5 points");
    act(() => vi.advanceTimersByTime(4_999));
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  test("Toast_does_not_dismiss_itself_when_the_action_is_pressed_that_is_the_panels_to_say", () => {
    const onDismiss = vi.fn();
    render(<Toast toast={removed({ action: { label: "Undo", onClick: () => undefined } })} onDismiss={onDismiss} />);

    fireEvent.click(screen.getByRole("button", { name: "Undo" }));

    expect(onDismiss).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  test("Toast_shows_what_the_panel_puts_after_it_in_the_same_place", () => {
    render(
      <Toast toast={removed()} onDismiss={() => undefined}>
        <p role="alert">Could not restore: That removal was undone already.</p>
      </Toast>,
    );

    const status = screen.getByRole("status");
    const alert = screen.getByRole("alert");
    expect(status).not.toContainElement(alert); // an alert is not a status
    expect(status.parentElement).toBe(alert.parentElement); // they are in one place on the screen
  });
});

// WCAG 2.2.1: a note that goes by itself must not go while it is being read or reached for.
describe("Toast held", () => {
  test("Toast_does_not_go_while_the_pointer_is_over_it_and_has_what_was_left_of_its_time_when_the_pointer_leaves", () => {
    const onDismiss = vi.fn();
    render(<Toast toast={removed({ durationMs: 10_000 })} onDismiss={onDismiss} />);
    act(() => vi.advanceTimersByTime(6_000));

    fireEvent.pointerEnter(screen.getByRole("status").firstElementChild!);
    act(() => vi.advanceTimersByTime(60_000));
    expect(onDismiss).not.toHaveBeenCalled(); // for as long as it is held

    fireEvent.pointerLeave(screen.getByRole("status").firstElementChild!);
    act(() => vi.advanceTimersByTime(3_999));
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(onDismiss).toHaveBeenCalledTimes(1); // the 4 s that were left of the 10
  });

  test("Toast_does_not_go_while_it_has_the_focus_and_goes_when_the_focus_has_left_it", () => {
    const onDismiss = vi.fn();
    render(<Toast toast={removed({ durationMs: 10_000, action: { label: "Undo", onClick: () => undefined } })} onDismiss={onDismiss} />);
    act(() => vi.advanceTimersByTime(9_000));

    act(() => screen.getByRole("button", { name: "Undo" }).focus());
    act(() => vi.advanceTimersByTime(60_000));
    expect(onDismiss).not.toHaveBeenCalled();

    act(() => screen.getByRole("button", { name: "Undo" }).blur());
    act(() => vi.advanceTimersByTime(999));
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  test("Toast_stays_held_while_either_the_pointer_or_the_focus_is_on_it", () => {
    const onDismiss = vi.fn();
    render(<Toast toast={removed({ durationMs: 1_000, action: { label: "Undo", onClick: () => undefined } })} onDismiss={onDismiss} />);
    const card = screen.getByRole("status").firstElementChild!;

    fireEvent.pointerEnter(card);
    act(() => screen.getByRole("button", { name: "Undo" }).focus());
    fireEvent.pointerLeave(card); // the focus is still in it
    act(() => vi.advanceTimersByTime(60_000));
    expect(onDismiss).not.toHaveBeenCalled();

    act(() => screen.getByRole("button", { name: "Undo" }).blur());
    act(() => vi.advanceTimersByTime(1_000));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
