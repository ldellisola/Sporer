import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { parseRoute, useRoute } from "../app/router";
import { periodDays } from "../time/dates";
import { TopBar } from "./TopBar";

// The bar is told the route it shows and moves the address; the harness gives it the route the address shows, as the app does.
function Harness() {
  return <TopBar route={useRoute()} />;
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

    press("Day"); // and back in: the start of the year, as the bar has no other date to go by
    expect(pathname()).toBe("/day/2026-01-01");
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

  test("TopBar_range_fields_set_the_range_and_keep_it_valid", () => {
    open("/range/2026-10-19..2026-10-25");
    const change = (name: "From" | "To", value: string) => fireEvent.change(field(name), { target: { value } });

    change("From", "2026-10-20");
    expect(pathname()).toBe("/range/2026-10-20..2026-10-25");
    change("To", "2026-11-02");
    expect(pathname()).toBe("/range/2026-10-20..2026-11-02");
    expect(label()).toBe("20 Oct – 2 Nov 2026");

    // A start after the end takes the end along, and an end before the start the start: one day, not a range that runs backwards.
    change("From", "2026-11-10");
    expect(pathname()).toBe("/range/2026-11-10..2026-11-10");
    expect(field("To")).toHaveValue("2026-11-10");
    change("To", "2026-11-01");
    expect(pathname()).toBe("/range/2026-11-01..2026-11-01");
    expect(field("From")).toHaveValue("2026-11-01");

    // The API answers 400 for more than 400 days; the other end gives way instead of the owner being sent to an error.
    change("To", "2028-01-01");
    const route = parseRoute(pathname(), "2026-10-24");
    expect(route).toMatchObject({ view: "range", to: "2028-01-01" });
    expect(periodDays(route as Extract<typeof route, { view: "range" }>)).toBe(400);
    expect(field("From")).toHaveValue((route as { from: string }).from);
  });

  test("TopBar_range_fields_ignore_what_is_not_yet_a_date", () => {
    open("/range/2026-10-19..2026-10-25");
    const before = pathname();

    fireEvent.change(field("From"), { target: { value: "" } }); // a part of the field cleared, on the way to another date
    fireEvent.change(field("To"), { target: { value: "0002-10-25" } }); // the year typed so far, on the way to 2026

    expect(pathname()).toBe(before);
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
    key("ArrowLeft", {}, target);
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
