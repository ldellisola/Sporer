import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { ApiError } from "../api/client";
import { pointEditing } from "../test/pointEditing";
import { EditBar } from "./EditBar";

const group = () => screen.getByRole("group", { name: "Edit points" });

describe("EditBar", () => {
  test("EditBar_says_how_many_points_are_selected_and_has_clear_remove_and_done", () => {
    render(<EditBar edit={pointEditing({ selected: new Set([0, 2, 3]) })} onDone={() => undefined} />);

    expect(within(group()).getByText("3 selected")).toBeInTheDocument();
    expect(within(group()).getByRole("button", { name: "Clear" })).toBeEnabled();
    expect(within(group()).getByRole("button", { name: "Remove 3 points" })).toBeEnabled();
    expect(within(group()).getByRole("button", { name: "Done" })).toBeEnabled();
  });

  test.each([
    [0, "0 selected", "Remove 0 points"],
    [1, "1 selected", "Remove 1 point"],
    [2, "2 selected", "Remove 2 points"],
    [1234, "1,234 selected", "Remove 1,234 points"],
  ])("EditBar_counts_%i_selected_points_as_%s_and_%s", (count, selected, remove) => {
    render(<EditBar edit={pointEditing({ selected: new Set(Array.from({ length: count }, (_, i) => i)) })} onDone={() => undefined} />);

    expect(screen.getByText(selected)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: remove })).toBeInTheDocument(); // the name is the text that is on the button
  });

  test("EditBar_has_nothing_to_clear_or_remove_while_nothing_is_selected_and_says_how_to_select", () => {
    render(<EditBar edit={pointEditing()} onDone={() => undefined} />);

    expect(screen.getByRole("button", { name: "Clear" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Remove 0 points" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Done" })).toBeEnabled();
    expect(screen.getByText(/Tap a point/)).toBeInTheDocument();
  });

  test("EditBar_announces_the_count_as_it_changes_without_being_a_status_of_its_own", () => {
    const { rerender } = render(<EditBar edit={pointEditing({ selected: new Set([1]) })} onDone={() => undefined} />);

    const count = screen.getByText("1 selected");
    expect(count).toHaveAttribute("aria-live", "polite");
    expect(screen.queryByRole("status")).not.toBeInTheDocument(); // the page has other statuses, which are told apart by what they say

    rerender(<EditBar edit={pointEditing({ selected: new Set([1, 2]) })} onDone={() => undefined} />);

    expect(screen.getByText("2 selected")).toBe(count); // the same element, whose text changed: that is what is announced
  });

  test("EditBar_buttons_do_what_they_say", () => {
    const edit = pointEditing({ selected: new Set([0, 1]) });
    const onDone = vi.fn();
    render(<EditBar edit={edit} onDone={onDone} />);

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(edit.clear).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Remove 2 points" }));
    expect(edit.removal.run).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(edit.done).not.toHaveBeenCalled(); // the panel that has the bar ends edit mode: it also says where the focus goes
  });

  test("EditBar_shows_that_the_removal_is_on_its_way_and_holds_the_points_still", () => {
    render(<EditBar edit={pointEditing({ selected: new Set([0, 1]), removal: { run: vi.fn(), pending: true, error: null, reset: vi.fn() } })} onDone={() => undefined} />);

    expect(screen.getByRole("button", { name: "Removing…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Clear" })).toBeDisabled(); // what is sent is the selection as it was
    expect(screen.getByRole("button", { name: "Done" })).toBeEnabled(); // the owner can leave: the shell says what it did
  });

  test("EditBar_does_not_take_the_focus_as_it_appears_which_is_the_maps", () => {
    render(
      <div>
        <button type="button">on the map</button>
        <EditBar edit={pointEditing()} onDone={() => undefined} />
      </div>,
    );
    screen.getByRole("button", { name: "on the map" }).focus();

    expect(document.activeElement).toBe(screen.getByRole("button", { name: "on the map" }));
  });

  test("EditBar_says_the_points_are_on_their_way", () => {
    render(<EditBar edit={pointEditing({ points: undefined, load: { pending: true, error: null, retry: vi.fn() } })} onDone={() => undefined} />);

    expect(screen.getByText("Loading points…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Done" })).toBeEnabled(); // and edit mode can be left
    expect(screen.queryByText(/Tap a point/)).not.toBeInTheDocument();
  });

  test("EditBar_says_the_points_could_not_be_had_with_a_retry_and_keeps_done", () => {
    const retry = vi.fn();
    render(
      <EditBar
        edit={pointEditing({ points: undefined, load: { pending: false, error: new ApiError(503, "/api/day/2026-10-22/points"), retry } })}
        onDone={() => undefined}
      />,
    );

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Couldn't load the points — Retry");
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Done" })).toBeEnabled();
  });

  test("EditBar_says_a_day_has_no_points_when_the_server_has_none_for_it", () => {
    render(<EditBar edit={pointEditing({ points: { date: "2026-10-22", devices: [], points: [] } })} onDone={() => undefined} />);

    expect(screen.getByText("No points on this day")).toBeInTheDocument();
    expect(screen.queryByText(/Tap a point/)).not.toBeInTheDocument();
  });

  test("EditBar_says_a_refused_removal_in_the_words_of_the_server_with_no_retry", () => {
    const error = new ApiError(400, "/api/points/remove", "POST", "At most 50000 points can be removed at once.");
    render(
      <EditBar
        edit={pointEditing({ selected: new Set([0]), removal: { run: vi.fn(), pending: false, error, reset: vi.fn() } })}
        onDone={() => undefined}
      />,
    );

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Could not remove: At most 50000 points can be removed at once.");
    expect(within(alert).queryByRole("button")).not.toBeInTheDocument(); // asking again is refused again: the way back is Clear, and the bar is there
    expect(screen.getByRole("button", { name: "Clear" })).toBeEnabled();
  });

  test("EditBar_cannot_send_a_refused_removal_again_unchanged_and_can_once_the_selection_has_changed", () => {
    // Every 4xx but a 408 and a 429 is a refusal (P4-R29): the same selection is refused again. Changing the selection clears the error (the shell does), which is the way back.
    for (const status of [400, 401, 404, 409, 413]) {
      const error = new ApiError(status, "/api/points/remove", "POST", "No.");
      const { unmount } = render(
        <EditBar edit={pointEditing({ selected: new Set([0, 1]), removal: { run: vi.fn(), pending: false, error, reset: vi.fn() } })} onDone={() => undefined} />,
      );

      expect(screen.getByRole("button", { name: "Remove 2 points" }), String(status)).toBeDisabled();
      expect(screen.getByRole("button", { name: "Clear" }), String(status)).toBeEnabled(); // and the way back is there
      unmount();
    }
    const { rerender } = render(
      <EditBar
        edit={pointEditing({ selected: new Set([0, 1]), removal: { run: vi.fn(), pending: false, error: new ApiError(400, "/api/points/remove", "POST"), reset: vi.fn() } })}
        onDone={() => undefined}
      />,
    );
    expect(screen.getByRole("button", { name: "Remove 2 points" })).toBeDisabled();

    rerender(<EditBar edit={pointEditing({ selected: new Set([0]) })} onDone={() => undefined} />); // a point taken off: no error any more

    expect(screen.getByRole("button", { name: "Remove 1 point" })).toBeEnabled();
  });

  test("EditBar_puts_the_focus_on_clear_when_a_removal_is_refused_for_remove_is_off_and_had_it", () => {
    const refused = (status = 400) => pointEditing({ selected: new Set([0, 1]), removal: { run: vi.fn(), pending: false, error: new ApiError(status, "/api/points/remove", "POST", "No."), reset: vi.fn() } });
    const quiet = pointEditing({ selected: new Set([0, 1]) });

    // It had the focus when it was pressed: Clear is the way back.
    const first = render(<EditBar edit={quiet} onDone={() => undefined} />);
    screen.getByRole("button", { name: "Remove 2 points" }).focus();
    first.rerender(<EditBar edit={refused()} onDone={() => undefined} />);
    expect(screen.getByRole("button", { name: "Clear" })).toHaveFocus();
    first.unmount();

    // It was off while the request was on its way, and the focus had gone to the page with it.
    const second = render(<EditBar edit={quiet} onDone={() => undefined} />);
    expect(document.body).toHaveFocus();
    second.rerender(<EditBar edit={refused(409)} onDone={() => undefined} />);
    expect(screen.getByRole("button", { name: "Clear" })).toHaveFocus();
  });

  test("EditBar_leaves_the_focus_where_the_owner_has_put_it_when_a_removal_is_refused_and_for_a_failure_that_may_pass", () => {
    const withError = (status: number) =>
      pointEditing({ selected: new Set([0, 1]), removal: { run: vi.fn(), pending: false, error: new ApiError(status, "/api/points/remove", "POST", "No."), reset: vi.fn() } });
    const ui = (edit: ReturnType<typeof pointEditing>) => (
      <div>
        <button type="button">on the map</button>
        <EditBar edit={edit} onDone={() => undefined} />
      </div>
    );
    const { rerender } = render(ui(pointEditing({ selected: new Set([0, 1]) })));
    screen.getByRole("button", { name: "on the map" }).focus();

    rerender(ui(withError(400)));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "on the map" })); // not the bar's to take

    rerender(ui(pointEditing({ selected: new Set([0, 1]) })));
    screen.getByRole("button", { name: "Remove 2 points" }).focus();
    rerender(ui(withError(502))); // Remove is on: the focus is where it was
    expect(screen.getByRole("button", { name: "Remove 2 points" })).toHaveFocus();
  });

  test("EditBar_leaves_remove_on_for_a_failure_that_may_pass_which_is_sent_again_by_it_or_by_the_retry", () => {
    for (const error of [new ApiError(408, "/api/points/remove", "POST"), new ApiError(429, "/api/points/remove", "POST"), new ApiError(502, "/api/points/remove", "POST"), new TypeError("Failed to fetch")]) {
      const run = vi.fn();
      const { unmount } = render(<EditBar edit={pointEditing({ selected: new Set([0]), removal: { run, pending: false, error, reset: vi.fn() } })} onDone={() => undefined} />);

      fireEvent.click(screen.getByRole("button", { name: "Remove 1 point" }));

      expect(run, String(error)).toHaveBeenCalledTimes(1);
      unmount();
    }
  });

  test("EditBar_says_a_removal_that_failed_may_pass_with_a_retry_that_sends_it_again", () => {
    const run = vi.fn();
    const error = new ApiError(502, "/api/points/remove", "POST");
    render(<EditBar edit={pointEditing({ selected: new Set([0]), removal: { run, pending: false, error, reset: vi.fn() } })} onDone={() => undefined} />);

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Couldn't remove — Retry");
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));

    expect(run).toHaveBeenCalledTimes(1);
  });
});
