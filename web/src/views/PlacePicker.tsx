import type { UseQueryResult } from "@tanstack/react-query";
import { useEffect, useState, type KeyboardEvent } from "react";
import { useCandidates, usePlaceSearch } from "../api/queries";
import type { PlaceCandidate, PlaceSearchResult } from "../api/types";
import { formatCount, formatDistance } from "../time/format";
import forms from "./Forms.module.css";
import styles from "./PlacePicker.module.css";
import { UNNAMED } from "./placeNames";
import rows from "./Rows.module.css";
import { Shown } from "./Shown";
import { Empty, ErrorState, Loading } from "./States";
import { useKeptData } from "./useKeptData";

/** How long the owner has to stop typing before the search is asked for. */
const DEBOUNCE_MS = 300;

/** `value`, as it was `ms` after it last changed: a search is asked for once the typing has paused, and not at every key. */
function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), ms);
    return () => window.clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

/**
 * A place of the list, which is one button: its name, where it is, how far (when the list is of the places near one: `distance` is what it says),
 * and how many stays there were. The button is named by what the row says, in the order it says it, so that its name holds the text that is on it
 * (voice control says what it sees).
 */
function PlaceRow<T extends PlaceSearchResult>({ place, distance, onPick }: { place: T; distance: string | null; onPick: (place: T) => void }) {
  const name = place.name ?? UNNAMED;
  const address = place.address ?? "";
  const visits = formatCount(place.visits, "visit");
  return (
    <li>
      <button
        type="button"
        className={`${rows.tap} ${rows.row} ${distance === null ? styles.found : styles.candidate}`}
        aria-label={[name, address, distance ?? "", visits].filter((part) => part !== "").join(", ")}
        onClick={() => onPick(place)}
      >
        <span className={styles.name}>{name}</span>
        {address !== "" && <span className={styles.address}>{address}</span>}
        {distance !== null && <span className={`${rows.duration} ${styles.distance}`}>{distance}</span>}
        <span className={styles.visits}>{visits}</span>
      </button>
    </li>
  );
}

/** The text of the search field, and what is asked for: the text as it was 300 ms after the last key, trimmed. */
function usePickerText() {
  const [text, setText] = useState("");
  return { text, setText, q: useDebounced(text, DEBOUNCE_MS).trim() };
}

interface PickerViewProps<T extends PlaceSearchResult> {
  search: ReturnType<typeof usePickerText>;
  query: UseQueryResult<T[]>;
  onPick: (place: T) => void;
  onCancel?: () => void;
  /** What a row says of how far the place is, for a list of the places near one; the rows of a list that is not of that say none. */
  distanceOf?: (place: T) => string;
}

/** The field, the places under it, and the way out: all that is of the picker whichever places it lists. */
function PickerView<T extends PlaceSearchResult>({ search, query, onPick, onCancel, distanceOf }: PickerViewProps<T>) {
  const places = useKeptData(query.data);
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape" && onCancel !== undefined) onCancel();
  };
  return (
    <div className={styles.picker} onKeyDown={onKeyDown}>
      <input
        type="search"
        className={forms.field}
        aria-label="Search places"
        placeholder="Search places"
        autoComplete="off"
        autoFocus
        value={search.text}
        onChange={(event) => search.setText(event.target.value)}
      />
      {query.isError && <ErrorState error={query.error} onRetry={() => void query.refetch()} />}
      {places !== undefined ? (
        <Shown busy={query.isPlaceholderData}>
          {places.length === 0 ? (
            <Empty message="No places found" />
          ) : (
            <ul className={rows.list} aria-label="Places">
              {places.map((place) => (
                <PlaceRow key={place.id} place={place} distance={distanceOf?.(place) ?? null} onPick={onPick} />
              ))}
            </ul>
          )}
        </Shown>
      ) : (
        !query.isError && <Loading />
      )}
      {onCancel !== undefined && (
        <button type="button" className={`${forms.secondary} ${styles.cancel}`} onClick={onCancel}>
          Cancel
        </button>
      )}
    </div>
  );
}

export type PlacePickerProps = {
  /** The owner gave up: the Cancel button, and Escape in the field. With none the picker has neither (a form that has its own Cancel). */
  onCancel?: () => void;
} & (
  | {
      /** The place the list is of (`GET /api/places/{id}/candidates`): the nearest to it first, and never it or a place merged into it. */
      placeId: number;
      /** A place of the list was chosen. */
      onPick: (candidate: PlaceCandidate) => void;
    }
  | {
      /** No place to start from (`GET /api/places/search`): the places in use, the most visited first, with no distance. */
      placeId?: undefined;
      onPick: (place: PlaceSearchResult) => void;
    }
);

/**
 * Where the owner picks one of their places: a field to search by name or address (asked for 300 ms after the last key), and the places
 * under it, each a button. With a `placeId` they are the places near it, the nearest first (to merge with: the places that can be); with none they are
 * all the places in use, the most visited first (to set as home, where there may be no place to measure from). It knows nothing of what the choice is for:
 * whoever shows it is told which place was chosen. The list that was on screen stays, fainter, while the next search is on its way, and stays under an
 * error with its Retry.
 */
export function PlacePicker(props: PlacePickerProps) {
  const search = usePickerText();
  // Both are asked for in every render, as hooks are; the one that is not wanted has nothing to ask for.
  const near = useCandidates(props.placeId ?? null, search.q);
  const found = usePlaceSearch(props.placeId === undefined ? search.q : null);
  return props.placeId === undefined ? (
    <PickerView search={search} query={found} onPick={props.onPick} onCancel={props.onCancel} />
  ) : (
    <PickerView search={search} query={near} onPick={props.onPick} onCancel={props.onCancel} distanceOf={(candidate) => formatDistance(candidate.distanceM)} />
  );
}
