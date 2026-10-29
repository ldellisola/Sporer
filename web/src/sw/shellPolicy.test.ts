import { describe, expect, test } from "vitest";
import { NAVIGATION_TIMEOUT_MS, cacheName, cachesToDelete, installCacheMode, isAppPage, isProxyError, isShellDocument, routeOf, shellPaths } from "./shellPolicy";

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

  test("routeOf_matches_a_file_whose_name_needs_encoding", () => {
    // The set is of what a request's path is (percent-encoded), built from the names the build gives (shellPaths).
    const shell = shellPaths(["/icons/my icon.png", "/assets/a+b.js", "/assets/ü.js"], ORIGIN);
    const routed = (path: string) => routeOf({ url: `${ORIGIN}${path}`, mode: "cors", method: "GET" }, ORIGIN, shell);

    expect(routed("/icons/my%20icon.png")).toBe("shell");
    expect(routed("/icons/my icon.png")).toBe("shell"); // the URL parser encodes the space itself
    expect(routed("/assets/a+b.js")).toBe("shell");
    expect(routed("/assets/%C3%BC.js")).toBe("shell");
    expect(routed("/icons/my-icon.png")).toBe("pass");
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

  test("routeOf_passes_a_navigation_to_a_file_because_the_server_does_not_answer_it_with_the_page", () => {
    // The server's fallback to index.html is for a path whose last segment has no extension (Program.cs): a file is the file, or a 404. Showing the
    // cached page for one would put the app where the file should be, and a worker's own address is one of them.
    expect(route("/sw.js", { mode: "navigate" })).toBe("pass");
    expect(route("/icons/icon.svg", { mode: "navigate" })).toBe("pass");
    expect(route("/manifest.webmanifest", { mode: "navigate" })).toBe("pass");
    expect(route("/assets/index-abc.js?x=1", { mode: "navigate" })).toBe("pass");
    expect(route("/index.html", { mode: "navigate" })).toBe("pass");
    expect(route("/sw%2Ejs", { mode: "navigate" })).toBe("pass"); // the server decodes the path first
    expect(route("/missing.txt#top", { mode: "navigate" })).toBe("pass");
  });

  test("routeOf_takes_a_navigation_to_a_path_with_a_dot_that_is_no_extension_for_a_page", () => {
    // The server's rule is a dot and then letters or digits to the end of the path: a range's `..` is not one.
    expect(route("/range/2026-10-01..2026-10-22", { mode: "navigate" })).toBe("navigation");
    expect(route("/day/2026-01-01", { mode: "navigate" })).toBe("navigation");
    expect(route("/trips", { mode: "navigate" })).toBe("navigation");
    expect(route("/", { mode: "navigate" })).toBe("navigation");
    expect(route("/places/a.b/", { mode: "navigate" })).toBe("navigation"); // a dot that does not end the path
    expect(route("/places/ends-with-a-dot.", { mode: "navigate" })).toBe("navigation");
  });

  test("routeOf_passes_the_login_proxys_callback_under_outpost_goauthentik_io", () => {
    // Authentik's forward auth sends the browser here to finish a sign-in; the worker answering with the cached page would stop it.
    expect(route("/outpost.goauthentik.io/callback?x=1", { mode: "navigate" })).toBe("pass");
    expect(route("/outpost.goauthentik.io/start", { mode: "navigate" })).toBe("pass");
    expect(route("/outpost.goauthentik.io/auth/nginx", { mode: "navigate" })).toBe("pass");
    expect(route("/Outpost.goauthentik.io/callback", { mode: "navigate" })).toBe("pass");
    expect(route("/outpost%2Egoauthentik.io/callback", { mode: "navigate" })).toBe("pass");
    expect(route("/outpost.goauthentik.io/callback")).toBe("pass");
    expect(route("/outpost.goauthentik.io", { mode: "navigate" })).toBe("pass"); // a name with an extension, in any case
    expect(route("/outpost.goauthentik.io-not/x", { mode: "navigate" })).toBe("navigation"); // under it is by segment
  });
});

describe("isProxyError", () => {
  test("isProxyError_is_true_for_the_answers_of_a_proxy_that_cannot_reach_the_app", () => {
    expect(isProxyError({ status: 502 })).toBe(true);
    expect(isProxyError({ status: 503 })).toBe(true);
    expect(isProxyError({ status: 504 })).toBe(true);
  });

  test("isProxyError_is_false_for_every_other_answer_which_is_given_as_it_is", () => {
    for (const status of [200, 204, 301, 302, 304, 307, 308, 400, 401, 403, 404, 429, 500, 501, 505]) expect(isProxyError({ status }), String(status)).toBe(false);
    expect(isProxyError({ status: 0 })).toBe(false); // an opaque redirect: a navigation is made with redirect "manual", and the login's answer is its own
  });
});

describe("installCacheMode", () => {
  test("installCacheMode_asks_the_server_for_the_page_and_the_files_outside_assets", () => {
    // These keep their names when they change, so what the browser's HTTP cache has of them may be of another build.
    expect(installCacheMode("/index.html")).toBe("reload");
    expect(installCacheMode("/manifest.webmanifest")).toBe("reload");
    expect(installCacheMode("/icons/icon-192.png")).toBe("reload");
    expect(installCacheMode("/icons/icon.svg")).toBe("reload");
    expect(installCacheMode("/assetsfile.js")).toBe("reload"); // /assets is a directory
  });

  test("installCacheMode_lets_the_hashed_files_of_assets_come_from_the_browsers_cache", () => {
    // Their names are their content: whatever the cache has under one is that file, never a mix of two builds.
    expect(installCacheMode("/assets/index-BfJmJxUU.js")).toBe("default");
    expect(installCacheMode("/assets/index-15BW97du.css")).toBe("default");
    expect(installCacheMode("/assets/maplibre-Cy9aRMf-.js")).toBe("default");
  });
});

describe("shellPaths", () => {
  test("shellPaths_gives_the_paths_as_a_request_has_them", () => {
    expect([...shellPaths(["/assets/index-abc.js", "/icons/my icon.png", "/manifest.webmanifest"], ORIGIN)]).toEqual([
      "/assets/index-abc.js",
      "/icons/my%20icon.png",
      "/manifest.webmanifest",
    ]);
    expect(shellPaths([], ORIGIN).size).toBe(0);
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
  function response(init: { ok?: boolean; type?: string; redirected?: boolean; contentType?: string | null }) {
    const headers = new Map<string, string>();
    if (init.contentType !== null) headers.set("content-type", init.contentType ?? "text/html");
    return {
      ok: init.ok ?? true,
      type: init.type ?? "basic",
      redirected: init.redirected ?? false,
      headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
    };
  }

  test("isShellDocument_accepts_a_page_of_this_origin", () => {
    expect(isShellDocument(response({}))).toBe(true);
    expect(isShellDocument(response({ contentType: "text/html; charset=utf-8" }))).toBe(true);
    expect(isShellDocument(response({ contentType: "Text/HTML" }))).toBe(true);
  });

  test("isShellDocument_refuses_what_is_not_the_page", () => {
    expect(isShellDocument(response({ ok: false }))).toBe(false); // an error page
    expect(isShellDocument(response({ ok: false, type: "opaqueredirect" }))).toBe(false); // the login's redirect
    expect(isShellDocument(response({ redirected: true }))).toBe(false); // what a redirect led to, a sign-in page for one
    expect(isShellDocument(response({ type: "cors" }))).toBe(false);
    expect(isShellDocument(response({ type: "opaque" }))).toBe(false);
    expect(isShellDocument(response({ contentType: "application/json" }))).toBe(false);
    expect(isShellDocument(response({ contentType: null }))).toBe(false);
  });
});

describe("isAppPage", () => {
  const FILES = new Set(["/assets/index-BfJmJxUU.js", "/assets/index-15BW97du.css", "/assets/maplibre-Cy9aRMf-.js", "/icons/icon.svg", "/manifest.webmanifest"]);

  // The page as the build writes it (the shape of web/index.html after `vite build`).
  const BUILT = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <link rel="icon" href="/icons/icon.svg" type="image/svg+xml" />
    <link rel="manifest" href="/manifest.webmanifest" />
    <title>Sporer</title>
    <script type="module" crossorigin src="/assets/index-BfJmJxUU.js"></script>
    <link rel="stylesheet" crossorigin href="/assets/index-15BW97du.css">
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>
`;

  test("isAppPage_accepts_the_page_as_the_build_writes_it", () => {
    expect(isAppPage(BUILT, FILES)).toBe(true);
  });

  test("isAppPage_refuses_a_page_without_the_root", () => {
    expect(isAppPage("<!doctype html><title>Sign in</title><form></form>", FILES)).toBe(false);
    expect(isAppPage(BUILT.replace('id="root"', 'id="app"'), FILES)).toBe(false);
    expect(isAppPage("", FILES)).toBe(false);
  });

  test("isAppPage_refuses_a_page_that_names_a_file_of_another_build", () => {
    expect(isAppPage(BUILT.replace("index-BfJmJxUU.js", "index-OTHER123.js"), FILES)).toBe(false);
    expect(isAppPage(BUILT.replace("index-15BW97du.css", "index-OTHER123.css"), FILES)).toBe(false);
    expect(isAppPage(BUILT.replace("</head>", '<link rel="modulepreload" href="/assets/extra-abc.js"></head>'), FILES)).toBe(false);
  });

  test("isAppPage_accepts_a_page_with_no_files_under_assets_but_the_root", () => {
    expect(isAppPage('<div id="root"></div>', new Set())).toBe(true);
    expect(isAppPage('<link rel="icon" href="/somewhere/else.svg"><div id="root"></div>', FILES)).toBe(true); // only /assets/ is the build's
  });

  test("isAppPage_reads_every_way_an_attribute_is_quoted", () => {
    const page = (attributes: string) => `<script ${attributes}></script><div id='root'></div>`;

    expect(isAppPage(page(`src="/assets/index-BfJmJxUU.js"`), FILES)).toBe(true);
    expect(isAppPage(page(`src='/assets/index-BfJmJxUU.js'`), FILES)).toBe(true);
    expect(isAppPage(page(`src=/assets/index-BfJmJxUU.js`), FILES)).toBe(true);
    expect(isAppPage(page(`SRC = "/assets/index-BfJmJxUU.js"`), FILES)).toBe(true);
    expect(isAppPage(page(`src="/assets/index-OTHER123.js"`), FILES)).toBe(false);
    expect(isAppPage(page(`src='/assets/index-OTHER123.js'`), FILES)).toBe(false);
    expect(isAppPage(page(`src=/assets/index-OTHER123.js`), FILES)).toBe(false);
    expect(isAppPage(`<div id="root"></div><link href='/assets/index-OTHER123.css'>`, FILES)).toBe(false);
  });

  test("isAppPage_reads_an_attribute_at_the_very_start_of_the_page_and_ones_with_nothing_between", () => {
    // Nothing before `src` at the start of the string, and a quote that closes one attribute is what comes before the next one's name.
    expect(isAppPage('src="/assets/index-OTHER123.js"><div id="root"></div>', FILES)).toBe(false);
    expect(isAppPage('href=/assets/index-OTHER123.css><div id="root"></div>', FILES)).toBe(false);
    expect(isAppPage('src="/assets/index-BfJmJxUU.js"><div id="root"></div>', FILES)).toBe(true);
    expect(isAppPage('<script src="/assets/index-BfJmJxUU.js"src="/assets/index-OTHER123.js"></script><div id="root"></div>', FILES)).toBe(false);
    expect(isAppPage(`<link href='/assets/index-BfJmJxUU.js'href='/assets/index-OTHER123.js'><div id="root"></div>`, FILES)).toBe(false);
  });

  test("isAppPage_takes_only_the_attributes_src_and_href_and_the_id_of_a_div_for_what_they_are", () => {
    // A name that merely ends in src, href or id is another attribute, and what follows `>` is no attribute of the div.
    expect(isAppPage('<img data-src="/assets/index-OTHER123.js"><div id="root"></div>', FILES)).toBe(true);
    expect(isAppPage('<img xsrc="/assets/index-OTHER123.js"><div id="root"></div>', FILES)).toBe(true);
    expect(isAppPage('<a data-href=/assets/index-OTHER123.js></a><div id="root"></div>', FILES)).toBe(true);
    expect(isAppPage('<div data-id="root"></div>', FILES)).toBe(false);
    expect(isAppPage('<div class="x">id=root</div>', FILES)).toBe(false);
    expect(isAppPage('<div class="x" id="root"></div>', FILES)).toBe(true);
    expect(isAppPage('<div\nid=root></div>', FILES)).toBe(true);
  });

  test("isAppPage_ignores_a_query_and_reads_an_encoded_name", () => {
    const files = new Set(["/assets/a%20b.js"]);

    expect(isAppPage('<script src="/assets/a%20b.js?v=1"></script><div id="root"></div>', files)).toBe(true);
    expect(isAppPage('<script src="/assets/a b.js"></script><div id="root"></div>', files)).toBe(true);
    expect(isAppPage('<script src="/assets/a%20b.js?v=1"></script><div id="root"></div>', new Set())).toBe(false);
  });
});

test("NAVIGATION_TIMEOUT_MS_is_three_seconds", () => {
  expect(NAVIGATION_TIMEOUT_MS).toBe(3000);
});
