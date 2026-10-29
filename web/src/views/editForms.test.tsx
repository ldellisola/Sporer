import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { EditActions, focusLost } from "./editForms";

type Key = "first" | "second";

function actions(onFirst = vi.fn(), onSecond = vi.fn()) {
  return [
    { key: "first", label: "First thing", onClick: onFirst },
    { key: "second", label: "Second thing", onClick: onSecond },
  ] as const satisfies readonly { key: Key; label: string; onClick: () => void }[];
}

describe("EditActions", () => {
  test("EditActions_has_a_button_for_each_action_in_order_and_says_which_was_pressed", () => {
    const onFirst = vi.fn();
    const onSecond = vi.fn();
    render(<EditActions actions={actions(onFirst, onSecond)} />);

    expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual(["First thing", "Second thing"]);
    fireEvent.click(screen.getByRole("button", { name: "First thing" }));
    expect([onFirst.mock.calls.length, onSecond.mock.calls.length]).toEqual([1, 0]);
    fireEvent.click(screen.getByRole("button", { name: "Second thing" }));
    expect([onFirst.mock.calls.length, onSecond.mock.calls.length]).toEqual([1, 1]);
  });

  test("EditActions_puts_the_focus_on_the_button_that_opened_the_form_that_was_closed_and_nowhere_when_it_is_not_told", () => {
    const { unmount } = render(<EditActions actions={actions()} />);
    expect(document.body).toHaveFocus(); // as the panel opens: nothing was pressed
    unmount();

    const first = render(<EditActions actions={actions()} focus="first" />);
    expect(screen.getByRole("button", { name: "First thing" })).toHaveFocus();
    first.unmount();

    render(<EditActions actions={actions()} focus="second" />);
    expect(screen.getByRole("button", { name: "Second thing" })).toHaveFocus();
  });

  test("EditActions_moves_the_focus_when_it_is_told_another_button_and_leaves_it_when_the_buttons_are_made_again", () => {
    const { rerender } = render(<EditActions actions={actions()} focus="first" />);
    screen.getByRole("button", { name: "Second thing" }).focus(); // the owner has gone on

    rerender(<EditActions actions={actions()} focus="first" />);
    expect(screen.getByRole("button", { name: "Second thing" })).toHaveFocus(); // the same request is not made again

    rerender(<EditActions actions={actions()} focus="second" />);
    expect(screen.getByRole("button", { name: "Second thing" })).toHaveFocus();
  });
});

describe("focusLost", () => {
  test("focusLost_is_true_when_the_page_has_the_focus_and_false_when_a_control_has_it", () => {
    render(<button type="button">a control</button>);
    expect(focusLost()).toBe(true);

    screen.getByRole("button").focus();
    expect(focusLost()).toBe(false);

    screen.getByRole("button").blur();
    expect(focusLost()).toBe(true);
  });
});
