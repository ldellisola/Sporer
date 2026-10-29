import { describe, expect, test, vi } from "vitest";
import { registerServiceWorker, type RegistrationEnv } from "./registerServiceWorker";

type Register = NonNullable<RegistrationEnv["navigator"]["serviceWorker"]>["register"];

/** A page that is still loading (`readyState` is `loading`) or has loaded (`complete`), and the `load` event of it to fire. */
function fakeWindow(readyState: string) {
  const target = new EventTarget();
  const addEventListener = vi.spyOn(target, "addEventListener");
  return { window: Object.assign(target, { document: { readyState } }), addEventListener, load: () => target.dispatchEvent(new Event("load")) };
}

/** An environment whose service worker container is `register`; `serviceWorker` is left out when there is none (Safari's private windows once, an insecure page). */
function envWith(register: Register | null, over: Partial<{ production: boolean; readyState: string }> = {}) {
  const page = fakeWindow(over.readyState ?? "loading");
  const env: RegistrationEnv = {
    production: over.production ?? true,
    navigator: register === null ? {} : { serviceWorker: { register } },
    window: page.window,
  };
  return { env, ...page };
}

const registered = () => vi.fn<Register>(async () => ({}));

describe("registerServiceWorker", () => {
  test("registerServiceWorker_registers_sw_js_with_scope_root_and_no_cache_for_the_script_once_the_page_has_loaded", () => {
    const register = registered();
    const { env, load } = envWith(register);

    registerServiceWorker(env);
    expect(register).not.toHaveBeenCalled(); // the page's own files come first: the worker's install fetches the whole shell

    load();

    expect(register).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledWith("/sw.js", { scope: "/", updateViaCache: "none" });
  });

  test("registerServiceWorker_registers_at_once_when_the_page_has_loaded_already", () => {
    const register = registered();
    const { env, addEventListener } = envWith(register, { readyState: "complete" });

    registerServiceWorker(env);

    expect(register).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledWith("/sw.js", { scope: "/", updateViaCache: "none" });
    expect(addEventListener).not.toHaveBeenCalled(); // a load event that has happened will not come again
  });

  test("registerServiceWorker_registers_once_however_many_times_the_page_says_it_has_loaded", () => {
    const register = registered();
    const { env, load } = envWith(register);

    registerServiceWorker(env);
    load();
    load();

    expect(register).toHaveBeenCalledTimes(1);
  });

  test("registerServiceWorker_does_nothing_outside_a_production_build", () => {
    // `vite dev` has no /sw.js: a registration would only fail, and a worker left over from a production build on this origin must not be fed.
    for (const readyState of ["loading", "complete"]) {
      const register = registered();
      const { env, addEventListener, load } = envWith(register, { production: false, readyState });

      registerServiceWorker(env);
      load();

      expect(register, readyState).not.toHaveBeenCalled();
      expect(addEventListener, readyState).not.toHaveBeenCalled();
    }
  });

  test("registerServiceWorker_does_nothing_where_the_browser_has_no_service_workers", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { env, addEventListener, load } = envWith(null);

    expect(() => registerServiceWorker(env)).not.toThrow();
    load();

    expect(addEventListener).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled(); // no worker is not a failure
  });

  test("registerServiceWorker_does_nothing_where_looking_for_the_container_throws", () => {
    const { env, addEventListener } = envWith(null);
    const hostile = {
      ...env,
      navigator: {
        get serviceWorker(): never {
          throw new DOMException("The operation is insecure.", "SecurityError");
        },
      },
    };

    expect(() => registerServiceWorker(hostile)).not.toThrow();
    expect(addEventListener).not.toHaveBeenCalled();
  });

  test("registerServiceWorker_logs_a_registration_that_is_refused_as_a_warning_and_does_not_throw", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const refusal = new DOMException("The operation is insecure.", "SecurityError");
    const { env, load } = envWith(vi.fn<Register>(async () => Promise.reject(refusal)));
    registerServiceWorker(env);

    load();
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));

    expect(String(warn.mock.calls[0]?.[0])).toMatch(/service worker/i);
    expect(warn.mock.calls[0]).toContain(refusal);
  });

  test("registerServiceWorker_logs_a_register_that_throws_at_once_as_a_warning_too", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { env } = envWith(
      vi.fn<Register>(() => {
        throw new TypeError("Failed to register a ServiceWorker");
      }),
      { readyState: "complete" },
    );

    expect(() => registerServiceWorker(env)).not.toThrow();

    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
  });
});
