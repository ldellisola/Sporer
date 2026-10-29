import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { putJson } from "../api/client";
import { useWrite } from "../api/mutations";
import { settingsQueryOptions, useSettings } from "../api/queries";
import type { SettingsResponse } from "../api/types";
import { formatKm } from "../time/format";
import { focusLost } from "./editForms";
import forms from "./Forms.module.css";
import styles from "./TripDistance.module.css";
import { useNote } from "./SettingsNotes";
import { Section } from "./SettingsSection";
import { ErrorState, Loading } from "./States";
import { useKeptData } from "./useKeptData";
import { WriteError } from "./WriteError";

/** The distances the server takes, in kilometres (the ends included). */
const MIN_KM = 5;
const MAX_KM = 1000;

/** What the form says of a distance that is not one the server would take. */
const NOT_A_DISTANCE = `Enter a distance from ${MIN_KM} to ${MAX_KM} km.`;

/** The distance the text says, or null when it says none that the server takes: a number from 5 to 1000. */
function distanceOf(text: string): number | null {
  if (text.trim() === "") return null;
  const km = Number(text);
  return Number.isFinite(km) && km >= MIN_KM && km <= MAX_KM ? km : null;
}

/**
 * The distance as a field, with Save and Reset to default. The field has the distance that is in effect until the owner types in it, and then what they
 * typed: an untouched field follows the settings (they are read again after every write, and when the window is focused), and Save is for what was
 * changed, so a value that was only read is never sent back as the owner's (it would pin the default as a choice, and a stale one as an edit). A number
 * that the server would not take (outside 5 to 1000) is told by the form, on Save and not as it is typed, with the focus on the field; every other refusal
 * is the server's, in its words with no Retry (`WriteError`), and the field keeps what was typed. A failure that may pass has its Retry, which sends the
 * same again, and the focus goes back to the button that sent it. Reset sends null, which is the distance that is configured, and drops what was typed.
 * One write at a time: both buttons are off while one is on its way. What was done is a note (`useNote`); trips are worked out again by the server
 * before it answers, and what is on screen is asked for again.
 */
function Distance({ settings }: { settings: SettingsResponse }) {
  const client = useQueryClient();
  const fieldId = useId();
  const hintId = useId();
  const problemId = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const [problem, setProblem] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  const saveButton = useRef<HTMLButtonElement>(null);
  const resetButton = useRef<HTMLButtonElement>(null);
  const write = useWrite((km: number | null) => putJson<SettingsResponse>("/api/settings", { tripMinDistanceKm: km }));
  useNote(
    write.isSuccess
      ? {
          id: write.submittedAt,
          message:
            write.variables === null
              ? `Trip distance back to the default, ${formatKm(write.data.tripMinDistanceKm)}`
              : `Trip distance set to ${formatKm(write.data.tripMinDistanceKm)}`,
        }
      : null,
    write.reset,
  );
  // A button that is turned off while it is pressed may take the focus with it: it goes back to the one that sent the write, which is pressed again to retry.
  useEffect(() => {
    if (write.isError && focusLost()) (write.variables === null ? resetButton : saveButton).current?.focus();
  }, [write.isError, write.variables]);
  const text = draft ?? String(settings.tripMinDistanceKm);
  // A text that says no distance is a change (it is put right on Save); one that says the distance in effect is not.
  const changed = draft !== null && distanceOf(draft) !== settings.tripMinDistanceKm;
  const run = (km: number | null) => {
    if (write.isPending) return;
    write.mutate(km, {
      onSuccess: (answer) => {
        client.setQueryData(settingsQueryOptions().queryKey, answer);
        setDraft(null);
      },
    });
  };
  const save = () => {
    if (write.isPending || !changed) return;
    const km = distanceOf(text);
    setProblem(km === null);
    if (km === null) {
      write.reset(); // one thing to put right at a time: the refusal of the server was of the text that was
      field.current?.focus();
      return;
    }
    run(km);
  };
  const saving = write.isPending && write.variables !== null;
  const resetting = write.isPending && write.variables === null;
  return (
    <form
      className={forms.form}
      noValidate
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        save();
      }}
    >
      <label className={forms.label} htmlFor={fieldId}>
        Minimum distance from home (km)
      </label>
      <input
        ref={field}
        id={fieldId}
        className={forms.field}
        type="number"
        inputMode="decimal"
        min={MIN_KM}
        max={MAX_KM}
        step="any"
        autoComplete="off"
        value={text}
        aria-describedby={problem ? `${hintId} ${problemId}` : hintId}
        aria-invalid={problem ? true : undefined}
        onChange={(event) => {
          setDraft(event.target.value);
          setProblem(false); // what it said was of the text that was
        }}
      />
      <p id={hintId} className={styles.hint}>
        A trip is a night spent this far from home, or farther.
      </p>
      {problem && (
        <p id={problemId} className={forms.problem} role="alert">
          {NOT_A_DISTANCE}
        </p>
      )}
      <div className={forms.buttons}>
        <button ref={saveButton} type="submit" className={forms.primary} disabled={write.isPending || !changed}>
          {saving ? "Saving…" : "Save"}
        </button>
        <button
          ref={resetButton}
          type="button"
          className={forms.secondary}
          disabled={write.isPending}
          onClick={() => {
            setProblem(false);
            run(null);
          }}
        >
          {resetting ? "Resetting…" : `Reset to default (${formatKm(settings.tripMinDistanceKmDefault)})`}
        </button>
      </div>
      {write.isError && (
        <WriteError what="save" error={write.error} onRetry={() => run(write.variables)} gone="The settings no longer exist." />
      )}
    </form>
  );
}

/**
 * How far from home a night has to be to make a trip, from the settings (`GET /api/settings`, one request, and the one that the empty list of trips reads).
 * The settings that were on screen stay under an error with its Retry, as the lists do (`useKeptData`): the heading and the form are never blank.
 */
export function TripDistance() {
  const query = useSettings();
  const settings = useKeptData(query.data);
  return (
    <Section title="Trips">
      {query.isError && <ErrorState error={query.error} onRetry={() => void query.refetch()} />}
      {settings !== undefined ? <Distance settings={settings} /> : !query.isError && <Loading />}
    </Section>
  );
}
