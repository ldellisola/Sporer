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
});
