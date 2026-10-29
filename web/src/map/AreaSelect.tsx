import { useEffect, useEffectEvent, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import styles from "./AreaSelect.module.css";

/** A rectangle in pixels of the map, from its top left corner: what `map.project` says of a position is in them. */
export interface PixelBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface Pixel {
  x: number;
  y: number;
}

/**
 * How far a press has to move before it is a drag that draws a rectangle, in pixels, and not a tap: a finger is never still. A press that stays
 * within this is a tap on the map, as MapLibre's own click tolerance has it.
 */
const DRAG_THRESHOLD_PX = 6;

export interface AreaSelectProps {
  /** Whether a plain drag draws the rectangle: the map's Select area button is on. The map is not panned then, and a tap on it is `onTap`. */
  active: boolean;
  /** The element the map is in: a shift-drag on it draws the rectangle too, on a desktop where the button is not needed. */
  host: RefObject<HTMLElement | null>;
  /** Called when a rectangle has been drawn and the pointer is let go, with it. */
  onBox: (box: PixelBox) => void;
  /** Called for a press that did not become a drag while `active`: the surface has the touch, so a tap on the map comes here. */
  onTap: (point: Pixel) => void;
}

const boxOf = (a: Pixel, b: Pixel): PixelBox => ({ left: Math.min(a.x, b.x), top: Math.min(a.y, b.y), right: Math.max(a.x, b.x), bottom: Math.max(a.y, b.y) });

/** A drag in progress: where it began, and whether it has moved far enough to be one. */
interface Drag {
  /** The pointer that has it, for a touch; the mouse's is the one it has. */
  id: number;
  from: Pixel;
  moved: boolean;
}

/**
 * Selecting by area over the map: a one-finger drag draws a rectangle (the map's Select area button is on: `active`), and a shift-drag with the
 * mouse does too (on a desktop, where no button is needed). The rectangle is drawn over the map, and on release `onBox` has it in pixels of the
 * map, for the map to select the points that its `project` puts inside it; nothing is panned or zoomed by it.
 *
 * While `active` a surface with pointer events lies over the map and has every touch: a press that does not move is `onTap`, for the map under
 * it never saw it. The shift-drag is taken on the way down to the map (in the capture phase, so that MapLibre never sees the press, and so would
 * not pan with it), and the click that follows its release is held back (it would select the point under the pointer); a shift-click that did
 * not move is the map's own tap, and goes through. The component draws and reports, and knows nothing of the map.
 */
export function AreaSelect({ active, host, onBox, onTap }: AreaSelectProps) {
  const surface = useRef<HTMLDivElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const [box, setBox] = useState<PixelBox | null>(null);
  const reportBox = useEffectEvent(onBox);
  const reportTap = useEffectEvent(onTap);

  /** Where a pointer event is, in pixels of the layer (which has the size and the place of the map). */
  const at = (event: { clientX: number; clientY: number }): Pixel => {
    const rect = layer.current?.getBoundingClientRect();
    return { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) };
  };

  // A button that is turned off in the middle of a drag takes the drag with it.
  useEffect(() => {
    if (active) return;
    drag.current = null;
    setBox(null);
  }, [active]);

  const onPointerDown = (event: ReactPointerEvent) => {
    if (!event.isPrimary || (event.pointerType === "mouse" && event.button !== 0)) return;
    drag.current = { id: event.pointerId, from: at(event), moved: false };
    surface.current?.setPointerCapture?.(event.pointerId); // the drag goes on over the sheet, and out of the window
  };
  const onPointerMove = (event: ReactPointerEvent) => {
    const current = drag.current;
    if (current === null || current.id !== event.pointerId) return;
    const here = at(event);
    if (!current.moved && Math.hypot(here.x - current.from.x, here.y - current.from.y) <= DRAG_THRESHOLD_PX) return;
    current.moved = true;
    setBox(boxOf(current.from, here));
  };
  const onPointerUp = (event: ReactPointerEvent) => {
    const current = drag.current;
    if (current === null || current.id !== event.pointerId) return;
    drag.current = null;
    setBox(null);
    if (current.moved) reportBox(boxOf(current.from, at(event)));
    else reportTap(current.from);
  };
  const onPointerCancel = (event: ReactPointerEvent) => {
    if (drag.current?.id !== event.pointerId) return;
    drag.current = null;
    setBox(null);
  };

  // The shift-drag of a mouse, on the map itself. The press is stopped on its way down, so that the map never has it; the move and the release are
  // the window's, as MapLibre's own are, so that a drag that goes out of the map is still one.
  useEffect(() => {
    const element = host.current;
    if (element === null || active) return;
    const onMouseDown = (event: MouseEvent): void => {
      if (!event.shiftKey || event.button !== 0) return;
      event.stopPropagation();
      event.preventDefault(); // no text is selected, and nothing takes the focus
      const from = at(event);
      let moved = false;
      const onMove = (move: MouseEvent): void => {
        const here = at(move);
        if (!moved && Math.hypot(here.x - from.x, here.y - from.y) <= DRAG_THRESHOLD_PX) return;
        moved = true;
        setBox(boxOf(from, here));
      };
      const onUp = (up: MouseEvent): void => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        setBox(null);
        if (!moved) return; // a shift-click: the click that follows is the map's, which selects the point under it
        reportBox(boxOf(from, at(up)));
        // The click that follows the release would select the point under the pointer: it is held back, for as long as it takes to come.
        const swallow = (click: Event): void => click.stopPropagation();
        element.addEventListener("click", swallow, { capture: true, once: true });
        window.setTimeout(() => element.removeEventListener("click", swallow, true), 0);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    };
    element.addEventListener("mousedown", onMouseDown, true);
    return () => {
      element.removeEventListener("mousedown", onMouseDown, true);
    };
  }, [host, active]);

  return (
    <div ref={layer} className={styles.layer} aria-hidden="true">
      {active && (
        <div
          ref={surface}
          className={styles.surface}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
        />
      )}
      {box !== null && (
        <div className={styles.box} style={{ left: box.left, top: box.top, width: box.right - box.left, height: box.bottom - box.top }} />
      )}
    </div>
  );
}
