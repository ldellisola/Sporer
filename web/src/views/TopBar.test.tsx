import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import tripsFixture from "../../e2e/fixtures/trips.json";
import type { TripResponse, TripsResponse } from "../api/types";
import { parseRoute, useRoute } from "../app/router";
import { useLastDay } from "../app/useLastDay";
import { periodDays } from "../time/dates";
import { TopBar } from "./TopBar";

// The bar is told the route it shows and moves the address; the harness gives it the route the address shows and the last day
// that was shown, as the app does.
function Harness() {
  const route = useRoute();
  return <TopBar route={route} lastDay={useLastDay(route)} />;
}

function open(path: string) {
  window.history.replaceState(null, "", path);
  return render(<Harness />);
}

const pathname = () => window.location.pathname;
const press = (name: string) => fireEvent.click(screen.getByRole("button", { name }));
const label = () => screen.getByRole("heading").textContent;
const field = (name: "From" | "To") => screen.getByLabelText(name) as HTMLInputElement;
/** Presses a key: false when something called `preventDefault` on it (the bar took the key), true when the page keeps it. */
const key = (name: string, init: KeyboardEventInit = {}, target: Element | Window = document.body) =>
  fireEvent.keyDown(target, { key: name, ...init });

beforeEach(() => {
  window.history.replaceState(null, "", "/");
});

afterEach(() => {
  vi.useRealTimers();
});

describe("TopBar", () => {
  test("TopBar_switching_views_keeps_anchor_date", () => {
    open("/day/2026-10-22");
    expect(screen.getByRole("button", { name: "Day", pressed: true })).toBeInTheDocument();

    press("Week"); // the week of the day
    expect(pathname()).toBe("/week/2026-10-19");
    expect(screen.getByRole("button", { name: "Week", pressed: true })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Day", pressed: false })).toBeInTheDocument();

    press("Month"); // the month of the week
    expect(pathname()).toBe("/month/2026-10");

    press("Year");
    expect(pathname()).toBe("/year/2026");

    press("Day"); // and back in: the day that was shown, which lies in the year
    expect(pathname()).toBe("/day/2026-10-22");
  });

  test("TopBar_switching_to_a_finer_view_lands_on_the_day_that_was_shown", () => {
    open("/day/2026-08-14");

    press("Month");
    expect(pathname()).toBe("/month/2026-08");
    press("Day");
    expect(pathname()).toBe("/day/2026-08-14");

    press("Year");
    press("Month"); // a year to a month: the month of that day, not January
    expect(pathname()).toBe("/month/2026-08");
    press("Week");
    expect(pathname()).toBe("/week/2026-08-10");
    press("Day");
    expect(pathname()).toBe("/day/2026-08-14");

    press("Range"); // a range holds the period, and the day is still the one to go back to
    expect(pathname()).toBe("/range/2026-08-14..2026-08-14");
    press("Year");
    press("Range");
    press("Day");
    expect(pathname()).toBe("/day/2026-08-14");
  });

  test("TopBar_the_day_that_was_shown_is_not_used_outside_the_period_that_is", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-24T12:00:00"));
    open("/day/2026-08-14");

    press("Next day"); // the last day shown is the 15th
    press("Week");
    expect(pathname()).toBe("/week/2026-08-10");
    press("Next week"); // a week that does not hold the 15th, nor today (the 24th of October)
    expect(pathname()).toBe("/week/2026-08-17");
    press("Day");
    expect(pathname()).toBe("/day/2026-08-17"); // so its first day

    press("Year");
    press("Next year");
    expect(pathname()).toBe("/year/2027");
    press("Day");
    expect(pathname()).toBe("/day/2027-01-01"); // a year that holds neither the 17th of August nor today
  });

  test("TopBar_a_finer_view_of_a_period_that_holds_today_lands_on_today_when_no_day_was_shown", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-24T12:00:00"));
    open("/week/2026-10-19"); // opened straight on a week: no day has been shown

    press("Day");

    expect(pathname()).toBe("/day/2026-10-24");
  });

  test("TopBar_a_finer_view_of_another_period_than_today_lands_on_its_first_day_when_no_day_was_shown", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-24T12:00:00"));
    open("/month/2026-03");

    press("Week");

    expect(pathname()).toBe("/week/2026-02-23"); // the week of March 1st
    press("Day");
    expect(pathname()).toBe("/day/2026-02-23"); // and now the week is the period, with its first day
  });

  test("TopBar_switching_to_the_view_that_is_shown_goes_nowhere", () => {
    open("/week/2026-10-19");
    const entries = window.history.length;

    press("Week");

    expect(pathname()).toBe("/week/2026-10-19");
    expect(window.history.length).toBe(entries);
  });

  test.each([
    ["/day/2026-10-22", "2026-10-22", "2026-10-22"],
    ["/week/2026-10-19", "2026-10-19", "2026-10-25"],
    ["/month/2026-02", "2026-02-01", "2026-02-28"],
    ["/year/2026", "2026-01-01", "2026-12-31"],
  ])("TopBar_range_opens_two_date_fields_prefilled_with_the_period_of_%s", (path, from, to) => {
    open(path);
    expect(screen.queryByLabelText("From")).not.toBeInTheDocument();

    press("Range");

    expect(pathname()).toBe(`/range/${from}..${to}`);
    expect(screen.getByRole("button", { name: "Range", pressed: true })).toBeInTheDocument();
    expect(field("From")).toHaveAttribute("type", "date");
    expect(field("To")).toHaveAttribute("type", "date");
    expect(field("From")).toHaveValue(from);
    expect(field("To")).toHaveValue(to);
  });

  // A date field is committed when it is left, when Enter is pressed, or (a date that is fine) after a pause: not for each part of it
  // that is typed (see DateField).
  const commit = (name: "From" | "To", value: string) => {
    fireEvent.change(field(name), { target: { value } });
    fireEvent.blur(field(name));
  };

  test("TopBar_range_fields_set_the_range_and_keep_it_valid", () => {
    open("/range/2026-10-19..2026-10-25");

    commit("From", "2026-10-20");
    expect(pathname()).toBe("/range/2026-10-20..2026-10-25");
    commit("To", "2026-11-02");
    expect(pathname()).toBe("/range/2026-10-20..2026-11-02");
    expect(label()).toBe("20 Oct – 2 Nov 2026");

    // A start after the end takes the end along, and an end before the start the start: one day, not a range that runs backwards.
    commit("From", "2026-11-10");
    expect(pathname()).toBe("/range/2026-11-10..2026-11-10");
    expect(field("To")).toHaveValue("2026-11-10");
    commit("To", "2026-11-01");
    expect(pathname()).toBe("/range/2026-11-01..2026-11-01");
    expect(field("From")).toHaveValue("2026-11-01");

    // The API answers 400 for more than 400 days; the other end gives way instead of the owner being sent to an error.
    commit("To", "2028-01-01");
    const route = parseRoute(pathname(), "2026-10-24");
    expect(route).toMatchObject({ view: "range", to: "2028-01-01" });
    expect(periodDays(route as Extract<typeof route, { view: "range" }>)).toBe(400);
    expect(field("From")).toHaveValue((route as { from: string }).from);
  });

  test("TopBar_range_fields_commit_on_Enter_too", () => {
    open("/range/2026-10-19..2026-10-25");

    fireEvent.change(field("To"), { target: { value: "2026-10-28" } });
    expect(pathname()).toBe("/range/2026-10-19..2026-10-25");
    fireEvent.keyDown(field("To"), { key: "Enter" });

    expect(pathname()).toBe("/range/2026-10-19..2026-10-28");
  });

  test("TopBar_range_fields_take_a_date_typed_one_part_at_a_time_as_one_change", () => {
    open("/range/2026-10-19..2026-10-25");
    const entries = window.history.length;

    // Typing 28 into the day of 2026-10-25: the browser reports 2026-10-02 after the 2, and 2026-10-28 after the 8.
    fireEvent.change(field("To"), { target: { value: "2026-10-02" } });
    fireEvent.change(field("To"), { target: { value: "2026-10-28" } });
    expect(pathname()).toBe("/range/2026-10-19..2026-10-25"); // nothing yet: no request, no history entry, and From is where it was
    expect(window.history.length).toBe(entries);
    expect(field("From")).toHaveValue("2026-10-19");

    fireEvent.blur(field("To"));

    expect(pathname()).toBe("/range/2026-10-19..2026-10-28"); // and From is still the 19th
    expect(window.history.length).toBe(entries + 1);
    expect(field("From")).toHaveValue("2026-10-19");
    expect(field("To")).toHaveValue("2026-10-28");

    fireEvent.blur(field("To")); // a field that is left again with the same date is no change
    expect(window.history.length).toBe(entries + 1);
  });

  describe("a date that is left in the field", () => {
    // A date picked from the calendar of a desktop browser leaves the focus in the field: no blur, no Enter. A date that is fine
    // is taken after a pause of 600 ms without another edit; one that is not waits to be left.
    const draft = (name: "From" | "To", value: string) => fireEvent.change(field(name), { target: { value } });
    const wait = (ms: number) => act(() => void vi.advanceTimersByTime(ms));

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    });

    test("TopBar_range_field_takes_a_valid_date_after_600ms_and_not_before", () => {
      open("/range/2026-10-19..2026-10-25");
      const entries = window.history.length;

      draft("To", "2026-10-28");
      wait(599);
      expect(pathname()).toBe("/range/2026-10-19..2026-10-25");

      wait(1);
      expect(pathname()).toBe("/range/2026-10-19..2026-10-28");
      expect(window.history.length).toBe(entries + 1);
      wait(5000); // once, and the field keeps what it was given
      expect(window.history.length).toBe(entries + 1);
      expect(field("To")).toHaveValue("2026-10-28");
    });

    test("TopBar_range_field_waits_the_pause_out_again_for_each_edit", () => {
      open("/range/2026-10-19..2026-10-25");

      draft("To", "2026-10-26");
      wait(400);
      draft("To", "2026-10-27");
      wait(400); // 800 ms since the first edit, 400 since the last
      expect(pathname()).toBe("/range/2026-10-19..2026-10-25");

      wait(200);
      expect(pathname()).toBe("/range/2026-10-19..2026-10-27");
    });

    test("TopBar_range_field_holds_a_date_that_crosses_the_other_end_until_it_is_left", () => {
      open("/range/2026-10-19..2026-10-25");

      draft("To", "2026-10-02"); // the 2 of 28 typed into the day: before From
      wait(5000);
      expect(pathname()).toBe("/range/2026-10-19..2026-10-25"); // never on the timer
      expect(field("From")).toHaveValue("2026-10-19");

      fireEvent.blur(field("To")); // left like that: From is dragged along
      expect(pathname()).toBe("/range/2026-10-02..2026-10-02");
    });

    test("TopBar_range_field_holds_a_date_that_makes_the_range_too_long_until_it_is_left", () => {
      open("/range/2026-10-19..2026-10-25");

      draft("To", "2028-01-01"); // more than 400 days
      wait(5000);
      expect(pathname()).toBe("/range/2026-10-19..2026-10-25");
      draft("From", "2020-01-01");
      wait(5000);
      expect(pathname()).toBe("/range/2026-10-19..2026-10-25");

      fireEvent.blur(field("From"));
      const route = parseRoute(pathname(), "2026-10-24") as Extract<ReturnType<typeof parseRoute>, { view: "range" }>;
      expect(route.from).toBe("2020-01-01");
      expect(periodDays(route)).toBe(400); // the other end gave way
    });

    test("TopBar_range_field_typed_one_part_at_a_time_is_held_then_taken_after_the_pause", () => {
      open("/range/2026-10-19..2026-10-25");
      const entries = window.history.length;

      draft("To", "2026-10-02"); // the 2 of 28: invalid, held
      draft("To", "2026-10-28"); // the 8: valid
      wait(599);
      expect(pathname()).toBe("/range/2026-10-19..2026-10-25");
      expect(field("From")).toHaveValue("2026-10-19");
      wait(1);

      expect(pathname()).toBe("/range/2026-10-19..2026-10-28"); // From was not dragged along by the 2nd
      expect(window.history.length).toBe(entries + 1);
    });

    test("TopBar_range_field_blur_and_Enter_take_a_valid_date_at_once_and_only_once", () => {
      open("/range/2026-10-19..2026-10-25");
      const entries = window.history.length;

      draft("To", "2026-10-28");
      fireEvent.blur(field("To"));
      expect(pathname()).toBe("/range/2026-10-19..2026-10-28");
      wait(5000); // the pause that was running is over with the blur
      expect(window.history.length).toBe(entries + 1);

      draft("From", "2026-10-20");
      fireEvent.keyDown(field("From"), { key: "Enter" });
      expect(pathname()).toBe("/range/2026-10-20..2026-10-28");
      wait(5000);
      expect(window.history.length).toBe(entries + 2);
    });

    test("TopBar_range_field_forgets_the_pause_when_the_range_is_moved_from_elsewhere", () => {
      open("/range/2026-10-19..2026-10-25");

      draft("To", "2026-10-28");
      press("Next range"); // an arrow: the range is another one, and the draft belongs to the old
      expect(pathname()).toBe("/range/2026-10-26..2026-11-01");
      wait(5000);

      expect(pathname()).toBe("/range/2026-10-26..2026-11-01");
      expect(field("To")).toHaveValue("2026-11-01");
    });

    test("TopBar_range_field_forgets_the_pause_when_the_other_end_moves_from_elsewhere", () => {
      open("/range/2026-10-19..2026-10-25");
      commit("To", "2026-10-31");
      expect(pathname()).toBe("/range/2026-10-19..2026-10-31");
      const entries = window.history.length;

      draft("From", "2026-10-28"); // fine against the 31st
      // Back to 19..25 inside the pause: this field's own date (the 19th) is the same, only the other end moved, and 28 is
      // after the new end, so taking it would push 28..28 over a range the owner went back to.
      act(() => {
        window.history.replaceState(null, "", "/range/2026-10-19..2026-10-25");
        window.dispatchEvent(new PopStateEvent("popstate"));
      });
      wait(5000);

      expect(pathname()).toBe("/range/2026-10-19..2026-10-25");
      expect(window.history.length).toBe(entries);
      expect(field("From")).toHaveValue("2026-10-19");
      expect(field("To")).toHaveValue("2026-10-25");
    });

    test("TopBar_range_field_forgets_the_pause_when_the_bar_goes", () => {
      const { unmount } = open("/range/2026-10-19..2026-10-25");
      draft("To", "2026-10-28");

      unmount();
      wait(5000);

      expect(pathname()).toBe("/range/2026-10-19..2026-10-25");
    });

    test("TopBar_range_field_forgets_the_pause_when_the_view_changes", () => {
      open("/range/2026-10-19..2026-10-25");
      draft("To", "2026-10-28");

      press("Week"); // no fields any more
      wait(5000);

      expect(pathname()).toBe("/week/2026-10-19");
    });
  });

  test("TopBar_range_fields_ignore_what_is_not_a_date_and_show_the_range_again", () => {
    open("/range/2026-10-19..2026-10-25");
    const before = pathname();

    commit("From", ""); // a part of the field cleared, on the way to another date
    expect(field("From")).toHaveValue("2026-10-19"); // left like that, the field shows the range it is part of
    commit("To", "0002-10-25"); // the year typed so far, on the way to 2026
    expect(field("To")).toHaveValue("2026-10-25");

    expect(pathname()).toBe(before);
  });

  test("TopBar_range_fields_follow_the_range_when_an_arrow_moves_it_over_a_typed_date", () => {
    open("/range/2026-10-19..2026-10-25");

    fireEvent.change(field("To"), { target: { value: "2026-10-28" } });
    press("Next range"); // the draft is not the range: the arrow steps the range that is

    expect(pathname()).toBe("/range/2026-10-26..2026-11-01");
    expect(field("From")).toHaveValue("2026-10-26");
    expect(field("To")).toHaveValue("2026-11-01");
  });

  test("TopBar_arrows_and_keys_step_period", () => {
    open("/day/2026-10-22");

    press("Next day");
    expect(pathname()).toBe("/day/2026-10-23");
    expect(label()).toBe("Friday 23 October");
    press("Previous day");
    press("Previous day");
    expect(pathname()).toBe("/day/2026-10-21");

    key("ArrowRight");
    expect(pathname()).toBe("/day/2026-10-22");
    key("ArrowLeft");
    key("ArrowLeft");
    expect(pathname()).toBe("/day/2026-10-20");

    // The same arrows step a week, a month, a year and a range by their own measure.
    press("Week");
    expect(pathname()).toBe("/week/2026-10-19");
    press("Next week");
    expect(pathname()).toBe("/week/2026-10-26");
    press("Month");
    press("Previous month");
    expect(pathname()).toBe("/month/2026-09");
    press("Year");
    key("ArrowRight");
    expect(pathname()).toBe("/year/2027");
    press("Range");
    expect(pathname()).toBe("/range/2027-01-01..2027-12-31");
    press("Next range");
    expect(pathname()).toBe("/range/2028-01-01..2028-12-30"); // 365 days further: as long as it is
  });

  test.each([
    ["an input", "<input />"],
    ["a textarea", "<textarea></textarea>"],
    ["a select", "<select></select>"],
    ["a contenteditable element", '<div contenteditable="true"></div>'],
    ["something inside a contenteditable element", '<div contenteditable="plaintext-only"><b>text</b></div>'],
  ])("TopBar_keys_leave_%s_alone", (_name, html) => {
    open("/day/2026-10-22");
    const host = document.createElement("div");
    host.innerHTML = html;
    document.body.append(host);
    const target = host.querySelector("b") ?? host.firstElementChild!;

    key("ArrowRight", {}, target);
    key("ArrowRight", {}, target);
    expect(pathname()).toBe("/day/2026-10-22");

    host.remove();
    key("ArrowRight"); // and with the focus elsewhere the page answers
    expect(pathname()).toBe("/day/2026-10-23");
  });

  test("TopBar_keys_leave_the_map_to_the_map", () => {
    open("/day/2026-10-22");
    const host = document.createElement("div");
    host.innerHTML = '<div role="region" aria-label="Map view"><div tabindex="0" class="canvas-container"><canvas></canvas></div></div>';
    document.body.append(host);

    key("ArrowRight", {}, host.querySelector("canvas")!); // the map pans with the arrows when it has the focus
    key("ArrowRight", {}, host.querySelector(".canvas-container")!);
    expect(pathname()).toBe("/day/2026-10-22");

    host.remove();
    key("ArrowRight"); // and with the focus elsewhere the page answers
    expect(pathname()).toBe("/day/2026-10-23");
  });

  test("TopBar_keys_leave_the_date_fields_to_the_field", () => {
    open("/range/2026-10-19..2026-10-25");

    key("ArrowRight", {}, field("From")); // moves between the day, month and year of the field

    expect(pathname()).toBe("/range/2026-10-19..2026-10-25");
  });

  test("TopBar_keys_leave_shortcuts_of_the_browser_and_held_keys_alone", () => {
    open("/day/2026-10-22");

    key("ArrowLeft", { altKey: true }); // back
    key("ArrowRight", { altKey: true });
    key("ArrowLeft", { metaKey: true });
    key("ArrowRight", { ctrlKey: true });
    key("ArrowRight", { shiftKey: true });
    key("ArrowRight", { repeat: true }); // a key held down would ask for a day every few milliseconds
    key("ArrowUp");
    key("a");

    expect(pathname()).toBe("/day/2026-10-22");
  });

  test("TopBar_stops_listening_for_keys_when_it_goes", () => {
    const { unmount } = open("/day/2026-10-22");
    unmount();

    key("ArrowRight");

    expect(pathname()).toBe("/day/2026-10-22");
  });

  describe("swipe", () => {
    const row = () => screen.getByRole("heading").parentElement!;
    function swipe(from: [number, number], to: [number, number]) {
      fireEvent.pointerDown(row(), { pointerId: 1, isPrimary: true, pointerType: "touch", clientX: from[0], clientY: from[1] });
      fireEvent.pointerUp(row(), { pointerId: 1, isPrimary: true, pointerType: "touch", clientX: to[0], clientY: to[1] });
    }

    test("TopBar_swipe_steps_period", () => {
      open("/day/2026-10-22");

      swipe([200, 40], [120, 44]); // 80 px to the left: on to the next
      expect(pathname()).toBe("/day/2026-10-23");

      swipe([100, 40], [190, 38]); // to the right: back
      swipe([100, 40], [190, 38]);
      expect(pathname()).toBe("/day/2026-10-21");

      swipe([200, 40], [150, 40]); // exactly 50 px counts
      expect(pathname()).toBe("/day/2026-10-22");
    });

    test("TopBar_swipe_needs_50px_and_a_mostly_horizontal_move", () => {
      open("/day/2026-10-22");

      swipe([200, 40], [160, 40]); // 40 px: a twitch
      swipe([200, 40], [140, 150]); // 60 px across but 110 down: someone scrolling
      swipe([200, 40], [200, 40]); // a tap
      expect(pathname()).toBe("/day/2026-10-22");

      fireEvent.pointerDown(row(), { pointerId: 1, isPrimary: true, clientX: 200, clientY: 40 });
      fireEvent.pointerCancel(row(), { pointerId: 1, isPrimary: true }); // the browser took the gesture over
      fireEvent.pointerUp(row(), { pointerId: 1, isPrimary: true, clientX: 100, clientY: 40 });
      expect(pathname()).toBe("/day/2026-10-22");
    });

    test("TopBar_swipe_ignores_a_release_that_never_started_here", () => {
      open("/day/2026-10-22");

      fireEvent.pointerUp(row(), { pointerId: 1, isPrimary: true, clientX: 100, clientY: 40 });

      expect(pathname()).toBe("/day/2026-10-22");
    });

    test("TopBar_a_tap_on_an_arrow_steps_once", () => {
      open("/day/2026-10-22");
      const next = screen.getByRole("button", { name: "Next day" });

      fireEvent.pointerDown(next, { pointerId: 1, isPrimary: true, clientX: 300, clientY: 40 });
      fireEvent.pointerUp(next, { pointerId: 1, isPrimary: true, clientX: 300, clientY: 40 });
      fireEvent.click(next);

      expect(pathname()).toBe("/day/2026-10-23");
    });
  });

  describe("on a place", () => {
    test("TopBar_on_a_place_shows_no_period_and_a_view_starts_from_today", () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-10-24T12:00:00"));
      open("/place/5");

      expect(screen.queryByRole("heading")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /^(Previous|Next)/ })).not.toBeInTheDocument();
      for (const name of ["Day", "Week", "Month", "Year", "Range"]) {
        expect(screen.getByRole("button", { name, pressed: false })).toBeInTheDocument();
      }
      key("ArrowRight"); // nothing to step
      expect(pathname()).toBe("/place/5");

      press("Week");

      expect(pathname()).toBe("/week/2026-10-19");
    });

    test("TopBar_range_from_a_place_is_today", () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-10-24T12:00:00"));
      open("/place/5");

      press("Range");

      expect(pathname()).toBe("/range/2026-10-24..2026-10-24");
    });
  });

  test("TopBar_follows_the_route_it_is_given", () => {
    const { rerender } = render(<TopBar route={{ view: "month", month: "2026-10" }} />);
    expect(label()).toBe("October 2026");

    rerender(<TopBar route={{ view: "week", start: "2026-10-19" }} />);
    expect(label()).toBe("19 – 25 Oct 2026");
    expect(screen.getByRole("button", { name: "Week", pressed: true })).toBeInTheDocument();
  });

  describe("the Trips button", () => {
    test("TopBar_trips_button_opens_the_trips_list_and_is_pressed_there", () => {
      open("/day/2026-10-22");
      expect(screen.getByRole("button", { name: "Trips", pressed: false })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Trips" }).querySelector("svg")).not.toBeNull(); // the suitcase, drawn in place

      press("Trips");

      expect(pathname()).toBe("/trips");
      expect(screen.getByRole("button", { name: "Trips", pressed: true })).toBeInTheDocument();
      // The date row gives way to a title row, and no view is the current one.
      expect(label()).toBe("Trips");
      expect(screen.queryByRole("button", { name: /^(Previous|Next|Older|Newer)/ })).not.toBeInTheDocument();
      for (const name of ["Day", "Week", "Month", "Year", "Range"]) {
        expect(screen.getByRole("button", { name, pressed: false })).toBeInTheDocument();
      }
      expect(screen.queryByLabelText("From")).not.toBeInTheDocument();
    });

    test("TopBar_trips_button_is_not_pressed_on_the_views_of_time_and_places", () => {
      for (const path of ["/day/2026-10-22", "/week/2026-10-19", "/month/2026-10", "/year/2026", "/range/2026-10-19..2026-10-25", "/place/5"]) {
        const { unmount } = open(path);
        expect(screen.getByRole("button", { name: "Trips", pressed: false }), path).toBeInTheDocument();
        unmount();
      }
    });

    test("TopBar_trips_button_on_the_list_goes_nowhere", () => {
      open("/trips");
      const entries = window.history.length;

      press("Trips");

      expect(pathname()).toBe("/trips");
      expect(window.history.length).toBe(entries);
    });

    test("TopBar_a_view_chosen_on_the_trips_list_is_at_the_day_that_was_shown_last", () => {
      open("/day/2026-08-14");
      press("Next day"); // the 15th is the last day shown

      press("Trips");
      press("Month");
      expect(pathname()).toBe("/month/2026-08");

      press("Trips");
      press("Day");
      expect(pathname()).toBe("/day/2026-08-15");

      press("Trips");
      press("Range");
      expect(pathname()).toBe("/range/2026-08-15..2026-08-15");
    });

    test("TopBar_a_view_chosen_on_a_trips_list_that_was_opened_as_a_page_starts_from_today", () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-10-24T12:00:00"));
      open("/trips"); // no day has been shown

      press("Week");

      expect(pathname()).toBe("/week/2026-10-19");
    });

    test("TopBar_leaves_the_arrow_keys_alone_on_the_trips_list", () => {
      open("/trips");

      key("ArrowRight");
      key("ArrowLeft");

      expect(pathname()).toBe("/trips");
    });
  });

  describe("the Settings button", () => {
    test("TopBar_settings_button_is_a_gear_next_to_Trips_that_opens_the_settings_and_is_pressed_there", () => {
      open("/day/2026-10-22");
      const gear = screen.getByRole("button", { name: "Settings", pressed: false });
      expect(gear.querySelector("svg")).not.toBeNull(); // drawn in place, and hidden from the reader (the button has its name)
      expect(gear.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
      expect(screen.getByRole("button", { name: "Trips" }).nextElementSibling).toBe(gear); // right after Trips

      press("Settings");

      expect(pathname()).toBe("/settings");
      expect(screen.getByRole("button", { name: "Settings", pressed: true })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Trips", pressed: false })).toBeInTheDocument(); // the list of trips is not what is shown
      // The date row gives way to a title row, and no view is the current one, as on the trips.
      expect(label()).toBe("Settings");
      expect(screen.queryByRole("button", { name: /^(Previous|Next|Older|Newer)/ })).not.toBeInTheDocument();
      for (const name of ["Day", "Week", "Month", "Year", "Range"]) {
        expect(screen.getByRole("button", { name, pressed: false })).toBeInTheDocument();
      }
      expect(screen.queryByLabelText("From")).not.toBeInTheDocument();
    });

    test("TopBar_settings_button_is_not_pressed_on_any_other_view", () => {
      for (const path of ["/day/2026-10-22", "/week/2026-10-19", "/month/2026-10", "/year/2026", "/range/2026-10-19..2026-10-25", "/place/5", "/trips"]) {
        const { unmount } = open(path);
        expect(screen.getByRole("button", { name: "Settings", pressed: false }), path).toBeInTheDocument();
        unmount();
      }
    });

    test("TopBar_settings_button_on_the_settings_goes_nowhere", () => {
      open("/settings");
      const entries = window.history.length;

      press("Settings");

      expect(pathname()).toBe("/settings");
      expect(window.history.length).toBe(entries);
    });

    test("TopBar_a_view_chosen_on_the_settings_is_at_the_day_that_was_shown_last", () => {
      open("/day/2026-08-14");
      press("Next day"); // the 15th is the last day shown

      press("Settings");
      press("Month");
      expect(pathname()).toBe("/month/2026-08");

      press("Settings");
      press("Day");
      expect(pathname()).toBe("/day/2026-08-15");
    });

    test("TopBar_a_view_chosen_on_settings_that_were_opened_as_a_page_starts_from_today", () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-10-24T12:00:00"));
      open("/settings"); // no day has been shown

      press("Week");

      expect(pathname()).toBe("/week/2026-10-19");
    });

    test("TopBar_leaves_the_arrow_keys_alone_on_the_settings", () => {
      open("/settings");

      key("ArrowRight");
      key("ArrowLeft");

      expect(pathname()).toBe("/settings");
    });
  });

  // The trips are the API's: the bar asks for the list (the order of it is what ‹ and › step by) and for the trip it shows.
  describe("on a trip", () => {
    const TRIPS = tripsFixture as TripsResponse; // newest first: 2026-10-22 (New York, ongoing), 2026-09-12 (Lisbon & Sintra), 2026-08-01 (Copenhagen)

    function detail(id: string): TripResponse | undefined {
      const listed = TRIPS.trips.find((t) => t.id === id);
      if (listed === undefined) return undefined;
      const { thumbnail: _thumbnail, ...summary } = listed;
      return { ...summary, stats: { flights: 0, cities: 0, places: 0, groundDistanceMeters: 0 }, moves: [], days: [] };
    }

    /** Answers the list and each trip of it; a trip that is not in it is a 404. `list` and `trip` stand in for either answer. */
    function stubTrips(over: { list?: () => Promise<Response>; trip?: (id: string) => Promise<Response> } = {}): string[] {
      const paths: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (path: string) => {
          paths.push(path);
          if (path === "/api/trips") return over.list ? over.list() : Response.json(TRIPS);
          const id = path.split("/").pop()!;
          if (over.trip) return over.trip(id);
          const found = detail(id);
          return found === undefined ? new Response("{}", { status: 404 }) : Response.json(found);
        }),
      );
      return paths;
    }

    function openTrip(path: string) {
      window.history.replaceState(null, "", path);
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      return {
        client,
        ...render(
          <QueryClientProvider client={client}>
            <Harness />
          </QueryClientProvider>,
        ),
      };
    }

    const older = () => screen.getByRole<HTMLButtonElement>("button", { name: "Older trip" });
    const newer = () => screen.getByRole<HTMLButtonElement>("button", { name: "Newer trip" });
    /** Waits for the bar to have the list, which is when the arrows have something to step to. */
    const listLoaded = () => waitFor(() => expect(older().disabled && newer().disabled).toBe(false)); // a trip of the middle of the list has both

    test("TopBar_on_a_trip_shows_its_name_and_dates_and_no_period", async () => {
      stubTrips();
      openTrip("/trip/2026-09-12");

      expect(await screen.findByRole("heading", { name: "Lisbon & Sintra" })).toBeInTheDocument();
      expect(screen.getByText("12 – 16 Sep 2026")).toBeInTheDocument(); // the month said once, as the week view says its dates, and as the cards do
      expect(screen.getByRole("button", { name: "Trips", pressed: true })).toBeInTheDocument();
      for (const name of ["Day", "Week", "Month", "Year", "Range"]) {
        expect(screen.getByRole("button", { name, pressed: false })).toBeInTheDocument();
      }
      expect(screen.queryByRole("button", { name: /^(Previous|Next)/ })).not.toBeInTheDocument();
      await listLoaded();
    });

    test("TopBar_on_a_trip_says_what_it_is_waiting_for_and_not_a_name_that_is_not_known", async () => {
      let release: (response: Response) => void = () => undefined;
      stubTrips({ trip: () => new Promise<Response>((resolve) => (release = resolve)) });
      openTrip("/trip/2026-09-12");

      expect(label()).toBe("Loading trip…"); // neutral: not the "Trip" of a trip that is not there
      expect(screen.queryByText(/Sep/)).not.toBeInTheDocument();

      release(Response.json(detail("2026-09-12")));
      expect(await screen.findByRole("heading", { name: "Lisbon & Sintra" })).toBeInTheDocument();
      await listLoaded();
    });

    test("TopBar_on_a_trip_that_does_not_exist_is_called_Trip_and_has_nowhere_to_step", async () => {
      const paths = stubTrips();
      const { client } = openTrip("/trip/2026-01-01");

      expect(await screen.findByRole("heading", { name: "Trip" })).toBeInTheDocument(); // not the placeholder, which is another name
      expect(screen.queryByText(/2026/)).not.toBeInTheDocument();
      await waitFor(() => expect(client.getQueryState(["trips"])?.status).toBe("success")); // the list is there...
      await act(async () => await new Promise((resolve) => setTimeout(resolve, 0))); // ...and the bar has been told so
      expect(paths).toContain("/api/trips");
      expect(older()).toBeDisabled(); // ...and the trip is not in it: no trip is older or newer than it
      expect(newer()).toBeDisabled();
    });

    test("TopBar_on_a_trip_whose_page_fails_is_called_Trip_too", async () => {
      stubTrips({ trip: async () => new Response("{}", { status: 500 }) });
      openTrip("/trip/2026-09-12");

      expect(await screen.findByRole("heading", { name: "Trip" })).toBeInTheDocument();
      await listLoaded(); // the list is another request: its arrows still work, and a trip that does load is a step away
    });

    test("TopBar_on_a_trip_steps_to_the_older_and_newer_trip", async () => {
      stubTrips();
      openTrip("/trip/2026-09-12");
      await listLoaded();

      press("Older trip"); // ‹: the next trip in a list that is newest first
      expect(pathname()).toBe("/trip/2026-08-01");
      expect(await screen.findByRole("heading", { name: "Copenhagen" })).toBeInTheDocument();
      expect(older()).toBeDisabled(); // the oldest there is
      expect(newer()).toBeEnabled();

      press("Newer trip"); // ›
      press("Newer trip");
      expect(pathname()).toBe("/trip/2026-10-22");
      expect(await screen.findByRole("heading", { name: "New York" })).toBeInTheDocument();
      expect(newer()).toBeDisabled(); // the newest
      expect(older()).toBeEnabled();

      press("Newer trip"); // a disabled arrow goes nowhere
      expect(pathname()).toBe("/trip/2026-10-22");
    });

    test("TopBar_on_a_trip_steps_with_the_arrow_keys_and_stops_at_the_ends", async () => {
      stubTrips();
      openTrip("/trip/2026-09-12");
      await listLoaded();

      key("ArrowLeft"); // ‹
      expect(pathname()).toBe("/trip/2026-08-01");
      await screen.findByRole("heading", { name: "Copenhagen" });
      key("ArrowLeft"); // already the oldest
      expect(pathname()).toBe("/trip/2026-08-01");

      key("ArrowRight");
      key("ArrowRight");
      expect(pathname()).toBe("/trip/2026-10-22");
      await screen.findByRole("heading", { name: "New York" });
      key("ArrowRight"); // already the newest
      expect(pathname()).toBe("/trip/2026-10-22");
    });

    test("TopBar_on_a_trip_with_nothing_to_step_to_does_not_take_the_arrow_keys_from_the_page", async () => {
      let release: (response: Response) => void = () => undefined;
      stubTrips({ list: () => new Promise<Response>((resolve) => (release = resolve)) });
      openTrip("/trip/2026-09-12");
      await screen.findByRole("heading", { name: "Lisbon & Sintra" }); // the list is not there: no trip is known to be older or newer

      expect(key("ArrowLeft")).toBe(true); // not prevented: the page keeps its own use of the key
      expect(key("ArrowRight")).toBe(true);

      release(Response.json(TRIPS));
      await listLoaded();
      expect(key("ArrowLeft")).toBe(false); // with somewhere to go the bar takes the keys
      expect(key("ArrowRight")).toBe(false);
    });

    test("TopBar_on_a_trip_that_is_not_in_the_list_does_not_take_the_arrow_keys_either", async () => {
      stubTrips();
      const { client } = openTrip("/trip/2026-01-01");
      await screen.findByRole("heading", { name: "Trip" });
      await waitFor(() => expect(client.getQueryState(["trips"])?.status).toBe("success"));
      await act(async () => await new Promise((resolve) => setTimeout(resolve, 0))); // the bar has been told

      expect(key("ArrowLeft")).toBe(true);
      expect(key("ArrowRight")).toBe(true);
      expect(pathname()).toBe("/trip/2026-01-01");
    });

    test("TopBar_on_a_trip_leaves_the_arrow_keys_to_a_field_the_map_and_the_browser", async () => {
      stubTrips();
      openTrip("/trip/2026-09-12");
      await listLoaded();
      const host = document.createElement("div");
      host.innerHTML = '<input /><div role="region" aria-label="Map view"><canvas></canvas></div>';
      document.body.append(host);

      key("ArrowRight", {}, host.querySelector("input")!);
      key("ArrowRight", {}, host.querySelector("canvas")!);
      key("ArrowRight", { altKey: true });
      key("ArrowLeft", { metaKey: true });
      key("ArrowRight", { repeat: true });
      expect(pathname()).toBe("/trip/2026-09-12");

      host.remove();
      key("ArrowRight"); // and with the focus elsewhere the page answers
      expect(pathname()).toBe("/trip/2026-10-22");
      await screen.findByRole("heading", { name: "New York" });
    });

    test("TopBar_on_a_trip_has_its_arrows_disabled_and_its_keys_idle_until_the_list_is_there", async () => {
      let release: (response: Response) => void = () => undefined;
      stubTrips({ list: () => new Promise<Response>((resolve) => (release = resolve)) });
      openTrip("/trip/2026-09-12");
      await screen.findByRole("heading", { name: "Lisbon & Sintra" }); // the trip itself is here, and the list is not

      expect(older()).toBeDisabled();
      expect(newer()).toBeDisabled();
      key("ArrowLeft");
      key("ArrowRight");
      press("Older trip");
      expect(pathname()).toBe("/trip/2026-09-12");

      release(Response.json(TRIPS));
      await listLoaded();
      expect(older()).toBeEnabled();
      expect(newer()).toBeEnabled();
    });

    test("TopBar_on_a_trip_has_its_arrows_disabled_when_the_list_cannot_be_had", async () => {
      stubTrips({ list: async () => new Response("{}", { status: 500 }) });
      const { client } = openTrip("/trip/2026-09-12");
      await screen.findByRole("heading", { name: "Lisbon & Sintra" });
      await waitFor(() => expect(client.getQueryState(["trips"])?.status).toBe("error"));
      await act(async () => await new Promise((resolve) => setTimeout(resolve, 0)));

      expect(older()).toBeDisabled();
      expect(newer()).toBeDisabled();
    });

    describe("swipe", () => {
      // A press and a release on the title of the trip, which bubble up to the row, as a finger along the row does.
      function swipe(from: [number, number], to: [number, number]) {
        const title = screen.getByRole("heading");
        fireEvent.pointerDown(title, { pointerId: 1, isPrimary: true, pointerType: "touch", clientX: from[0], clientY: from[1] });
        fireEvent.pointerUp(title, { pointerId: 1, isPrimary: true, pointerType: "touch", clientX: to[0], clientY: to[1] });
      }

      test("TopBar_a_swipe_along_the_row_of_a_trip_steps_to_the_older_and_newer_trip_as_it_does_for_a_period", async () => {
        stubTrips();
        openTrip("/trip/2026-09-12");
        await listLoaded();

        swipe([200, 40], [120, 44]); // 80 px to the left: on to the next, which is the newer trip (›)
        expect(pathname()).toBe("/trip/2026-10-22");
        swipe([200, 40], [100, 40]); // already the newest
        expect(pathname()).toBe("/trip/2026-10-22");

        swipe([100, 40], [190, 38]); // to the right: back, to the older trip (‹)
        expect(pathname()).toBe("/trip/2026-09-12");
        swipe([100, 40], [150, 40]); // exactly 50 px counts
        expect(pathname()).toBe("/trip/2026-08-01");
        swipe([100, 40], [190, 38]); // already the oldest
        expect(pathname()).toBe("/trip/2026-08-01");
      });

      test("TopBar_a_swipe_along_the_row_of_a_trip_needs_50px_and_a_mostly_horizontal_move_and_a_list_to_step_in", async () => {
        let release: (response: Response) => void = () => undefined;
        stubTrips({ list: () => new Promise<Response>((resolve) => (release = resolve)) });
        openTrip("/trip/2026-09-12");
        await screen.findByRole("heading", { name: "Lisbon & Sintra" });

        swipe([200, 40], [100, 40]); // the list is not there: nothing to step to
        expect(pathname()).toBe("/trip/2026-09-12");

        release(Response.json(TRIPS));
        await listLoaded();
        swipe([200, 40], [160, 40]); // 40 px: a twitch
        swipe([200, 40], [140, 150]); // 60 px across but 110 down: someone scrolling
        swipe([200, 40], [200, 40]); // a tap
        expect(pathname()).toBe("/trip/2026-09-12");

        fireEvent.pointerDown(screen.getByRole("heading"), { pointerId: 1, isPrimary: true, clientX: 200, clientY: 40 });
        fireEvent.pointerCancel(screen.getByRole("heading"), { pointerId: 1, isPrimary: true }); // the browser took the gesture over
        fireEvent.pointerUp(screen.getByRole("heading"), { pointerId: 1, isPrimary: true, clientX: 100, clientY: 40 });
        expect(pathname()).toBe("/trip/2026-09-12");
      });
    });

    test("TopBar_a_trip_goes_to_the_list_with_the_Trips_button_and_to_a_view_from_the_day_shown_last", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-10-24T12:00:00"));
      stubTrips();
      openTrip("/trip/2026-09-12");
      await screen.findByRole("heading", { name: "Lisbon & Sintra" });
      await listLoaded();

      press("Trips");
      expect(pathname()).toBe("/trips");
      expect(label()).toBe("Trips");

      press("Day"); // a trip was opened as a page: no day has been shown, so today
      expect(pathname()).toBe("/day/2026-10-24");
    });

    test("TopBar_stops_listening_for_keys_on_a_trip_when_it_goes", async () => {
      stubTrips();
      const { unmount } = openTrip("/trip/2026-09-12");
      await listLoaded();
      unmount();

      key("ArrowRight");

      expect(pathname()).toBe("/trip/2026-09-12");
    });
  });
});
