import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { SettingsNotes, useNote, type NoteData } from "./SettingsNotes";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/** A section of the settings that says `note` (null: nothing), and is told when its time is up. */
function Says({ note, onDismiss = () => undefined }: { note: NoteData | null; onDismiss?: () => void }) {
  useNote(note, onDismiss);
  return null;
}

const status = () => screen.getByRole("status");
const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

describe("SettingsNotes", () => {
  test("SettingsNotes_has_one_status_that_is_empty_until_a_section_says_something_and_is_the_same_element_after", () => {
    const { rerender } = render(
      <SettingsNotes>
        <Says note={null} />
        <Says note={null} />
      </SettingsNotes>,
    );
    const live = status();
    expect(screen.getAllByRole("status")).toHaveLength(1); // however many sections there are
    expect(live).toBeEmptyDOMElement(); // there before the message is: a live region is announced when what is in it changes

    rerender(
      <SettingsNotes>
        <Says note={{ id: 1, message: "Restored 3 points" }} />
        <Says note={null} />
      </SettingsNotes>,
    );

    expect(status()).toBe(live);
    expect(live).toHaveTextContent("Restored 3 points");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  test("SettingsNotes_takes_the_note_off_when_the_section_stops_saying_it_and_when_the_section_goes", () => {
    const { rerender } = render(
      <SettingsNotes>
        <Says note={{ id: 1, message: "One" }} />
      </SettingsNotes>,
    );
    expect(status()).toHaveTextContent("One");

    rerender(
      <SettingsNotes>
        <Says note={null} />
      </SettingsNotes>,
    );
    expect(status()).toBeEmptyDOMElement();

    rerender(
      <SettingsNotes>
        <Says note={{ id: 2, message: "Two" }} />
      </SettingsNotes>,
    );
    expect(status()).toHaveTextContent("Two");

    rerender(<SettingsNotes>{null}</SettingsNotes>);
    expect(status()).toBeEmptyDOMElement();
  });

  test("SettingsNotes_tells_the_section_when_the_time_of_its_note_is_up_which_is_ten_seconds_and_calls_the_latest_callback", async () => {
    const first = vi.fn();
    const latest = vi.fn();
    const { rerender } = render(
      <SettingsNotes>
        <Says note={{ id: 1, message: "One" }} onDismiss={first} />
      </SettingsNotes>,
    );
    rerender(
      <SettingsNotes>
        <Says note={{ id: 1, message: "One" }} onDismiss={latest} /> {/* the same note, with another callback: the note does not start again */}
      </SettingsNotes>,
    );

    await advance(9_999);
    expect(latest).not.toHaveBeenCalled();
    await advance(1);

    expect(latest).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });

  test("SettingsNotes_shows_the_note_that_came_last_in_place_of_the_one_before_with_its_whole_time_and_leaves_the_first_section_alone", async () => {
    const dismissA = vi.fn();
    const dismissB = vi.fn();
    const view = (a: NoteData | null, b: NoteData | null) => (
      <SettingsNotes>
        <Says note={a} onDismiss={dismissA} />
        <Says note={b} onDismiss={dismissB} />
      </SettingsNotes>
    );
    const { rerender } = render(view({ id: 1, message: "From A" }, null));
    await advance(6_000);

    // B says something, with the same id: another section's note is another note, and has its own time.
    rerender(view({ id: 1, message: "From A" }, { id: 1, message: "From B" }));
    expect(status()).toHaveTextContent("From B");
    expect(status()).not.toHaveTextContent("From A");
    await advance(6_000); // 12 s since A's, 6 since B's

    expect(status()).toHaveTextContent("From B");
    expect(dismissA).not.toHaveBeenCalled(); // A was replaced, and its time is not what ends B's
    expect(dismissB).not.toHaveBeenCalled();
    await advance(4_000);

    expect(dismissB).toHaveBeenCalledTimes(1);
    expect(dismissA).not.toHaveBeenCalled();
  });

  test("SettingsNotes_takes_another_id_of_the_same_section_as_another_note_with_its_whole_time", async () => {
    const dismiss = vi.fn();
    const view = (note: NoteData) => (
      <SettingsNotes>
        <Says note={note} onDismiss={dismiss} />
      </SettingsNotes>
    );
    const { rerender } = render(view({ id: 1, message: "Retrying 1 period" }));
    await advance(8_000);

    rerender(view({ id: 2, message: "Retrying 2 periods" }));
    await advance(8_000);

    expect(status()).toHaveTextContent("Retrying 2 periods");
    expect(dismiss).not.toHaveBeenCalled();
    await advance(2_000);
    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  test("SettingsNotes_says_that_a_note_needs_the_settings_to_be_said_in", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined); // React logs what is thrown while rendering
    expect(() => render(<Says note={{ id: 1, message: "Lost" }} />)).toThrow("useNote is used inside SettingsNotes");
    error.mockRestore();
  });
});
