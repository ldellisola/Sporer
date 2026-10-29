import type { KeyboardEvent } from "react";

// What the inline forms of the edits (a place's, a trip's) take from one another.

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
