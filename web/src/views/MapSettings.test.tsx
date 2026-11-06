import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { useStoredFlag } from "../app/useStoredFlag";
import { MapSettings } from "./MapSettings";

function Probe() {
  const [fade] = useStoredFlag("fadeRoutes", true);
  return <output aria-label="fade">{String(fade)}</output>;
}

const section = () => screen.getByRole("region", { name: "Map" });
const fade = () => within(section()).getByRole("checkbox", { name: "Fade routes in weeks, months and years" });

beforeEach(() => window.localStorage.clear());
afterEach(() => act(() => window.localStorage.clear()));

describe("MapSettings", () => {
  test("MapSettings_has_a_checkbox_named_by_its_label_that_is_on_by_default_with_a_note", () => {
    render(<MapSettings />);

    expect(fade()).toBeChecked();
    expect(within(section()).getByText("Off draws them as strongly as a day's.")).toBeInTheDocument();
  });

  test("MapSettings_keeps_the_choice_under_fadeRoutes_and_the_app_reads_it_at_once", () => {
    render(
      <>
        <MapSettings />
        <Probe />
      </>,
    );

    fireEvent.click(fade());

    expect(fade()).not.toBeChecked();
    expect(window.localStorage.getItem("fadeRoutes")).toBe("false");
    expect(screen.getByLabelText("fade")).toHaveTextContent("false");

    fireEvent.click(fade());

    expect(fade()).toBeChecked();
    expect(window.localStorage.getItem("fadeRoutes")).toBe("true");
  });
});
