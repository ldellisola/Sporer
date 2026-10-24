import { act, renderHook } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { useMediaQuery } from "./useMediaQuery";

/** A `matchMedia` whose one query can be flipped by the test, as the window being resized does. */
function stubMatchMedia(initial: boolean) {
  const listeners = new Set<() => void>();
  let matches = initial;
  const queries: string[] = [];
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => {
      queries.push(query);
      return {
        get matches() {
          return matches;
        },
        addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
        removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
      };
    }),
  );
  return {
    queries,
    listenerCount: () => listeners.size,
    set(next: boolean) {
      matches = next;
      for (const listener of [...listeners]) listener();
    },
  };
}

describe("useMediaQuery", () => {
  test("useMediaQuery_follows_the_query_as_the_window_changes", () => {
    const media = stubMatchMedia(false);
    const { result, unmount } = renderHook(() => useMediaQuery("(min-width: 900px)"));
    expect(result.current).toBe(false);
    expect(media.queries.every((query) => query === "(min-width: 900px)")).toBe(true);

    act(() => media.set(true));
    expect(result.current).toBe(true);
    act(() => media.set(false));
    expect(result.current).toBe(false);

    unmount();
    expect(media.listenerCount()).toBe(0);
  });

  test("useMediaQuery_is_right_from_the_first_render", () => {
    stubMatchMedia(true);
    const seen: boolean[] = [];

    renderHook(() => {
      const matches = useMediaQuery("(min-width: 900px)");
      seen.push(matches);
      return matches;
    });

    expect(seen.every(Boolean)).toBe(true); // no frame of the wrong layout before the right one
  });

  test("useMediaQuery_is_false_in_a_browser_that_cannot_tell", () => {
    vi.stubGlobal("matchMedia", undefined);

    expect(renderHook(() => useMediaQuery("(min-width: 900px)")).result.current).toBe(false);
  });
});
