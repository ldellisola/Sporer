import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { deleteJson, isNotFound, isRefusal, postJson, putJson } from "../api/client";
import { useWrite } from "../api/mutations";
import type { PlaceCandidate, PlaceResponse } from "../api/types";
import forms from "./Forms.module.css";
import styles from "./PlaceEdits.module.css";
import { UNNAMED } from "./placeNames";
import rows from "./Rows.module.css";
import { WriteError } from "./WriteError";

// What the owner can do to a place: rename it, merge another into it, and separate what was merged in. The panel of the place composes these.

/**
 * The longest name the server takes. The field counts what a text field counts (WebKit counts what a reader sees as one character, an emoji,
 * as one; the server counts UTF-16 units, which make an emoji two), so a name can pass the field and be refused: that is a 400, which says so
 * in the server's words (`WriteError`).
 */
const MAX_NAME_LENGTH = 100;

/** The key handler of a form: Escape is Cancel, which every form of the panel takes it as. */
const onEscape = (action: () => void) => (event: KeyboardEvent) => {
  if (event.key === "Escape") action();
};

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
      <div className={styles.buttons}>
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

/**
 * What the merge is going to do, to be confirmed: "Merge B into A?", A being the place that is open (it is the one that stays), and which of
 * the two names the place is to have. A's is chosen to begin with. Keeping A's sends the name that is shown (the place has it as its own from
 * then on), or null when A has none (null leaves the name as it is, and "Unnamed place" is no name to give it); keeping B's sends B's, and
 * a B with no name has none to keep. Two places that have the same name have nothing to choose between: no choice is offered, and the
 * question says it is the other one that is merged in.
 *
 * It takes the focus when it opens (on the question, which a screen reader reads, and not on a button: Enter held down on the row that was
 * picked would merge), so that Escape is Cancel at once. A merge the server refuses (409, 404) would be refused again: no Retry, and Merge is
 * off, but the owner can choose another place (`onChooseAnother`) or cancel; the focus is put on that button, since the one it was on is off.
 */
export function MergeConfirm({
  place,
  placeKey,
  other,
  onClose,
  onChooseAnother,
}: EditProps & { other: PlaceCandidate; onClose: () => void; onChooseAnother: () => void }) {
  const client = useQueryClient();
  const group = useId();
  const question = useRef<HTMLParagraphElement>(null);
  const chooseAnother = useRef<HTMLButtonElement>(null);
  const [keep, setKeep] = useState<"here" | "there">("here");
  const merge = useWrite((name: string | null) => postJson<PlaceResponse>(`/api/places/${place.id}/merge`, { place: other.id, name }));
  const here = place.name ?? UNNAMED;
  const there = other.name ?? UNNAMED;
  const same = here === there;
  // A 400 can be put right (the other name may be shorter); a 404 or a 409 is about the two places, and not about what the form says.
  const conflict = merge.isError && isRefusal(merge.error) && merge.error.status !== 400;
  useEffect(() => question.current?.focus(), []);
  // Merge is off after a refusal, and the focus was on it (it is off while the request is on its way): it goes to the way on, which is there now.
  useEffect(() => {
    if (conflict) chooseAnother.current?.focus();
  }, [conflict]);
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
      <p ref={question} tabIndex={-1} className={styles.question}>
        {same ? `Merge the other “${there}” into this one?` : `Merge ${there} into ${here}?`}
      </p>
      {!same && (
        <fieldset className={styles.choices}>
          <legend className={forms.label}>Name to keep</legend>
          <label className={styles.choice}>
            <input type="radio" name={group} checked={keep === "here"} onChange={() => setKeep("here")} />
            {here}
          </label>
          <label className={styles.choice}>
            <input type="radio" name={group} checked={keep === "there"} disabled={other.name === null} onChange={() => setKeep("there")} />
            {there}
          </label>
        </fieldset>
      )}
      <div className={styles.buttons}>
        <button type="submit" className={forms.primary} disabled={merge.isPending || conflict}>
          {merge.isPending ? "Merging…" : "Merge"}
        </button>
        <button type="button" className={forms.secondary} onClick={onClose}>
          Cancel
        </button>
      </div>
      {merge.isError && (
        <WriteError
          what="merge"
          error={merge.error}
          onRetry={submit}
          gone="One of the places no longer exists."
          refusedActions={
            conflict ? (
              <button ref={chooseAnother} type="button" className={forms.secondary} onClick={onChooseAnother}>
                Choose another place
              </button>
            ) : undefined
          }
        />
      )}
    </form>
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

export interface EditActionsProps {
  onRename: () => void;
  onMerge: () => void;
  /** The button to put the focus on as the buttons come back, when a form that one of them opened was closed: the focus was in the form, which is gone. */
  focus?: "rename" | "merge";
}

/** The buttons that open the forms, in the place where the forms will be: the two things that can be done to a place. */
export function EditActions({ onRename, onMerge, focus }: EditActionsProps) {
  const renameButton = useRef<HTMLButtonElement>(null);
  const mergeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (focus === "rename") renameButton.current?.focus();
    if (focus === "merge") mergeButton.current?.focus();
  }, [focus]);
  return (
    <div className={styles.actions}>
      <button ref={renameButton} type="button" className={forms.secondary} onClick={onRename}>
        Rename
      </button>
      <button ref={mergeButton} type="button" className={forms.secondary} onClick={onMerge}>
        Merge with…
      </button>
    </div>
  );
}
