import { useQueryClient, type UseMutationResult } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { homesQueryOptions } from "../api/queries";
import type { AddHomeRequest, HomePeriod, HomesResponse, PlaceSearchResult } from "../api/types";
import { focusLost, onEscape } from "./editForms";
import forms from "./Forms.module.css";
import { PlacePicker } from "./PlacePicker";
import { UNNAMED } from "./placeNames";
import styles from "./SetHome.module.css";
import { WriteError } from "./WriteError";

/** The write that sets a home, which the section owns (it goes on, and what it did is said, when the form is gone): the form uses it, and `isPending` is its to show. */
export type AddHome = UseMutationResult<HomePeriod, Error, AddHomeRequest>;

/** The dates the server takes (1970 to 2099), which the date fields tell the pickers of a phone and a desktop. */
const EARLIEST_DATE = "1970-01-01";
const LATEST_DATE = "2099-12-31";

/** What is wrong with the two dates of the form, and the field that has it: the one to put the focus on. */
interface Problem {
  field: "from" | "to";
  message: string;
}

/**
 * What the form can tell of its dates without the server: the first is there, and the last, when there is one, is not before it (the same day is one night).
 * Dates of the form (`yyyy-MM-dd`) are in the order of their text.
 */
function problemOf(from: string, to: string): Problem | null {
  if (from === "") return { field: "from", message: "Enter a start date." };
  if (to !== "" && to < from) return { field: "to", message: "The end date must not be before the start date." };
  return null;
}

/** The periods with `period` among them, in date order as the server lists them (what was asked for again says the rest when it comes). */
const withPeriod = (old: HomesResponse | undefined, period: HomePeriod): HomesResponse | undefined =>
  old && { periods: [...old.periods, period].sort((a, b) => a.from.localeCompare(b.from) || a.id - b.id) };

interface HomeDatesProps {
  place: PlaceSearchResult;
  add: AddHome;
  onChooseAnother: () => void;
  onClose: () => void;
}

/**
 * What the place is to be home for, to be saved: the night it was home from, and the night it was home to when it was not for good (the nights are those the
 * owner slept at the place). A home that is set takes the place of what detection found for those dates, which the form says before it is saved (P4-R44). The question takes the focus when the form opens (it
 * is read, and Escape is Cancel at once). A start date that is empty, or an end date before it, is told by the form (on Save, and not as the dates are typed,
 * which passes through such dates), with the focus on the field to put right; every other refusal is the server's, in its words with no Retry (`WriteError`),
 * and the form stays as it was to be put right: a 409 is another home of the owner's in these dates, and a 404 is a place that is gone, which another place
 * is the way on from. While the write is on its way Cancel, Choose another place and Escape wait: they cannot take it back.
 */
function HomeDates({ place, add, onChooseAnother, onClose }: HomeDatesProps) {
  const client = useQueryClient();
  const fromId = useId();
  const toId = useId();
  const problemId = useId();
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [problem, setProblem] = useState<Problem | null>(null);
  const question = useRef<HTMLParagraphElement>(null);
  const fromField = useRef<HTMLInputElement>(null);
  const toField = useRef<HTMLInputElement>(null);
  const saveButton = useRef<HTMLButtonElement>(null);
  useEffect(() => question.current?.focus(), []);
  // The button is turned off while it is pressed, and may take the focus with it: it goes back to it, which is pressed again once the form is right.
  useEffect(() => {
    if (add.isError && focusLost()) saveButton.current?.focus();
  }, [add.isError, add.variables]);
  const send = (body: AddHomeRequest) => {
    if (add.isPending) return;
    add.mutate(body, {
      onSuccess: (period) => {
        client.setQueryData<HomesResponse>(homesQueryOptions().queryKey, (old) => withPeriod(old, period));
        onClose();
      },
    });
  };
  const save = () => {
    const found = problemOf(from, to);
    setProblem(found);
    if (found !== null) {
      add.reset(); // one thing to put right at a time: the refusal of the server was of the dates that were
      (found.field === "from" ? fromField : toField).current?.focus();
      return;
    }
    send({ placeId: place.id, from, to: to === "" ? null : to });
  };
  const onDate = (set: (date: string) => void) => (event: { target: { value: string } }) => {
    set(event.target.value);
    setProblem(null); // what it said was of the dates that were
  };
  /** What a date field says of itself when the form has found it wrong: that it is, and where the reason is. */
  const invalidIf = (field: Problem["field"]) => (problem?.field === field ? { "aria-invalid": true, "aria-describedby": problemId } : {});
  return (
    <form
      className={forms.form}
      noValidate
      onKeyDown={onEscape(() => !add.isPending && onClose())}
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        save();
      }}
    >
      <p ref={question} tabIndex={-1} className={forms.question}>
        {`Set ${place.name ?? UNNAMED} as home`}
      </p>
      {place.address !== null && <p className={styles.detail}>{place.address}</p>}
      <p className={styles.detail}>A home you set replaces what was detected for those dates.</p>
      <div className={forms.dates}>
        <div>
          <label className={forms.label} htmlFor={fromId}>
            From
          </label>
          <input
            ref={fromField}
            id={fromId}
            className={`${forms.field} ${forms.date}`}
            type="date"
            min={EARLIEST_DATE}
            max={LATEST_DATE}
            value={from}
            onChange={onDate(setFrom)}
            {...invalidIf("from")}
          />
        </div>
        <div>
          <label className={forms.label} htmlFor={toId}>
            To (optional)
          </label>
          <input
            ref={toField}
            id={toId}
            className={`${forms.field} ${forms.date}`}
            type="date"
            min={EARLIEST_DATE}
            max={LATEST_DATE}
            value={to}
            onChange={onDate(setTo)}
            {...invalidIf("to")}
          />
        </div>
      </div>
      <div className={styles.another}>
        <button type="button" className={forms.secondary} disabled={add.isPending} onClick={onChooseAnother}>
          Choose another place
        </button>
      </div>
      {problem !== null && (
        <p id={problemId} className={forms.problem} role="alert">
          {problem.message}
        </p>
      )}
      <div className={forms.buttons}>
        <button ref={saveButton} type="submit" className={forms.primary} disabled={add.isPending}>
          {add.isPending ? "Saving…" : "Save"}
        </button>
        <button type="button" className={forms.secondary} disabled={add.isPending} onClick={onClose}>
          Cancel
        </button>
      </div>
      {add.isError && <WriteError what="save" error={add.error} onRetry={() => send(add.variables)} gone="That place no longer exists." />}
    </form>
  );
}

/**
 * The form that sets a home: first the place, picked from all the places in use (`PlacePicker` with no place to start from: there may be none that was
 * detected, which is when this matters most), then the dates (`HomeDates`), with a way back to the picker, which drops what the write said of the place
 * that was chosen. `add` is the write, which the section owns.
 */
export function SetHome({ add, onClose }: { add: AddHome; onClose: () => void }) {
  const [place, setPlace] = useState<PlaceSearchResult | null>(null);
  if (place === null) return <PlacePicker onPick={setPlace} onCancel={onClose} />;
  // The refusal that is on screen was of that place: it is forgotten with it, and not said again (a live region that is made with a message is announced)
  // of the form for the next one.
  const chooseAnother = () => {
    add.reset();
    setPlace(null);
  };
  return <HomeDates place={place} add={add} onChooseAnother={chooseAnother} onClose={onClose} />;
}
