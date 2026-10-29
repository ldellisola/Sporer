import { vi } from "vitest";
import type { PointEditing } from "../app/useEditPoints";

/** The points of a day for the tests of what shows edit mode: a few, at a time and a place each. */
export const FAKE_POINTS = {
  date: "2026-10-22",
  devices: ["phone"],
  points: [
    [1_761_120_000_000_000, 10.001, 59.001, 0],
    [1_761_120_030_000_000, 10.002, 59.002, 0],
    [1_761_120_060_000_000, 10.003, 59.003, 0],
    [1_761_120_090_000_000, 10.004, 59.004, 0],
  ],
} satisfies NonNullable<PointEditing["points"]>;

/** Edit mode as the shell gives it to a panel: on, with the points there and nothing selected, and every action a spy. `over` is what a test has otherwise. */
export function pointEditing(over: Partial<PointEditing> = {}): PointEditing {
  return {
    active: true,
    start: vi.fn(),
    done: vi.fn(),
    points: FAKE_POINTS,
    load: { pending: false, error: null, retry: vi.fn() },
    selected: new Set<number>(),
    toggle: vi.fn(),
    select: vi.fn(),
    clear: vi.fn(),
    area: false,
    setArea: vi.fn(),
    removal: { run: vi.fn(), pending: false, error: null, reset: vi.fn() },
    undo: { run: vi.fn(), pending: false, error: null },
    toast: null,
    failedRemoval: null,
    dismiss: vi.fn(),
    ...over,
  };
}
