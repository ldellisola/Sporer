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
