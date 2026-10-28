import { HOUSE_PATH } from "../map/house";

/**
 * The house that marks home in the list of a day, in place of the number: the one that is on the pin of the map (`map/house`), from the same
 * outline, in the colour of the text round it (the pin's, which is white). It is a picture and no text: the button of the row says "home", and
 * a reader that took the house for something to say would say it twice.
 */
export function HouseIcon() {
  return (
    <svg viewBox="0 0 32 32" width="16" height="16" aria-hidden="true" focusable="false">
      <path d={HOUSE_PATH} fill="currentColor" />
    </svg>
  );
}
