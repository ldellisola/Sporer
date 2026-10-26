// What the map needs of MapLibre, with its stylesheet and the address of its worker, as one module that the app imports dynamically
// (see ./maplibre.ts). Not `import("maplibre-gl")` itself: a dynamic import keeps every export of the module, which is 50 kB more than
// the two this uses. And all of it here, not where the map is: a stylesheet or an address imported from the page's own code would make
// its bundle depend on MapLibre's chunk, which would then be fetched and run at the start, as the one thing the page waits for.
import "maplibre-gl/dist/maplibre-gl.css";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";

export { MapLibreMap, setWorkerUrl } from "maplibre-gl";
// The worker is an asset of the build (Vite gives it a hashed name under /assets, which the API serves as a script).
export { workerUrl };
