import { act, render } from "@testing-library/react";
import { useRef } from "react";
import { describe, expect, test, vi } from "vitest";
import { useSideInsets, type SideInsets } from "./useSideInsets";

/** What the style sheet gives the probes, which only it can say (`env()` is its own): jsdom has no layout, so the widths are told. */
function stubInsets(initial: SideInsets) {
  let insets = initial;
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
    return this.dataset["side"] === "left" ? insets.left : insets.right;
  });
  return (next: SideInsets) => {
    insets = next;
    act(() => void window.dispatchEvent(new Event("resize")));
  };
}

function Probe({ onInsets }: { onInsets: (insets: SideInsets) => void }) {
  const left = useRef<HTMLSpanElement>(null);
  const right = useRef<HTMLSpanElement>(null);
  onInsets(useSideInsets(left, right));
  return (
    <>
      <span ref={left} data-side="left" />
      <span ref={right} data-side="right" />
    </>
  );
}

function measured() {
  const seen: SideInsets[] = [];
  const view = render(<Probe onInsets={(insets) => seen.push(insets)} />);
  return { view, last: () => seen.at(-1)!, renders: () => seen.length };
}

describe("useSideInsets", () => {
  test("useSideInsets_reads_the_sides_the_device_keeps_and_follows_a_phone_being_turned", () => {
    const turn = stubInsets({ left: 0, right: 0 });
    const { last } = measured();

    turn({ left: 59, right: 0 }); // landscape, the island on the left
    expect(last()).toEqual({ left: 59, right: 0 });

    turn({ left: 0, right: 59 }); // turned the other way
    expect(last()).toEqual({ left: 0, right: 59 });

    turn({ left: 0, right: 0 }); // upright
    expect(last()).toEqual({ left: 0, right: 0 });
  });

  test("useSideInsets_is_measured_before_the_first_paint_so_nothing_is_laid_out_against_a_guess", () => {
    stubInsets({ left: 47, right: 47 });
    const seen: SideInsets[] = [];

    render(<Probe onInsets={(insets) => seen.push(insets)} />);

    expect(seen.at(-1)).toEqual({ left: 47, right: 47 });
  });

  test("useSideInsets_gives_the_same_object_while_no_number_changes", () => {
    const turn = stubInsets({ left: 59, right: 0 });
    const objects = new Set<SideInsets>();
    render(<Probe onInsets={(insets) => objects.add(insets)} />);
    const before = objects.size;

    turn({ left: 59, right: 0 }); // a resize that moves nothing (a toolbar)

    expect(objects.size).toBe(before);
  });

  test("useSideInsets_stops_listening_when_unmounted", () => {
    const turn = stubInsets({ left: 0, right: 0 });
    const { view, renders } = measured();
    view.unmount();
    const rendersAtTheEnd = renders();

    turn({ left: 59, right: 59 });

    expect(renders()).toBe(rendersAtTheEnd);
  });

  test("useSideInsets_is_zero_with_no_probe_to_measure", () => {
    function NoProbe({ onInsets }: { onInsets: (insets: SideInsets) => void }) {
      onInsets(useSideInsets(useRef(null), useRef(null)));
      return null;
    }
    const seen: SideInsets[] = [];

    render(<NoProbe onInsets={(insets) => seen.push(insets)} />);

    expect(seen.at(-1)).toEqual({ left: 0, right: 0 });
  });
});
