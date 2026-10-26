import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { Shown } from "./Shown";

describe("Shown", () => {
  test("Shown_holds_what_it_is_given_and_says_when_it_is_busy", () => {
    const { container, rerender } = render(<Shown busy={false}>the week</Shown>);
    expect(screen.getByText("the week")).toBeInTheDocument();
    expect(container.firstElementChild).toHaveAttribute("aria-busy", "false");

    rerender(<Shown busy>the week</Shown>); // another week is on its way: this one stays, and is not the one asked for

    expect(screen.getByText("the week")).toBeInTheDocument();
    expect(container.firstElementChild).toHaveAttribute("aria-busy", "true");
  });
});
