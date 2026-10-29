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

/** A write of the edit, and the button that sent it: a Retry sends the same, and the focus goes back to that button. */
interface Write {
  body: EditBody;
  by: "save" | "detected";
}

/**
 * The name and the two dates of the trip as fields, with Save and Cancel. The dates are the trip's local dates: the day it begins and the day the
 * owner is back (the nights are those before it). The field is for the name that the owner gives the trip (`ownName`): it has the owner's name, and
 * is empty when the owner has given none, with the name that the trip is shown under as its placeholder, which is the made-up one then. An empty name
 * goes back to the made-up one. A name that was not touched is never made the owner's: what is sent for it is the owner's name as it is, null for none.
 *
 * The form is made for the trip as it was read when it opened (`read`, kept by the first render), and everything it judges is judged against that, whatever
 * the trip that is read again says while the form is open (the window is focused again, or the trip is 30 seconds old): which dates were touched, whether
 * the trip is ongoing, which dates are the owner's, and whether anything was changed. The one thing taken from the trip as it is now is the owner's name,
 * when the field was not touched: the name that was set elsewhere in the meantime is not taken back by a field that was never changed.
 *
 * What is sent for a date is only what the owner decided. A date that was not touched (it is what the form was filled in with) is null, which is "as
 * detected": a trip that is still going on has its end date moved on as nights are processed, so an end date sent back would be stored as the owner's, and
 * the trip would stop being ongoing and lose its latest night (P4-R41). The exception is a date that is the owner's already (`startEdited`, `endEdited`,
 * each its own): a write replaces the edit, and a null would take it back, so it is sent as it is. The end of a trip that is still going on is null when it
 * was not touched, whatever else is said of it. Nothing is sent when nothing was changed. A start that is not before the end, or a date that is empty, is
 * told by the form (on Save, and not as the dates are typed, which passes through such dates), with the focus on the field to put right; every other
 * refusal is the server's, in its words with no Retry (`WriteError`), and the form stays as it was to be put right. The trip's id is its first night, so a
 * new start date makes a new id: the page is replaced by the trip's new address, where the heading of the panel takes the focus (the form that had it is
 * gone). While the write is on its way Cancel and Escape wait: they cannot take it back, and a form that is gone cannot go on to the trip's new address.
 *
 * **Use detected dates** is for a trip whose edit has a start date or an end date: it sends null for both dates, with the name as the field has it (trimmed,
 * and null when empty), so the trip has the dates that detection found it with. The dates of the form are not sent, and may be empty. A write that failed
 * has its Retry send what failed, whichever button sent it, and the focus goes back to that button.
 */
export function EditTripForm({ trip, onClose }: { trip: TripResponse; onClose: () => void }) {
  const nameId = useId();
  const startId = useId();
  const endId = useId();
  const problemId = useId();
  const [read] = useState(() => trip);
  const initialName = read.ownName ?? "";
  const [name, setName] = useState(initialName);
  const [start, setStart] = useState(read.localStartDate);
  const [end, setEnd] = useState(read.localEndDate);
  const [problem, setProblem] = useState<Problem | null>(null);
  const startField = useRef<HTMLInputElement>(null);
  const endField = useRef<HTMLInputElement>(null);
  const saveButton = useRef<HTMLButtonElement>(null);
  const detectedButton = useRef<HTMLButtonElement>(null);
  const edit = useWrite(({ body }: Write) => putJson<EditTripResponse>(`/api/trips/${read.id}`, body));
  // A button that is turned off while it is pressed may take the focus with it: it goes back to the one that sent the write, which the owner presses
  // again once the form is right.
  useEffect(() => {
    if (edit.isError && focusLost()) (edit.variables.by === "detected" ? detectedButton : saveButton).current?.focus();
  }, [edit.isError, edit.variables]);
  const onDate = (set: (date: string) => void) => (event: ChangeEvent<HTMLInputElement>) => {
    set(event.target.value);
    setProblem(null); // what it said was of the dates that were
  };
  const send = (write: Write) =>
    edit.mutate(write, {
      onSuccess: ({ id }) => {
        if (id === read.id) return onClose();
        const route = { view: "trip", id } as const;
        wantHeadingFocus(route);
        navigate(route, { replace: true });
      },
    });
  /** What the field says of the name: the name that was typed, and null for an empty one; a field that was not touched says the owner's name as it is now. */
  const nameToSend = (): string | null => {
    const text = name.trim();
    if (text === initialName) return trip.ownName;
    return text === "" ? null : text;
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
    const nameTouched = name.trim() !== initialName;
    const startTouched = start !== read.localStartDate;
    const endTouched = end !== read.localEndDate;
    if (!nameTouched && !startTouched && !endTouched) return onClose();
    send({
      by: "save",
      body: {
        name: nameToSend(),
        startDate: startTouched || read.startEdited ? start : null,
        endDate: endTouched || (read.endEdited && !read.ongoing) ? end : null,
      },
    });
  };
  const detectedDates = () => {
    if (edit.isPending) return;
    setProblem(null);
    send({ by: "detected", body: { name: nameToSend(), startDate: null, endDate: null } });
  };
  const detecting = edit.isPending && edit.variables.by === "detected";
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
        placeholder={read.ownName === null ? read.name : "Automatic name"}
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
      {(read.startEdited || read.endEdited) && (
        <div className={styles.detected}>
          <button ref={detectedButton} type="button" className={forms.secondary} disabled={edit.isPending} onClick={detectedDates}>
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
 * Cancel at once. The page is replaced by the list of trips when the trip is deleted (Back must not land on a trip that is gone), where the heading of the list takes the focus (the question that had it is
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
        navigate({ view: "trips" }, { replace: true }); // the trip is gone: Back is not to go to it
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
