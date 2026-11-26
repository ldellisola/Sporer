import { useEffect, useRef, type KeyboardEvent, type Ref, type RefObject } from "react";
import type { Mode } from "../api/types";
import { MODE_WORDS, MODES, modeColor, type RouteMode } from "../map/layers";
import styles from "./ModeMenu.module.css";

// The menu that sets the mode of a move by hand: its button is the word of the mode in the row of the move, and the menu opens under the row, in the
// timeline, as the forms of the other edits open in their panels (a menu laid over the panel would be cut off by the bottom sheet, or left under it).

/** Where the focus goes as the menu opens: to the mode that is checked (the first mode when none is, for a mode the app does not know), or to the last choice (↑ on the button). */
export type MenuFocus = "checked" | "last";

export interface ModeButtonProps {
  ref?: Ref<HTMLButtonElement>;
  /** Its id, which names the menu. */
  id: string;
  /** What it says: the word of the move's mode ("Train", or "Move" for a mode that is not known). */
  word: string;
  /** Its accessible name, which holds `word` (P2-R46). */
  label: string;
  /** The id of the menu, which it controls while it is open. */
  menuId: string;
  open: boolean;
  /** While a mode is being saved: the button opens nothing, and says so. */
  busy: boolean;
  onOpen: (focus: MenuFocus) => void;
  onClose: () => void;
}

/**
 * The button of the menu: the word of the mode, with a chevron that turns as the menu opens. A press opens the menu (or closes it), and so do ↓ and ↑,
 * which put the focus on the checked mode or on the last choice. It is not disabled while a mode is being saved, which would take the focus off it: it
 * says it is (`aria-disabled`) and does nothing.
 */
export function ModeButton({ ref, id, word, label, menuId, open, busy, onOpen, onClose }: ModeButtonProps) {
  return (
    <button
      ref={ref}
      id={id}
      type="button"
      className={styles.modeButton}
      aria-label={label}
      aria-haspopup="menu"
      aria-expanded={open}
      aria-controls={open ? menuId : undefined}
      aria-disabled={busy || undefined}
      onClick={() => {
        if (busy) return;
        if (open) onClose();
        else onOpen("checked");
      }}
      onKeyDown={(event) => {
        if (busy || (event.key !== "ArrowDown" && event.key !== "ArrowUp")) return;
        event.preventDefault();
        onOpen(event.key === "ArrowUp" ? "last" : "checked");
      }}
    >
      {word}
    </button>
  );
}

export interface ModeMenuProps {
  id: string;
  /** The id of the button, which names the menu. */
  labelledBy: string;
  /** The button, which a press inside of does not count as a press elsewhere: the button closes the menu itself. */
  button: RefObject<HTMLButtonElement | null>;
  /** The mode of the move, which is checked; none is for a move whose mode is not known. */
  mode: RouteMode;
  /** Whether the owner set the mode: the menu then has "As detected", which takes it back. */
  edited: boolean;
  focus: MenuFocus;
  /** A mode was chosen, or "As detected" (null). The menu is to close. */
  onChoose: (mode: Mode | null) => void;
  /** The menu is to close: with the focus back on its button (`refocus`, for Escape), or left where it went (Tab, a press elsewhere). */
  onClose: (refocus: boolean) => void;
}

/**
 * The menu of the modes of a move (the six, in the order of `MODES`), with the mode of the move checked and, when the owner set it, "As detected". It is
 * a menu as WAI-ARIA has it: the focus goes into it as it opens, ↓ → and ↑ ← go from choice to choice (round from the last to the first), Home and End
 * to the first and the last, a letter to the next choice that begins with it, Enter and Space choose, and Escape closes it with the focus back on its
 * button. Tab, and a press anywhere but the menu and its button, close it and leave the focus where they put it. The arrow keys are the menu's while
 * the focus is in it: ← and → do not step the day.
 */
export function ModeMenu({ id, labelledBy, button, mode, edited, focus, onChoose, onClose }: ModeMenuProps) {
  const menu = useRef<HTMLDivElement>(null);
  const items = (): HTMLButtonElement[] => [...(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"], [role="menuitem"]') ?? [])];

  // Into the menu as it opens (and only then): on the mode that is checked, or the first, or on the last choice for ↑ on the button.
  useEffect(() => {
    const all = items();
    const checked = all.find((item) => item.getAttribute("aria-checked") === "true");
    (focus === "last" ? all.at(-1) : (checked ?? all[0]))?.focus();
  }, []);

  // A press elsewhere closes it: a tap does not move the focus in Safari, so a blur alone would not tell.
  useEffect(() => {
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target instanceof Node ? event.target : null;
      if (menu.current?.contains(target) || button.current?.contains(target)) return;
      onClose(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [button, onClose]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const all = items();
    const at = all.indexOf(document.activeElement as HTMLButtonElement);
    let next: HTMLButtonElement | undefined;
    if (event.key === "ArrowDown" || event.key === "ArrowRight") next = all[(at + 1) % all.length];
    else if (event.key === "ArrowUp" || event.key === "ArrowLeft") next = all[(at - 1 + all.length) % all.length];
    else if (event.key === "Home") next = all[0];
    else if (event.key === "End") next = all.at(-1);
    else if (event.key === "Escape") {
      event.preventDefault(); // the menu's, and not the card's of edit mode, which Escape closes too
      event.stopPropagation();
      onClose(true);
      return;
    } else if (event.key.length === 1 && /\p{L}/u.test(event.key)) {
      const letter = event.key.toLowerCase();
      const after = [...all.slice(at + 1), ...all.slice(0, at + 1)];
      next = after.find((item) => item.textContent?.trim().toLowerCase().startsWith(letter));
      if (next === undefined) return;
    } else {
      return;
    }
    event.preventDefault(); // no scroll of the panel
    event.stopPropagation(); // ← and → are the menu's here, and not the steps of the day (useArrowKeys)
    next?.focus();
  };

  return (
    <div
      ref={menu}
      id={id}
      role="menu"
      aria-labelledby={labelledBy}
      className={styles.modeMenu}
      onKeyDown={onKeyDown}
      onBlur={(event) => {
        // Tab, or a press on something that takes the focus, closes it; not a move within the menu, nor to its button (which toggles it), nor to no
        // element at all (another window), which a press elsewhere is told by (see above).
        const to = event.relatedTarget;
        if (to === null || menu.current?.contains(to) || to === button.current) return;
        onClose(false);
      }}
    >
      {MODES.map((choice) => (
        <button
          key={choice}
          type="button"
          role="menuitemradio"
          aria-checked={choice === mode}
          tabIndex={-1}
          className={styles.modeItem}
          onClick={() => onChoose(choice)}
        >
          <span className={styles.modeSwatch} style={{ backgroundColor: modeColor(choice) }} aria-hidden="true" />
          {MODE_WORDS[choice]}
          {choice === mode && (
            <svg className={styles.modeCheck} width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
              <path d="M2 6.5L5 9.5L10 3" />
            </svg>
          )}
        </button>
      ))}
      {edited && (
        <>
          <div role="separator" className={styles.modeSeparator} />
          <button type="button" role="menuitem" tabIndex={-1} className={styles.modeItem} onClick={() => onChoose(null)}>
            As detected
          </button>
        </>
      )}
    </div>
  );
}
