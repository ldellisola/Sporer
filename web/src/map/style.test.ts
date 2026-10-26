import { afterEach, describe, expect, test, vi } from "vitest";
import { loadStyle, toEnglishLabels, type StyleSpecification } from "./style";

const ENGLISH = ["coalesce", ["get", "name:en"], ["get", "name_en"], ["get", "name:latin"], ["get", "name"]];

function styleOf(...layers: object[]): StyleSpecification {
  return { version: 8, name: "test", sources: {}, layers } as StyleSpecification;
}

function symbol(id: string, textField: unknown, extra: object = {}): object {
  return { id, type: "symbol", source: "tiles", layout: { "text-field": textField, "text-size": 14, ...extra } };
}

function textFieldOf(style: StyleSpecification, id: string): unknown {
  const layer = style.layers.find((candidate) => candidate.id === id);
  if (layer?.type !== "symbol") throw new Error(`${id} is not a symbol layer`);
  return layer.layout?.["text-field"];
}

describe("toEnglishLabels", () => {
  test("toEnglishLabels_rewrites_name_text_fields_only", () => {
    const style = styleOf(
      { id: "background", type: "background", paint: { "background-color": "#eee" } },
      { id: "water", type: "fill", source: "tiles", paint: { "fill-color": "#9cf" } },
      { id: "road", type: "line", source: "tiles", layout: { "text-field": "{name}" } }, // not a symbol layer: left alone
      symbol("city", ["coalesce", ["get", "name:latin"], ["get", "name"]], { "text-font": ["Noto Sans Bold"] }),
      symbol("country", ["get", "name"]),
      symbol("town", "{name}"),
      symbol("old-style", "{name:latin}\n{name:nonlatin}"),
      symbol("already-english", ["coalesce", ["get", "name:en"], ["get", "name"]]),
      symbol("wrapped", ["to-string", ["get", "name"]]),
      symbol("branch", ["case", ["has", "name:nonlatin"], ["concat", ["get", "name:latin"], "\n", ["get", "name:nonlatin"]], ["get", "name"]]),
      symbol("shield", "{ref}"),
      symbol("shield-expression", ["get", "ref"]),
      symbol("house-number", ["get", "housenumber"]),
      symbol("literal-only", ["concat", "{name} ", ["get", "class"]]),
      { id: "icon-only", type: "symbol", source: "tiles", layout: { "icon-image": "dot" } },
    );

    const result = toEnglishLabels(style);

    for (const id of ["city", "country", "town", "old-style", "already-english", "wrapped", "branch"]) {
      expect(textFieldOf(result, id), id).toEqual(ENGLISH);
    }
    for (const id of ["shield", "shield-expression", "house-number", "literal-only"]) {
      expect(textFieldOf(result, id), id).toEqual(textFieldOf(style, id));
    }
    for (const id of ["background", "water", "road", "icon-only"]) {
      expect(result.layers.find((layer) => layer.id === id), id).toEqual(style.layers.find((layer) => layer.id === id));
    }
    // Only the text field changes: the rest of the layer, and of its layout, stays.
    const city = result.layers.find((layer) => layer.id === "city");
    expect(city).toMatchObject({ type: "symbol", source: "tiles", layout: { "text-size": 14, "text-font": ["Noto Sans Bold"] } });
    expect(result.layers.map((layer) => layer.id)).toEqual(style.layers.map((layer) => layer.id));
    expect(result.version).toBe(8);
    expect(result.name).toBe("test");
  });

  test("toEnglishLabels_returns_a_copy_and_leaves_the_input_alone", () => {
    const style = styleOf(symbol("city", "{name}"), { id: "water", type: "fill", source: "tiles" });
    const before = structuredClone(style);

    const result = toEnglishLabels(style);

    expect(style).toEqual(before);
    expect(result).not.toBe(style);
    expect(result.layers).not.toBe(style.layers);
  });

  test("toEnglishLabels_gives_each_layer_its_own_expression", () => {
    const result = toEnglishLabels(styleOf(symbol("a", "{name}"), symbol("b", "{name}")));

    expect(textFieldOf(result, "a")).not.toBe(textFieldOf(result, "b"));
  });

  test("toEnglishLabels_copes_with_a_style_without_layers_or_layout", () => {
    expect(toEnglishLabels(styleOf())).toEqual(styleOf());
    expect(toEnglishLabels(styleOf({ id: "bare", type: "symbol", source: "tiles" }))).toEqual(
      styleOf({ id: "bare", type: "symbol", source: "tiles" }),
    );
  });
});

// Styles of the old kind (OpenMapTiles' own among them) write a property that changes with the zoom as a "function": an object with
// `stops` (and `base`, `type`, `property`), not an expression. A function holds no expression, so it is turned into one.
describe("toEnglishLabels with legacy functions", () => {
  test("toEnglishLabels_turns_a_legacy_zoom_function_of_name_tokens_into_a_step_of_the_English_label", () => {
    const style = styleOf(
      symbol("stops", { stops: [[6, "{name}"], [10, "{name:latin}\n{name:nonlatin}"], [14, "{name_int}"]] }),
      symbol("with-base", { base: 1.2, stops: [[4, "{name_en}"], [8, "{name}"]] }),
      symbol("one-stop", { stops: [[5, "{name:latin}"]] }),
    );

    const result = toEnglishLabels(style);

    // Whatever zoom it is at, the label is the English one: the first stop's value is for every zoom below the second stop, as in the old spec.
    expect(textFieldOf(result, "stops")).toEqual(["step", ["zoom"], ENGLISH, 10, ENGLISH, 14, ENGLISH]);
    expect(textFieldOf(result, "with-base")).toEqual(["step", ["zoom"], ENGLISH, 8, ENGLISH]);
    expect(textFieldOf(result, "one-stop")).toEqual(ENGLISH); // a step of one value is that value
  });

  test("toEnglishLabels_keeps_the_stops_of_a_legacy_function_that_say_something_other_than_a_name", () => {
    // A place that is named from some zoom on, and shows its reference or nothing before that.
    const style = styleOf(
      symbol("later", { stops: [[0, ""], [9, "{name}"]] }),
      symbol("ref-then-name", { stops: [[0, "{ref}"], [12, "{name}"]] }),
      symbol("plain-text", { stops: [[0, "Sporer"], [9, "{name:latin}"]] }),
    );

    const result = toEnglishLabels(style);

    expect(textFieldOf(result, "later")).toEqual(["step", ["zoom"], "", 9, ENGLISH]);
    expect(textFieldOf(result, "ref-then-name")).toEqual(["step", ["zoom"], ["to-string", ["coalesce", ["get", "ref"], ""]], 12, ENGLISH]);
    expect(textFieldOf(result, "plain-text")).toEqual(["step", ["zoom"], "Sporer", 9, ENGLISH]);
  });

  test("toEnglishLabels_puts_the_stops_of_a_legacy_function_in_order_of_zoom", () => {
    const result = toEnglishLabels(styleOf(symbol("unsorted", { stops: [[10, "{name:latin}"], [4, "{ref}"]] })));

    expect(textFieldOf(result, "unsorted")).toEqual(["step", ["zoom"], ["to-string", ["coalesce", ["get", "ref"], ""]], 10, ENGLISH]);
  });

  test("toEnglishLabels_makes_a_legacy_function_it_cannot_turn_into_a_step_the_English_label_whole", () => {
    // English wins over anything else: a function that depends on a property of the feature, or whose stops are not a list that a step
    // can have, is replaced by the label, as a field that mixes a name with something else is.
    const style = styleOf(
      symbol("by-property", { property: "rank", type: "interval", stops: [[1, "{name}"], [5, "{name:latin}"]] }),
      symbol("composite", { property: "rank", stops: [[{ zoom: 5, value: 1 }, "{name}"], [{ zoom: 9, value: 1 }, "{name:latin}"]] }),
      symbol("identity", { property: "name", type: "identity" }),
      symbol("identity-latin", { property: "name:latin", type: "identity" }),
      symbol("duplicate-zoom", { stops: [[6, "{name}"], [6, "{name:latin}"]] }),
      symbol("no-stops", { base: 2, default: "{name}" }),
      symbol("odd-stops", { stops: [["six", "{name}"], [7]] }),
      symbol("empty-stops", { stops: [], default: "{name:latin}" }),
    );

    const result = toEnglishLabels(style);

    for (const id of ["by-property", "composite", "identity", "identity-latin", "duplicate-zoom", "no-stops", "odd-stops", "empty-stops"]) {
      expect(textFieldOf(result, id), id).toEqual(ENGLISH);
    }
  });

  test("toEnglishLabels_leaves_a_legacy_function_that_shows_no_name_as_it_is", () => {
    const style = styleOf(
      symbol("refs", { stops: [[0, "{ref}"], [10, "{ref} {class}"]] }),
      symbol("numbers", { property: "housenumber", type: "identity" }),
      symbol("plain", { stops: [[0, ""], [5, "Sporer"]] }),
      symbol("by-class", { property: "class", type: "categorical", stops: [["city", "{ref}"]], default: "" }),
      symbol("name-as-the-key", { property: "name", type: "categorical", stops: [["Oslo", "{ref}"]] }), // `name` is only what it is looked up by
      symbol("not-a-function", {}),
    );

    const result = toEnglishLabels(style);

    for (const id of ["refs", "numbers", "plain", "by-class", "name-as-the-key", "not-a-function"]) {
      expect(textFieldOf(result, id), id).toEqual(textFieldOf(style, id));
    }
  });

  test("toEnglishLabels_leaves_the_rest_of_the_layer_of_a_legacy_function_alone", () => {
    const style = styleOf(symbol("city", { stops: [[6, "{name}"], [10, "{name:latin}"]] }, { "text-font": ["Noto Sans Bold"], "text-size": { stops: [[6, 10], [10, 14]] } }));

    const result = toEnglishLabels(style);

    expect(result.layers[0]).toMatchObject({ layout: { "text-size": { stops: [[6, 10], [10, 14]] }, "text-font": ["Noto Sans Bold"] } });
    expect(style.layers[0]).toMatchObject({ layout: { "text-field": { stops: [[6, "{name}"], [10, "{name:latin}"]] } } }); // and the input
  });

  test("toEnglishLabels_gives_each_stop_its_own_expression", () => {
    const result = toEnglishLabels(styleOf(symbol("city", { stops: [[0, "{name}"], [5, "{name}"]] })));
    const step = textFieldOf(result, "city") as unknown[];

    expect(step[2]).not.toBe(step[4]);
  });
});

describe("loadStyle", () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubFetch(response: Response | Promise<Response>) {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => response);
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  test("loadStyle_fetches_the_style_and_rewrites_its_labels", async () => {
    const fetchMock = stubFetch(Response.json(styleOf(symbol("city", "{name:latin}\n{name:nonlatin}"))));
    const controller = new AbortController();

    const style = await loadStyle("/styles/liberty", controller.signal);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/styles/liberty");
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
    expect(textFieldOf(style, "city")).toEqual(ENGLISH);
  });

  test("loadStyle_rejects_for_a_response_that_is_not_a_success", async () => {
    stubFetch(new Response("down", { status: 503 }));

    await expect(loadStyle("/styles/liberty")).rejects.toThrow(/503/);
  });

  test("loadStyle_rejects_for_a_body_that_is_not_json", async () => {
    stubFetch(new Response("<html>not a style</html>", { status: 200 }));

    await expect(loadStyle("/styles/liberty")).rejects.toThrow();
  });

  test("loadStyle_rejects_for_json_that_is_not_a_style", async () => {
    stubFetch(Response.json({ hello: "world" }));

    await expect(loadStyle("/styles/liberty")).rejects.toThrow(/style/i);
  });

  test("loadStyle_passes_on_a_failed_request_and_an_abort", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    await expect(loadStyle("/styles/liberty")).rejects.toThrow("Failed to fetch");

    const controller = new AbortController();
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      init?.signal?.throwIfAborted();
      return Response.json(styleOf());
    }));
    controller.abort();
    await expect(loadStyle("/styles/liberty", controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
});
