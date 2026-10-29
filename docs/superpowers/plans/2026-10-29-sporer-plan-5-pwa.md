# Sporer Plan 5 — PWA polish and the final performance pass

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the installed app start fast and fail gracefully, prove it on Safari's engine, and close v1:
- a service worker caches the app shell, so a start from the home screen loads the app's code from the phone, not the network;
- a start without a network shows the app's own error states with Retry, never a browser error page;
- a session that expired at the login in front of the app sends the owner to the login instead of leaving them on an error;
- a WebKit smoke project runs in CI (iOS Safari is the owner's browser), and CI caches the Playwright browsers;
- the first refresh and the first edit after a process start are as fast as the rest (P3-R26);
- every §8 target is measured once more on the final build, and the owner gets the checklist to sign v1 off on the iPhone.

**Architecture:**
- **The service worker is hand-written and small.** No Workbox, no plugin: one TypeScript entry built to `/sw.js` as a classic script, with the list of files to cache and a version injected at build time by a small Vite plugin of our own. The decisions it makes (which request it answers, from where, which caches to delete) live in a pure module with unit tests.
- **What it answers:**
  - **Navigations** (same origin, not `/api/…`): network first, so a new release and the login in front of the app are always seen. On a network error, or no answer within **3 s**, it serves the cached `index.html`. A successful answer refreshes the cached copy.
  - **The shell's files** (the build's hashed `/assets/…`, the icons, the manifest): cache first. They are precached on install.
  - **Everything else is not intercepted:** `/api/…`, other origins (map styles, tiles, fonts), and anything not in the list. API data is never cached (spec §7.4).
- **Updates.** A new `/sw.js` (the server already sends it `no-cache`) installs in the background, precaches the new files, takes over at once (`skipWaiting`, `clients.claim`), and deletes the caches of older versions. Since navigations go to the network first, the next start of the app runs the new release.
- **Signed out.** API requests are made with `redirect: "manual"`. An answer that is a redirect (`opaqueredirect`, which is what the forward-auth login in front of the app answers once its session has expired) reloads the page, so the navigation goes through the login. It reloads at most once a minute, so a login that keeps redirecting cannot loop.
- **CI.** The Playwright config gains a `webkit` project (an iPhone on WebKit) that runs the tests tagged `@smoke`. It is defined only where `PW_WEBKIT=1`, because the build container has no WebKit. CI caches `~/.cache/ms-playwright` by the Playwright version. A manual run of the workflow on a branch other than `main` runs the checks only and never builds or publishes an image, so a branch can be verified in CI before it is merged.
- **Start-up.** The API is published ReadyToRun, so a fresh process does not JIT the refresh, the recompute and the first requests. A read-only warm-up runs only if the measurements say ReadyToRun was not enough (Task 4).

**Tech Stack:** unchanged. No new dependencies on either side.

**Spec:** `docs/superpowers/specs/2026-10-23-sporer-web-app-design.md` (approved). Sections used:
- §7.4: the installable web app and the service worker; error handling;
- §7.5: the service worker's scope and the paths at `/`; releases;
- §8: the quality bar, all of it;
- §9: phone and desktop viewports; acceptance by the owner on their phone;
- §10, phase 7: PWA polish and a performance pass against §8.

Earlier decisions:
- `docs/superpowers/plans/2026-10-23-sporer-plan-1-rulings.md`
- `docs/superpowers/plans/2026-10-24-sporer-plan-2-rulings.md`
- `docs/superpowers/plans/2026-10-26-sporer-plan-3-rulings.md`
- `docs/superpowers/plans/2026-10-28-sporer-plan-4-rulings.md`

The earlier perf docs (`…-plan-1-perf.md` to `…-plan-4-perf.md`) hold the methods this plan repeats.

**Plan series.** Plans 1–4 are merged. This is Plan 5, the last of v1. It builds spec phase 7.

## Environment setup (once per container)

As in Plan 4:
- .NET 10 SDK;
- Docker for Testcontainers and the perf database (`nohup dockerd >/tmp/dockerd.log 2>&1 &` if `docker ps` fails);
- Node 22;
- Playwright's Chromium in `/opt/pw-browsers`. Never run `playwright install`. There is no WebKit here: the `webkit` project is verified in CI only.

No external host is reachable from tests.

## Global Constraints

- **Earlier constraints.** Every Plan 1–4 constraint still applies:
  - `locationLog` rows are never updated or deleted, and its schema is not changed.
  - Owner data is never rewritten by processing.
  - Ingest never waits on processing.
  - Web dependencies stay exactly as pinned; styling is CSS Modules plus custom properties.
  - TypeScript stays strict.
  - Every view has loading, empty and error states with Retry.
  - `GET /api/*` keeps the strong ETag and the 304. Writes accept only JSON.
  - No test makes an external request.
  - Never skip, disable or quarantine a test. Test output stays pristine.
  - Accessible names contain the visible text (P2-R46).
- **No migrations.**
- **The service worker:**
  - is `/sw.js`, scope `/`, registered with `updateViaCache: "none"`;
  - is registered only in a production build, after the page's `load` event, and only where `navigator.serviceWorker` exists;
  - never answers a request to `/api/…` or to another origin, and never stores an API answer;
  - never precaches `test-style.json` (it is for the tests) or itself;
  - names its caches `sporer-shell-<version>`, where the version is a hash of the precached files' names and of `index.html`, so a build with the same files has the same version;
  - is one classic script (no `import` or `export`), because Safari's support for module service workers is not something to depend on.
- **Navigation timeout:** **3 000 ms**, then the cached `index.html`.
- **Signed out:** reload at most once per **60 s** (the time of the last reload in `sessionStorage`). Only a redirect answer (`response.type === "opaqueredirect"`) counts. A network error is not a sign-out: it keeps the error with Retry.
- **The e2e suite runs with service workers blocked** (`serviceWorkers: "block"`), except the service worker's own spec, so that the API mocks see every request.
- **WebKit project:**
  - defined only when `PW_WEBKIT=1`;
  - runs only tests tagged `@smoke`;
  - the Chromium-only launch arguments (SwiftShader) move into the Chromium projects, since WebKit rejects them.
- **CI images.** The image is still built and published only from `main` and `v*.*.*` tags, and built without pushing for a pull request. A `workflow_dispatch` run on any other ref runs the `test` and `web` jobs only.
- **§8 targets** (verbatim from the spec): open the app (cold, installed) to the map visible ≤ 2 s; a past day after ‹ › ≤ 1 s; a month ≤ 2 s; a year ≤ 3 s; pan and zoom smooth on the iPhone; ingest p95 < 200 ms while processing runs; no unhandled error reaching a blank screen.

## Review Focus

1. **The service worker never serves stale or private data.**
   - No `/api/…` request is answered by it, in the code and in the e2e spec.
   - A navigation goes to the network first. The cached `index.html` is served only on a network error or after the timeout.
   - A redirect answer to a navigation (the login) is followed, never replaced by the cached shell.
2. **Updates reach the owner.**
   - A new build has a new version. The old caches are deleted when it activates.
   - An app whose code changed while it was open still works: a chunk that is gone shows the existing "unavailable, Retry" state, as it does today without a service worker.
3. **Signed out.** The reload happens once, and a login that keeps redirecting does not loop. A network error never reloads.
4. **CI.** WebKit runs the smoke set and nothing else. A cache hit still installs the browsers' system packages. A manual run on a branch never pushes an image.
5. **Numbers.** Every §8 row has a number from this pass, or says plainly why only the owner can measure it.

---

## File structure

```
web/src/sw/
    shellPolicy.ts                      create: what the worker answers and how; cache names; caches to delete (pure)
    shellPolicy.test.ts                 create
    sw.ts                               create: the worker (install, activate, fetch), on top of shellPolicy
    tsconfig.json                       create: WebWorker types for sw.ts
web/build/serviceWorker.ts              create: Vite plugin: builds sw.ts to /sw.js, injects the file list and version
web/src/app/registerServiceWorker.ts    create (+ .test.ts)
web/src/api/client.ts                   modify: redirect "manual"; signed out reloads (+ client.test.ts)
web/src/main.tsx                        modify: register the worker
web/vite.config.ts, web/tsconfig.json, web/package.json (typecheck script)
web/playwright.config.ts                modify: service workers blocked; webkit project; launch args per project
web/e2e/service-worker.spec.ts          create
web/e2e/*.spec.ts                       modify: tag the smoke set
.github/workflows/docker-publish.yml    modify: WebKit, browser cache, branch runs check only
docker/dockerfile                       modify: ReadyToRun publish
tools/perf/day-latency.sh               modify: the seeded generator of api-latency.sh
tools/perf/*                            create as needed: start-up timings, ingest during processing
README.md, docs/superpowers/plans/2026-10-29-sporer-plan-5-perf.md
```

---

### Task 1: The service worker: policy, worker and build

**Files:**
- Create: `web/src/sw/{shellPolicy.ts, shellPolicy.test.ts, sw.ts, tsconfig.json}`, `web/build/serviceWorker.ts`
- Modify: `web/vite.config.ts`, `web/tsconfig.json`, `web/package.json` (the `typecheck` script also checks `src/sw`)

- [ ] **Step 1: The policy, test first.** `shellPolicy.ts` exports pure functions with no worker globals:
  - `routeOf(request: { url: string; mode: string; method: string }, origin: string, shellFiles: ReadonlySet<string>)` → `"navigation" | "shell" | "pass"`.
    - `pass` for anything that is not `GET`, another origin, any path under `/api` (including `/api` itself), and a path not in `shellFiles`;
    - `navigation` for `mode === "navigate"` (same origin, not `/api`);
    - `shell` for a path in `shellFiles`. The query string is ignored when matching.
  - `cacheName(version)` → `sporer-shell-<version>`, and `cachesToDelete(names, current)` → every `sporer-shell-*` name except the current one. Caches with other names are left alone.
  - `NAVIGATION_TIMEOUT_MS = 3000`.
  - Tests cover each branch: `/api/day/2026-01-01` as a navigation is `pass`; `/api` is `pass`; `/apiary` is not; a tile URL on another origin is `pass`; `POST /` is `pass`; `/assets/index-abc.js?x=1` is `shell`; `/trips/2026-01-01` navigating is `navigation`.
- [ ] **Step 2: The worker** (`sw.ts`), on the policy:
  - `install`: open the version's cache and add every shell file and `/index.html`, fetched with `cache: "reload"`; then `skipWaiting()`.
  - `activate`: delete `cachesToDelete(...)`, then `clients.claim()`.
  - `fetch`:
    - `pass`: return without `respondWith`.
    - `shell`: the cache, else the network.
    - `navigation`: the network, raced against the timeout. A response that is `ok`, of type `basic` and `text/html` is put in the cache as `/index.html`. Any other response, a redirect included, is returned as it is. On a network error or the timeout, the cached `/index.html`; if there is none, the network's own answer or error.
  - The file list and version arrive as one injected constant (e.g. `self.__SHELL__ = { version, files }`), declared in `sw.ts`.
- [ ] **Step 3: The build.** A plugin in `web/build/serviceWorker.ts`, added in `vite.config.ts`:
  - collects the build's output files (chunks and assets, and the files copied from `public/`), minus `index.html` (it is cached apart, as `/index.html`, for navigations), `test-style.json`, `sw.js` and source maps;
  - computes the version from the sorted names and the content of `index.html`;
  - builds `src/sw/sw.ts` into one classic script with no `import` or `export` (for example a nested Vite library build in `iife` format, with the public Vite API only), injects the constant, and emits it as `sw.js` at the root of the output.

  `vite dev` neither builds nor serves it. The Dockerfile's `--outDir /web-dist` must also get it.
- [ ] **Step 4: Types.** `src/sw/tsconfig.json` uses `lib: ["ES2023", "WebWorker"]` and covers `sw.ts`. The app's `tsconfig.json` leaves `src/sw/sw.ts` out (the policy module stays in, for its tests). `npm run typecheck` checks both.
- [ ] **Step 5: Check the output.** After `npm run build`: `sw.js` exists at the root of the web root, starts with no `import`, names every hashed file under `/assets/`, and its version changes when one source file changes and stays when nothing does. Script that check as `scripts/check-sw.mjs`, run it, and record the precache size (raw and Brotli) in the report.
- [ ] **Step 6: Commit.** Message: `Add a service worker that caches the app shell`.

### Task 2: Registration, the signed-out reload and the service worker's e2e

**Files:**
- Create: `web/src/app/registerServiceWorker.ts` (+ `.test.ts`), `web/e2e/service-worker.spec.ts`
- Modify: `web/src/main.tsx`, `web/src/api/client.ts` (+ tests), `web/playwright.config.ts`

- [ ] **Step 1: Registration, test first.** `registerServiceWorker(env)` registers `/sw.js` with scope `/` and `updateViaCache: "none"` on the window's `load` event (or at once if the page has already loaded). It does nothing where `navigator.serviceWorker` is missing or outside a production build. A registration error is logged with `console.warn`, never thrown. Unit tests use a fake `navigator.serviceWorker`.
- [ ] **Step 2: Signed out, test first.** In `client.ts`, every request (reads and writes) uses `redirect: "manual"`.
  - A response of type `opaqueredirect` reloads the page, unless the last such reload was under 60 s ago (`sessionStorage`). Either way the call throws an `ApiError` that the views show as the error state with Retry, as today.
  - `sessionStorage` that throws (private mode) counts as "never reloaded".
  - Tests: one redirect reloads once; a second within 60 s does not; one after 60 s does; a network error never reloads; a 401, which the API never sends to the web app, is treated as any other error.
- [ ] **Step 3: Blocked in the suite.** `playwright.config.ts` sets `serviceWorkers: "block"` in `use`. The whole e2e suite still passes.
- [ ] **Step 4: The worker's e2e** (`service-worker.spec.ts`, `test.use({ serviceWorkers: "allow" })`, phone and desktop):
  - after the first load, the page is controlled by the worker (`navigator.serviceWorker.controller` is set after a reload);
  - with the context offline, a reload shows the app (the top bar and the view's error state with Retry), not a browser error page;
  - API requests are not answered by the worker: the API mock still sees them, and with the mock removed they fail rather than come back from a cache;
  - a navigation answered with a 302 to another path ends on that path, not on the cached shell;
  - a navigation that does not answer within 3 s shows the cached shell.
- [ ] **Step 5: Commit.** Message: `Register the service worker, and send a signed-out app to the login`.

### Task 3: CI: WebKit smoke project, browser cache, branch runs

**Files:**
- Modify: `web/playwright.config.ts`, the e2e specs of the smoke set (tags only), `.github/workflows/docker-publish.yml`, `README.md` (Development, CI)

- [ ] **Step 1: The smoke set.** Tag `@smoke` with Playwright's `tag` option, one or two tests per flow:
  - the app opens on today;
  - day navigation;
  - the month view;
  - opening a trip;
  - renaming a place;
  - removing and restoring points;
  - Settings;
  - the service worker (Task 2's first two cases).

  No test changes otherwise.
- [ ] **Step 2: The project.** In `playwright.config.ts`, when `process.env.PW_WEBKIT === "1"`, add the project `webkit`. It uses Playwright's `iPhone 14` descriptor (WebKit, touch, mobile) at the phone project's viewport, with `grep: /@smoke/`. Move `launchOptions.args` (SwiftShader) from the shared `use` into the `phone` and `desktop` projects. Locally (`PW_WEBKIT` unset), the projects and the run are unchanged.
- [ ] **Step 3: The workflow.**
  - **Browser cache.** Read the Playwright version from `web/package-lock.json`. Cache `~/.cache/ms-playwright` on `${{ runner.os }}-playwright-<version>`. On a miss, `npx playwright install --with-deps chromium webkit`; on a hit, `npx playwright install-deps chromium webkit` (the system packages are not in the cache).
  - **WebKit.** Run `npm run e2e` with `PW_WEBKIT=1`. Raise the job's timeout if the measured run needs it, with the time written beside it.
  - **Branch runs.** The `build` job gets `if: github.event_name != 'workflow_dispatch' || github.ref == 'refs/heads/main' || startsWith(github.ref, 'refs/tags/')`. Explain why in a comment.
- [ ] **Step 4: Verify in CI.** Push the branch and start a manual run of the workflow on it. All three of `test`, `web` (with WebKit) and the skipped `build` must come out as they should.
  - WebKit's WebGL on the runner is the unknown here. If MapLibre cannot draw there, record it, and keep only the smoke tests that do not wait for the map to draw. Every test stays as it is on Chromium.
  - Record the run, its times and the cache's effect (a second run hits the cache) in the report.
- [ ] **Step 5: Commit.** Message: `Run a WebKit smoke set in CI and cache the browsers`.

### Task 4: Start-up and perf tooling

**Files:**
- Modify: `docker/dockerfile`, `tools/perf/day-latency.sh`, and `src/Sporer.Api` only if Step 3 is needed
- Create: `tools/perf/` scripts as needed

- [ ] **Step 1: Measure first** on the 10.7 M-row history (the Plan 4 perf doc's method; it found the first edit after a start at 232–259 ms against a steady p95 under 50 ms). After each fresh start of the Release build, take five times each, with the steady-state p50 and p95 beside them:
  - the first worker refresh;
  - the first edit that recomputes (`PUT /api/settings`);
  - the first `GET /api/day`, `/api/range` (a month) and `/api/trips`.
- [ ] **Step 2: ReadyToRun.** Publish the API with `PublishReadyToRun=true` in the Dockerfile, for the architecture being built: buildx's `TARGETARCH`, `amd64` → `linux-x64`, `arm64` → `linux-arm64` (`linux-x64` when it is unset), restoring for the same runtime identifier. It stays framework-dependent on the same runtime image. Build the image here with Docker and start it against the perf database, to show it runs: CI's manual branch run (Task 3) does not build the image. Measure Step 1 again on a ReadyToRun publish, and record the image size before and after.
- [ ] **Step 3: Warm-up, only if needed.** Add one only if, after ReadyToRun, the first edit's recompute is over **300 ms**, or the first refresh is over twice the steady p95.
  - It is read-only: it loads the nights and runs home and trip detection without writing, once, in the background, after migrations.
  - It never delays ingest or the first requests.
  - A failure is logged and ignored.
  - Test it: it writes nothing, and a failure does not stop the app.

  If it is not needed, record the numbers that show it.
- [ ] **Step 4: `day-latency.sh`** draws its dates with the seeded generator of `api-latency.sh`. Share it in one file if that leaves `api-latency.sh`'s draws unchanged for a seed. Fix the comment that says the dates are random by seed.
- [ ] **Step 5: Commit.** Message: `Publish ReadyToRun and seed the day timings` (adjust if Step 3 adds a warm-up).

### Task 5: The final §8 pass, README and the owner's sign-off

**Files:**
- Create: `docs/superpowers/plans/2026-10-29-sporer-plan-5-perf.md`
- Modify: `README.md`, `web/perf/web-timing.spec.ts`, `web/scripts/perf/record.mjs`, `tools/perf/` as needed

- [ ] **Step 1: Server, on the final build** (10.7 M rows, Release, published ReadyToRun as the Dockerfile does):
  - `api-latency.sh` and `day-latency.sh` (now seeded);
  - the edit timings;
  - day points;
  - places search;
  - **ingest p95 while processing runs:** `POST /api/overland` batches during a backfill. Target: p95 < 200 ms.
- [ ] **Step 2: Web, phone project at 4× CPU, with a network like the owner's VPN:** 60 ms round trip, 20 Mbit/s down, 5 up, through CDP. Use the recorded API answers, as Plans 2–4 did.
  - **Open the app, cold and installed** (the perf config blocks service workers through the e2e config's `use`; this scenario allows them) to the map visible (the map's first `idle` with the recorded style; the panel's rows too). Two cases:
    - the first visit, with no worker;
    - the installed case: the worker active and its cache filled, a new page, the HTTP memory cache gone.

    Target: ≤ 2 s.
  - **Day after ‹ ›** (cold and prefetched), **month**, **year:** ≤ 1 / 2 / 3 s.
  - **Edit mode on the heaviest day** (Plan 4's scenario, measured again because the point halo became a layer of its own after it was timed, P4-R45): ≤ 2 s.
  - **Pan and zoom:** frame times during a scripted pan and zoom on the Year view with routes. Report the p95 frame time and the frames over 50 ms. This is information only: SwiftShader draws on the processor, far slower than the iPhone's GPU, and the verdict is the owner's.
  - The bundle and the precache size.
- [ ] **Step 3: Fix misses,** with a re-measurement, and never by changing results.
- [ ] **Step 4: The perf doc.** One §8 table, one row per target, with this pass's numbers and verdicts, then the method, the caveats and "Repeat it". Point to the earlier docs for history rather than repeat them.
- [ ] **Step 5: README.**
  - **"Installing on the iPhone":** add to the home screen; what the worker caches and what it never does (API data); what a start without a network shows; how a release reaches the installed app (the next start after the server updates; an app left open runs on until it is closed); and what to do if it ever seems stuck (close the app from the app switcher and open it again; as a last resort, Settings → Safari → Advanced → Website Data → remove the site).
  - **Behind the login:** an expired session sends the app to the login on its next request.
  - **CI:** the WebKit smoke set, and how to verify a branch with a manual run.
  - **The owner's §8 sign-off:** one line per §8 row: what to do on the phone, what to look at, and the target. Plus the detection-quality items from Plans 3 and 4 that are only signed off on real data.
- [ ] **Step 6: Commit.** Message: `Record the final performance pass and the owner's sign-off`.

---

## Out of scope (later, spec §11)

- Offline viewing of data loaded before. The worker caches the shell only.
- Train and transit detection, photos and notes, an all-time "everywhere I've been" view.
- An in-app "new version" prompt.
- Telling an applied trip date from a stored one (Plan 4, Task 9, parked by P4-R46): it needs the server to report both, and is reachable only with two devices editing one trip at once.
