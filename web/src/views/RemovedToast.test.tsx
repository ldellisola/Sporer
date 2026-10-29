import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ApiError } from "../api/client";
import type { FailedRemoval } from "../app/useEditPoints";
import { pointEditing } from "../test/pointEditing";
import { RemovedToast } from "./RemovedToast";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

const REMOVED = { id: 1, kind: "removed", count: 3, batch: "b-1", date: "2026-10-22" } as const;
const noUndo = { run: vi.fn(), pending: false, error: null };

describe("RemovedToast", () => {
  test("RemovedToast_keeps_an_empty_status_while_there_is_nothing_to_say", () => {
    render(<RemovedToast edit={pointEditing()} />);

    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  });

  test("RemovedToast_says_how_many_points_were_removed_with_an_undo_that_undoes_it", () => {
    const edit = pointEditing({ toast: REMOVED, undo: { ...noUndo, run: vi.fn() } });
    render(<RemovedToast edit={edit} />);

    expect(screen.getByRole("status")).toHaveTextContent("Removed 3 points");
    fireEvent.click(within(screen.getByRole("status")).getByRole("button", { name: "Undo" }));
    expect(edit.undo.run).toHaveBeenCalledTimes(1);
  });

  test("RemovedToast_says_one_point_in_the_singular", () => {
    render(<RemovedToast edit={pointEditing({ toast: { ...REMOVED, count: 1 } })} />);

    expect(screen.getByRole("status")).toHaveTextContent("Removed 1 point");
    expect(screen.getByRole("status")).not.toHaveTextContent("Removed 1 points");
  });

  test("RemovedToast_goes_after_ten_seconds_by_telling_the_shell_to_dismiss_it", () => {
    const edit = pointEditing({ toast: REMOVED });
    render(<RemovedToast edit={edit} />);

    act(() => vi.advanceTimersByTime(9_999));
    expect(edit.dismiss).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(edit.dismiss).toHaveBeenCalledTimes(1);
  });

  test("RemovedToast_shows_that_the_undo_is_on_its_way_and_stays_while_it_is", () => {
    const edit = pointEditing({ toast: REMOVED, undo: { ...noUndo, pending: true } });
    render(<RemovedToast edit={edit} />);

    expect(screen.getByRole("button", { name: "Undoing…" })).toBeDisabled();
    act(() => vi.advanceTimersByTime(60_000));
    expect(edit.dismiss).not.toHaveBeenCalled(); // it would take away the toast of an undo that has not been heard of yet
  });

  test("RemovedToast_says_nothing_was_removed_when_the_points_were_gone_already_and_offers_no_undo", () => {
    render(<RemovedToast edit={pointEditing({ toast: { id: 2, kind: "none" } })} />);

    expect(screen.getByRole("status")).toHaveTextContent("Those points were removed already");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  test("RemovedToast_says_how_many_points_were_restored", () => {
    render(<RemovedToast edit={pointEditing({ toast: { id: 3, kind: "restored", count: 3 } })} />);

    expect(screen.getByRole("status")).toHaveTextContent("Restored 3 points");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  test("RemovedToast_says_an_undo_the_server_refused_in_its_own_words_with_no_retry_and_a_way_to_dismiss_it", () => {
    const error = new ApiError(404, "/api/points/removed/b-1", "DELETE", "That removal has been undone already.");
    const edit = pointEditing({ toast: REMOVED, undo: { ...noUndo, error } });
    render(<RemovedToast edit={edit} />);

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Could not undo: That removal has been undone already.");
    expect(within(alert).queryByRole("button", { name: "Retry" })).not.toBeInTheDocument(); // sent again it is refused again
    expect(screen.getByRole("status")).not.toContainElement(alert);
    act(() => vi.advanceTimersByTime(60_000));
    expect(edit.dismiss).not.toHaveBeenCalled(); // a failure is not taken away by the time

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" })); // under the message, in the same card
    expect(edit.dismiss).toHaveBeenCalledTimes(1);
  });

  test("RemovedToast_offers_no_undo_on_the_toast_once_an_undo_has_failed_so_that_a_refusal_cannot_be_sent_again", () => {
    // A refusal (404: it is restored already) is refused again; a failure that may pass has the Retry of its alert, and the toast's Undo would be a second way to the same.
    for (const status of [404, 409, 500, 503]) {
      const edit = pointEditing({ toast: REMOVED, undo: { ...noUndo, error: new ApiError(status, "/api/points/removed/b-1", "DELETE") } });
      const { unmount } = render(<RemovedToast edit={edit} />);

      expect(screen.getByRole("status"), String(status)).toHaveTextContent("Removed 3 points"); // what was done is still said
      expect(within(screen.getByRole("status")).queryByRole("button"), String(status)).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Undo" }), String(status)).not.toBeInTheDocument();
      unmount();
    }
  });

  test("RemovedToast_has_its_undo_back_when_the_failure_has_been_dismissed_or_there_is_none", () => {
    const { rerender } = render(<RemovedToast edit={pointEditing({ toast: REMOVED, undo: { ...noUndo, error: new ApiError(404, "/api/points/removed/b-1", "DELETE") } })} />);
    expect(screen.queryByRole("button", { name: "Undo" })).not.toBeInTheDocument();

    rerender(<RemovedToast edit={pointEditing({ toast: REMOVED })} />); // dismissed: the shell has reset the undo, and the next removal is a new toast

    expect(screen.getByRole("button", { name: "Undo" })).toBeEnabled();
  });

  test("RemovedToast_says_a_404_with_no_words_of_the_servers_as_what_it_is", () => {
    render(<RemovedToast edit={pointEditing({ toast: REMOVED, undo: { ...noUndo, error: new ApiError(404, "/api/points/removed/b-1", "DELETE") } })} />);

    expect(screen.getByRole("alert")).toHaveTextContent("Could not undo: That removal has been undone already.");
  });

  test("RemovedToast_says_an_undo_that_failed_may_pass_with_a_retry_and_a_way_to_dismiss_it", () => {
    const edit = pointEditing({ toast: REMOVED, undo: { ...noUndo, error: new ApiError(503, "/api/points/removed/b-1", "DELETE") } });
    render(<RemovedToast edit={edit} />);

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Couldn't undo — Retry");
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(edit.undo.run).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(edit.dismiss).toHaveBeenCalledTimes(1);
  });

  test("RemovedToast_does_not_take_the_focus_as_it_appears", () => {
    const { rerender } = render(
      <div>
        <button type="button">on the map</button>
        <RemovedToast edit={pointEditing()} />
      </div>,
    );
    screen.getByRole("button", { name: "on the map" }).focus();

    rerender(
      <div>
        <button type="button">on the map</button>
        <RemovedToast edit={pointEditing({ toast: REMOVED })} />
      </div>,
    );

    expect(document.activeElement).toBe(screen.getByRole("button", { name: "on the map" }));
  });
});

// P4-R32: a removal that failed after the owner had pressed Done is told here, wherever they are: in the words of P4-R28 (the server's for a refusal, with no Retry).
describe("RemovedToast a failed removal", () => {
  const failed = (error: Error, over: Partial<FailedRemoval> = {}): FailedRemoval => ({ count: 3, error, retrying: false, retry: vi.fn(), dismiss: vi.fn(), ...over });
  const post = (status: number, detail: string | null = null) => new ApiError(status, "/api/points/remove", "POST", detail);

  test("RemovedToast_says_a_removal_that_the_server_refused_in_its_own_words_with_no_retry_and_no_undo", () => {
    const failedRemoval = failed(post(400, "At most 50000 points can be removed at once."));
    render(<RemovedToast edit={pointEditing({ failedRemoval })} />);

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Could not remove 3 points: At most 50000 points can be removed at once.");
    expect(within(alert).queryByRole("button", { name: "Retry" })).not.toBeInTheDocument(); // sent again it is refused again
    expect(screen.queryByRole("button", { name: "Undo" })).not.toBeInTheDocument(); // nothing was removed
    expect(screen.getByRole("status")).toBeEmptyDOMElement();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(failedRemoval.dismiss).toHaveBeenCalledTimes(1);
  });

  test("RemovedToast_says_it_in_the_singular_and_with_a_line_of_its_own_for_a_refusal_with_no_words", () => {
    render(<RemovedToast edit={pointEditing({ failedRemoval: failed(post(409), { count: 1 }) })} />);

    expect(screen.getByRole("alert")).toHaveTextContent("Could not remove 1 point: The server refused it.");
  });

  test("RemovedToast_offers_a_retry_for_a_failure_that_may_pass_and_not_for_a_refusal", () => {
    for (const error of [post(500), post(502), post(408), post(429), new TypeError("Failed to fetch")]) {
      const failedRemoval = failed(error);
      const { unmount } = render(<RemovedToast edit={pointEditing({ failedRemoval })} />);

      const alert = screen.getByRole("alert");
      expect(alert, String(error)).toHaveTextContent("Couldn't remove 3 points — Retry");
      fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
      expect(failedRemoval.retry, String(error)).toHaveBeenCalledTimes(1);
      unmount();
    }
    for (const error of [post(400), post(403), post(404), post(409), post(415)]) {
      const { unmount } = render(<RemovedToast edit={pointEditing({ failedRemoval: failed(error) })} />);

      expect(within(screen.getByRole("alert")).queryByRole("button", { name: "Retry" }), String(error)).not.toBeInTheDocument();
      unmount();
    }
  });

  test("RemovedToast_says_the_removal_is_being_sent_again_and_has_no_buttons_for_that_while", () => {
    render(<RemovedToast edit={pointEditing({ failedRemoval: failed(post(503), { retrying: true }) })} />);

    expect(screen.getByText("Removing 3 points…")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  test("RemovedToast_shows_a_failed_removal_with_the_toast_of_another_that_went_through_and_leaves_its_undo", () => {
    const edit = pointEditing({ toast: REMOVED, failedRemoval: failed(post(400, "No.")) });
    render(<RemovedToast edit={edit} />);

    expect(screen.getByRole("alert")).toHaveTextContent("Could not remove 3 points: No.");
    fireEvent.click(within(screen.getByRole("status")).getByRole("button", { name: "Undo" })); // the one that went through can still be undone
    expect(edit.undo.run).toHaveBeenCalledTimes(1);
  });

  test("RemovedToast_does_not_take_the_focus_when_a_failed_removal_is_told", () => {
    const { rerender } = render(
      <div>
        <button type="button">on the map</button>
        <RemovedToast edit={pointEditing()} />
      </div>,
    );
    screen.getByRole("button", { name: "on the map" }).focus();

    rerender(
      <div>
        <button type="button">on the map</button>
        <RemovedToast edit={pointEditing({ failedRemoval: failed(post(503)) })} />
      </div>,
    );

    expect(document.activeElement).toBe(screen.getByRole("button", { name: "on the map" }));
  });

  test("RemovedToast_puts_the_focus_on_the_way_on_when_a_retry_fails_again_for_the_button_that_was_pressed_was_gone", () => {
    const ui = (failedRemoval: FailedRemoval) => <RemovedToast edit={pointEditing({ failedRemoval })} />;
    const { rerender } = render(ui(failed(post(503))));
    screen.getByRole("button", { name: "Retry" }).focus();
    rerender(ui(failed(post(503), { retrying: true }))); // pressed: the card says it is sending, and the button is gone with the focus
    expect(document.body).toHaveFocus();

    rerender(ui(failed(post(502)))); // failed again, for a reason that may pass

    expect(screen.getByRole("button", { name: "Retry" })).toHaveFocus();

    rerender(ui(failed(post(503), { retrying: true })));
    rerender(ui(failed(post(400, "No.")))); // and a refusal this time: there is no Retry

    expect(screen.getByRole("button", { name: "Dismiss" })).toHaveFocus();
  });
});

// The Undo button is gone once an undo has failed, and the focus was on it.
describe("RemovedToast focus after a failed undo", () => {
  const withError = (status: number) => pointEditing({ toast: REMOVED, undo: { ...noUndo, error: new ApiError(status, "/api/points/removed/b-1", "DELETE") } });

  test("RemovedToast_puts_the_focus_on_retry_when_an_undo_fails_for_a_reason_that_may_pass_and_on_dismiss_when_it_is_refused", () => {
    for (const [status, name] of [[503, "Retry"], [502, "Retry"], [404, "Dismiss"], [409, "Dismiss"]] as const) {
      const { rerender, unmount } = render(<RemovedToast edit={pointEditing({ toast: REMOVED })} />);
      screen.getByRole("button", { name: "Undo" }).focus();

      rerender(<RemovedToast edit={withError(status)} />); // the undo failed: the button went, and the focus with it

      expect(screen.getByRole("button", { name }), String(status)).toHaveFocus();
      unmount();
    }
  });

  test("RemovedToast_does_not_move_the_focus_that_the_owner_has_put_elsewhere_when_an_undo_fails", () => {
    const { rerender } = render(
      <div>
        <button type="button">on the map</button>
        <RemovedToast edit={pointEditing({ toast: REMOVED })} />
      </div>,
    );
    screen.getByRole("button", { name: "on the map" }).focus();

    rerender(
      <div>
        <button type="button">on the map</button>
        <RemovedToast edit={withError(503)} />
      </div>,
    );

    expect(document.activeElement).toBe(screen.getByRole("button", { name: "on the map" }));
  });
});
