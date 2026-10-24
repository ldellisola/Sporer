import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
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
});
