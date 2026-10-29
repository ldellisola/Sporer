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

  test("EditBar_says_the_points_are_on_their_way_in_its_row", () => {
    render(<EditBar edit={pointEditing({ points: undefined, load: { pending: true, error: null, retry: vi.fn() } })} onDone={() => undefined} />);

    const row = screen.getByText("Loading points…");
    expect(row).toBeInTheDocument();
    expect(row.closest("p")).toBeNull(); // in the row, with the buttons: a sheet at its lowest shows nothing under it
    expect(row.parentElement).toContainElement(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByText(/selected/)).not.toBeInTheDocument(); // there is nothing to count yet
    expect(screen.queryByText(/Tap a point/)).not.toBeInTheDocument();
  });

  test("EditBar_says_the_points_could_not_be_had_with_a_retry_in_its_row_and_keeps_done", () => {
    const retry = vi.fn();
    render(
      <EditBar
        edit={pointEditing({ points: undefined, load: { pending: false, error: new ApiError(503, "/api/day/2026-10-22/points"), retry } })}
        onDone={() => undefined}
      />,
    );

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Couldn't load the points — Retry");
    expect(alert.parentElement).toContainElement(screen.getByRole("button", { name: "Done" })); // in the row, where the sheet at its lowest shows it
    expect(screen.queryByText(/selected/)).not.toBeInTheDocument();
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Done" })).toBeEnabled();
  });

  test("EditBar_says_what_failed_under_its_row_and_not_in_it", () => {
    render(
      <EditBar
        edit={pointEditing({ points: undefined, load: { pending: false, error: new ApiError(503, "/api/day/2026-10-22/points"), retry: vi.fn() } })}
        onDone={() => undefined}
      />,
    );

    const detail = screen.getByText("GET /api/day/2026-10-22/points failed with status 503");
    expect(detail).toBeInTheDocument();
    expect(screen.getByRole("alert")).not.toContainElement(detail); // the row has the words and the Retry: the line under it is for whoever reads on
    expect(screen.getByRole("button", { name: "Done" }).compareDocumentPosition(detail) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy(); // under the row, after its buttons
  });

  test("EditBar_says_a_day_has_no_points_when_the_server_has_none_for_it_in_its_row", () => {
    render(<EditBar edit={pointEditing({ points: { date: "2026-10-22", devices: [], points: [] } })} onDone={() => undefined} />);

    const row = screen.getByText("No points on this day");
    expect(row.parentElement).toContainElement(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByText(/selected/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Tap a point/)).not.toBeInTheDocument();
  });

  test("EditBar_has_only_done_while_there_are_no_points_to_select_which_is_while_they_load_when_they_could_not_be_had_and_when_the_day_has_none", () => {
    const states = {
      loading: pointEditing({ points: undefined, load: { pending: true, error: null, retry: vi.fn() } }),
      failed: pointEditing({ points: undefined, load: { pending: false, error: new ApiError(503, "/api/day/2026-10-22/points"), retry: vi.fn() } }),
      none: pointEditing({ points: { date: "2026-10-22", devices: [], points: [] } }),
    };
    for (const [state, edit] of Object.entries(states)) {
      const { unmount } = render(<EditBar edit={edit} onDone={() => undefined} />);

      expect(within(group()).getAllByRole("button").map((button) => button.textContent), state).toEqual(state === "failed" ? ["Retry", "Done"] : ["Done"]);
      expect(screen.getByRole("button", { name: "Done" }), state).toBeEnabled();
      unmount();
    }
  });

  test("EditBar_has_clear_remove_and_done_once_the_points_are_there", () => {
    const { rerender } = render(<EditBar edit={pointEditing({ points: undefined, load: { pending: true, error: null, retry: vi.fn() } })} onDone={() => undefined} />);
    expect(screen.queryByRole("button", { name: "Clear" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Remove/ })).not.toBeInTheDocument();

    rerender(<EditBar edit={pointEditing()} onDone={() => undefined} />); // the points came

    expect(within(group()).getAllByRole("button").map((button) => button.textContent)).toEqual(["Clear", "Remove 0 points", "Done"]);
    expect(screen.getByText("0 selected")).toBeInTheDocument();
    expect(screen.queryByText("Loading points…")).not.toBeInTheDocument();
  });

  test("EditBar_says_a_later_failed_load_in_its_row_in_the_place_of_the_count_and_keeps_clear_remove_and_done", () => {
    // A refetch that failed (the points of the day are asked for again after a removal or an Undo): what is on screen is still there to select, and a sheet at its
    // lowest shows the row and nothing under it, so the words and the Retry are in the row as they are for a first load that failed.
    const retry = vi.fn();
    render(
      <EditBar
        edit={pointEditing({ selected: new Set([0, 1]), load: { pending: false, error: new ApiError(503, "/api/day/2026-10-22/points"), retry } })}
        onDone={() => undefined}
      />,
    );

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Couldn't load the points — Retry");
    expect(alert.parentElement).toContainElement(screen.getByRole("button", { name: "Done" })); // in the row, where the sheet at its lowest shows it
    expect(within(group()).getAllByRole("button").map((button) => button.textContent)).toEqual(["Retry", "Clear", "Remove 2 points", "Done"]);
    expect(screen.getByRole("button", { name: "Clear" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Remove 2 points" })).toBeEnabled();
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  test("EditBar_says_what_a_later_load_failed_with_under_its_row_as_for_the_first_and_has_no_second_alert", () => {
    render(
      <EditBar
        edit={pointEditing({ selected: new Set([0]), load: { pending: false, error: new ApiError(503, "/api/day/2026-10-22/points"), retry: vi.fn() } })}
        onDone={() => undefined}
      />,
    );

    const detail = screen.getByText("GET /api/day/2026-10-22/points failed with status 503");
    expect(screen.getAllByRole("alert")).toHaveLength(1); // the one in the row: nothing under it that a sheet at its lowest would hide
    expect(screen.getByRole("alert")).not.toContainElement(detail);
    expect(screen.getByRole("button", { name: "Done" }).compareDocumentPosition(detail) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy(); // under the row, after its buttons
  });

  test("EditBar_keeps_the_count_in_the_page_for_a_screen_reader_while_a_later_load_failure_takes_its_place_on_screen", () => {
    const failed = (selected: number[]) =>
      pointEditing({ selected: new Set(selected), load: { pending: false, error: new ApiError(503, "/api/day/2026-10-22/points"), retry: vi.fn() } });
    const { rerender } = render(<EditBar edit={pointEditing({ selected: new Set([0, 1]) })} onDone={() => undefined} />);
    const count = screen.getByText("2 selected");
    expect(count).not.toHaveClass("heardOnly");

    rerender(<EditBar edit={failed([0, 1])} onDone={() => undefined} />);

    expect(screen.getByText("2 selected")).toBe(count); // the same live region, which is not mounted again with its words (that may be said twice)
    expect(count).toHaveAttribute("aria-live", "polite");
    expect(count).toHaveClass("heardOnly"); // not on screen: the row has the alert in its place

    rerender(<EditBar edit={failed([0, 1, 2])} onDone={() => undefined} />);

    expect(screen.getByText("3 selected")).toBe(count); // and what is tapped while the alert is there is still said

    rerender(<EditBar edit={pointEditing({ selected: new Set([0, 1, 2]) })} onDone={() => undefined} />); // the retry went through

    expect(screen.getByText("3 selected")).toBe(count);
    expect(count).not.toHaveClass("heardOnly");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  test("EditBar_has_the_one_live_region_for_what_its_row_says_of_the_points_and_of_the_count", () => {
    const { rerender } = render(<EditBar edit={pointEditing({ points: undefined, load: { pending: true, error: null, retry: vi.fn() } })} onDone={() => undefined} />);
    const region = screen.getByText("Loading points…");
    expect(region).toHaveAttribute("aria-live", "polite");

    rerender(<EditBar edit={pointEditing({ selected: new Set([1]) })} onDone={() => undefined} />);

    expect(screen.getByText("1 selected")).toBe(region); // mounted already when the points come: the count is heard as it changes
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

  describe("the focus", () => {
    const sent = (over: Partial<ReturnType<typeof pointEditing>> = {}) =>
      pointEditing({ selected: new Set([0, 1]), removal: { run: vi.fn(), pending: true, error: null, reset: vi.fn() }, ...over });
    const failed = (status = 503) =>
      pointEditing({ selected: new Set([0, 1]), removal: { run: vi.fn(), pending: false, error: new ApiError(status, "/api/points/remove", "POST"), reset: vi.fn() } });
    const removed = () => pointEditing({ selected: new Set() }); // sent and gone through: the selection is cleared
    const ui = (edit: ReturnType<typeof pointEditing>) => (
      <div>
        <button type="button">on the map</button>
        <EditBar edit={edit} onDone={() => undefined} />
      </div>
    );

    test("EditBar_puts_the_focus_on_done_when_a_removal_has_gone_through_and_the_focus_was_lost_with_the_button_that_was_pressed", () => {
      const { rerender } = render(<EditBar edit={pointEditing({ selected: new Set([0, 1]) })} onDone={() => undefined} />);
      expect(document.body).toHaveFocus();

      rerender(<EditBar edit={sent()} onDone={() => undefined} />);
      expect(document.body).toHaveFocus(); // not while it is on its way: the focus is looked at when the answer is there

      rerender(<EditBar edit={removed()} onDone={() => undefined} />);

      expect(screen.getByRole("button", { name: "Clear" })).toBeDisabled(); // nothing is selected: Done is the one button that is on
      expect(screen.getByRole("button", { name: "Done" })).toHaveFocus();
    });

    test("EditBar_puts_the_focus_on_clear_when_a_removal_failed_with_the_selection_still_there_and_the_focus_was_lost", () => {
      for (const status of [503, 408, 429]) {
        const { rerender, unmount } = render(<EditBar edit={sent()} onDone={() => undefined} />);
        expect(document.body).toHaveFocus();

        rerender(<EditBar edit={failed(status)} onDone={() => undefined} />);

        expect(screen.getByRole("button", { name: "Clear" }), String(status)).toBeEnabled();
        expect(screen.getByRole("button", { name: "Clear" }), String(status)).toHaveFocus();
        unmount();
      }
    });

    test("EditBar_takes_the_focus_from_remove_when_remove_is_off_and_had_it_which_a_browser_that_keeps_it_on_a_disabled_button_does", () => {
      const quiet = pointEditing({ selected: new Set([0, 1]) });
      const { rerender } = render(<EditBar edit={quiet} onDone={() => undefined} />);
      screen.getByRole("button", { name: "Remove 2 points" }).focus();

      rerender(<EditBar edit={sent()} onDone={() => undefined} />);
      rerender(<EditBar edit={removed()} onDone={() => undefined} />);

      expect(screen.getByRole("button", { name: "Done" })).toHaveFocus();
    });

    test("EditBar_leaves_the_focus_where_the_owner_has_put_it_when_a_removal_stops_being_on_its_way", () => {
      for (const after of [removed(), failed()]) {
        const { rerender, unmount } = render(ui(sent()));
        screen.getByRole("button", { name: "on the map" }).focus();

        rerender(ui(after));

        expect(screen.getByRole("button", { name: "on the map" })).toHaveFocus();
        unmount();
      }
      // A button of a toast, or the Undo that it has, is another's as well.
      const toast = render(
        <div>
          <EditBar edit={sent()} onDone={() => undefined} />
          <button type="button">Undo</button>
        </div>,
      );
      screen.getByRole("button", { name: "Undo" }).focus();
      toast.rerender(
        <div>
          <EditBar edit={removed()} onDone={() => undefined} />
          <button type="button">Undo</button>
        </div>,
      );
      expect(screen.getByRole("button", { name: "Undo" })).toHaveFocus();
    });

    test("EditBar_leaves_the_focus_on_a_button_of_the_bar_where_it_is_when_a_removal_stops_being_on_its_way", () => {
      const { rerender } = render(<EditBar edit={sent()} onDone={() => undefined} />);
      screen.getByRole("button", { name: "Done" }).focus();

      rerender(<EditBar edit={removed()} onDone={() => undefined} />);

      expect(screen.getByRole("button", { name: "Done" })).toHaveFocus();
    });

    test("EditBar_puts_the_focus_on_done_when_the_points_to_select_are_gone_with_the_buttons_that_had_the_focus", () => {
      const gone = {
        "the day has none now": pointEditing({ points: { date: "2026-10-22", devices: [], points: [] } }),
        "they are on their way again": pointEditing({ points: undefined, load: { pending: true, error: null, retry: vi.fn() } }),
      };
      for (const [state, edit] of Object.entries(gone)) {
        for (const name of ["Clear", "Remove 1 point"]) {
          const { rerender, unmount } = render(<EditBar edit={pointEditing({ selected: new Set([0]) })} onDone={() => undefined} />);
          screen.getByRole("button", { name }).focus();
          expect(screen.getByRole("button", { name })).toHaveFocus();

          rerender(<EditBar edit={edit} onDone={() => undefined} />);

          expect(screen.queryByRole("button", { name: "Clear" }), state).not.toBeInTheDocument();
          expect(screen.getByRole("button", { name: "Done" }), `${state}, ${name}`).toHaveFocus();
          unmount();
        }
      }
    });

    test("EditBar_leaves_the_focus_where_the_owner_has_put_it_when_the_points_to_select_are_gone", () => {
      const { rerender } = render(ui(pointEditing({ selected: new Set([0]) })));
      screen.getByRole("button", { name: "on the map" }).focus();

      rerender(ui(pointEditing({ points: { date: "2026-10-22", devices: [], points: [] } })));

      expect(screen.getByRole("button", { name: "on the map" })).toHaveFocus();
    });

    test("EditBar_takes_no_focus_when_it_appears_or_when_the_points_come_or_while_nothing_has_changed", () => {
      const { rerender } = render(<EditBar edit={pointEditing({ points: undefined, load: { pending: true, error: null, retry: vi.fn() } })} onDone={() => undefined} />);
      expect(document.body).toHaveFocus();

      rerender(<EditBar edit={pointEditing()} onDone={() => undefined} />); // the points came: there is something to select, which is the map's to do

      expect(document.body).toHaveFocus();

      rerender(<EditBar edit={pointEditing({ selected: new Set([2]) })} onDone={() => undefined} />); // a tap

      expect(document.body).toHaveFocus();
    });
  });
});
