import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Toast, type ToastData } from "./Toast";

/** What a section says: `id` tells one note from the next (another `id` is another note, and the same `id` the same one), and `message` is what it says. */
export type NoteData = Pick<ToastData, "id" | "message">;

/** The note that is on show, and the section it is of (the one to tell when its time is up). */
interface Note {
  /** Whose it is: the id of the section's `useNote`. */
  owner: string;
  data: NoteData;
  onDismiss: () => void;
}

interface Notes {
  /** Shows the note as the owner's, in place of any other. */
  post: (owner: string, data: NoteData, onDismiss: () => void) => void;
  /** Takes the owner's note off, if it is the one on show. */
  retract: (owner: string) => void;
}

const NotesContext = createContext<Notes | null>(null);

/**
 * The one place that every section of the settings says what it has done in: a single status over the map (`Toast`), which is there whether anything
 * is said or not, so that the screen reader announces what is put into it. Each section has its own status and a screen reader has to follow
 * them all; with one it follows one, and two sections that say something at once do not talk over each other: the note that came last is the one
 * on show. A section gives its notes to `useNote`.
 */
export function SettingsNotes({ children }: { children: ReactNode }) {
  const [note, setNote] = useState<Note | null>(null);
  const post = useCallback((owner: string, data: NoteData, onDismiss: () => void) => setNote({ owner, data, onDismiss }), []);
  const retract = useCallback((owner: string) => setNote((current) => (current?.owner === owner ? null : current)), []);
  const notes = useMemo(() => ({ post, retract }), [post, retract]);
  // Another section's note is another toast, with the whole of its time, though its id is the same as the last one's: the id is made of the owner too.
  const toast = note === null ? null : { ...note.data, id: `${note.owner}:${note.data.id}` };
  return (
    <NotesContext value={notes}>
      {children}
      <Toast toast={toast} onDismiss={() => note?.onDismiss()} />
    </NotesContext>
  );
}

/**
 * Says `note` (null: nothing) in the status of the settings, for as long as the section keeps it, and calls `onDismiss` when its time is up, which is the
 * section's to stop keeping it (a write's `reset`). A note with another `id` is another note, and shows at once with its whole time. It goes when the
 * section stops giving it, and with the section. The latest `onDismiss` is the one that is called, whatever it was when the note was given.
 */
export function useNote(note: NoteData | null, onDismiss: () => void): void {
  const notes = useContext(NotesContext);
  if (notes === null) throw new Error("useNote is used inside SettingsNotes");
  const owner = useId();
  const latest = useRef(onDismiss);
  useEffect(() => {
    latest.current = onDismiss;
  });
  const id = note?.id;
  const message = note?.message;
  useEffect(() => {
    if (id === undefined || message === undefined) return;
    notes.post(owner, { id, message }, () => latest.current());
    return () => notes.retract(owner);
  }, [notes, owner, id, message]);
}
