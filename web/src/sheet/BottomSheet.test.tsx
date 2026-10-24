import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { BottomSheet } from "./BottomSheet";

// A viewport of 800 px makes the snap points 96 (peek), 400 (half) and 680 (full: the viewport less 120).
const PEEK = 96;
const HALF = 400;
const FULL = 680;

let clock = 0;

beforeEach(() => {
  clock = 1_000;
  vi.stubGlobal("innerHeight", 800);
});

afterEach(() => {
  vi.useRealTimers();
});

function renderSheet() {
  const onHeightChange = vi.fn<(height: number) => void>();
  const view = render(
    <BottomSheet onHeightChange={onHeightChange}>
      <p>Panel</p>
    </BottomSheet>,
  );
  const sheet = screen.getByRole("region", { name: "Details" });
  return { ...view, onHeightChange, sheet };
}

const grip = () => screen.getByRole("button", { name: "Resize panel" });
const content = () => screen.getByText("Panel").parentElement!;
/** How much of the sheet is on the screen: it is as tall as its largest point and moved down by the rest. */
function visibleHeight(sheet: HTMLElement): number {
  const moved = /translateY\((-?[\d.]+)px\)/.exec(sheet.style.transform);
  return parseFloat(sheet.style.height) - Number(moved![1]);
}

const pointer = (extra: object) => ({ pointerId: 1, isPrimary: true, pointerType: "touch", button: 0, clientX: 100, ...extra });

// The speed of a drag is measured on the time stamps of its events, which the tests set by hand from `clock`.
function send(type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel", target: Element | Window, init: object): void {
  const event = new PointerEvent(type, { bubbles: true, cancelable: true, ...init });
  Object.defineProperty(event, "timeStamp", { value: clock });
  fireEvent(target, event);
}
const down = (target: Element | Window, init: object) => send("pointerdown", target, init);
const move = (target: Element | Window, init: object) => send("pointermove", target, init);
const up = (target: Element | Window, init: object) => send("pointerup", target, init);
const cancel = (target: Element | Window, init: object) => send("pointercancel", target, init);

/** A finger from `fromY` to `toY` over `ms`, in five moves a fifth of that apart (whole numbers, so that speeds come out exact). */
function drag(target: Element, fromY: number, toY: number, ms: number) {
  const steps = 5;
  down(target, pointer({ clientY: fromY }));
  for (let step = 1; step <= steps; step += 1) {
    clock += ms / steps;
    move(target, pointer({ clientY: fromY + ((toY - fromY) * step) / steps }));
  }
  up(target, pointer({ clientY: toY }));
}

const lastHeight = (onHeightChange: ReturnType<typeof renderSheet>["onHeightChange"]) => onHeightChange.mock.calls.at(-1)?.[0];

describe("BottomSheet", () => {
  test("BottomSheet_is_a_non_modal_panel_that_starts_at_its_peek", () => {
    const { sheet, onHeightChange } = renderSheet();

    expect(sheet).toBeVisible();
    expect(sheet).not.toHaveAttribute("aria-modal");
    expect(sheet).toHaveAttribute("data-snap", "peek");
    expect(screen.getByText("Panel")).toBeInTheDocument();
    expect(onHeightChange).toHaveBeenCalledTimes(1);
    expect(onHeightChange).toHaveBeenLastCalledWith(PEEK);
    expect(visibleHeight(sheet)).toBe(PEEK);
    expect(sheet.style.height).toBe(`${FULL}px`);
  });

  test("BottomSheet_snaps_to_nearest_and_by_flick", () => {
    const { sheet, onHeightChange } = renderSheet();

    // Slowly, and let go in between two points: the nearer one wins.
    drag(grip(), 700, 520, 1000); // 180 px up: 276, nearer half than peek
    expect(lastHeight(onHeightChange)).toBe(HALF);
    expect(sheet).toHaveAttribute("data-snap", "half");
    drag(grip(), 500, 400, 800); // 100 px up: 500, nearer half than full
    expect(lastHeight(onHeightChange)).toBe(HALF);
    drag(grip(), 500, 200, 1500); // 300 px up: 700, past full, which is as far as it goes
    expect(lastHeight(onHeightChange)).toBe(FULL);
    expect(sheet).toHaveAttribute("data-snap", "full");
    drag(grip(), 100, 500, 2000); // 400 px down: 280, nearer half than peek
    expect(lastHeight(onHeightChange)).toBe(HALF);
    drag(grip(), 300, 800, 2000); // 500 px down: below peek, which is as far as it goes
    expect(lastHeight(onHeightChange)).toBe(PEEK);

    // A flick (faster than 0.5 px/ms) goes on to the next point in its direction, whichever is nearer.
    drag(grip(), 700, 640, 100); // 0.6 px/ms up: only 156 px high, nearer peek, but a flick up: half
    expect(lastHeight(onHeightChange)).toBe(HALF);
    drag(grip(), 400, 360, 50); // 0.8 px/ms up: 440, nearer half, but a flick up: full
    expect(lastHeight(onHeightChange)).toBe(FULL);
    drag(grip(), 100, 140, 50); // 0.8 px/ms down: 640, nearer full, but a flick down: half
    expect(lastHeight(onHeightChange)).toBe(HALF);
    drag(grip(), 400, 430, 40); // 0.75 px/ms down: 370, nearer half, but a flick down: peek
    expect(lastHeight(onHeightChange)).toBe(PEEK);

    // Nothing lies beyond the ends.
    drag(grip(), 700, 640, 100);
    drag(grip(), 400, 360, 50);
    expect(lastHeight(onHeightChange)).toBe(FULL);
    drag(grip(), 700, 640, 100); // up again, at full
    expect(lastHeight(onHeightChange)).toBe(FULL);
    expect(sheet).toHaveAttribute("data-snap", "full");
  });

  test("BottomSheet_a_drag_of_exactly_0_5px_per_ms_is_no_flick", () => {
    const { onHeightChange } = renderSheet();

    drag(grip(), 700, 650, 100); // 50 px in 100 ms: 146 high, nearer peek

    expect(lastHeight(onHeightChange)).toBe(PEEK);
  });

  test("BottomSheet_judges_the_speed_at_the_end_of_the_drag_not_its_average", () => {
    const { onHeightChange } = renderSheet();

    // Fast at first (100 px in 50 ms), then the finger rests for half a second before it lets go: no flick, so the nearer point.
    down(grip(), pointer({ clientY: 700 }));
    clock += 50;
    move(grip(), pointer({ clientY: 600 }));
    clock += 500;
    up(grip(), pointer({ clientY: 600 })); // 196 high: nearer peek
    expect(lastHeight(onHeightChange)).toBe(PEEK);

    // Slow at first (10 px in half a second), then a quick stroke (50 px in 40 ms) as it lets go: a flick, whatever the average.
    down(grip(), pointer({ clientY: 700 }));
    clock += 500;
    move(grip(), pointer({ clientY: 690 }));
    clock += 20;
    move(grip(), pointer({ clientY: 665 }));
    clock += 20;
    move(grip(), pointer({ clientY: 640 }));
    up(grip(), pointer({ clientY: 640 })); // 156 high: nearer peek, but a flick up
    expect(lastHeight(onHeightChange)).toBe(HALF);
  });

  test("BottomSheet_follows_the_finger_and_tells_where_it_came_to_rest_not_every_step", () => {
    const { sheet, onHeightChange } = renderSheet();

    down(grip(), pointer({ clientY: 700 }));
    clock += 100;
    move(grip(), pointer({ clientY: 600 })); // 100 px up
    expect(visibleHeight(sheet)).toBe(PEEK + 100);
    expect(sheet).toHaveAttribute("data-dragging", "true");
    clock += 100;
    move(grip(), pointer({ clientY: 500 }));
    expect(visibleHeight(sheet)).toBe(PEEK + 200);
    expect(onHeightChange).toHaveBeenCalledTimes(1); // only the first, at the peek: the map does not chase a finger

    up(grip(), pointer({ clientY: 500 }));

    expect(sheet).toHaveAttribute("data-dragging", "false");
    expect(visibleHeight(sheet)).toBe(HALF);
    expect(onHeightChange).toHaveBeenCalledTimes(2);
  });

  test("BottomSheet_cannot_be_pulled_past_its_ends", () => {
    const { sheet } = renderSheet();

    down(grip(), pointer({ clientY: 700 }));
    clock += 100;
    move(grip(), pointer({ clientY: 0 }));
    expect(visibleHeight(sheet)).toBe(FULL);
    clock += 100;
    move(grip(), pointer({ clientY: 1000 }));
    expect(visibleHeight(sheet)).toBe(PEEK);
    cancel(grip(), pointer({}));
  });

  test("BottomSheet_follows_a_pointer_that_has_left_the_sheet", () => {
    const { sheet, onHeightChange } = renderSheet();

    // A mouse that is pulled up fast is on the map in the next event, not on the sheet any more.
    down(grip(), pointer({ clientY: 700, pointerType: "mouse" }));
    clock += 100;
    move(document.body, pointer({ clientY: 500, pointerType: "mouse" }));
    expect(visibleHeight(sheet)).toBe(PEEK + 200);
    up(document.body, pointer({ clientY: 500, pointerType: "mouse" }));

    expect(lastHeight(onHeightChange)).toBe(HALF);
  });

  test("BottomSheet_takes_its_listeners_off_the_window_when_a_drag_ends_or_the_sheet_goes", () => {
    const added = vi.spyOn(window, "addEventListener");
    const removed = vi.spyOn(window, "removeEventListener");
    const names = (spy: typeof added) => spy.mock.calls.map(([type]) => type).filter((type) => type.startsWith("pointer"));
    const { unmount } = renderSheet();
    expect(names(added)).toEqual([]); // nothing is listened for until a finger is down

    drag(grip(), 700, 520, 1000);
    expect(names(added).sort()).toEqual(["pointercancel", "pointermove", "pointerup"]);
    expect(names(removed).sort()).toEqual(["pointercancel", "pointermove", "pointerup"]);

    removed.mockClear();
    down(grip(), pointer({ clientY: 700 })); // and a finger still down when the sheet goes
    unmount();
    expect(names(removed).sort()).toEqual(["pointercancel", "pointermove", "pointerup"]);
  });

  test("BottomSheet_starts_afresh_when_a_finger_comes_down_after_a_drag_that_never_ended", () => {
    const { sheet, onHeightChange } = renderSheet();
    down(grip(), pointer({ clientY: 700, pointerType: "mouse" })); // its release is lost

    drag(grip(), 700, 520, 1000);

    expect(lastHeight(onHeightChange)).toBe(HALF);
    expect(sheet).toHaveAttribute("data-snap", "half");
  });

  test("BottomSheet_a_drag_that_ends_on_the_handle_is_no_click_on_it", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { sheet } = renderSheet();

    drag(grip(), 700, 600, 1000); // pulled a little and let go slowly: back at its peek
    fireEvent.click(grip()); // the click that the browser makes of that release, if it ends on the handle...
    expect(sheet).toHaveAttribute("data-snap", "peek"); // ...is not a press of the handle

    vi.advanceTimersByTime(1000); // a press that comes later is
    fireEvent.click(grip());
    expect(sheet).toHaveAttribute("data-snap", "half");
  });

  test("BottomSheet_a_tap_is_no_drag_and_the_content_keeps_its_clicks", () => {
    const onClick = vi.fn();
    const onHeightChange = vi.fn();
    render(
      <BottomSheet onHeightChange={onHeightChange}>
        <button onClick={onClick}>Row</button>
      </BottomSheet>,
    );
    const row = screen.getByRole("button", { name: "Row" });

    down(row, pointer({ clientY: 750 }));
    clock += 80;
    move(row, pointer({ clientY: 748 })); // a finger is never quite still
    up(row, pointer({ clientY: 748 }));
    fireEvent.click(row);

    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onHeightChange).toHaveBeenCalledTimes(1);
  });

  test("BottomSheet_can_be_dragged_by_its_content_until_it_is_full", () => {
    const { sheet, onHeightChange } = renderSheet();

    drag(content(), 700, 500, 1000); // 200 px up: 296, nearer half
    expect(lastHeight(onHeightChange)).toBe(HALF);

    // At full the content is the owner's to scroll: only the handle moves the sheet.
    drag(grip(), 500, 200, 1500);
    expect(sheet).toHaveAttribute("data-snap", "full");
    drag(content(), 120, 600, 1500);
    expect(lastHeight(onHeightChange)).toBe(FULL);
    expect(sheet).toHaveAttribute("data-snap", "full");
    drag(grip(), 120, 420, 1500); // 300 px down: 380, nearer half
    expect(sheet).toHaveAttribute("data-snap", "half");
  });

  test("BottomSheet_content_scrolls_only_at_full", () => {
    renderSheet();
    expect(content()).toHaveStyle({ overflowY: "hidden" });

    fireEvent.click(grip()); // half
    expect(content()).toHaveStyle({ overflowY: "hidden" });
    fireEvent.click(grip()); // full
    expect(content()).toHaveStyle({ overflowY: "auto" });

    fireEvent.click(grip()); // and round again
    expect(content()).toHaveStyle({ overflowY: "hidden" });
  });

  test("BottomSheet_handle_steps_through_the_points_when_pressed", () => {
    const { sheet, onHeightChange } = renderSheet();

    fireEvent.click(grip());
    expect(lastHeight(onHeightChange)).toBe(HALF);
    fireEvent.click(grip());
    expect(lastHeight(onHeightChange)).toBe(FULL);
    fireEvent.click(grip());
    expect(lastHeight(onHeightChange)).toBe(PEEK);
    expect(sheet).toHaveAttribute("data-snap", "peek");
  });

  test("BottomSheet_follows_the_viewport", () => {
    const { sheet, onHeightChange } = renderSheet();
    fireEvent.click(grip()); // half of 800
    expect(lastHeight(onHeightChange)).toBe(HALF);

    vi.stubGlobal("innerHeight", 600); // a phone turned, or its toolbar gone
    fireEvent(window, new Event("resize"));

    expect(lastHeight(onHeightChange)).toBe(300);
    expect(sheet.style.height).toBe("480px");
    expect(visibleHeight(sheet)).toBe(300);
    expect(sheet).toHaveAttribute("data-snap", "half");
  });

  test("BottomSheet_leaves_the_room_at_the_top_that_the_bar_asks_for", () => {
    const onHeightChange = vi.fn<(height: number) => void>();
    const { rerender } = render(<BottomSheet topClearance={170} onHeightChange={onHeightChange}>x</BottomSheet>);
    fireEvent.click(grip());
    fireEvent.click(grip()); // full
    expect(lastHeight(onHeightChange)).toBe(800 - 170);

    rerender(<BottomSheet topClearance={120} onHeightChange={onHeightChange}>x</BottomSheet>); // the bar is smaller again
    expect(lastHeight(onHeightChange)).toBe(FULL);
    expect(screen.getByRole("region", { name: "Details" }).style.height).toBe(`${FULL}px`);
  });

  test("BottomSheet_never_goes_below_its_peek_or_beyond_the_viewport_however_small_that_is", () => {
    vi.stubGlobal("innerHeight", 200); // half is 100, and the viewport less 120 would be 80: less than the peek
    const { onHeightChange } = renderSheet();

    fireEvent.click(grip());
    fireEvent.click(grip());
    fireEvent.click(grip());

    const heights = onHeightChange.mock.calls.map(([height]) => height);
    expect(heights.length).toBeGreaterThan(1);
    expect(heights.every((height) => height >= PEEK && height <= 200)).toBe(true);
  });

  test("BottomSheet_works_without_a_listener_and_stops_listening_when_it_goes", () => {
    const { unmount } = render(<BottomSheet>x</BottomSheet>);

    expect(() => fireEvent.click(grip())).not.toThrow();
    unmount();
    expect(() => fireEvent(window, new Event("resize"))).not.toThrow();
  });

  test("BottomSheet_leaves_the_secondary_mouse_button_alone", () => {
    const { onHeightChange } = renderSheet();

    down(grip(), pointer({ clientY: 700, button: 2, pointerType: "mouse" }));
    clock += 100;
    move(grip(), pointer({ clientY: 500, pointerType: "mouse" }));
    up(grip(), pointer({ clientY: 500, pointerType: "mouse" }));

    expect(onHeightChange).toHaveBeenCalledTimes(1);
  });
});
