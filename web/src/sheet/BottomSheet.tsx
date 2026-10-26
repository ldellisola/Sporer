import {
  useEffect,
  useEffectEvent,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type Ref,
} from "react";
import { useViewportHeight } from "../app/useViewportHeight";
import styles from "./BottomSheet.module.css";

/**
 * How much of the sheet shows at its lowest point, in pixels, above the home indicator of a phone that has one: the sheet peeks this
 * far plus the bottom safe area. The app starts the map's padding from this, until the sheet says how much shows.
 */
export const SHEET_PEEK = 96;

/** What the highest point leaves free at the top of the screen, for the bar over the map, unless the bar needs more (`topClearance`). */
export const SHEET_TOP_CLEARANCE = 120;

/** A drag that ends faster than this (pixels per millisecond) is a flick: it goes on to the next point rather than the nearest. */
const FLICK_SPEED = 0.5;

/** How far a finger has to move before a touch is a drag and no longer a tap on whatever is under it. */
const DRAG_THRESHOLD_PX = 6;

/** How far back from the release the speed of a drag is measured. */
const SPEED_WINDOW_MS = 100;

/** How long after a drag a click on the sheet is taken for the release of that drag, and not a press of anything on it. */
const CLICK_AFTER_DRAG_MS = 300;

type Snap = "peek" | "half" | "full";
const SNAPS: readonly Snap[] = ["peek", "half", "full"];

/** How much of the sheet shows at the middle point in a viewport `viewport` pixels high: half of it. */
export const sheetHalfHeight = (viewport: number): number => Math.max(SHEET_PEEK, Math.round(viewport / 2));

/**
 * How much of the sheet shows at each point in a viewport `viewport` pixels high, with `inset` pixels of home indicator under the
 * peek; in a very small viewport the points still come in order.
 */
function pointsFor(viewport: number, topClearance: number, inset: number): Record<Snap, number> {
  const peek = SHEET_PEEK + inset;
  const half = Math.max(peek, sheetHalfHeight(viewport));
  return { peek, half, full: Math.max(half, viewport - topClearance) };
}

/**
 * The point a sheet comes to rest at when let go at `height`. A flick (`upward` is its speed in pixels per millisecond, up
 * positive) goes to the next point in its direction, and to the end if there is none; anything slower, to the nearest.
 */
function settleAt(height: number, upward: number, points: Record<Snap, number>): Snap {
  if (Math.abs(upward) > FLICK_SPEED) {
    // A pixel of leeway, so that a sheet let go on a point is not "before" it by a rounding error.
    const next =
      upward > 0 ? SNAPS.find((snap) => points[snap] > height + 1) : SNAPS.findLast((snap) => points[snap] < height - 1);
    return next ?? (upward > 0 ? "full" : "peek");
  }
  return SNAPS.reduce((best, snap) => (Math.abs(points[snap] - height) < Math.abs(points[best] - height) ? snap : best));
}

/** Where a finger was and when; the time is the one the browser stamped on the event, which a busy page cannot make late. */
interface Sample {
  t: number;
  y: number;
}

/** How fast the finger was going up (pixels per millisecond) over the last moments before `now`; 0 when it had stopped. */
function upwardSpeed(samples: Sample[], now: number): number {
  const recent = samples.filter((sample) => sample.t >= now - SPEED_WINDOW_MS);
  const first = recent[0];
  const last = recent.at(-1);
  if (first === undefined || last === undefined || last.t === first.t) return 0;
  return (first.y - last.y) / (last.t - first.t);
}

interface Drag {
  pointerId: number;
  startY: number;
  /** How much of the sheet showed when the finger came down. */
  startHeight: number;
  /** How much shows now, once the finger has moved far enough for this to be a drag. */
  height: number;
  active: boolean;
  samples: Sample[];
  /** Takes the listeners of the drag off the window. */
  detach: () => void;
}

/** What the app can ask of the sheet besides what the owner does to it with a finger. */
export interface BottomSheetHandle {
  /**
   * Brings the sheet down to `snap` if it is higher than that, and leaves it where it is if it is there or lower: a request to lower
   * it, never to raise it. For what the owner has done that is best seen on the map (a row tapped) while the sheet covers it.
   */
  lowerTo(snap: "peek" | "half"): void;
}

export interface BottomSheetProps {
  children: ReactNode;
  /** The handle by which the app lowers the sheet (see `BottomSheetHandle`). */
  ref?: Ref<BottomSheetHandle>;
  /** What the panel is called for those who cannot see it. */
  label?: string;
  /**
   * How much of the top of the screen the highest point leaves free, in pixels: 120, the room the bar over the map needs. A bar
   * that is taller (its range fields open) or lower (a notch above it) asks for more, so that the sheet never comes up over it, and
   * over the handle that it is let down by.
   */
  topClearance?: number;
  /**
   * Told how much of the sheet shows (in pixels from the bottom of the screen) when it first appears and each time it has come
   * to rest at another height or the screen has changed size; not while a finger is moving it. The map is padded by it.
   */
  onHeightChange?: (height: number) => void;
}

/**
 * The panel of a phone: a sheet at the bottom of the screen over the map, which never goes away and is not modal (the map
 * behind it stays in use). It rests at three points, a peek of 96 px above the home indicator, half the screen and the screen less 120 px (`topClearance`), and is pulled
 * between them by its handle or, until it is full, by any part of it. Let go slowly it goes to the nearest point; flicked, to the
 * next one that way. The handle also steps through the points when pressed, for those who cannot drag. Its content scrolls only at
 * full: below that the part that shows is a preview, and a drag on it is the sheet's. The app can ask for it to be lowered
 * (`ref`).
 */
export function BottomSheet({
  children,
  ref,
  label = "Details",
  topClearance = SHEET_TOP_CLEARANCE,
  onHeightChange,
}: BottomSheetProps) {
  const viewport = useViewportHeight();
  const probe = useRef<HTMLSpanElement>(null);
  const [inset, setInset] = useState(0);
  // The bottom safe area, which only the style sheet can say (env() is its own), read from a probe that has it as its height. Before
  // the first paint, so that the sheet never shows at a peek that the home indicator then covers.
  useLayoutEffect(() => {
    const measure = () => setInset(probe.current?.offsetHeight ?? 0);
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);
  const points = pointsFor(viewport, topClearance, inset);
  const [snap, setSnap] = useState<Snap>("peek");
  const [dragHeight, setDragHeight] = useState<number | null>(null);
  const drag = useRef<Drag | null>(null);
  const justDragged = useRef(false);

  useImperativeHandle(
    ref,
    () => ({ lowerTo: (to) => setSnap((current) => (SNAPS.indexOf(current) > SNAPS.indexOf(to) ? to : current)) }),
    [],
  );

  const settled = points[snap];
  const visible = dragHeight ?? settled;

  const report = useEffectEvent((height: number) => onHeightChange?.(height));
  useEffect(() => report(settled), [settled]);

  // A drag in progress when the sheet goes (a layout change, say) must not leave its listeners on the window.
  useEffect(() => () => drag.current?.detach(), []);

  const onPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (!event.isPrimary || (event.pointerType === "mouse" && event.button !== 0)) return;
    // At full the content is the owner's to scroll; only the handle moves the sheet then.
    if (snap === "full" && !(event.target instanceof Element && event.target.closest("[data-grip]"))) return;

    drag.current?.detach(); // a drag whose release never came (a mouse let go outside the window) is over
    const current: Drag = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startHeight: settled,
      height: settled,
      active: false,
      samples: [{ t: event.timeStamp, y: event.clientY }],
      detach: () => undefined,
    };
    // The moves and the release are listened for on the window, not on the sheet: a mouse that leaves the sheet in one jump takes
    // them with it (a touch keeps them on the sheet by itself). Pointer capture would do as much, but a captured pointer takes the
    // click of whatever was tapped with it.
    const onMove = (move: PointerEvent) => {
      if (move.pointerId !== current.pointerId) return;
      current.samples.push({ t: move.timeStamp, y: move.clientY });
      const moved = move.clientY - current.startY;
      if (!current.active && Math.abs(moved) < DRAG_THRESHOLD_PX) return; // a tap, until the finger has gone somewhere
      current.active = true;
      current.height = Math.min(points.full, Math.max(points.peek, current.startHeight - moved));
      setDragHeight(current.height);
    };
    const onEnd = (end: PointerEvent, cancelled: boolean) => {
      if (end.pointerId !== current.pointerId) return;
      current.detach();
      drag.current = null;
      if (!current.active) return;
      current.samples.push({ t: end.timeStamp, y: end.clientY });
      setSnap(settleAt(current.height, cancelled ? 0 : upwardSpeed(current.samples, end.timeStamp), points));
      setDragHeight(null);
      justDragged.current = true; // see onClickCapture
      setTimeout(() => (justDragged.current = false), CLICK_AFTER_DRAG_MS);
    };
    const onUp = (up: PointerEvent) => onEnd(up, false);
    const onCancel = (cancel: PointerEvent) => onEnd(cancel, true);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    current.detach = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
    };
    drag.current = current;
  };

  const stepThroughPoints = () => setSnap(SNAPS[(SNAPS.indexOf(snap) + 1) % SNAPS.length]!);

  // The release of a mouse that drags the sheet by a row (or by the handle) is a click on whatever it ends on, which is not a press of
  // that: it is taken here, before it reaches the content.
  const onClickCapture = (event: ReactMouseEvent<HTMLElement>) => {
    if (!justDragged.current) return;
    event.stopPropagation();
    event.preventDefault();
  };

  return (
    <section
      className={styles.sheet}
      aria-label={label}
      data-snap={snap}
      data-dragging={dragHeight !== null}
      style={{ height: points.full, transform: `translateY(${points.full - visible}px)` }}
      onPointerDown={onPointerDown}
      onClickCapture={onClickCapture}
    >
      <button type="button" className={styles.grip} data-grip="" aria-label="Resize panel" onClick={stepThroughPoints}>
        <span className={styles.handle} />
      </button>
      <div className={styles.content} style={{ overflowY: snap === "full" ? "auto" : "hidden" }}>
        {children}
      </div>
      <span ref={probe} className={styles.inset} aria-hidden="true" />
    </section>
  );
}
