import type { MapLibreMap } from "maplibre-gl";

// `maplibre-gl` does not pass on the types of its style-spec package, and that package is only its dependency, not ours:
// what is needed is taken from the signature of `Map.setStyle` instead.
/** A MapLibre style document, as `setStyle` takes it. */
export type StyleSpecification = Exclude<Parameters<MapLibreMap["setStyle"]>[0], string | null>;

type Layer = StyleSpecification["layers"][number];
type SymbolLayer = Extract<Layer, { type: "symbol" }>;
type TextField = NonNullable<NonNullable<SymbolLayer["layout"]>["text-field"]>;

/** What a label shows: the English name where the tiles have one, else a Latin-script name, else the local one. */
function englishLabel(): TextField {
  return ["coalesce", ["get", "name:en"], ["get", "name_en"], ["get", "name:latin"], ["get", "name"]];
}

/** `name`, and the variants of it that OpenMapTiles writes: `name:en`, `name:latin`, `name:nonlatin`, `name_en`, `name_int`. */
const NAME_PROPERTY = /^name(?:[:_].*)?$/;
const NAME_TOKEN = /\{name(?:[:_][^}]*)?\}/;

/**
 * Whether a `text-field` shows a name. It is written either as a string, where `{name}` is a token that stands for the
 * property, or as an expression, where the property is read with `["get", "name"]` (a string inside an expression is just
 * text, whatever it looks like). Anything else, such as the `ref` of a road shield or a house number, is not a name.
 */
function showsName(textField: unknown): boolean {
  if (typeof textField === "string") return NAME_TOKEN.test(textField);
  return isExpressionShowingName(textField);
}

function isExpressionShowingName(expression: unknown): boolean {
  if (!Array.isArray(expression)) return false;
  if (expression[0] === "get") return typeof expression[1] === "string" && NAME_PROPERTY.test(expression[1]);
  return expression.some(isExpressionShowingName);
}

/**
 * A copy of `style` in which every symbol layer that labels with a name labels with the English one (see `englishLabel`); the
 * other layers, and the rest of those layers, are as they were. Street names, which rarely have an English one, fall back to the
 * local name by the same expression. A text field that mixes a name with something else, such as an elevation, is replaced whole.
 */
export function toEnglishLabels(style: StyleSpecification): StyleSpecification {
  return {
    ...style,
    layers: style.layers.map((layer): Layer => {
      if (layer.type !== "symbol" || !showsName(layer.layout?.["text-field"])) return layer;
      return { ...layer, layout: { ...layer.layout, "text-field": englishLabel() } };
    }),
  };
}

/**
 * Fetches the style document at `url` and gives it English labels. Rejects, with whatever `fetch` rejects with (an
 * `AbortError` once `signal` aborts), when there is no answer, the answer is not a success, or it is not a style.
 */
export async function loadStyle(url: string, signal?: AbortSignal): Promise<StyleSpecification> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`GET ${url} failed with status ${response.status}`);
  const style = (await response.json()) as Partial<StyleSpecification> | null;
  if (typeof style !== "object" || style === null || !Array.isArray(style.layers)) {
    throw new Error(`${url} is not a map style: it has no layers.`);
  }
  return toEnglishLabels(style as StyleSpecification);
}
