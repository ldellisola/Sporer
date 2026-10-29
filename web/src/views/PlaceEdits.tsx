import { useQueryClient } from "@tanstack/react-query";
import { useId, useState, type FormEvent, type KeyboardEvent } from "react";
import { ApiError, deleteJson, isNotFound, postJson, putJson } from "../api/client";
import { useWrite } from "../api/mutations";
import type { PlaceCandidate, PlaceResponse } from "../api/types";
import styles from "./PlaceEdits.module.css";
import rows from "./Rows.module.css";
import { ErrorState } from "./States";

// What the owner can do to a place: rename it, merge another into it, and separate what was merged in. The panel of the place composes these.

/** What a place is called where it has no name. */
export const UNNAMED = "Unnamed place";

/** The longest name the server takes, in characters as a text field counts them. */
const MAX_NAME_LENGTH = 100;

/** The key handler of a form: Escape is Cancel, which every form of the panel takes it as. */
const onEscape = (action: () => void) => (event: KeyboardEvent) => {
  if (event.key === "Escape") action();
};

/**
 * Why a write did not go through, for the line under its Retry: what is said for the status it was answered with, and for any other
 * failure the error itself (which names the method, the path and the status). A string is what the error line shows as it is.
 */
const whyNot = (error: unknown, saidFor404: string): unknown => (isNotFound(error) ? saidFor404 : error);

/**
 * Why a merge did not go through, for the line under its Retry. A 409 is shown in the server's own words (`detail`, which is the message of
 * the refusal): the web never reads those words to decide what to say (P4-R26), and a 409 that has none gets a generic line. A 404 is the
 * status's business: one of the two places is gone. Any other failure is the error itself, which names the method, the path and the status.
 */
function whyMergeFailed(error: unknown): unknown {
  if (!(error instanceof ApiError)) return error;
  if (error.status === 404) return "One of the places no longer exists.";
  if (error.status === 409) return `Could not merge: ${error.detail ?? "the server refused it."}`;
  return error;
}

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
      className={styles.form}
      onKeyDown={onEscape(onClose)}
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        save();
      }}
    >
      <label className={styles.label} htmlFor={fieldId}>
        Name
      </label>
      <input
        id={fieldId}
        className={styles.field}
        type="text"
        autoComplete="off"
        autoFocus
        maxLength={MAX_NAME_LENGTH}
        placeholder="OpenStreetMap name"
        value={text}
        onFocus={(event) => event.currentTarget.select()}
        onChange={(event) => setText(event.target.value)}
      />
      <div className={styles.buttons}>
        <button type="submit" className={styles.primary} disabled={rename.isPending}>
          {rename.isPending ? "Saving…" : "Save"}
        </button>
        <button type="button" className={styles.secondary} onClick={onClose}>
          Cancel
        </button>
      </div>
      {rename.isError && <ErrorState message="Couldn't rename" error={whyNot(rename.error, "This place no longer exists")} onRetry={save} />}
    </form>
  );
}

/**
 * What the merge is going to do, to be confirmed: "Merge B into A?", A being the place that is open (it is the one that stays), and which of
 * the two names the place is to have. A's is chosen to begin with. Keeping A's sends the name that is shown (the place has it as its own from
 * then on), or null when A has none (null leaves the name as it is, and "Unnamed place" is no name to give it); keeping B's sends B's, and
 * a B with no name has none to keep.
 */
export function MergeConfirm({ place, placeKey, other, onClose }: EditProps & { other: PlaceCandidate; onClose: () => void }) {
  const client = useQueryClient();
  const group = useId();
  const [keep, setKeep] = useState<"here" | "there">("here");
  const merge = useWrite((name: string | null) => postJson<PlaceResponse>(`/api/places/${place.id}/merge`, { place: other.id, name }));
  const here = place.name ?? UNNAMED;
  const there = other.name ?? UNNAMED;
  const submit = () =>
    merge.mutate(keep === "here" ? place.name : other.name, {
      onSuccess: (survivor) => {
        client.setQueryData(placeKey, survivor);
        onClose();
      },
    });
  return (
    <form
      className={styles.form}
      onKeyDown={onEscape(onClose)}
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        submit();
      }}
    >
      <p className={styles.question}>
        Merge {there} into {here}?
      </p>
      <fieldset className={styles.choices}>
        <legend className={styles.label}>Name to keep</legend>
        <label className={styles.choice}>
          <input type="radio" name={group} checked={keep === "here"} onChange={() => setKeep("here")} />
          {here}
        </label>
        <label className={styles.choice}>
          <input type="radio" name={group} checked={keep === "there"} disabled={other.name === null} onChange={() => setKeep("there")} />
          {there}
        </label>
      </fieldset>
      <div className={styles.buttons}>
        <button type="submit" className={styles.primary} disabled={merge.isPending}>
          {merge.isPending ? "Merging…" : "Merge"}
        </button>
        <button type="button" className={styles.secondary} onClick={onClose}>
          Cancel
        </button>
      </div>
      {merge.isError && <ErrorState message="Couldn't merge" error={whyMergeFailed(merge.error)} onRetry={submit} />}
    </form>
  );
}

/** The places that were merged into this one, each with the button that makes it a place of its own again (its stays and its name are its own). */
export function MergedPlaces({ place, placeKey }: EditProps) {
  const client = useQueryClient();
  const headingId = useId();
  const separate = useWrite((other: number) => deleteJson(`/api/places/${place.id}/merged/${other}`));
  const run = (other: number) =>
    separate.mutate(other, {
      onSuccess: () => client.setQueryData<PlaceResponse>(placeKey, (old) => old && { ...old, merged: old.merged.filter((merged) => merged.id !== other) }),
    });
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
                type="button"
                className={styles.secondary}
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
        <ErrorState
          message="Couldn't separate"
          error={whyNot(separate.error, "It is not merged into this place any more.")}
          onRetry={() => separate.variables !== undefined && run(separate.variables)}
        />
      )}
    </section>
  );
}

/** The buttons that open the forms, in the place where the forms will be: the two things that can be done to a place. */
export function EditActions({ onRename, onMerge }: { onRename: () => void; onMerge: () => void }) {
  return (
    <div className={styles.actions}>
      <button type="button" className={styles.secondary} onClick={onRename}>
        Rename
      </button>
      <button type="button" className={styles.secondary} onClick={onMerge}>
        Merge with…
      </button>
    </div>
  );
}
