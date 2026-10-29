import { useQueryClient } from "@tanstack/react-query";
import { useId, useState, type FormEvent, type KeyboardEvent } from "react";
import { ApiError, deleteJson, isNotFound, postJson, putJson } from "../api/client";
import { useWrite } from "../api/mutations";
import { placeQueryOptions, shownOf, usePlace } from "../api/queries";
import type { PlaceCandidate, PlaceResponse, PlaceVisit } from "../api/types";
import { goBack, navigate } from "../app/router";
import { dateLabel, dateOf } from "../time/dates";
import { formatDuration, formatInteger, formatTime } from "../time/format";
import styles from "./PlacePanel.module.css";
import { PlacePicker } from "./PlacePicker";
import rows from "./Rows.module.css";
import { Empty, ErrorState, Loading } from "./States";

export interface PlacePanelProps {
  /** The place the address asks for. A panel is made for one place: another place is another panel (the app keys it by this). */
  id: number;
}

/** What the line under the name says of where the place is: the address (which names the city) or else the city, and the country. */
function whereIs(place: PlaceResponse): string | null {
  const parts = [place.address || place.city, place.country].filter((part): part is string => part !== null && part !== "");
  return parts.length === 0 ? null : parts.join(", ");
}

/** The way out, which every state of the panel has: the view the owner came from, or today if the place was opened as a page (`goBack`). */
function BackButton() {
  return (
    <button type="button" className={`${rows.tap} ${styles.back}`} onClick={() => goBack()}>
      <span aria-hidden="true">‹</span> Back
    </button>
  );
}

/** A figure of the place and what it is. The term is read first, and the figure is shown first: that is the mockup's stat. */
function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.stat}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

/**
 * A visit opens its day: the local date it began on, as the API says it (`date`), which is not always the date of it on the clock of
 * this device. Both times are on the clock of the zone it began in. The button is named by what the row says, so that its name holds
 * the text that is on it, and no two rows have the same.
 */
function VisitRow({ visit }: { visit: PlaceVisit }) {
  const day = dateLabel(visit.date);
  const times = `${formatTime(visit.start, visit.timeZone)} – ${formatTime(visit.end, visit.timeZone)}`;
  const length = formatDuration((Date.parse(visit.end) - Date.parse(visit.start)) / 1000);
  return (
    <li>
      <button
        type="button"
        className={`${rows.tap} ${rows.row} ${styles.visit}`}
        aria-label={`Open ${day}, ${times}, ${length}`}
        onClick={() => navigate({ view: "day", date: visit.date })}
      >
        <span className={styles.day}>{day}</span>
        <span className={styles.times}>{times}</span>
        <span className={`${rows.duration} ${styles.length}`}>{length}</span>
      </button>
    </li>
  );
}

/** What a place is called where it has no name. */
const UNNAMED = "Unnamed place";

/** The longest name the server takes, in characters as a text field counts them. */
const MAX_NAME_LENGTH = 100;

/** What an edit is doing to the place: nothing, or the one form that is open (the forms are in the panel, and only one is open at a time). */
type Editing = { form: "none" } | { form: "rename" } | { form: "pick" } | { form: "merge"; other: PlaceCandidate };

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
 * A merge that was refused with a 409 is one of two things, and the server's message says which (`detail`): the two places are the same place
 * once their merges are followed, or the merge would make a chain longer than the views follow (32 merges: its message says "merges deep").
 */
function whyMergeFailed(error: unknown): unknown {
  if (!(error instanceof ApiError)) return error;
  if (error.status === 404) return "One of the places no longer exists.";
  if (error.status === 409) return error.detail?.includes("merges deep") ? "Too many places are merged into one already." : "These are the same place already.";
  return error;
}

interface EditProps {
  /** The place that is shown: its id is the one that every write is to (a place that was merged is served as the one it was merged into). */
  place: PlaceResponse;
  /** The key of the place's query: the answer of a write is put in it, so that the name is the new one as the form closes and not a moment later. */
  placeKey: readonly unknown[];
}

/** The name of the place as a field, with Save and Cancel: an empty name goes back to the one OpenStreetMap has. */
function RenameForm({ place, placeKey, onClose }: EditProps & { onClose: () => void }) {
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
function MergeConfirm({ place, placeKey, other, onClose }: EditProps & { other: PlaceCandidate; onClose: () => void }) {
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
function MergedPlaces({ place, placeKey }: EditProps) {
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

/** What is on screen of a place that is there: its name and where it is, what can be done to it, its figures, and its latest visits. */
function Place({ place, id }: { place: PlaceResponse; id: number }) {
  const visitsHeading = useId();
  const [editing, setEditing] = useState<Editing>({ form: "none" });
  const close = () => setEditing({ form: "none" });
  // The answer of a write is the place as the address asks for it, so it goes in the query of the address (the panel's `id`), not of the place's own id.
  const edit: EditProps = { place, placeKey: placeQueryOptions(id).queryKey };
  const where = whereIs(place);
  // The response has no zone of the place, only of each visit. A place is where it is, so its visits are in one zone: the one the latest
  // began in. The first and the last visit are dates of that clock (the zone of the instant, and not of this device, which may be
  // anywhere); with no visit to take the zone from, UTC.
  const zone = place.recentVisits[0]?.timeZone ?? "UTC";
  return (
    <>
      <h1 className={styles.name}>{place.name ?? UNNAMED}</h1>
      {where !== null && <p className={styles.where}>{where}</p>}
      {editing.form === "none" && (
        <div className={styles.actions}>
          <button type="button" className={styles.secondary} onClick={() => setEditing({ form: "rename" })}>
            Rename
          </button>
          <button type="button" className={styles.secondary} onClick={() => setEditing({ form: "pick" })}>
            Merge with…
          </button>
        </div>
      )}
      {editing.form === "rename" && <RenameForm {...edit} onClose={close} />}
      {editing.form === "pick" && <PlacePicker placeId={place.id} onPick={(other) => setEditing({ form: "merge", other })} onCancel={close} />}
      {editing.form === "merge" && <MergeConfirm {...edit} other={editing.other} onClose={close} />}
      <dl className={styles.stats}>
        <Stat label="Total time" value={formatDuration(place.totalSeconds)} />
        <Stat label="Visits" value={formatInteger(place.visits)} />
        <Stat label="First visit" value={dateLabel(dateOf(place.firstVisit, zone))} />
        <Stat label="Last visit" value={dateLabel(dateOf(place.lastVisit, zone))} />
      </dl>
      {place.merged.length > 0 && <MergedPlaces {...edit} />}
      {place.recentVisits.length > 0 && (
        <div className={rows.section}>
          <h2 id={visitsHeading} className={rows.heading}>
            Recent visits
          </h2>
          <ul className={rows.list} aria-labelledby={visitsHeading}>
            {place.recentVisits.map((visit) => (
              <VisitRow key={visit.start} visit={visit} />
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

/**
 * The panel of a place: its name and address, how long the owner spent there in all, how many visits, the dates of the first and the
 * last, and the latest visits, each of which opens its day. Whatever it shows, it has the way back.
 *
 * A place that is no longer there (a 404) says so, with no Retry (asking again cannot help) and nothing of what it showed before: a
 * failure of another kind is an error with its Retry, and the place stays under it if it was on screen. Nothing of another place is
 * ever shown for this one (the query keeps none). The place is the one the map draws, from the same query.
 */
export function PlacePanel({ id }: PlacePanelProps) {
  const place = usePlace(id);
  const { gone, shown } = shownOf(place);
  return (
    <>
      <BackButton />
      {gone && <Empty message="This place no longer exists" />}
      {!gone && place.isError && <ErrorState error={place.error} onRetry={() => void place.refetch()} />}
      {shown !== undefined ? <Place place={shown} id={id} /> : !gone && !place.isError && <Loading />}
    </>
  );
}
