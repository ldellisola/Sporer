/** What the map uses of MapLibre: the map, the way to tell it where its worker is, and where that is (see `./maplibre-entry`). */
export type MapLibreModule = Pick<typeof import("maplibre-gl"), "MapLibreMap" | "setWorkerUrl"> & { workerUrl: string };

/** How a map gets MapLibre: a promise of the module, which a failure rejects. */
export type MapLibreLoader = () => Promise<MapLibreModule>;

/**
 * A loader that fetches the module with `importModule` the first time it is asked, once, and hands the same one to everyone after
 * that. MapLibre looks for its worker next to its own module, and once a bundler has put the module into a chunk of its own that is
 * not where the worker is, so the module is told where the worker is before anyone gets it. A failed import (the chunk could not be fetched: offline, or a release that replaced it under an open page)
 * is not kept: the next ask tries again.
 */
export function createMapLibreLoader(importModule: MapLibreLoader): MapLibreLoader {
  let loading: Promise<MapLibreModule> | null = null;
  return () => {
    loading ??= importModule().then(
      (module) => {
        module.setWorkerUrl(module.workerUrl);
        return module;
      },
      (error: unknown) => {
        loading = null;
        throw error;
      },
    );
    return loading;
  };
}

/**
 * MapLibre is most of the bytes of the app (two thirds of its JavaScript, and its parsing is the longest task of a start), so it is
 * not part of the bundle the page starts with: the panel and its rows come first, and the map's own chunk (with its stylesheet) is
 * fetched, and run, once they are on their way. Vite keeps it in a chunk of its own (see vite.config.ts).
 */
export const loadMapLibre: MapLibreLoader = createMapLibreLoader(() => import("./maplibre-entry"));
