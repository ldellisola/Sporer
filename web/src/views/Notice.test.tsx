import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { Notice } from "./Notice";

describe("Notice", () => {
  test("Notice_says_what_it_is_given_and_has_no_retry_unless_asked", () => {
    render(<Notice>Map unavailable</Notice>);

    expect(screen.getByRole("status")).toHaveTextContent("Map unavailable");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  test("Notice_with_a_way_to_try_again_ends_in_the_retry_button_that_the_errors_of_the_panels_have", () => {
    const onRetry = vi.fn();
    render(
      <Notice tone="error" onRetry={onRetry}>
        Couldn't load the heat map
      </Notice>,
    );

    expect(screen.getByRole("status")).toHaveTextContent("Couldn't load the heat map — Retry");
    expect(onRetry).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
