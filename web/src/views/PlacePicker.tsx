import { useEffect, useState, type KeyboardEvent } from "react";
import { useCandidates } from "../api/queries";
import type { PlaceCandidate } from "../api/types";
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
 * A place of the list, which is one button: its name, where it is, how far, and how many stays there were. The button is named by what the
 * row says, in the order it says it, so that its name holds the text that is on it (voice control says what it sees).
 */
function CandidateRow({ candidate, onPick }: { candidate: PlaceCandidate; onPick: (candidate: PlaceCandidate) => void }) {
  const name = candidate.name ?? UNNAMED;
  const address = candidate.address ?? "";
  const distance = formatDistance(candidate.distanceM);
  const visits = formatCount(candidate.visits, "visit");
  return (
    <li>
      <button
        type="button"
        className={`${rows.tap} ${rows.row} ${styles.candidate}`}
        aria-label={[name, address, distance, visits].filter((part) => part !== "").join(", ")}
        onClick={() => onPick(candidate)}
      >
        <span className={styles.name}>{name}</span>
        {address !== "" && <span className={styles.address}>{address}</span>}
        <span className={`${rows.duration} ${styles.distance}`}>{distance}</span>
        <span className={styles.visits}>{visits}</span>
      </button>
    </li>
  );
}

export interface PlacePickerProps {
  /** The place the list is of (`GET /api/places/{id}/candidates`): the nearest to it first, and never it or a place merged into it. */
  placeId: number;
  /** A place of the list was chosen. */
  onPick: (candidate: PlaceCandidate) => void;
  /** The owner gave up: the Cancel button, and Escape in the field. With none the picker has neither (a form that has its own Cancel). */
  onCancel?: () => void;
}

/**
 * Where the owner picks one of their places: a field to search by name or address (asked for 300 ms after the last key), and the places
 * under it, the nearest first, each a button. It knows nothing of what the choice is for (a merge, a home): whoever shows it is told which
 * place was chosen. The list that was on screen stays, fainter, while the next search is on its way, and stays under an error with its Retry.
 */
export function PlacePicker({ placeId, onPick, onCancel }: PlacePickerProps) {
  const [text, setText] = useState("");
  const q = useDebounced(text, DEBOUNCE_MS).trim();
  const query = useCandidates(placeId, q);
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
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      {query.isError && <ErrorState error={query.error} onRetry={() => void query.refetch()} />}
      {places !== undefined ? (
        <Shown busy={query.isPlaceholderData}>
          {places.length === 0 ? (
            <Empty message="No places found" />
          ) : (
            <ul className={rows.list} aria-label="Places">
              {places.map((candidate) => (
                <CandidateRow key={candidate.id} candidate={candidate} onPick={onPick} />
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
