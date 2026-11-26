import { useCallback, useMemo, useState } from "react";
import type { Route } from "./router";

/**
 * Merge mode of a place: the places the owner picks, on the map or in the list, to merge into the place on show. It is the shell's, as edit mode for
 * points is, since the map is where the places are picked and the panel has the form that merges them.
 */
export interface PlaceMerge {
  /** The place the picked places are to be merged into (the one the panel shows, which survives), while merge mode is on; null when it is off. */
  into: number | null;
  /** The picked places, in the order they were picked. A new array for each change. */
  selected: readonly number[];
  /** The same, as a set, for the map. */
  selectedSet: ReadonlySet<number>;
  /** Turns it on for the place on show, which the panel says by the id it is served as (`into`), with nothing picked. Nothing on a view that is not a place. */
  start: (into: number) => void;
  /** Turns it off, and forgets what was picked. */
  stop: () => void;
  /** Picks the place if it was not, and takes it off if it was. The place merged into is never picked: a tap on its own pin does nothing. */
  toggle: (id: number) => void;
}

interface Merging {
  /** The place of the address, which merge mode is on for: it ends with it. */
  route: number;
  into: number;
  selected: readonly number[];
}

const NONE: readonly number[] = [];

/**
 * Merge mode, for the place of the address and for no other: going to another view ends it, and what was picked with it. It is turned on and off by the
 * panel of the place; the map picks and unpicks places while it is on (a tap on a place does not open it then).
 */
export function usePlaceMerge(route: Route): PlaceMerge {
  const id = route.view === "place" ? route.id : null;
  const [merging, setMerging] = useState<Merging | null>(null);
  // Adjusting state while rendering, as React documents it: this render is thrown away and made again with it ended.
  if (merging !== null && merging.route !== id) setMerging(null);
  const on = merging !== null && merging.route === id ? merging : null;

  const start = useCallback((into: number) => {
    if (id !== null) setMerging({ route: id, into, selected: NONE });
  }, [id]);
  const stop = useCallback(() => setMerging(null), []);
  const toggle = useCallback((place: number) => {
    setMerging((last) => {
      if (last === null || place === last.into) return last;
      const selected = last.selected.includes(place) ? last.selected.filter((picked) => picked !== place) : [...last.selected, place];
      return { ...last, selected };
    });
  }, []);
  const selected = on?.selected ?? NONE;
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  return { into: on?.into ?? null, selected, selectedSet, start, stop, toggle };
}
