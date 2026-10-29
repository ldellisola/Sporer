import { describe, expect, test } from "vitest";
import { NAVIGATION_TIMEOUT_MS, cacheName, cachesToDelete, isShellDocument, routeOf } from "./shellPolicy";

const ORIGIN = "https://sporer.example";
const SHELL = new Set(["/assets/index-abc.js", "/assets/index-abc.css", "/icons/icon-192.png", "/manifest.webmanifest"]);

function route(path: string, init: { mode?: string; method?: string; origin?: string } = {}) {
  return routeOf({ url: `${init.origin ?? ORIGIN}${path}`, mode: init.mode ?? "cors", method: init.method ?? "GET" }, ORIGIN, SHELL);
}

describe("routeOf", () => {
  test("routeOf_passes_the_api_even_as_a_navigation", () => {
    expect(route("/api/day/2026-01-01", { mode: "navigate" })).toBe("pass");
    expect(route("/api/day/2026-01-01")).toBe("pass");
    expect(route("/api", { mode: "navigate" })).toBe("pass");
    expect(route("/api?x=1", { mode: "navigate" })).toBe("pass");
    expect(route("/api/")).toBe("pass");
  });

  test("routeOf_matches_the_api_prefix_by_segment_and_not_by_case_or_encoding", () => {
    expect(route("/apiary", { mode: "navigate" })).toBe("navigation");
    expect(route("/api-docs", { mode: "navigate" })).toBe("navigation");
    // The server routes /API and /%61pi to the API as well, so the worker must not take them for pages.
    expect(route("/API/day/2026-01-01", { mode: "navigate" })).toBe("pass");
    expect(route("/Api", { mode: "navigate" })).toBe("pass");
    expect(route("/%61pi/day/2026-01-01", { mode: "navigate" })).toBe("pass");
    expect(route("/%E0%A4%A", { mode: "navigate" })).toBe("navigation"); // not decodable: nothing to tell it from a page
  });

  test("routeOf_passes_another_origin", () => {
    expect(route("/12/3/4.pbf", { origin: "https://tiles.example" })).toBe("pass");
    expect(route("/assets/index-abc.js", { origin: "https://cdn.example" })).toBe("pass");
    expect(route("/", { origin: "https://cdn.example", mode: "navigate" })).toBe("pass");
    expect(route("/", { origin: "http://sporer.example", mode: "navigate" })).toBe("pass"); // another scheme is another origin
  });

  test("routeOf_passes_whatever_is_not_a_get", () => {
    expect(route("/", { method: "POST", mode: "navigate" })).toBe("pass");
    expect(route("/", { method: "POST" })).toBe("pass");
    expect(route("/assets/index-abc.js", { method: "HEAD" })).toBe("pass");
    expect(route("/api/places/1", { method: "PUT" })).toBe("pass");
  });

  test("routeOf_serves_a_file_of_the_shell_from_it_whatever_the_query", () => {
    expect(route("/assets/index-abc.js?x=1")).toBe("shell");
    expect(route("/assets/index-abc.css")).toBe("shell");
    expect(route("/icons/icon-192.png#top")).toBe("shell");
    expect(route("/manifest.webmanifest")).toBe("shell");
  });

  test("routeOf_passes_a_file_that_is_not_in_the_shell", () => {
    expect(route("/test-style.json")).toBe("pass");
    expect(route("/sw.js")).toBe("pass");
    expect(route("/assets/other-def.js")).toBe("pass");
    expect(route("/index.html")).toBe("pass"); // the page is kept apart, for navigations
    expect(route("/ASSETS/index-abc.js")).toBe("pass"); // a path is matched exactly
  });

  test("routeOf_answers_a_navigation_to_any_page_of_the_app_with_the_network_first_policy", () => {
    expect(route("/trips/2026-01-01", { mode: "navigate" })).toBe("navigation");
    expect(route("/", { mode: "navigate" })).toBe("navigation");
    expect(route("/range/2026-10-01..2026-10-22", { mode: "navigate" })).toBe("navigation");
    expect(route("/day/2026-10-22?x=1", { mode: "navigate" })).toBe("navigation");
  });

  test("routeOf_passes_a_request_that_is_not_a_navigation_and_not_in_the_shell", () => {
    expect(route("/trips/2026-01-01")).toBe("pass");
    expect(route("/", { mode: "no-cors" })).toBe("pass");
  });

  test("routeOf_takes_a_navigation_to_a_file_of_the_shell_for_a_navigation", () => {
    // Opening a file's address in the tab is a navigation, and the network answers it first like any other page.
    expect(route("/manifest.webmanifest", { mode: "navigate" })).toBe("navigation");
  });
});

describe("cacheName and cachesToDelete", () => {
  test("cacheName_carries_the_version", () => {
    expect(cacheName("0123456789abcdef")).toBe("sporer-shell-0123456789abcdef");
  });

  test("cachesToDelete_deletes_every_other_shell_cache", () => {
    const current = cacheName("new");

    expect(cachesToDelete(["sporer-shell-old", current, "sporer-shell-older"], current)).toEqual(["sporer-shell-old", "sporer-shell-older"]);
    expect(cachesToDelete([current], current)).toEqual([]);
    expect(cachesToDelete([], current)).toEqual([]);
  });

  test("cachesToDelete_leaves_caches_with_other_names_alone", () => {
    const current = cacheName("new");

    expect(cachesToDelete(["workbox-precache", "sporer-shell", "sporer-tiles-1", "other-sporer-shell-1", current, "sporer-shell-old"], current)).toEqual([
      "sporer-shell-old",
    ]);
  });
});

describe("isShellDocument", () => {
  function response(init: { ok?: boolean; type?: string; contentType?: string | null }) {
    const headers = new Map<string, string>();
    if (init.contentType !== null) headers.set("content-type", init.contentType ?? "text/html");
    return { ok: init.ok ?? true, type: init.type ?? "basic", headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null } };
  }

  test("isShellDocument_accepts_a_page_of_this_origin", () => {
    expect(isShellDocument(response({}))).toBe(true);
    expect(isShellDocument(response({ contentType: "text/html; charset=utf-8" }))).toBe(true);
    expect(isShellDocument(response({ contentType: "Text/HTML" }))).toBe(true);
  });

  test("isShellDocument_refuses_what_is_not_the_page", () => {
    expect(isShellDocument(response({ ok: false }))).toBe(false); // an error page
    expect(isShellDocument(response({ ok: false, type: "opaqueredirect" }))).toBe(false); // the login's redirect
    expect(isShellDocument(response({ type: "cors" }))).toBe(false);
    expect(isShellDocument(response({ type: "opaque" }))).toBe(false);
    expect(isShellDocument(response({ contentType: "application/json" }))).toBe(false);
    expect(isShellDocument(response({ contentType: null }))).toBe(false);
  });
});

test("NAVIGATION_TIMEOUT_MS_is_three_seconds", () => {
  expect(NAVIGATION_TIMEOUT_MS).toBe(3000);
});
