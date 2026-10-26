import { useEffect, useRef } from "react";
import { today } from "../time/dates";
import { navigate, type Route } from "./router";

/**
 * Takes the day on show to the new today when the page is back after midnight. An app opened from the home screen is not reloaded: it is
 * put away, and brought back the next morning to the day it showed, which is yesterday, and the owner who opened it for today's
 * map would find yesterday's. So when the page comes back into view (or the window gets the focus) and the route is a day that was
 * today when it was shown, and the browser's today has moved on since, the route is replaced by today's day (replaced, so that Back does
 * not lead to a day that is gone). A day that was not today when it was shown (yesterday, a day of last week, tomorrow) was the owner's
 * own choice and stays, and so does every other kind of view.
 */
export function useDayRollover(route: Route): void {
  // Whether the day on show was today when it was shown: noted each time the route is another, and not read from the clock later, which
  // is what has changed.
  const wasToday = useRef(false);
  useEffect(() => {
    wasToday.current = route.view === "day" && route.date === today();
  }, [route]);

  useEffect(() => {
    const onReturn = (): void => {
      if (document.visibilityState === "hidden" || route.view !== "day" || !wasToday.current) return;
      const now = today();
      if (now !== route.date) navigate({ view: "day", date: now }, { replace: true });
    };
    document.addEventListener("visibilitychange", onReturn);
    window.addEventListener("focus", onReturn);
    return () => {
      document.removeEventListener("visibilitychange", onReturn);
      window.removeEventListener("focus", onReturn);
    };
  }, [route]);
}
