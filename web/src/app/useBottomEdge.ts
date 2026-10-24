import { useLayoutEffect, useState, type RefObject } from "react";

/**
 * Where the bottom of an element is, in pixels from the top of the window, kept up to date: when the element changes size (a row
 * more in it) and when the window does (a phone turned moves the safe area, and with it the element). Measured before the
 * first paint, so that nothing is laid out against a guess. The map is padded by it, to keep clear of the bar.
 */
export function useBottomEdge(ref: RefObject<HTMLElement | null>): number {
  const [bottom, setBottom] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) return;
    // Up to the next whole pixel: padding is for keeping clear, and a fraction short would be a line of the bar over the map.
    const measure = () => setBottom(Math.ceil(element.getBoundingClientRect().bottom));
    measure();
    window.addEventListener("resize", measure);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(element);
    return () => {
      window.removeEventListener("resize", measure);
      observer?.disconnect();
    };
  }, [ref]);
  return bottom;
}
