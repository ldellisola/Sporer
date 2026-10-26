import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { useStoredFlag } from "./useStoredFlag";

// Every test has a key of its own: the memory the hook falls back to belongs to the module, not to a test.

afterEach(() => {
  vi.restoreAllMocks(); // a test that broke the storage must not break the clearing of it
  window.localStorage.clear();
});

describe("useStoredFlag", () => {
  test("useStoredFlag_starts_with_the_default_and_keeps_what_it_is_given_in_localStorage", () => {
    const { result } = renderHook(() => useStoredFlag("flag-default", false));
    expect(result.current[0]).toBe(false);

    act(() => result.current[1](true));

    expect(result.current[0]).toBe(true);
    expect(window.localStorage.getItem("flag-default")).toBe("true");
    act(() => result.current[1](false));
    expect(result.current[0]).toBe(false);
    expect(window.localStorage.getItem("flag-default")).toBe("false");
  });

  test("useStoredFlag_reads_what_an_earlier_visit_stored", () => {
    window.localStorage.setItem("flag-earlier", "true");
    window.localStorage.setItem("flag-earlier-off", "false");

    expect(renderHook(() => useStoredFlag("flag-earlier", false)).result.current[0]).toBe(true);
    expect(renderHook(() => useStoredFlag("flag-earlier-off", true)).result.current[0]).toBe(false);
  });

  test("useStoredFlag_takes_a_stored_value_that_is_no_boolean_for_none", () => {
    window.localStorage.setItem("flag-garbage", "banana");

    expect(renderHook(() => useStoredFlag("flag-garbage", true)).result.current[0]).toBe(true);
    expect(renderHook(() => useStoredFlag("flag-garbage", false)).result.current[0]).toBe(false);
  });

  test("useStoredFlag_instances_of_one_key_agree_and_other_keys_are_left_alone", () => {
    const first = renderHook(() => useStoredFlag("flag-shared", false));
    const second = renderHook(() => useStoredFlag("flag-shared", false));
    const other = renderHook(() => useStoredFlag("flag-other", false));

    act(() => first.result.current[1](true));

    expect(second.result.current[0]).toBe(true);
    expect(other.result.current[0]).toBe(false);
  });

  // A private window, blocked site data or a full quota: reading throws, writing throws, or the `localStorage` property itself does.
  describe("useStoredFlag_works_when_storage_throws", () => {
    const failures: [string, () => void][] = [
      [
        "getItem and setItem",
        () => {
          vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
            throw new DOMException("The operation is insecure.", "SecurityError");
          });
          vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
            throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
          });
        },
      ],
      [
        "the localStorage property",
        () => {
          vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
            throw new DOMException("The operation is insecure.", "SecurityError");
          });
        },
      ],
    ];

    test.each(failures)("%s", (_name, breakStorage) => {
      breakStorage();
      const key = `flag-broken-${_name}`;

      const { result, unmount } = renderHook(() => useStoredFlag(key, false));
      expect(result.current[0]).toBe(false); // the default, and no throw

      expect(() => act(() => result.current[1](true))).not.toThrow();

      expect(result.current[0]).toBe(true); // kept in memory for as long as the page lives
      unmount();
      expect(renderHook(() => useStoredFlag(key, false)).result.current[0]).toBe(true);
    });

    test("a_write_that_fails_is_not_undone_by_what_the_storage_still_holds", () => {
      window.localStorage.setItem("flag-stale", "false");
      vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
        throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
      });
      const { result } = renderHook(() => useStoredFlag("flag-stale", false));

      act(() => result.current[1](true));

      expect(result.current[0]).toBe(true);
    });
  });
});
