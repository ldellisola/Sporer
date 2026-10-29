import { useEffect, useRef, type KeyboardEvent } from "react";
import forms from "./Forms.module.css";

// What the inline forms of the edits (a place's, a trip's) and the notes that follow them take from one another.

/**
 * The longest name the server takes. The field counts what a text field counts (WebKit counts what a reader sees as one character, an emoji,
 * as one; the server counts UTF-16 units, which make an emoji two), so a name can pass the field and be refused: that is a 400, which says so
 * in the server's words (`WriteError`).
 */
export const MAX_NAME_LENGTH = 100;

/** The key handler of a form: Escape is Cancel, which every form of the panel takes it as. */
export const onEscape = (action: () => void) => (event: KeyboardEvent) => {
  if (event.key === "Escape") action();
};

/**
 * Whether the focus has been lost: it is on the page itself, because what had it has gone (a form that was closed, a row that was taken off) or was
 * turned off (a button that is disabled while its write is on its way may take the focus with it, and a tap does not focus a button in Safari). Code
 * that puts the focus back moves it only then: where the owner has put it is theirs.
 */
export const focusLost = (): boolean => document.activeElement === null || document.activeElement === document.body;

/** A button that opens a form of an edit: what it says, what it does, and the `key` that `focus` names it by. */
export interface EditAction<Key extends string> {
  key: Key;
  label: string;
  onClick: () => void;
}

export interface EditActionsProps<Key extends string> {
  actions: readonly EditAction<Key>[];
  /** The button to put the focus on as the buttons come back, when a form that one of them opened was closed: the focus was in the form, which is gone. */
  focus?: Key;
}

/** The buttons that open the forms of the edits of what a panel shows, in the place where the forms will be. */
export function EditActions<Key extends string>({ actions, focus }: EditActionsProps<Key>) {
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  useEffect(() => {
    if (focus !== undefined) buttons.current.get(focus)?.focus();
  }, [focus]);
  return (
    <div className={forms.actions}>
      {actions.map(({ key, label, onClick }) => (
        <button
          key={key}
          ref={(button) => {
            if (button === null) buttons.current.delete(key);
            else buttons.current.set(key, button);
          }}
          type="button"
          className={forms.secondary}
          onClick={onClick}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
