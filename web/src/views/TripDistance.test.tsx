import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import type { SettingsResponse } from "../api/types";
import { refusal, stubEdits, type Call } from "../test/stubEdits";
import { SettingsNotes } from "./SettingsNotes";
import { TripDistance } from "./TripDistance";

/**
 * A server that keeps the distance that was put to it: `GET /api/settings` says what is in effect and the default, `PUT /api/settings` sets it (null:
 * the default again) and answers with the settings as they are then. `put` can be changed to refuse or to fail.
 */
function server(initial = 80) {
  const state = { settings: { tripMinDistanceKm: initial, tripMinDistanceKmDefault: 50 } as SettingsResponse };
  const handlers = {
    put: (call: Call): Response | Promise<Response> => {
      const { tripMinDistanceKm } = call.body as { tripMinDistanceKm: number | null };
      state.settings = { ...state.settings, tripMinDistanceKm: tripMinDistanceKm ?? state.settings.tripMinDistanceKmDefault };
      return Response.json(state.settings);
    },
  };
  const api = stubEdits({
    "GET /api/settings": () => Response.json(state.settings),
    "PUT /api/settings": (call) => handlers.put(call),
  });
  return { state, handlers, api };
}

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <SettingsNotes>
          <TripDistance />
        </SettingsNotes>
      </QueryClientProvider>,
    ),
  };
}

const section = () => screen.getByRole("region", { name: "Trips" });
const field = () => screen.findByRole("spinbutton", { name: "Minimum distance from home (km)" });
const save = () => within(section()).getByRole("button", { name: /^Sav/ });
const reset = () => within(section()).getByRole("button", { name: /^Reset to default|^Resetting/ });
const note = () => screen.getByRole("status").textContent ?? "";
const type = async (text: string) => fireEvent.change(await field(), { target: { value: text } });

describe("TripDistance", () => {
  test("TripDistance_shows_the_distance_in_effect_in_a_number_field_with_save_off_and_reset_naming_the_default", async () => {
    const { api } = server(80);

    mount();

    expect(within(section()).getByText("Loading…")).toBeInTheDocument();
    const distance = await field();
    expect(distance).toHaveValue(80);
    expect(distance).toHaveAttribute("min", "5");
    expect(distance).toHaveAttribute("max", "1000");
    expect(within(section()).getByText("A trip is a night spent this far from home, or farther.")).toBeInTheDocument();
    expect(save()).toHaveTextContent("Save");
    expect(save()).toBeDisabled(); // nothing was changed: an untouched value is never sent as the owner's
    expect(reset()).toHaveTextContent("Reset to default (50 km)");
    expect(reset()).toBeEnabled();
    expect(api.reads("/api/settings")).toHaveLength(1);
  });

  test("TripDistance_saves_the_distance_as_a_number_in_json_says_it_is_saving_and_then_what_it_did", async () => {
    const { handlers, api } = server(80);
    let release: () => void = () => undefined;
    const answer = handlers.put;
    handlers.put = (call) =>
      new Promise<Response>((resolve) => {
        release = () => resolve(answer(call) as Response);
      });
    mount();

    await type("120");
    expect(save()).toBeEnabled();
    fireEvent.click(save());

    expect(await within(section()).findByRole("button", { name: "Saving…" })).toBeDisabled();
    expect(reset()).toBeDisabled(); // one write at a time
    expect(api.writes()).toEqual([{ method: "PUT", path: "/api/settings", search: "", contentType: "application/json", body: { tripMinDistanceKm: 120 } }]);

    release();

    await waitFor(() => expect(note()).toBe("Trip distance set to 120 km"));
    expect(await field()).toHaveValue(120);
    expect(save()).toBeDisabled(); // what is in the field is what is in effect now
    expect(save()).toHaveTextContent("Save");
  });

  test("TripDistance_takes_decimals_and_sends_them_as_they_are", async () => {
    const { api } = server(80);
    mount();

    await type("7.5");
    fireEvent.click(save());

    await waitFor(() => expect(note()).toBe("Trip distance set to 7.5 km"));
    expect(api.writes().map((write) => write.body)).toEqual([{ tripMinDistanceKm: 7.5 }]);
  });

  test("TripDistance_resets_to_the_default_by_sending_null_and_shows_the_default_in_the_field", async () => {
    const { api } = server(80);
    mount();
    await field();

    fireEvent.click(reset());

    await waitFor(() => expect(note()).toBe("Trip distance back to the default, 50 km"));
    expect(api.writes()).toEqual([{ method: "PUT", path: "/api/settings", search: "", contentType: "application/json", body: { tripMinDistanceKm: null } }]);
    expect(await field()).toHaveValue(50);
    expect(save()).toBeDisabled();
  });

  test("TripDistance_resets_what_was_typed_too", async () => {
    server(80);
    mount();
    await type("200");

    fireEvent.click(reset());

    await waitFor(() => expect(note()).toBe("Trip distance back to the default, 50 km"));
    expect(await field()).toHaveValue(50); // not the 200 that was never saved
  });

  test("TripDistance_says_what_is_wrong_with_a_distance_the_server_would_refuse_and_asks_nothing_of_it", async () => {
    const { api } = server(80);
    mount();

    for (const bad of ["", "4.9", "1000.5", "-3", "0"]) {
      await type(bad);
      fireEvent.click(save());
      const alert = await within(section()).findByRole("alert");
      expect(alert, bad).toHaveTextContent("Enter a distance from 5 to 1000 km.");
      expect(await field(), bad).toHaveAttribute("aria-invalid", "true");
      expect(await field(), bad).toHaveFocus();
    }
    expect(api.writes()).toEqual([]);

    await type("5"); // the ends are distances
    expect(within(section()).queryByRole("alert")).not.toBeInTheDocument(); // what it said was of the text that was
    fireEvent.click(save());
    await waitFor(() => expect(note()).toBe("Trip distance set to 5 km"));
    await type("1000");
    fireEvent.click(save());
    await waitFor(() => expect(note()).toBe("Trip distance set to 1,000 km"));
    expect(api.writes().map((write) => write.body)).toEqual([{ tripMinDistanceKm: 5 }, { tripMinDistanceKm: 1000 }]);
  });

  test("TripDistance_sends_nothing_when_the_field_is_put_back_to_what_is_in_effect_and_enter_in_an_untouched_field_does_nothing", async () => {
    const { api } = server(80);
    mount();
    await type("90");
    await type("80");

    expect(save()).toBeDisabled();
    fireEvent.submit((await field()).closest("form")!);

    expect(api.writes()).toEqual([]);
  });

  test("TripDistance_says_a_refusal_in_the_words_of_the_server_with_no_retry_and_keeps_what_was_typed", async () => {
    const { handlers, api } = server(80);
    handlers.put = () => refusal(400, "The distance must be from 5 to 1000 kilometres, or be null.");
    mount();
    await type("999");

    fireEvent.click(save());

    const alert = await within(section()).findByRole("alert");
    expect(alert).toHaveTextContent("Could not save: The distance must be from 5 to 1000 kilometres, or be null.");
    expect(within(alert).queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
    expect(await field()).toHaveValue(999); // to be put right
    expect(save()).toBeEnabled();
    expect(api.writes()).toHaveLength(1);
  });

  test("TripDistance_offers_a_retry_for_a_failure_that_may_pass_and_sends_the_same_distance_again", async () => {
    const { handlers, api } = server(80);
    const works = handlers.put;
    handlers.put = () => new Response("{}", { status: 503 });
    mount();
    await type("150");
    const button = save();
    button.focus();

    fireEvent.click(button);

    const alert = await within(section()).findByRole("alert");
    expect(alert).toHaveTextContent("Couldn't save — Retry");
    expect(await field()).toHaveValue(150);
    await waitFor(() => expect(save()).toHaveFocus()); // the button was turned off while it was pressed: the focus is not left on the page

    handlers.put = works;
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(note()).toBe("Trip distance set to 150 km"));
    expect(api.writes().map((write) => write.body)).toEqual([{ tripMinDistanceKm: 150 }, { tripMinDistanceKm: 150 }]);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  test("TripDistance_follows_a_distance_that_was_changed_elsewhere_in_a_field_that_was_not_touched_and_keeps_what_the_owner_typed", async () => {
    const { state } = server(80);
    const { client } = mount();
    expect(await field()).toHaveValue(80);

    state.settings = { ...state.settings, tripMinDistanceKm: 60 }; // set in another window
    await act(async () => {
      await client.refetchQueries({ queryKey: ["settings"] });
    });
    expect(await field()).toHaveValue(60); // an untouched field is what is in effect

    await type("70");
    state.settings = { ...state.settings, tripMinDistanceKm: 90 };
    await act(async () => {
      await client.refetchQueries({ queryKey: ["settings"] });
    });
    expect(await field()).toHaveValue(70); // what the owner typed is theirs
  });

  test("TripDistance_shows_an_error_when_the_settings_cannot_be_had_with_a_retry_and_keeps_its_heading", async () => {
    const { state } = server(80);
    const failing = stubEdits({ "GET /api/settings": () => new Response("{}", { status: 503 }) });

    mount();

    const alert = await within(section()).findByRole("alert");
    expect(alert).toHaveTextContent("Couldn't load — Retry");
    expect(within(section()).getByRole("heading", { name: "Trips" })).toBeInTheDocument(); // never blank
    expect(within(section()).queryByRole("spinbutton")).not.toBeInTheDocument(); // there is no distance to show or to change

    failing.routes["GET /api/settings"] = () => Response.json(state.settings);
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));

    expect(await field()).toHaveValue(80);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
