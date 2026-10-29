import { fireEvent, render, screen } from "@testing-library/react";
import type { MapLibreMap } from "maplibre-gl";
import { createRef } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { EditControls } from "./EditControls";
import type { MapEdit } from "./editPoints";
import { LAYER_IDS, type EditPointCollection } from "./layers";

const POINTS: EditPointCollection = {
  type: "FeatureCollection",
  features: [[100, 100], [140, 100], [300, 300]].map(([x, y], id) => ({ type: "Feature", id, properties: {}, geometry: { type: "Point", coordinates: [x!, y!] } })),
};

function fakeMap() {
  const handler = (enabled = true) => ({ enabled, isEnabled: () => enabled, enable: vi.fn(), disable: vi.fn() });
  return {
    boxZoom: handler(),
    doubleClickZoom: handler(),
    dragPan: handler(),
    getLayer: (id: string) => (id === LAYER_IDS.editPoints ? {} : undefined),
    queryRenderedFeatures: () => [{ id: 1, layer: { id: LAYER_IDS.editPoints }, properties: {}, geometry: { type: "Point", coordinates: [140, 100] } }],
    project: ([x, y]: [number, number]) => ({ x, y }),
  };
}

const edit = (over: Partial<MapEdit> = {}): MapEdit => ({ selected: new Set(), area: false, onAreaChange: vi.fn(), onToggle: vi.fn(), onSelect: vi.fn(), ...over });

function mount(props: { edit: MapEdit; map?: ReturnType<typeof fakeMap> | null }) {
  const host = createRef<HTMLDivElement>();
  const map = props.map === undefined ? fakeMap() : props.map;
  const ui = (next: MapEdit) => (
    <div ref={host}>
      <div data-testid="controls">
        <EditControls edit={next} map={map as unknown as MapLibreMap | null} points={POINTS} host={host} within={{ top: 0, right: 0, bottom: 0, left: 0 }} />
      </div>
    </div>
  );
  const view = render(ui(props.edit));
  return { ...view, map, host, rerender: (next: MapEdit) => view.rerender(ui(next)) };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("EditControls", () => {
  test("EditControls_has_the_select_area_button_that_says_whether_it_is_on_and_asks_for_the_other", () => {
    const onAreaChange = vi.fn();
    const { rerender } = mount({ edit: edit({ onAreaChange }) });
    const button = screen.getByRole("button", { name: "Select area" });
    expect(button).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByTestId("controls")).toContainElement(button);

    fireEvent.click(button);
    expect(onAreaChange).toHaveBeenLastCalledWith(true);

    rerender(edit({ onAreaChange, area: true }));
    expect(button).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(button);
    expect(onAreaChange).toHaveBeenLastCalledWith(false);
  });

  test("EditControls_puts_the_selection_layer_in_the_element_of_the_map_and_not_in_its_group_of_buttons", () => {
    const { host } = mount({ edit: edit({ area: true }) });

    expect(host.current!.querySelector(".surface")).not.toBeNull();
    expect(screen.getByTestId("controls").querySelector(".layer")).toBeNull();
  });

  test("EditControls_takes_the_gestures_of_the_map_while_it_is_there_and_gives_them_back_when_it_goes", () => {
    const map = fakeMap();
    const { unmount } = mount({ edit: edit({ area: true }), map });
    expect(map.boxZoom.disable).toHaveBeenCalledTimes(1);
    expect(map.doubleClickZoom.disable).toHaveBeenCalledTimes(1);
    expect(map.dragPan.disable).toHaveBeenCalledTimes(1);

    unmount();

    for (const gesture of [map.boxZoom, map.doubleClickZoom, map.dragPan]) expect(gesture.enable).toHaveBeenCalledTimes(1); // each was on when it was found, so each comes back
  });

  test("EditControls_selects_the_points_in_a_rectangle_and_the_one_near_a_tap_on_the_surface", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return this.className.includes("layer") ? ({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 } as DOMRect) : ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 } as DOMRect);
    });
    const onSelect = vi.fn();
    const onToggle = vi.fn();
    const { host } = mount({ edit: edit({ area: true, onSelect, onToggle }) });
    const surface = host.current!.querySelector(".surface")!;
    const at = (x: number, y: number) => ({ clientX: x, clientY: y, pointerId: 1, isPrimary: true, pointerType: "touch" });

    fireEvent.pointerDown(surface, at(90, 90));
    fireEvent.pointerMove(surface, at(150, 150));
    fireEvent.pointerUp(surface, at(150, 150));
    expect(onSelect).toHaveBeenCalledWith([0, 1]);

    fireEvent.pointerDown(surface, at(141, 101));
    fireEvent.pointerUp(surface, at(141, 101));
    expect(onToggle).toHaveBeenCalledWith(1);
  });

  test("EditControls_selects_nothing_before_there_is_a_map", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return this.className.includes("layer") ? ({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 } as DOMRect) : ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 } as DOMRect);
    });
    const onSelect = vi.fn();
    const onToggle = vi.fn();
    const { host } = mount({ edit: edit({ area: true, onSelect, onToggle }), map: null });
    const surface = host.current!.querySelector(".surface")!;
    const at = (x: number, y: number) => ({ clientX: x, clientY: y, pointerId: 1, isPrimary: true, pointerType: "touch" });

    fireEvent.pointerDown(surface, at(90, 90));
    fireEvent.pointerMove(surface, at(150, 150));
    fireEvent.pointerUp(surface, at(150, 150));
    fireEvent.pointerDown(surface, at(141, 101));
    fireEvent.pointerUp(surface, at(141, 101));

    expect(onSelect).not.toHaveBeenCalled();
    expect(onToggle).not.toHaveBeenCalled();
  });
});
