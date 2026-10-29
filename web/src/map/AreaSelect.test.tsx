import { fireEvent, render } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, test, vi } from "vitest";
import { AreaSelect } from "./AreaSelect";

/** A map's element to put the selection over, with an element inside it for what the map would have under the finger (its canvas). */
function mount(props: { active?: boolean } = {}) {
  const onBox = vi.fn();
  const onTap = vi.fn();
  const host = createRef<HTMLDivElement>();
  const ui = (active: boolean) => (
    <div ref={host} data-testid="host">
      <div data-testid="canvas" />
      <AreaSelect active={active} host={host} onBox={onBox} onTap={onTap} />
    </div>
  );
  const view = render(ui(props.active ?? false));
  const canvas = view.getByTestId("canvas");
  const surface = () => view.container.querySelector<HTMLElement>(".surface");
  const rectangle = () => view.container.querySelector<HTMLElement>(".box");
  return { onBox, onTap, host, canvas, surface, rectangle, rerender: (active: boolean) => view.rerender(ui(active)), unmount: view.unmount, view };
}

const touch = (x: number, y: number, over: Record<string, unknown> = {}) => ({ clientX: x, clientY: y, pointerId: 1, isPrimary: true, pointerType: "touch", button: 0, ...over });

describe("AreaSelect with the button on", () => {
  test("AreaSelect_has_a_surface_over_the_map_only_while_it_is_on", () => {
    const { surface, rerender } = mount();

    expect(surface()).toBeNull(); // the map has every touch while it is off

    rerender(true);
    expect(surface()).not.toBeNull();

    rerender(false);
    expect(surface()).toBeNull();
  });

  test("AreaSelect_draws_a_rectangle_for_a_drag_and_gives_the_box_when_the_finger_lifts", () => {
    const { surface, rectangle, onBox, onTap } = mount({ active: true });

    fireEvent.pointerDown(surface()!, touch(40, 50));
    expect(rectangle()).toBeNull(); // not before it has moved
    fireEvent.pointerMove(surface()!, touch(140, 190));

    expect(rectangle()).toHaveStyle({ left: "40px", top: "50px", width: "100px", height: "140px" });
    expect(onBox).not.toHaveBeenCalled(); // on release, and not before

    fireEvent.pointerUp(surface()!, touch(140, 190));

    expect(onBox).toHaveBeenCalledTimes(1);
    expect(onBox).toHaveBeenCalledWith({ left: 40, top: 50, right: 140, bottom: 190 });
    expect(onTap).not.toHaveBeenCalled();
    expect(rectangle()).toBeNull();
  });

  test("AreaSelect_gives_the_box_the_right_way_up_for_a_drag_that_goes_up_and_to_the_left", () => {
    const { surface, rectangle, onBox } = mount({ active: true });

    fireEvent.pointerDown(surface()!, touch(140, 190));
    fireEvent.pointerMove(surface()!, touch(40, 50));
    expect(rectangle()).toHaveStyle({ left: "40px", top: "50px", width: "100px", height: "140px" });
    fireEvent.pointerUp(surface()!, touch(40, 50));

    expect(onBox).toHaveBeenCalledWith({ left: 40, top: 50, right: 140, bottom: 190 });
  });

  test("AreaSelect_takes_a_press_that_stays_within_a_few_pixels_for_a_tap_on_the_map_and_draws_nothing", () => {
    const { surface, rectangle, onBox, onTap } = mount({ active: true });

    fireEvent.pointerDown(surface()!, touch(200, 300));
    fireEvent.pointerMove(surface()!, touch(203, 302)); // a finger is not still
    expect(rectangle()).toBeNull();
    fireEvent.pointerUp(surface()!, touch(203, 302));

    expect(onTap).toHaveBeenCalledTimes(1);
    expect(onTap).toHaveBeenCalledWith({ x: 200, y: 300 }); // where it came down
    expect(onBox).not.toHaveBeenCalled();
  });

  test("AreaSelect_follows_the_first_finger_only_and_lets_the_second_be", () => {
    const { surface, onBox } = mount({ active: true });

    fireEvent.pointerDown(surface()!, touch(10, 10));
    fireEvent.pointerDown(surface()!, touch(300, 300, { pointerId: 2, isPrimary: false }));
    fireEvent.pointerMove(surface()!, touch(400, 400, { pointerId: 2, isPrimary: false }));
    fireEvent.pointerUp(surface()!, touch(400, 400, { pointerId: 2, isPrimary: false }));
    expect(onBox).not.toHaveBeenCalled();
    fireEvent.pointerMove(surface()!, touch(60, 70));
    fireEvent.pointerUp(surface()!, touch(60, 70));

    expect(onBox).toHaveBeenCalledWith({ left: 10, top: 10, right: 60, bottom: 70 });
  });

  test("AreaSelect_drops_a_drag_that_is_cancelled_and_gives_no_box", () => {
    const { surface, rectangle, onBox, onTap } = mount({ active: true });

    fireEvent.pointerDown(surface()!, touch(10, 10));
    fireEvent.pointerMove(surface()!, touch(90, 90));
    expect(rectangle()).not.toBeNull();
    fireEvent.pointerCancel(surface()!, touch(90, 90));

    expect(rectangle()).toBeNull();
    expect(onBox).not.toHaveBeenCalled();
    expect(onTap).not.toHaveBeenCalled();
  });

  test("AreaSelect_ignores_a_button_of_the_mouse_that_is_not_the_main_one", () => {
    const { surface, onBox, onTap } = mount({ active: true });

    fireEvent.pointerDown(surface()!, touch(10, 10, { pointerType: "mouse", button: 2 }));
    fireEvent.pointerMove(surface()!, touch(90, 90, { pointerType: "mouse" }));
    fireEvent.pointerUp(surface()!, touch(90, 90, { pointerType: "mouse", button: 2 }));

    expect(onBox).not.toHaveBeenCalled();
    expect(onTap).not.toHaveBeenCalled();
  });

  test("AreaSelect_drops_the_rectangle_when_the_button_is_turned_off_in_the_middle_of_a_drag", () => {
    const { surface, rectangle, rerender, onBox } = mount({ active: true });
    fireEvent.pointerDown(surface()!, touch(10, 10));
    fireEvent.pointerMove(surface()!, touch(90, 90));

    rerender(false);

    expect(rectangle()).toBeNull();
    expect(onBox).not.toHaveBeenCalled();
  });

  test("AreaSelect_takes_what_the_surface_gets_and_leaves_the_map_nothing_of_it", () => {
    const { surface, canvas } = mount({ active: true });
    const seen = vi.fn();
    canvas.addEventListener("pointerdown", seen);

    fireEvent.pointerDown(surface()!, touch(10, 10)); // the surface is over the map: it is not a child of it

    expect(seen).not.toHaveBeenCalled();
    expect(surface()).not.toContainElement(canvas);
  });
});

describe("AreaSelect with a shift-drag", () => {
  const mouse = (x: number, y: number, over: Record<string, unknown> = {}) => ({ clientX: x, clientY: y, button: 0, shiftKey: true, ...over });

  test("AreaSelect_draws_a_rectangle_for_a_shift_drag_on_the_map_and_gives_the_box_on_release", () => {
    const { canvas, rectangle, onBox, onTap } = mount();

    fireEvent.mouseDown(canvas, mouse(40, 50));
    fireEvent.mouseMove(window, mouse(140, 190));

    expect(rectangle()).toHaveStyle({ left: "40px", top: "50px", width: "100px", height: "140px" });
    fireEvent.mouseUp(window, mouse(140, 190, { shiftKey: false })); // the key may be let go before the button

    expect(onBox).toHaveBeenCalledWith({ left: 40, top: 50, right: 140, bottom: 190 });
    expect(onTap).not.toHaveBeenCalled();
    expect(rectangle()).toBeNull();
  });

  test("AreaSelect_keeps_the_press_of_a_shift_drag_from_the_map_which_would_pan_with_it", () => {
    const { canvas } = mount();
    const seen = vi.fn();
    canvas.addEventListener("mousedown", seen);

    fireEvent.mouseDown(canvas, mouse(40, 50));
    fireEvent.mouseUp(window, mouse(140, 190));

    expect(seen).not.toHaveBeenCalled(); // the map's handlers did not see the press, so nothing pans
  });

  test("AreaSelect_keeps_the_click_that_ends_a_shift_drag_from_the_map_which_would_select_a_point_with_it", () => {
    vi.useFakeTimers();
    try {
      const { canvas } = mount();
      const clicked = vi.fn();
      canvas.addEventListener("click", clicked);

      fireEvent.mouseDown(canvas, mouse(40, 50));
      fireEvent.mouseMove(window, mouse(140, 190));
      fireEvent.mouseUp(window, mouse(140, 190));
      fireEvent.click(canvas, mouse(140, 190)); // the browser's, after the release
      expect(clicked).not.toHaveBeenCalled();

      vi.runAllTimers();
      fireEvent.click(canvas, mouse(140, 190, { shiftKey: false })); // a click of its own, later
      expect(clicked).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("AreaSelect_lets_a_shift_click_that_did_not_move_be_a_click_on_the_map_which_selects_the_point_under_it", () => {
    const { canvas, onBox } = mount();
    const clicked = vi.fn();
    canvas.addEventListener("click", clicked);

    fireEvent.mouseDown(canvas, mouse(40, 50));
    fireEvent.mouseUp(window, mouse(41, 50));
    fireEvent.click(canvas, mouse(41, 50));

    expect(onBox).not.toHaveBeenCalled();
    expect(clicked).toHaveBeenCalledTimes(1);
  });

  test("AreaSelect_leaves_a_press_without_shift_to_the_map", () => {
    const { canvas, rectangle, onBox } = mount();
    const seen = vi.fn();
    canvas.addEventListener("mousedown", seen);

    fireEvent.mouseDown(canvas, mouse(40, 50, { shiftKey: false }));
    fireEvent.mouseMove(window, mouse(140, 190, { shiftKey: false }));
    fireEvent.mouseUp(window, mouse(140, 190, { shiftKey: false }));

    expect(seen).toHaveBeenCalledTimes(1);
    expect(rectangle()).toBeNull();
    expect(onBox).not.toHaveBeenCalled();
  });

  test("AreaSelect_leaves_a_shift_press_with_another_button_to_the_map", () => {
    const { canvas, onBox } = mount();
    const seen = vi.fn();
    canvas.addEventListener("mousedown", seen);

    fireEvent.mouseDown(canvas, mouse(40, 50, { button: 2 }));
    fireEvent.mouseUp(window, mouse(140, 190, { button: 2 }));

    expect(seen).toHaveBeenCalledTimes(1);
    expect(onBox).not.toHaveBeenCalled();
  });

  test("AreaSelect_leaves_the_shift_press_to_the_surface_while_the_button_is_on", () => {
    const { surface, onBox } = mount({ active: true });

    fireEvent.mouseDown(surface()!, mouse(40, 50)); // the surface has the pointer's own events: one rectangle, and not two
    fireEvent.mouseMove(window, mouse(140, 190));
    fireEvent.mouseUp(window, mouse(140, 190));

    expect(onBox).not.toHaveBeenCalled();
  });

  test("AreaSelect_stops_listening_when_it_goes", () => {
    const { canvas, unmount, onBox } = mount();
    const seen = vi.fn();
    canvas.addEventListener("mousedown", seen);
    unmount();

    fireEvent.mouseDown(canvas, mouse(40, 50));
    fireEvent.mouseUp(window, mouse(140, 190));

    expect(seen).toHaveBeenCalledTimes(1);
    expect(onBox).not.toHaveBeenCalled();
  });
});
