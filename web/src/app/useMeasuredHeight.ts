import { useLayoutEffect, useState } from "react";

/**
 * How tall an element is, in pixels, kept up to date as it changes (text that is set larger wraps a row onto a second line); 0 while there is none. Up to
 * the next whole pixel, for it is used to leave room. Measured before the first paint, so that nothing is laid out against a guess.
 */
export function useMeasuredHeight(element: HTMLElement | null): number {
  const [height, setHeight] = useState(0);
  useLayoutEffect(() => {
    if (element === null) {
      setHeight(0);
      return;
    }
    const measure = () => setHeight(Math.ceil(element.getBoundingClientRect().height) || 0);
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(element);
    return () => observer?.disconnect();
  }, [element]);
  return height;
}
