import { useLayoutEffect, useState, type RefObject } from "react";

/** The parts of the screen at the left and at the right that the device keeps for itself, in pixels. */
export interface SideInsets {
  left: number;
  right: number;
}

const NONE: SideInsets = { left: 0, right: 0 };

/**
 * How much of each side of the screen the device keeps for itself (the Dynamic Island side of a phone on its side, which the page is
 * drawn under: `viewport-fit=cover`), kept up to date as the phone is turned. Only the style sheet can say it (`env()` is its own), so it
 * is read from two probes, which it gives the width of the inset (`left` and `right`: see `App.module.css`). Measured before the first
 * paint, so that nothing is laid out against a guess. The map is padded by it, so that what it shows and its buttons do not sit under it.
 */
export function useSideInsets(left: RefObject<HTMLElement | null>, right: RefObject<HTMLElement | null>): SideInsets {
  const [insets, setInsets] = useState<SideInsets>(NONE);
  useLayoutEffect(() => {
    // A new object only when a number changes: it goes into the padding of the map, which hands it on.
    const measure = () => {
      const next = { left: left.current?.offsetWidth ?? 0, right: right.current?.offsetWidth ?? 0 };
      setInsets((last) => (last.left === next.left && last.right === next.right ? last : next));
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [left, right]);
  return insets;
}
