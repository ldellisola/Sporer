import { describe, expect, test, vi } from "vitest";
import { createMapLibreLoader, type MapLibreModule } from "./maplibre";

// The loader is MapLibre's way in: one fetch of the module, the worker's address told to it before anyone gets it, and a failure that
// is not remembered. (What a map does with a module that arrives late, or not at all, is in MapView.test.tsx.)

const moduleWith = (setWorkerUrl: (url: string) => void, workerUrl = "/assets/maplibre-gl-worker-abc.mjs") =>
  ({ setWorkerUrl, workerUrl }) as unknown as MapLibreModule;

describe("createMapLibreLoader", () => {
  test("loads_the_module_once_for_everyone_and_tells_it_where_its_worker_is_before_handing_it_over", async () => {
    const setWorkerUrl = vi.fn<(url: string) => void>();
    const mapLibre = moduleWith(setWorkerUrl);
    const importModule = vi.fn(async () => mapLibre);
    const load = createMapLibreLoader(importModule);

    const [first, second] = await Promise.all([load(), load()]);
    const third = await load();

    expect(importModule).toHaveBeenCalledTimes(1);
    expect([first, second, third]).toEqual([mapLibre, mapLibre, mapLibre]);
    expect(setWorkerUrl).toHaveBeenCalledTimes(1);
    expect(setWorkerUrl).toHaveBeenCalledWith("/assets/maplibre-gl-worker-abc.mjs");
  });

  test("does_not_fetch_anything_until_it_is_asked", () => {
    const importModule = vi.fn(async () => moduleWith(() => undefined));

    createMapLibreLoader(importModule);

    expect(importModule).not.toHaveBeenCalled();
  });

  test("rejects_with_the_error_of_a_failed_fetch_and_tries_again_on_the_next_ask", async () => {
    const setWorkerUrl = vi.fn<(url: string) => void>();
    const failure = new TypeError("Failed to fetch dynamically imported module");
    const importModule = vi
      .fn<() => Promise<MapLibreModule>>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(moduleWith(setWorkerUrl));
    const load = createMapLibreLoader(importModule);

    await expect(load()).rejects.toBe(failure);
    expect(setWorkerUrl).not.toHaveBeenCalled(); // there was no module to tell
    await expect(load()).resolves.toMatchObject({ setWorkerUrl });

    expect(importModule).toHaveBeenCalledTimes(2);
    expect(setWorkerUrl).toHaveBeenCalledWith("/assets/maplibre-gl-worker-abc.mjs");
    await load();
    expect(importModule).toHaveBeenCalledTimes(2); // and once it is there, it is kept
  });
});
