import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ApiError } from "../api/client";
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
