import { renderHook } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { useKeptData } from "./useKeptData";

describe("useKeptData", () => {
  test("useKeptData_keeps_the_last_data_that_there_was", () => {
    const { result, rerender } = renderHook(({ data }: { data: string | undefined }) => useKeptData(data), {
      initialProps: { data: undefined as string | undefined },
    });
    expect(result.current).toBeUndefined();

    rerender({ data: "Thursday" });
    expect(result.current).toBe("Thursday");

    rerender({ data: undefined }); // a query that failed has none; the view it left stays
    expect(result.current).toBe("Thursday");

    rerender({ data: "Friday" });
    expect(result.current).toBe("Friday");
    rerender({ data: undefined });
    expect(result.current).toBe("Friday");
  });

  test("useKeptData_drops_what_it_kept_when_it_is_told_not_to_keep_and_does_not_bring_it_back", () => {
    const { result, rerender } = renderHook(({ data, keep }: { data: string | undefined; keep: boolean }) => useKeptData(data, keep), {
      initialProps: { data: "Thursday" as string | undefined, keep: true },
    });
    expect(result.current).toBe("Thursday");

    rerender({ data: undefined, keep: false }); // the view that it was for is gone
    expect(result.current).toBeUndefined();

    rerender({ data: undefined, keep: true }); // and the next one starts with nothing
    expect(result.current).toBeUndefined();
    rerender({ data: "Friday", keep: true });
    expect(result.current).toBe("Friday");
  });
});
