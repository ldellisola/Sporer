import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { ApiError } from "../api/client";
import { WriteError } from "./WriteError";

const failed = (status: number, detail: string | null = null) => new ApiError(status, "/api/places/2/merge", "POST", detail);

describe("WriteError", () => {
  test("WriteError_says_a_refusal_in_the_words_of_the_server_with_no_retry", () => {
    for (const status of [400, 401, 403, 404, 409, 415, 422]) {
      const { unmount } = render(<WriteError what="merge" error={failed(status, "The server's own words.")} onRetry={() => undefined} />);

      expect(screen.getByRole("alert"), String(status)).toHaveTextContent("Could not merge: The server's own words.");
      expect(screen.queryByRole("button", { name: "Retry" }), String(status)).not.toBeInTheDocument();
      unmount();
    }
  });

  test("WriteError_says_a_generic_line_for_a_refusal_with_no_message_and_what_is_gone_for_a_404_when_it_is_told", () => {
    const { rerender } = render(<WriteError what="merge" error={failed(409)} onRetry={() => undefined} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Could not merge: The server refused it.");

    rerender(<WriteError what="merge" error={failed(400)} onRetry={() => undefined} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Could not merge: The server did not accept it.");

    rerender(<WriteError what="merge" error={failed(404)} onRetry={() => undefined} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Could not merge: It no longer exists.");

    // Any other 4xx is a refusal too (P4-R29), and has a line of its own to say when the server gave none.
    for (const status of [401, 403, 415, 422]) {
      rerender(<WriteError what="merge" error={failed(status)} onRetry={() => undefined} />);
      expect(screen.getByRole("alert"), String(status)).toHaveTextContent("Could not merge: The server did not accept it.");
    }

    rerender(<WriteError what="merge" error={failed(404)} gone="One of the places no longer exists." onRetry={() => undefined} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Could not merge: One of the places no longer exists.");

    // The server's own message is what is shown, over what the control knows.
    rerender(<WriteError what="merge" error={failed(404, "Not here.")} gone="One of the places no longer exists." onRetry={() => undefined} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Could not merge: Not here.");
  });

  test("WriteError_says_what_a_409_is_when_the_server_gave_no_words_and_it_is_told", () => {
    const { rerender } = render(<WriteError what="save" error={failed(409)} conflict="Overlaps another trip." onRetry={() => undefined} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Could not save: Overlaps another trip.");

    // The server's own message is what is shown, over what the control knows; and the line is for a 409 and no other refusal.
    rerender(<WriteError what="save" error={failed(409, "The trip would have nights from 2026-09-12 to 2026-10-24.")} conflict="Overlaps another trip." onRetry={() => undefined} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Could not save: The trip would have nights from 2026-09-12 to 2026-10-24.");

    rerender(<WriteError what="save" error={failed(400)} conflict="Overlaps another trip." onRetry={() => undefined} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Could not save: The server did not accept it.");
  });

  test("WriteError_shows_what_else_can_be_done_about_a_refusal_and_only_there", () => {
    const { rerender } = render(<WriteError what="merge" error={failed(409, "No.")} onRetry={() => undefined} refusedActions={<button type="button">Choose another place</button>} />);
    expect(screen.getByRole("alert")).toContainElement(screen.getByRole("button", { name: "Choose another place" }));

    rerender(<WriteError what="merge" error={failed(500)} onRetry={() => undefined} refusedActions={<button type="button">Choose another place</button>} />);
    expect(screen.queryByRole("button", { name: "Choose another place" })).not.toBeInTheDocument(); // a failure that may pass is for Retry
  });

  test("WriteError_offers_a_retry_for_a_failure_that_may_pass_and_says_what_failed", () => {
    const failures: unknown[] = [failed(500), failed(502), failed(503), failed(408), failed(429), new TypeError("Failed to fetch"), "something else"];
    for (const error of failures) {
      const onRetry = vi.fn();
      const { unmount } = render(<WriteError what="rename" error={error} onRetry={onRetry} gone="Gone." />);

      expect(screen.getByRole("alert"), String(error)).toHaveTextContent("Couldn't rename — Retry");
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      expect(onRetry, String(error)).toHaveBeenCalledTimes(1);
      unmount();
    }
    render(<WriteError what="rename" error={failed(500)} onRetry={() => undefined} />);
    expect(screen.getByText("POST /api/places/2/merge failed with status 500")).toBeInTheDocument();
  });
});
