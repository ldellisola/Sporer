import { useEffect, useId, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { deleteJson, isRefusal, putJson } from "../api/client";
import { useWrite } from "../api/mutations";
import type { EditTripResponse, TripResponse } from "../api/types";
import { wantHeadingFocus } from "../app/headingFocus";
import { navigate } from "../app/router";
import { focusLost, MAX_NAME_LENGTH, onEscape } from "./editForms";
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

/** What a write of the trip's edit says: all three keys, which the server wants, and null for each of them is as detected. */
interface EditBody {
  name: string | null;
  startDate: string | null;
  endDate: string | null;
}

/**
 * The name and the two dates of the trip as fields, with Save and Cancel. The dates are the trip's local dates: the day it begins and the day the
 * owner is back (the nights are those before it). The field is for the name that the owner gives the trip (`ownName`): it has the owner's name, and
 * is empty when the owner has given none, with the name that the trip is shown under as its placeholder, which is the made-up one then. An empty name
 * goes back to the made-up one. What is sent for a name that was not touched is `ownName` as it is, so that a made-up name is never made the owner's.
 *
 * The dates are sent as they are, and the server takes one that is the trip's own as detected. Nothing is sent when nothing was changed. A start
 * that is not before the end, or a date that is empty, is told by the form (on Save, and not as the dates are typed, which passes through such
 * dates), with the focus on the field to put right; every other refusal is the server's, in its words with no Retry (`WriteError`), and the form
 * stays as it was to be put right. The trip's id is its first night, so a new start date makes a new id: the page is replaced by the trip's new address,
 * where the heading of the panel takes the focus (the form that had it is gone). While the write is on its way Cancel and Escape wait: they cannot take
 * it back, and a form that is gone cannot go on to the trip's new address.
 *
 * **Use detected dates** is for a trip that was edited (which does not say that its dates were: a name is an edit too): it sends null for both dates, with
 * the owner's name as it is (what is typed in the form is not sent, and neither are its dates, which may be empty), so the trip has the dates that
 * detection found it with. A write that failed has its Retry send what failed, whichever button it was sent by.
 */
export function EditTripForm({ trip, onClose }: { trip: TripResponse; onClose: () => void }) {
  const nameId = useId();
  const startId = useId();
  const endId = useId();
  const problemId = useId();
  const initialName = trip.ownName ?? "";
  const [name, setName] = useState(initialName);
  const [start, setStart] = useState(trip.localStartDate);
  const [end, setEnd] = useState(trip.localEndDate);
  const [problem, setProblem] = useState<Problem | null>(null);
  const startField = useRef<HTMLInputElement>(null);
  const endField = useRef<HTMLInputElement>(null);
  const saveButton = useRef<HTMLButtonElement>(null);
  const edit = useWrite((body: EditBody) => putJson<EditTripResponse>(`/api/trips/${trip.id}`, body));
  // A button that is turned off while it is pressed may take the focus with it: it goes back to Save, which the owner presses again once the form is right.
  useEffect(() => {
    if (edit.isError && focusLost()) saveButton.current?.focus();
  }, [edit.isError]);
  const onDate = (set: (date: string) => void) => (event: ChangeEvent<HTMLInputElement>) => {
    set(event.target.value);
    setProblem(null); // what it said was of the dates that were
  };
  const send = (body: EditBody) =>
    edit.mutate(body, {
      onSuccess: ({ id }) => {
        if (id === trip.id) return onClose();
        const route = { view: "trip", id } as const;
        wantHeadingFocus(route);
        navigate(route, { replace: true });
      },
    });
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
    send({ name: text === "" ? null : text, startDate: start, endDate: end });
  };
  const detectedDates = () => {
    if (edit.isPending) return;
    setProblem(null);
    send({ name: trip.ownName, startDate: null, endDate: null });
  };
  const detecting = edit.isPending && edit.variables.startDate === null;
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
        placeholder={trip.ownName === null ? trip.name : "Automatic name"}
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
      {trip.edited && (
        <div className={styles.detected}>
          <button type="button" className={forms.secondary} disabled={edit.isPending} onClick={detectedDates}>
            {detecting ? "Using detected dates…" : "Use detected dates"}
          </button>
        </div>
      )}
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
        <WriteError what="save" error={edit.error} onRetry={() => send(edit.variables)} gone="This trip no longer exists." conflict="Overlaps another trip." />
      )}
    </form>
  );
}

/**
 * What deleting the trip is going to do, to be confirmed: it stays deleted when the data is processed again, and Settings brings it back. The
 * question takes the focus when it opens (it is read, and is not a button: Enter held down on the one that opened it would delete), so that Escape is
 * Cancel at once. The page goes to the list of trips when the trip is deleted, where the heading of the list takes the focus (the question that had it is
 * gone). A refusal (the trip is gone already: 404) would be refused again: no Retry,
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
    remove.mutate(undefined, {
      onSuccess: () => {
        wantHeadingFocus({ view: "trips" });
        navigate({ view: "trips" });
      },
    });
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
