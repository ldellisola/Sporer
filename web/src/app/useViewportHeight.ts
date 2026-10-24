import { useSyncExternalStore } from "react";

function subscribe(onChange: () => void): () => void {
  window.addEventListener("resize", onChange);
  return () => window.removeEventListener("resize", onChange);
}

const read = (): number => window.innerHeight;

/** The height of the window in pixels, kept up to date (a phone turned, a toolbar gone). */
export const useViewportHeight = (): number => useSyncExternalStore(subscribe, read);
