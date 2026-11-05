// Where the card of a point goes: above the point, below it when there is no room above, and always inside what the map shows (what no sheet, bar or button covers).

/** A rectangle of the map, in pixels from its top left. */
export interface Area {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface CardPlace {
  left: number;
  top: number;
  /** Which side of the point the card is on, or `over` when neither has room for it and it lies over the point. */
  side: "above" | "below" | "over";
  /** The most the card may be as high as, so that it fits in what is free (it scrolls inside). */
  maxHeight: number;
  /** The most it may be as wide as. */
  maxWidth: number;
  /** Where the point is along the card, from its left edge: what a pointer is put at. */
  pointerX: number;
}

const clamp = (value: number, low: number, high: number): number => Math.min(Math.max(value, low), Math.max(low, high));

/**
 * The place of a card of `size` for a point at `at`, `gap` pixels from it, in `area`: above the point when it fits there, else below, else over it (in the
 * free part nearest to the middle of it). Along the map the card is as near to centred on the point as `area` allows.
 */
export function placeCard(at: { x: number; y: number }, size: { width: number; height: number }, area: Area, gap: number): CardPlace {
  const maxWidth = Math.max(0, area.right - area.left);
  const maxHeight = Math.max(0, area.bottom - area.top);
  const width = Math.min(size.width, maxWidth);
  const height = Math.min(size.height, maxHeight);
  const left = clamp(at.x - width / 2, area.left, area.right - width);
  const pointerX = clamp(at.x - left, 14, width - 14);
  const above = at.y - gap - height;
  const below = at.y + gap;
  if (above >= area.top && at.y - gap <= area.bottom) return { left, top: above, side: "above", maxHeight, maxWidth, pointerX };
  if (below + height <= area.bottom && below >= area.top) return { left, top: below, side: "below", maxHeight, maxWidth, pointerX };
  return { left, top: clamp(at.y - height / 2, area.top, area.bottom - height), side: "over", maxHeight, maxWidth, pointerX };
}

/** Whether two places are the same to within half a pixel, so that a map that moves a hair does not have the card drawn again. */
export function samePlace(a: CardPlace, b: CardPlace): boolean {
  return a.side === b.side && (["left", "top", "maxHeight", "maxWidth", "pointerX"] as const).every((key) => Math.abs(a[key] - b[key]) < 0.5);
}
