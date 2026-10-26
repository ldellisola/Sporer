import { useCallback, useSyncExternalStore } from "react";

/**
 * Whether the window matches a CSS media query, now and whenever that changes (a window resized, a phone turned). It is right
 * from the first render, so that the layout is never drawn wrong for a frame; a browser that cannot tell is taken not to match.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (typeof window.matchMedia !== "function") return () => undefined;
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    [query],
  );
  const matches = () => typeof window.matchMedia === "function" && window.matchMedia(query).matches;
  return useSyncExternalStore(subscribe, matches, () => false);
}
