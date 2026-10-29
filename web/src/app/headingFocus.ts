import { formatRoute, type Route } from "./router";

// Where the focus goes when an edit takes the owner to another view: the view that the page is replaced by is a new page, and the focus would
// be on the page itself. The edit says which view it is taking the owner to, and the panel of that view puts the focus on its heading once it
// is there (a trip's heading is there once the trip is, which may be after the request for it has been answered).

/** The path of the view whose heading is to take the focus, or null when none is asked for. */
let wanted: string | null = null;

/** Asks for the heading of the panel of `route` to take the focus when it is shown; call it before going there. A later request takes the place of this one. */
export function wantHeadingFocus(route: Route): void {
  wanted = formatRoute(route);
}

/**
 * Whether the panel that is shown now is the one that was asked for, which is to put the focus on its heading: it is told so once. A panel that is
 * shown and is not the one forgets the request, which was for a view that the owner has left since.
 */
export function takeHeadingFocus(): boolean {
  const mine = wanted !== null && wanted === window.location.pathname;
  wanted = null;
  return mine;
}
