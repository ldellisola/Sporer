// Registers the service worker (/sw.js, made by `vite build`; see src/sw/sw.ts). What it needs of the browser and of the build is given
// to it, not looked up, so that the rules here can be tested without either.

/** What registration needs: whether this is a production build, and the parts of `navigator` and `window` it touches. */
export interface RegistrationEnv {
  /** `vite build` makes /sw.js; `vite dev` has none, and a worker that a production build left on the same origin is not to be fed from it. */
  production: boolean;
  navigator: {
    readonly serviceWorker?: {
      register(scriptUrl: string, options: { scope: string; updateViaCache: "none" }): Promise<unknown>;
    };
  };
  window: {
    readonly document: { readonly readyState: string };
    addEventListener(type: "load", listener: () => void, options: { once: true }): void;
  };
}

/**
 * Registers /sw.js with the scope `/`, and with `updateViaCache: "none"` so that the browser asks the server for the script itself every
 * time it looks for an update, never its own HTTP cache: a new build's worker is found at the next visit. It waits for the page's `load`
 * event, so that the worker's install, which fetches every file of the shell, does not compete with the files the page itself is waiting
 * for; a page that has loaded already registers at once.
 *
 * Does nothing outside a production build or where the browser has no service workers. A registration that fails (a browser that blocks
 * workers, a script that cannot be fetched) is a warning in the console and no more: the app does not need the worker to work.
 */
export function registerServiceWorker({ production, navigator, window }: RegistrationEnv): void {
  if (!production) return;
  const container = serviceWorkerOf(navigator);
  if (container === undefined) return;

  const register = async (): Promise<void> => {
    try {
      await container.register("/sw.js", { scope: "/", updateViaCache: "none" });
    } catch (error) {
      console.warn("The service worker could not be registered; the app works as it does without one.", error);
    }
  };

  if (window.document.readyState === "complete") void register();
  else window.addEventListener("load", () => void register(), { once: true });
}

// Some browsers throw at the property itself (Firefox with its site data blocked once did): no worker, as where there is none.
function serviceWorkerOf(navigator: RegistrationEnv["navigator"]): RegistrationEnv["navigator"]["serviceWorker"] {
  try {
    return navigator.serviceWorker;
  } catch {
    return undefined;
  }
}
