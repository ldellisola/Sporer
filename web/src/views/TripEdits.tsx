import { useEffect, useId, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { deleteJson, isRefusal, putJson } from "../api/client";
import { useWrite } from "../api/mutations";
import type { EditTripResponse, TripResponse } from "../api/types";
import { navigate } from "../app/router";
import { MAX_NAME_LENGTH, onEscape } from "./editForms";
import forms from "./Forms.module.css";
import styles from "./TripEdits.module.css";
import { WriteError } from "./WriteError";

// What the owner can do to a trip: name it, give it other dates, and delete it (Settings brings it back). The panel of the trip composes these.

/** The dates the server takes (1970 to 2099), which the date fields tell the pickers of a phone and a desktop. */
const EARLIEST_DATE = "1970-01-01";
const LATEST_DATE = "2099-12-31";

/** What is wrong with the two dates of the form, and the field that has it: the one to put the focus on. */
interface Problem {
  field: "start" | "end";
  message: string;
}

/**
 * What the form can tell of its dates without the server: both are there, and the trip begins before the day the owner comes back (its nights run from
 * the start date to the night before the end date, so the same day is no trip). Dates of the form (`yyyy-MM-dd`) are in the order of their text.
 */
function problemOf(start: string, end: string): Problem | null {
  if (start === "") return { field: "start", message: "Enter a start date." };
  if (end === "") return { field: "end", message: "Enter an end date." };
  if (start >= end) return { field: "end", message: "The start date must be before the end date." };
  return null;
}

/** Whether the focus has been lost (it is on the page itself: what had it has gone or was turned off). */
const focusLost = (): boolean => document.activeElement === null || document.activeElement === document.body;

/**
 * The name and the two dates of the trip as fields, with Save and Cancel. The dates are the trip's local dates: the day it begins and the day the
 * owner is back (the nights are those before it). The name of a trip that the owner has not edited is the automatic one: the field is empty
 * and shows it, and an empty name goes back to it. A trip that was edited shows the name it has, which may be the owner's or the automatic one (the
 * server does not say which), and keeps it unless the owner clears it: an automatic name sent back would be the owner's from then on.
 *
 * The dates are sent as they are, and the server takes one that is the trip's own as detected. Nothing is sent when nothing was changed. A start
 * that is not before the end, or a date that is empty, is told by the form (on Save, and not as the dates are typed, which passes through such
 * dates), with the focus on the field to put right; every other refusal is the server's, in its words with no Retry (`WriteError`), and the form
 * stays as it was to be put right. The trip's id is its first night, so a new start date makes a new id: the page is replaced by the trip's new address. While
 * the write is on its way Cancel and Escape wait: they cannot take it back, and a form that is gone cannot go on to the trip's new address.
 */
export function EditTripForm({ trip, onClose }: { trip: TripResponse; onClose: () => void }) {
  const nameId = useId();
  const startId = useId();
  const endId = useId();
  const problemId = useId();
  const initialName = trip.edited ? trip.name : "";
  const [name, setName] = useState(initialName);
  const [start, setStart] = useState(trip.localStartDate);
  const [end, setEnd] = useState(trip.localEndDate);
  const [problem, setProblem] = useState<Problem | null>(null);
  const startField = useRef<HTMLInputElement>(null);
  const endField = useRef<HTMLInputElement>(null);
  const saveButton = useRef<HTMLButtonElement>(null);
  const edit = useWrite((body: { name: string | null; startDate: string; endDate: string }) => putJson<EditTripResponse>(`/api/trips/${trip.id}`, body));
  // A button that is turned off while it is pressed may take the focus with it: it goes back to Save, which the owner presses again once the form is right.
  useEffect(() => {
    if (edit.isError && focusLost()) saveButton.current?.focus();
  }, [edit.isError]);
  const onDate = (set: (date: string) => void) => (event: ChangeEvent<HTMLInputElement>) => {
    set(event.target.value);
    setProblem(null); // what it said was of the dates that were
  };
  const save = () => {
    if (edit.isPending) return;
    const found = problemOf(start, end);
    setProblem(found);
    if (found !== null) {
      edit.reset(); // one thing to put right at a time: the refusal of the server was of the dates that were
      (found.field === "start" ? startField : endField).current?.focus();
      return;
    }
    const text = name.trim();
    if (text === initialName && start === trip.localStartDate && end === trip.localEndDate) return onClose();
    edit.mutate(
      { name: text === "" ? null : text, startDate: start, endDate: end },
      { onSuccess: ({ id }) => (id === trip.id ? onClose() : navigate({ view: "trip", id }, { replace: true })) },
    );
  };
  /** What a date field says of itself when the form has found it wrong: that it is, and where the reason is. */
  const invalidIf = (field: Problem["field"]) => (problem?.field === field ? { "aria-invalid": true, "aria-describedby": problemId } : {});
  return (
    <form
      className={forms.form}
      noValidate
      onKeyDown={onEscape(() => !edit.isPending && onClose())}
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        save();
      }}
    >
      <label className={forms.label} htmlFor={nameId}>
        Name
      </label>
      <input
        id={nameId}
        className={forms.field}
        type="text"
        autoComplete="off"
        autoFocus
        maxLength={MAX_NAME_LENGTH}
        placeholder={trip.edited ? "Automatic name" : trip.name}
        value={name}
        onFocus={(event) => event.currentTarget.select()}
        onChange={(event) => setName(event.target.value)}
      />
      <div className={styles.dates}>
        <div>
          <label className={forms.label} htmlFor={startId}>
            Start date
          </label>
          <input
            ref={startField}
            id={startId}
            className={`${forms.field} ${styles.date}`}
            type="date"
            min={EARLIEST_DATE}
            max={LATEST_DATE}
            value={start}
            onChange={onDate(setStart)}
            {...invalidIf("start")}
          />
        </div>
        <div>
          <label className={forms.label} htmlFor={endId}>
            End date
          </label>
          <input
            ref={endField}
            id={endId}
            className={`${forms.field} ${styles.date}`}
            type="date"
            min={EARLIEST_DATE}
            max={LATEST_DATE}
            value={end}
            onChange={onDate(setEnd)}
            {...invalidIf("end")}
          />
        </div>
      </div>
      {problem !== null && (
        <p id={problemId} className={styles.problem} role="alert">
          {problem.message}
        </p>
      )}
      <div className={forms.buttons}>
        <button ref={saveButton} type="submit" className={forms.primary} disabled={edit.isPending}>
          {edit.isPending ? "Saving…" : "Save"}
        </button>
        <button type="button" className={forms.secondary} disabled={edit.isPending} onClick={onClose}>
          Cancel
        </button>
      </div>
      {edit.isError && (
        <WriteError what="save" error={edit.error} onRetry={save} gone="This trip no longer exists." conflict="Overlaps another trip." />
      )}
    </form>
  );
}

/**
 * What deleting the trip is going to do, to be confirmed: it stays deleted when the data is processed again, and Settings brings it back. The
 * question takes the focus when it opens (it is read, and is not a button: Enter held down on the one that opened it would delete), so that Escape is
 * Cancel at once. The page goes to the list of trips when the trip is deleted. A refusal (the trip is gone already: 404) would be refused again: no Retry,
 * and Delete is off, with the focus on Cancel, which is the way on. While the write is on its way Cancel and Escape wait, as in the form of the edit.
 */
export function DeleteTripConfirm({ trip, onClose }: { trip: TripResponse; onClose: () => void }) {
  const question = useRef<HTMLParagraphElement>(null);
  const deleteButton = useRef<HTMLButtonElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const remove = useWrite(() => deleteJson(`/api/trips/${trip.id}`));
  const refused = remove.isError && isRefusal(remove.error);
  useEffect(() => question.current?.focus(), []);
  // Delete is off while the request is on its way, and after a refusal; the focus was on it, and goes to the button that is there to be pressed.
  useEffect(() => {
    if (refused) cancelButton.current?.focus();
    else if (remove.isError && focusLost()) deleteButton.current?.focus();
  }, [refused, remove.isError]);
  const submit = () => {
    if (remove.isPending) return;
    remove.mutate(undefined, { onSuccess: () => navigate({ view: "trips" }) });
  };
  return (
    <form
      className={forms.form}
      onKeyDown={onEscape(() => !remove.isPending && onClose())}
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        submit();
      }}
    >
      <p ref={question} tabIndex={-1} className={forms.question}>
        Delete this trip? It stays deleted when your data is reprocessed. You can restore it in Settings.
      </p>
      <div className={forms.buttons}>
        <button ref={deleteButton} type="submit" className={forms.primary} disabled={remove.isPending || refused}>
          {remove.isPending ? "Deleting…" : "Delete"}
        </button>
        <button ref={cancelButton} type="button" className={forms.secondary} disabled={remove.isPending} onClick={onClose}>
          Cancel
        </button>
      </div>
      {remove.isError && <WriteError what="delete" error={remove.error} onRetry={submit} gone="This trip no longer exists." />}
    </form>
  );
}

export interface TripEditActionsProps {
  onEdit: () => void;
  onDelete: () => void;
  /** The button to put the focus on as the buttons come back, when a form that one of them opened was closed: the focus was in the form, which is gone. */
  focus?: "edit" | "delete";
}

/** The buttons that open the forms, in the place where the forms will be: the two things that can be done to a trip. */
export function TripEditActions({ onEdit, onDelete, focus }: TripEditActionsProps) {
  const editButton = useRef<HTMLButtonElement>(null);
  const deleteButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (focus === "edit") editButton.current?.focus();
    if (focus === "delete") deleteButton.current?.focus();
  }, [focus]);
  return (
    <div className={forms.actions}>
      <button ref={editButton} type="button" className={forms.secondary} onClick={onEdit}>
        Edit
      </button>
      <button ref={deleteButton} type="button" className={forms.secondary} onClick={onDelete}>
        Delete trip
      </button>
    </div>
  );
}
