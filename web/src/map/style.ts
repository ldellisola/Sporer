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
const ANY_TOKEN = /\{([^}]*)\}/g;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Whether a `text-field` shows a name. It is written as a string, where `{name}` is a token that stands for the property; as an
 * expression, where the property is read with `["get", "name"]` (a string inside an expression is just text, whatever it looks like);
 * or, in styles of the old kind, as a function (see `showsNameInFunction`). Anything else, such as the `ref` of a road shield or a house
 * number, is not a name.
 */
function showsName(textField: unknown): boolean {
  if (typeof textField === "string") return NAME_TOKEN.test(textField);
  if (isRecord(textField)) return showsNameInFunction(textField);
  return isExpressionShowingName(textField);
}

function isExpressionShowingName(expression: unknown): boolean {
  if (!Array.isArray(expression)) return false;
  if (expression[0] === "get") return typeof expression[1] === "string" && NAME_PROPERTY.test(expression[1]);
  return expression.some(isExpressionShowingName);
}

/**
 * Whether a legacy function shows a name: `{ "stops": [[zoom, "{name}"], ...] }`, with `base`, `type`, `property` and `default` besides.
 * It does when one of its values (a stop's, or the default) has a name token, or when it is the property itself that it shows (an
 * `identity` function of `name`). A function of the property `name` that is not an identity looks the value of it up, and shows what
 * its stops say.
 */
function showsNameInFunction(fn: Record<string, unknown>): boolean {
  if (fn["type"] === "identity" && typeof fn["property"] === "string") return NAME_PROPERTY.test(fn["property"]);
  const { stops } = fn;
  const values = Array.isArray(stops) ? stops.map((stop: unknown) => (Array.isArray(stop) ? stop[1] : undefined)) : [];
  return [...values, fn["default"]].some((value) => typeof value === "string" && NAME_TOKEN.test(value));
}

/** A string of the old kind, where `{ref}` stands for the property, as an expression of the same text. */
function tokensToExpression(text: string): unknown {
  const parts: unknown[] = [];
  let last = 0;
  for (const match of text.matchAll(ANY_TOKEN)) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    parts.push(["to-string", ["coalesce", ["get", match[1]], ""]]);
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  if (parts.length === 0) return "";
  return parts.length === 1 ? parts[0] : ["concat", ...parts];
}

/**
 * The English label as an expression for a legacy function that shows a name. A function of the zoom (stops of `[zoom, text]`) becomes a
 * `step` of the zoom, which is what the old kind does for a text (it has nothing to interpolate between): a stop whose text shows a name
 * gives the English label, and the others give their text as it is. Anything that a step cannot say (a function of a property of the
 * feature, stops that are not a list of a zoom and a text, two stops at one zoom) gives the English label whole: English wins over what
 * else such a function would show.
 */
function legacyFunctionToExpression(fn: Record<string, unknown>): TextField {
  const stops = Array.isArray(fn["stops"]) ? fn["stops"] : [];
  const byZoom = stops.every((stop: unknown) => Array.isArray(stop) && stop.length === 2 && typeof stop[0] === "number" && typeof stop[1] === "string")
    ? (stops as [number, string][]).toSorted((a, b) => a[0] - b[0])
    : null;
  const ordered = byZoom !== null && byZoom.length > 0 && fn["property"] === undefined && byZoom.every(([zoom], i) => i === 0 || zoom > byZoom[i - 1]![0]);
  if (!ordered) return englishLabel();
  const valueOf = (text: string): unknown => (NAME_TOKEN.test(text) ? englishLabel() : tokensToExpression(text));
  const [first, ...rest] = byZoom;
  if (rest.length === 0) return valueOf(first![1]) as TextField;
  return ["step", ["zoom"], valueOf(first![1]), ...rest.flatMap(([zoom, text]) => [zoom, valueOf(text)])] as unknown as TextField;
}

/**
 * A copy of `style` in which every symbol layer that labels with a name labels with the English one (see `englishLabel`); the
 * other layers, and the rest of those layers, are as they were. Street names, which rarely have an English one, fall back to the
 * local name by the same expression. A text field that mixes a name with something else, such as an elevation, is replaced whole.
 * A text field written as a legacy function of the old kind is turned into an expression that is English (see
 * `legacyFunctionToExpression`), for it would otherwise be left as it was, with the local names in it.
 */
export function toEnglishLabels(style: StyleSpecification): StyleSpecification {
  return {
    ...style,
    layers: style.layers.map((layer): Layer => {
      if (layer.type !== "symbol") return layer;
      const textField: unknown = layer.layout?.["text-field"];
      if (!showsName(textField)) return layer;
      const english = isRecord(textField) ? legacyFunctionToExpression(textField) : englishLabel();
      return { ...layer, layout: { ...layer.layout, "text-field": english } };
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
