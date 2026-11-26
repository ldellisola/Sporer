import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { deleteJson, isNotFound, postJson, putJson } from "../api/client";
import { useWrite } from "../api/mutations";
import { usePlaces } from "../api/queries";
import type { PlaceCandidate, PlaceResponse } from "../api/types";
import { metresBetween } from "../map/geo";
import { formatCount, formatDistance } from "../time/format";
import { MAX_NAME_LENGTH, onEscape } from "./editForms";
import forms from "./Forms.module.css";
import styles from "./PlaceEdits.module.css";
import { PlacePicker } from "./PlacePicker";
import { UNNAMED } from "./placeNames";
import rows from "./Rows.module.css";
import { WriteError } from "./WriteError";

// What the owner can do to a place: rename it, merge others into it, and separate what was merged in. The panel of the place composes these.

export interface EditProps {
  /** The place that is shown: its id is the one that every write is to (a place that was merged is served as the one it was merged into). */
  place: PlaceResponse;
  /** The key of the place's query: the answer of a write is put in it, so that the name is the new one as the form closes and not a moment later. */
  placeKey: readonly unknown[];
}

/** The name of the place as a field, with Save and Cancel: an empty name goes back to the one OpenStreetMap has. */
export function RenameForm({ place, placeKey, onClose }: EditProps & { onClose: () => void }) {
  const client = useQueryClient();
  const fieldId = useId();
  const [text, setText] = useState(place.name ?? "");
  const rename = useWrite((name: string | null) => putJson<PlaceResponse>(`/api/places/${place.id}/name`, { name }));
  const save = () => {
    const name = text.trim();
    // What the field has is what is shown: a place that has only the name of OpenStreetMap would be given it as its own by a write of it.
    if (name === (place.name ?? "")) return onClose();
    rename.mutate(name === "" ? null : name, {
      onSuccess: (answer) => {
        client.setQueryData(placeKey, answer);
        onClose();
      },
    });
  };
  return (
    <form
      className={forms.form}
      onKeyDown={onEscape(onClose)}
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        save();
      }}
    >
      <label className={forms.label} htmlFor={fieldId}>
        Name
      </label>
      <input
        id={fieldId}
        className={forms.field}
        type="text"
        autoComplete="off"
        autoFocus
        maxLength={MAX_NAME_LENGTH}
        placeholder="OpenStreetMap name"
        value={text}
        onFocus={(event) => event.currentTarget.select()}
        onChange={(event) => setText(event.target.value)}
      />
      <div className={forms.buttons}>
        <button type="submit" className={forms.primary} disabled={rename.isPending}>
          {rename.isPending ? "Saving…" : "Save"}
        </button>
        <button type="button" className={forms.secondary} onClick={onClose}>
          Cancel
        </button>
      </div>
      {rename.isError && <WriteError what="rename" error={rename.error} onRetry={save} gone="This place no longer exists." />}
    </form>
  );
}

/** A place that is picked, as the form lists it: its name (null for none) and, when the map knows where it is, how far it is from the place it goes into. */
interface Picked {
  id: number;
  name: string | null;
  distanceM: number | null;
}

export interface MergeFormProps extends EditProps {
  /** The places picked so far, in the order they were picked: on the map (the shell's merge mode) or in the list under the form. */
  picked: readonly number[];
  /** Picks a place that was not, and takes off one that was. */
  onToggle: (id: number) => void;
  /** Closes the form: Cancel, Escape, and a merge that was made. */
  onClose: () => void;
}

/**
 * Merge mode's form: the places picked to be merged into the place that is open (it is the one that stays), which the owner picks by tapping their dots on
 * the map or their rows in the list of the nearest places under the form, each with its Remove; which of the names the place is to have, when there is more
 * than one to choose from; and Merge, which merges all of them at once (`places`), or none. The place's own name is chosen to begin with, as a merge of one
 * did: keeping it sends the name that is shown (the place has it as its own from then on), or null when it has none (null leaves the name as it is, and
 * "Unnamed place" is no name to give it). A picked place with no name has none to keep, and names that are the same are offered once.
 *
 * It takes the focus when it opens, on what it says (which a screen reader reads), so that Escape is Cancel at once. A merge the server refuses (409, 404)
 * would be refused again: no Retry, and the owner takes off the place that is in the way, or cancels.
 */
export function MergeForm({ place, placeKey, picked, onToggle, onClose }: MergeFormProps) {
  const client = useQueryClient();
  const group = useId();
  const question = useRef<HTMLParagraphElement>(null);
  const all = usePlaces().data?.places;
  // The names of the places picked in the list: a place picked there may not be on the map yet (its list has not come).
  const [seen, setSeen] = useState<ReadonlyMap<number, string | null>>(new Map());
  const [keep, setKeep] = useState<string | null>(place.name);
  const merge = useWrite((name: string | null) => postJson<PlaceResponse>(`/api/places/${place.id}/merge`, { places: picked, name }));
  useEffect(() => question.current?.focus(), []);

  const byId = new Map((all ?? []).map((one) => [one.id, one]));
  const listed: Picked[] = picked.map((id) => {
    const known = byId.get(id);
    return {
      id,
      name: known?.name ?? seen.get(id) ?? null,
      distanceM: known === undefined ? null : metresBetween(place, known),
    };
  });
  const here = place.name ?? UNNAMED;
  // The names to choose from: this place's, then each picked place's that is another, once.
  const names = [...new Set([place.name, ...listed.map((row) => row.name)].filter((name): name is string => name !== null))];
  const choices: (string | null)[] = place.name === null ? [null, ...names] : names;
  const kept = choices.includes(keep) ? keep : place.name; // a name of a place that was taken off is no longer one to keep
  const submit = () =>
    merge.mutate(kept, {
      onSuccess: (survivor) => {
        client.setQueryData(placeKey, survivor);
        onClose();
      },
    });
  const count = picked.length;
  return (
    // Escape is Cancel in the list as in the form: the list is part of merge mode.
    <div className={styles.merge} onKeyDown={onEscape(onClose)}>
      <form
        className={forms.form}
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          if (count > 0) submit();
        }}
      >
        <p ref={question} tabIndex={-1} className={forms.question}>
          {count === 0 ? `Tap the places on the map to merge into ${here}, or pick them in the list.` : `Merge ${formatCount(count, "place")} into ${here}?`}
        </p>
        {count > 0 && (
          <ul className={rows.list} aria-label="Places to merge">
            {listed.map((row) => {
              const name = row.name ?? UNNAMED;
              return (
                <li key={row.id} className={styles.merged}>
                  <span className={styles.mergedName}>
                    {name}
                    {row.distanceM !== null && <span className={styles.away}> · {formatDistance(row.distanceM)}</span>}
                  </span>
                  <button type="button" className={forms.secondary} aria-label={`Remove ${name}`} disabled={merge.isPending} onClick={() => onToggle(row.id)}>
                    Remove
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {count > 0 && choices.length > 1 && (
          <fieldset className={styles.choices}>
            <legend className={forms.label}>Name to keep</legend>
            {choices.map((name) => (
              <label key={name ?? ""} className={styles.choice}>
                <input type="radio" name={group} checked={kept === name} disabled={merge.isPending} onChange={() => setKeep(name)} />
                {name ?? UNNAMED}
              </label>
            ))}
          </fieldset>
        )}
        <div className={forms.buttons}>
          <button type="submit" className={forms.primary} disabled={merge.isPending || count === 0}>
            {merge.isPending ? "Merging…" : "Merge"}
          </button>
          <button type="button" className={forms.secondary} onClick={onClose}>
            Cancel
          </button>
        </div>
        {merge.isError && <WriteError what="merge" error={merge.error} onRetry={submit} gone="One of the places no longer exists." />}
      </form>
      <h2 className={rows.heading}>
        Nearest places
      </h2>
      <PlacePicker
        placeId={place.id}
        autoFocus={false}
        picked={new Set(picked)}
        onPick={(candidate: PlaceCandidate) => {
          setSeen((last) => new Map(last).set(candidate.id, candidate.name));
          onToggle(candidate.id);
        }}
      />
    </div>
  );
}

/**
 * The places that were merged into this one, each with the button that makes it a place of its own again (its stays and its name are its own).
 * The row that was separated is gone, and the focus was on its button: it goes to the button of the next row (the one before it for the last),
 * and for the last of all, where the section goes with it, to `onEmptied` (the panel puts it on the name of the place). A separate that failed
 * leaves the focus on the button of its row, which was off while the request was on its way; unless the server says there is no such merge (404):
 * the row goes with the refetch, and the focus goes where it does for a row that was separated. The focus that is to move is held until the
 * button it is to move to can take it, and is let go of when it has, or when that button is no longer there: it never moves later.
 */
export function MergedPlaces({ place, placeKey, onEmptied }: EditProps & { onEmptied: () => void }) {
  const client = useQueryClient();
  const headingId = useId();
  const buttons = useRef(new Map<number, HTMLButtonElement>());
  const focusAfter = useRef<number | null>(null);
  const separate = useWrite((other: number) => deleteJson(`/api/places/${place.id}/merged/${other}`));
  // A button that is disabled cannot take the focus, and all of them are while a write is on its way: the focus waits for the write to be
  // done, and the list to be drawn as it is to be. It is let go of once it has moved, and when the button it was to move to is not there.
  useEffect(() => {
    const target = focusAfter.current;
    if (target === null) return;
    const button = buttons.current.get(target);
    if (button?.disabled) return;
    focusAfter.current = null;
    button?.focus();
  });
  const run = (other: number) => {
    const at = place.merged.findIndex((merged) => merged.id === other);
    const next = place.merged[at + 1] ?? place.merged[at - 1];
    // The row is to go, and the focus on it with it: to the next row, or to the panel when there is none.
    const goes = () => {
      if (next === undefined) onEmptied();
      else focusAfter.current = next.id;
    };
    separate.mutate(other, {
      onSuccess: () => {
        goes();
        client.setQueryData<PlaceResponse>(placeKey, (old) => old && { ...old, merged: old.merged.filter((merged) => merged.id !== other) });
      },
      onError: (error) => {
        if (isNotFound(error)) goes(); // not merged any more: the refetch that a 404 makes takes the row away
        else focusAfter.current = other;
      },
    });
  };
  return (
    <section className={rows.section} aria-labelledby={headingId}>
      <h2 id={headingId} className={rows.heading}>
        Merged places
      </h2>
      <ul className={rows.list}>
        {place.merged.map((merged) => {
          const name = merged.name ?? UNNAMED;
          const working = separate.isPending && separate.variables === merged.id;
          return (
            <li key={merged.id} className={styles.merged}>
              <span className={styles.mergedName}>{name}</span>
              <button
                ref={(button) => {
                  if (button === null) buttons.current.delete(merged.id);
                  else buttons.current.set(merged.id, button);
                }}
                type="button"
                className={forms.secondary}
                aria-label={working ? undefined : `Separate ${name}`}
                disabled={separate.isPending}
                onClick={() => run(merged.id)}
              >
                {working ? "Separating…" : "Separate"}
              </button>
            </li>
          );
        })}
      </ul>
      {separate.isError && (
        <WriteError
          what="separate"
          error={separate.error}
          onRetry={() => separate.variables !== undefined && run(separate.variables)}
          gone="It is not merged into this place any more."
        />
      )}
    </section>
  );
}
