import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, test } from "vitest";
import type { PlaceSearchResult } from "../api/types";
import { stubEdits } from "../test/stubEdits";
import { PlacesPanel } from "./PlacesPanel";

const FOUND: PlaceSearchResult[] = [
  { id: 1, name: "Home", address: "Storgata 1, Oslo", visits: 300 },
  { id: 7, name: "Bistro", address: null, visits: 3 },
];

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <PlacesPanel />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  window.history.replaceState(null, "", "/places");
});

describe("PlacesPanel", () => {
  test("PlacesPanel_lists_the_places_most_visited_first_and_says_what_the_map_is_for", async () => {
    const api = stubEdits({ "GET /api/places/search": () => Response.json(FOUND) });
    mount();

    expect(screen.getByRole("heading", { name: "Places" })).toBeInTheDocument();
    expect(screen.getByText("Tap a place on the map or in the list to open it.")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Home, Storgata 1, Oslo, 300 visits" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Bistro, 3 visits" })).toBeInTheDocument();
    expect(screen.getByRole("searchbox", { name: "Search places" })).not.toHaveFocus(); // a keyboard would cover the map on a phone
    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument(); // the list is the page: there is nothing to cancel
    expect(api.reads("/api/places/search")).toHaveLength(1);
  });

  test("PlacesPanel_a_row_opens_its_place", async () => {
    stubEdits({ "GET /api/places/search": () => Response.json(FOUND) });
    mount();

    fireEvent.click(await screen.findByRole("button", { name: /^Bistro/ }));

    expect(window.location.pathname).toBe("/place/7");
  });
});
