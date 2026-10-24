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
