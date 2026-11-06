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
  /**
   * Which side of the point the card is on, `over` when neither has room for it and it lies over the point, or `away` when the point is out of the area
   * (the card is kept in sight and has no pointer, for it points at nothing).
   */
  side: "above" | "below" | "over" | "away";
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
 * free part nearest to the middle of it). Along the map the card is as near to centred on the point as `area` allows. `avoid` is a rectangle that the
 * card keeps clear of (the map's buttons, with air round them): where the card would be level with it, it ends at its left edge. A point in `area` and
 * not under `avoid` has its card pointed at it.
 */
export function placeCard(
  at: { x: number; y: number },
  size: { width: number; height: number },
  area: Area,
  gap: number,
  avoid: Area | null = null,
): CardPlace {
  const maxHeight = Math.max(0, area.bottom - area.top);
  const height = Math.min(size.height, maxHeight);
  const within = (box: Area): boolean => at.x >= box.left && at.x <= box.right && at.y >= box.top && at.y <= box.bottom;
  const inside = within(area) && !(avoid !== null && within(avoid));
  const place = (top: number, side: CardPlace["side"]): CardPlace => {
    // Level with the buttons it ends before them.
    const right = avoid !== null && top < avoid.bottom && top + height > avoid.top ? Math.min(area.right, avoid.left) : area.right;
    const maxWidth = Math.max(0, right - area.left);
    const width = Math.min(size.width, maxWidth);
    const left = clamp(at.x - width / 2, area.left, right - width);
    return { left, top, side: inside ? side : "away", maxHeight, maxWidth, pointerX: clamp(at.x - left, 14, width - 14) };
  };
  const above = at.y - gap - height;
  const below = at.y + gap;
  if (above >= area.top && at.y - gap <= area.bottom) return place(above, "above");
  if (below + height <= area.bottom && below >= area.top) return place(below, "below");
  return place(clamp(at.y - height / 2, area.top, area.bottom - height), "over");
}

/** Whether two places are the same to within half a pixel, so that a map that moves a hair does not have the card drawn again. */
export function samePlace(a: CardPlace, b: CardPlace): boolean {
  return a.side === b.side && (["left", "top", "maxHeight", "maxWidth", "pointerX"] as const).every((key) => Math.abs(a[key] - b[key]) < 0.5);
}
