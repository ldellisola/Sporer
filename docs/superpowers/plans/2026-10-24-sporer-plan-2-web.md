# Sporer Plan 2 — Web app: map views on top of the timeline server

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the map-first web app the owner adds to their iPhone home screen: Day / Week / Month / Year / Range views, heat layer and place detail, served by the existing API, plus the one robustness fix that must land before the first release.

**Architecture:** The .NET API (Plan 1) gains three read endpoints (range, heat, place), a config endpoint, conditional-GET caching and correct SPA hosting. A new React + TypeScript app in `web/` (Vite) talks only to `/api`, renders with MapLibre GL directly (no React map wrapper), keeps view state in the URL through a tiny in-house router, and is built into the API's `wwwroot` so one Docker image serves both.

**Tech Stack:** Server as Plan 1 (.NET 10, FastEndpoints 8.3, Dapper, Npgsql 10, TimescaleDB). Web: Node 22, Vite 8.3.5, `@vitejs/plugin-react` 6.1.2, React 19.3.1, TypeScript 5.9.3 (strict), `maplibre-gl` 6.15.0, `@tanstack/react-query` 5.104.5, `date-fns` 4.4.0. Web tests: Vitest 5.0.5 + jsdom 30.1.3 + `@testing-library/react` 16.3.3 + `@testing-library/jest-dom` 7.0.1; end-to-end: `@playwright/test` 1.56.1 (matches the Chromium preinstalled at `/opt/pw-browsers`).

**Spec:** `docs/superpowers/specs/2026-10-23-sporer-web-app-design.md` (approved) — §4 (what the owner sees), §7.3–7.4, §8. Mockups: `docs/superpowers/specs/assets/2026-10-23-map-views-mockup.html` (views 1, 2A, 2B-heat-look-only, 4). Plan 1's open findings and rulings: `docs/superpowers/plans/2026-10-23-sporer-plan-1-rulings.md`.

**Plan series.** Plan 1 (server) is merged. This is Plan 2. Plan 3 adds home periods and trips (trips list, trip view, house icon on home stops). Plan 4 adds editing (rename/merge places, remove/restore points, trip edits), Settings, the service worker and the final performance pass.

## Environment setup (once per container)

- .NET 10 SDK: `apt-get update && apt-get install -y dotnet-sdk-10.0` if `dotnet --version` is not `10.0.x`.
- Docker daemon for Testcontainers: if `docker ps` fails, `nohup dockerd >/tmp/dockerd.log 2>&1 &` and wait until `docker ps` succeeds.
- Node 22 and npm are preinstalled. Playwright browsers live in `/opt/pw-browsers` (`PLAYWRIGHT_BROWSERS_PATH` is set); never run `playwright install` locally.
- The container cannot reach OpenFreeMap tiles or other map hosts; every web test uses the local blank style (Task 6) and mocked API responses.

## Global Constraints

- Every Plan 1 constraint still applies (`docs/superpowers/plans/2026-10-23-sporer-plan-1-server.md`, "Global Constraints") — above all: existing `locationLog` rows are never updated or deleted, the app only INSERTs/SELECTs it, and ingest never waits on processing.
- Web dependencies are exactly those in Tech Stack (versions pinned exactly in `package.json`, lockfile committed). No router, UI-kit, CSS framework, state library or React map wrapper. Styling is CSS Modules plus CSS custom properties.
- TypeScript `strict: true`; `npm run typecheck` (`tsc --noEmit`) is clean.
- UI copy is English. Units metric; 24-hour clock; weeks start Monday.
- Times shown to the owner use the segment's own IANA zone via `Intl.DateTimeFormat(..., { timeZone })`. Dates in URLs and API calls are plain `YYYY-MM-DD` (no zone).
- Mode colours (mockups): walk `#34C759`, cycle `#30B0C7`, drive `#007AFF`, flight `#FF9500` drawn dashed; stop pins `#FF375F`.
- Light/dark follow `prefers-color-scheme`; the map style switches with it.
- Layout: viewport width ≥ 900 px → fixed left sidebar 320 px wide; narrower → bottom sheet with three snap points (peek 96 px, half 50 % of viewport height, full = viewport height − 120 px).
- URL routes (the only view state): `/day/YYYY-MM-DD`, `/week/YYYY-MM-DD` (Monday), `/month/YYYY-MM`, `/year/YYYY`, `/range/YYYY-MM-DD..YYYY-MM-DD`, `/place/{id}`; `/` and unknown paths redirect (replace) to today's day in the browser's zone.
- Every view has loading, empty and error states; an error shows a retry and never leaves a blank screen; previously shown data stays visible while a refetch is in flight.
- `localStorage` reads and writes are wrapped in `try/catch`; the app works without storage.
- OpenStreetMap attribution stays visible on the map.
- API: GET `/api/*` JSON responses carry a strong `ETag` and `Cache-Control: no-cache`, and answer `304` to a matching `If-None-Match`. Range and heat requests accept at most 400 days (inclusive) — otherwise 400.
- No test makes an external network request.
- Never skip, disable or quarantine a test. Test output stays pristine (no React act() warnings, no console errors in e2e).

## Review Focus

1. **A pending or partly processed period** — the day/range JSON says `"state": "pending"` while the backfill runs or today is being reprocessed: the UI shows what is there, a small "Updating…" note, refetches every 30 s while pending, and never blocks or blanks. (Task 9 `DayPanel_shows_segments_and_updating_note_while_pending`; Task 10 `RangePanel_shows_updating_note_while_pending`.)
2. **Times across zones and DST** — a day with an Oslo→New York flight shows each stop's times in its own zone, and the 25-hour DST day formats correctly. (Task 6 `formatTime_uses_segment_zone`, `formatTime_on_dst_end_day`.)
3. **API failure mid-navigation** — a 500 or a dropped connection while stepping days shows an error with Retry, keeps the previous day's map/list visible until new data arrives, and Retry recovers. (Task 8 e2e `error_then_retry_recovers`.)
4. **Map style cannot load** (OpenFreeMap down or blocked) — the timeline panel still works, a non-blocking "Map unavailable" note appears, and nothing throws. (Task 7 `MapView_reports_style_failure_without_throwing`.)
5. **A year of routes** — the year payload and rendering stay within budget (payload ≤ 1.5 MB gzip-uncompressed JSON, ≤ 60 000 vertices) and the map stays interactive. (Task 14 measurements; Task 3 `Range_year_respects_vertex_budget`.)

---

## File structure

```
src/Sporer.Api/
    Program.cs                                   modify: forwarded headers, compression, ETag middleware, SPA fallback
    Configuration/MapOptions.cs                  create — StyleLight, StyleDark
    Http/ConditionalGetMiddleware.cs             create — ETag / 304 for GET /api/*
    Database/Migrations/0004_backfill_attempts.sql create — processing_state.backfill_chunk_attempts
    Features/Timeline/{TimelineWorker,ProcessingQueue,SegmentStore,TimelineProcessor}.cs   modify (Task 1)
    Features/Config/GetConfigEndpoint.cs         create
    Features/Range/{GetRangeEndpoint,RangeResponse,RangeStore,DateRange}.cs  create
    Features/Heat/{GetHeatEndpoint,HeatResponse}.cs                    create (query in RangeStore)
    Features/Places/{GetPlaceEndpoint,PlaceResponse}.cs                create (query in PlaceStore)
tests/Sporer.Api.Tests/                          new test classes per task
web/
    package.json, package-lock.json, tsconfig.json, vite.config.ts, vitest.config.ts, playwright.config.ts, index.html
    public/manifest.webmanifest, public/icons/*, public/test-style.json
    src/main.tsx
    src/app/{App.tsx, App.module.css, router.ts, useMediaQuery.ts, useStoredFlag.ts}
    src/api/{types.ts, client.ts, queries.ts}
    src/time/{dates.ts, format.ts}
    src/map/{MapView.tsx, style.ts, layers.ts, bounds.ts}
    src/sheet/{BottomSheet.tsx, BottomSheet.module.css, Sidebar.tsx}
    src/views/{TopBar.tsx, DayPanel.tsx, RangePanel.tsx, PlacePanel.tsx, StatusBanner.tsx, States.tsx} (+ .module.css)
    src/styles/{tokens.css, global.css}
    e2e/{fixtures/*.json, mockApi.ts, *.spec.ts}
docker/dockerfile                                modify: Node build stage
.github/workflows/docker-publish.yml             modify: web job
README.md                                        modify: web app, development, home screen
```

---

### Task 1: Failure isolation from the database (Plan 1 findings N-1…N-4)

Plan 1's final review (see the rulings file, "Open before the first release") showed that the in-memory anchor floor does not isolate a failing stretch when it is the last backfill chunk, when the next chunk stores no stay, or after a restart; that a set-aside retry can leave a seam; that a version reset leaves duplicate set-aside rows; and that a failing live range freezes later live data. The reviewer's probe tests are kept at `docs/superpowers/plans/assets/2026-10-24-review-probe-tests.cs.txt` — read them; turn the relevant ones into real tests.

**Files:** Modify `TimelineWorker.cs`, `ProcessingQueue.cs`, `SegmentStore.cs`, `TimelineProcessor.cs`; Create `Database/Migrations/0004_backfill_attempts.sql`; Test `tests/Sporer.Api.Tests/FailureIsolationTests.cs`.

**Interfaces:**
- `const int SetAsideAfterAttempts = 3` (in `ProcessingQueue`). A `dirty_range` row with `attempts >= SetAsideAfterAttempts` is **set aside**.
- `SegmentStore.FindAnchorsAsync(from, to, ct)` — the `floorUtc` parameter is removed. Rule: `T0` = start of the last stored stay before `from` (as today), then raised to the largest `to_utc` of any set-aside row with `to_utc > T0 AND to_utc <= from` (never above `from`). A set-aside row being retried never floors itself (its `to_utc > from`). The in-memory `_anchorFloor` in `TimelineWorker` is deleted.
- `ITimelineProcessor.ReprocessAsync(from, to, ct)` — the `anchorFloorUtc` parameter is removed.
- Dirty ranges: when a dirty range fails and its new `attempts` reaches `SetAsideAfterAttempts`, it simply stays in the table (it already does); the floor rule above now applies to it, so later ranges stop reaching back into it.
- Backfill chunk set-aside (N-2): the row inserted for a set-aside chunk covers `[chunkFrom, min(chunkEnd + BackfillChunkDays, backfill_to)]`, with `attempts = 3`.
- Crash-type failures: migration `0004_backfill_attempts.sql` adds `processing_state.backfill_chunk_attempts int NOT NULL DEFAULT 0` (`ALTER TABLE processing_state ADD COLUMN IF NOT EXISTS …` — our own table). The worker increments it (persisted) **before** running a chunk and resets it to 0 after success; when it is already ≥ 3 before running, the chunk is set aside without running. This replaces the in-memory failure counter for chunks, so a process killed mid-chunk (OOM) still converges.
- `RestartBackfillAsync` (version change, R18) also deletes set-aside rows (N-3) and resets `backfill_chunk_attempts`.

- [ ] **Step 1: Write the failing tests** in `FailureIsolationTests.cs` (collection `"db"`, real `TimelineProcessor` wrapped by a stub that throws when its loaded window contains a "poison" time, as in the probe):

```csharp
[Fact] public async Task Failing_last_chunk_does_not_block_live_ranges()     // 3 weeks, poison in week 3; finish backfill; post a live point on day 22 → after debounce it is processed (stays exist on day 22)
[Fact] public async Task Failing_middle_chunk_followed_by_stayless_week_is_isolated() // week 2 poison, week 3 phone off (no stays) → week 4 processed, only one set-aside row
[Fact] public async Task Restart_between_set_aside_and_next_chunk_keeps_isolation()   // new ApiFactory (fresh worker) after the set-aside → next chunk not set aside
[Fact] public async Task Failing_live_range_does_not_freeze_later_live_ranges()       // a live range fails 3 times → later live ranges are processed
[Fact] public async Task Set_aside_retry_leaves_no_seam()                             // reviewer probe N-2: 1-day chunks, boundary inside a stay; fail 3×, then succeed → rows equal a single full run (ignoring ids)
[Fact] public async Task Version_reset_removes_set_aside_rows()                       // set-aside row exists; change Detection threshold → row gone, backfill_chunk_attempts = 0
[Fact] public async Task Chunk_attempts_survive_a_crash()                             // processing_state.backfill_chunk_attempts = 3 before RunOnce → chunk set aside without calling the processor
```

- [ ] **Step 2: Run them to see them fail.** `dotnet test src/Sporer.sln --filter "FullyQualifiedName~FailureIsolationTests"` — Expected: FAIL.
- [ ] **Step 3: Implement** the interfaces above; update existing tests that passed a floor (`TimelineWorkerTests`, `TimelineProcessorTests`) to the new behaviour without weakening their assertions.
- [ ] **Step 4: Run all tests.** `dotnet test src/Sporer.sln` — Expected: PASS, 0 warnings.
- [ ] **Step 5: Commit.** `git commit -m "Isolate failing stretches using set-aside rows in the database"`

---

### Task 2: Hosting: SPA fallback, forwarded headers, compression, conditional GET, config

**Files:** Modify `Program.cs`; Create `Configuration/MapOptions.cs`, `Http/ConditionalGetMiddleware.cs`, `Features/Config/GetConfigEndpoint.cs`; Test `tests/Sporer.Api.Tests/HostingTests.cs`.

**Interfaces:**
- `MapOptions { string StyleLight = "https://tiles.openfreemap.org/styles/liberty"; string StyleDark = "https://tiles.openfreemap.org/styles/dark"; }` bound from section `Map`.
- `GET /api/config` → `{ "mapStyleLight": "...", "mapStyleDark": "..." }`.
- SPA fallback: requests whose path does not start with `/api` and do not match a static file get `wwwroot/index.html` (200, `text/html`). Requests under `/api/` that match no endpoint get 404 (never `index.html`).
- `UseForwardedHeaders` for `X-Forwarded-For` and `X-Forwarded-Proto`, trusting any proxy (`KnownNetworks`/`KnownProxies` cleared — the app is reachable only through Traefik over the VPN; comment says so).
- Response compression (Brotli + Gzip, `EnableForHttps = true`) for `application/json`, `text/html`, `text/css`, `application/javascript`, `image/svg+xml`.
- `ConditionalGetMiddleware`: for `GET /api/*` responses with status 200 and JSON content type, buffers the body, sets `ETag: "<first 22 chars of base64url(SHA-256(body))>"` and `Cache-Control: no-cache`, and returns 304 with an empty body when the request's `If-None-Match` contains that tag. Other requests pass through untouched. `POST /api/overland` is never buffered.
- Static assets under `/assets/` (Vite hashed files) get `Cache-Control: public, max-age=31536000, immutable`; `index.html` gets `no-cache`.

- [ ] **Step 1: Write the failing tests.**

```csharp
[Fact] public async Task Unknown_api_route_is_404_not_index()              // GET /api/nope → 404, body not HTML
[Fact] public async Task Deep_link_serves_index_html()                      // test writes wwwroot/index.html into the factory's content root (or uses a WebRootPath override); GET /day/2026-10-22 → 200 text/html
[Fact] public async Task Config_returns_map_styles()                        // defaults; Map:StyleLight override is echoed
[Fact] public async Task Api_get_has_etag_and_no_cache()                    // GET /api/status → ETag present, Cache-Control no-cache
[Fact] public async Task Matching_if_none_match_returns_304()               // second GET with If-None-Match → 304, empty body
[Fact] public async Task Ingest_is_not_buffered_or_tagged()                  // POST /api/overland → no ETag header, body exactly {"result":"ok"}
[Fact] public async Task Json_is_compressed_when_accepted()                  // Accept-Encoding: br → Content-Encoding br
```

- [ ] **Step 2: Run to fail.** `dotnet test src/Sporer.sln --filter "FullyQualifiedName~HostingTests"` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run all tests.** `dotnet test src/Sporer.sln` — Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "Host the SPA properly, add conditional GET, compression and map config"`

---

### Task 3: Range API

**Files:** Create `Features/Range/{DateRange.cs, RangeStore.cs, RangeResponse.cs, GetRangeEndpoint.cs}`; Test `tests/Sporer.Api.Tests/RangeEndpointTests.cs`.

**Interfaces:**
- `DateRange.TryParse(string? from, string? to, out DateRange range, out string? error)` — strict `yyyy-MM-dd`, `from <= to`, at most 400 days inclusive. Reused by heat.
- `GET /api/range?from=YYYY-MM-DD&to=YYYY-MM-DD` → 400 on invalid input, else:

```json
{
  "from": "2026-10-01", "to": "2026-10-31", "state": "done",
  "summary": { "places": 38, "distanceMeters": 412000.0, "movingSeconds": 61200, "moves": 61 },
  "moves": [ { "id": 12, "mode": "drive", "start": "…Z", "end": "…Z", "geometry": [[10.75, 59.92], …] } ],
  "places": [ { "id": 3, "name": "Storgata 5", "city": "Oslo", "country": "Norway", "lat": 59.92, "lon": 10.75, "seconds": 1483200, "visits": 31 } ],
  "days": [ { "date": "2026-10-01", "distanceMeters": 13200.0, "movingSeconds": 2820, "places": 4 } ]
}
```

  - Selection: segments with `local_start_date <= to AND local_end_date >= from`.
  - `moves`: kind `move` only (flights included), ordered by `start_utc`, `geometry` = `geometry_coarse`.
  - `places`: stays grouped by the resolved surviving place (merged places resolve like the day API); `seconds` = each stay's duration clipped to `[from 00:00, to+1 00:00)` evaluated in that stay's `start_tz` (Postgres `(date::timestamp AT TIME ZONE tz)`); `visits` = number of stays; sorted by `seconds` desc then id; stays without a place are excluded; `name` = `coalesce(user_name, osm_name)`.
  - `summary`: `places` = number of entries in `places`; `distanceMeters`/`movingSeconds`/`moves` from the selected moves (full values, as the day API does).
  - `days`: one entry per local date in `[from, to]` that has at least one segment starting on it (`local_start_date`), with that day's move distance, moving seconds and distinct place count, ordered by date.
  - `state`: `pending` when a dirty range overlaps `[from 00:00 − 14 h, to+1 00:00 + 14 h]` UTC or the backfill cursor is below that span's end (reuse `ProcessingQueue.HasPendingWorkAsync`), else `done`.
- Vertex budget (Review Focus 5): if the selected moves' coarse geometries total more than 60 000 vertices, re-simplify each with `LineSimplifier.Simplify` at a tolerance that doubles from 100 m until the total fits (geometry stored as-is; this happens per response).

- [ ] **Step 1: Write the failing tests** (seed real segments with `TrackBuilder` + `ReprocessAsync`, or insert `segment`/`place` rows directly where that pins a rule):

```csharp
[Fact] public async Task Range_week_returns_moves_places_days_summary()
[Fact] public async Task Range_clips_overnight_stay_to_range_edges()          // stay 22:00 → 08:00 next day, range = first day only → seconds = 2 h (Oslo)
[Fact] public async Task Range_resolves_merged_places()
[Fact] public async Task Range_rejects_invalid_or_too_long()                  // bad format, from > to, 401 days → 400; 400 days → 200
[Fact] public async Task Range_pending_while_backfill_behind()
[Fact] public async Task Range_year_respects_vertex_budget()                  // insert moves totalling > 60 000 coarse vertices → response total ≤ 60 000, every move keeps first/last point
```

- [ ] **Step 2: Run to fail.** `dotnet test src/Sporer.sln --filter "FullyQualifiedName~RangeEndpointTests"` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run all tests.** `dotnet test src/Sporer.sln` — Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "Add range API"`

---

### Task 4: Heat API

**Files:** Create `Features/Heat/{GetHeatEndpoint.cs, HeatResponse.cs}`; Modify `Features/Range/RangeStore.cs` (heat query); Test `tests/Sporer.Api.Tests/HeatEndpointTests.cs`.

**Interfaces:**
- `GET /api/heat?from&to` (same validation as range) → `{ "maxSeconds": 1483200, "cells": [[10.751, 59.921, 1483200], …] }`.
- Cells come from **stays** (time spent, spec §4.4 — not point counts): each stay contributes its clipped seconds (same clipping as range) at its centre, bucketed to a grid of `round(lat, 3)` × `round(lon, 3)` degrees; a cell's coordinate is the bucket centre; `maxSeconds` = largest cell weight (0 when empty). Ordered by weight desc. Computed at request time (stays are few — tens of thousands over years); no new table.

- [ ] **Step 1: Write the failing tests.**

```csharp
[Fact] public async Task Heat_weights_by_time_not_points()       // a 6 h stay with 3 points outweighs a 10 min stay with 60 points
[Fact] public async Task Heat_buckets_nearby_stays_together()     // two stays 30 m apart → one cell with summed seconds
[Fact] public async Task Heat_empty_range_is_ok()                 // cells [], maxSeconds 0
[Fact] public async Task Heat_rejects_invalid_range()
```

- [ ] **Step 2: Run to fail.** `dotnet test src/Sporer.sln --filter "FullyQualifiedName~HeatEndpointTests"` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run all tests.** — Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "Add heat API"`

---

### Task 5: Place detail API

**Files:** Create `Features/Places/{GetPlaceEndpoint.cs, PlaceResponse.cs}`; Modify `Features/Timeline/PlaceStore.cs` (detail query); Test `tests/Sporer.Api.Tests/PlaceEndpointTests.cs`.

**Interfaces:**
- `GET /api/places/{id}` → 404 when the id doesn't exist or the place is not in use (`PlaceStore.InUse`), else (merged ids resolve to the survivor; the response carries the survivor's id):

```json
{ "id": 3, "name": "Storgata 5", "address": "Storgata 5, Oslo", "city": "Oslo", "country": "Norway",
  "lat": 59.92, "lon": 10.75, "totalSeconds": 1483200, "visits": 31,
  "firstVisit": "…Z", "lastVisit": "…Z",
  "recentVisits": [ { "start": "…Z", "end": "…Z", "date": "2026-10-22", "timeZone": "Europe/Oslo" } ] }
```

  `recentVisits` = the 50 most recent stays (newest first); `date` = the stay's `local_start_date`; totals over all stays of the place and the places merged into it.

- [ ] **Step 1: Write the failing tests.**

```csharp
[Fact] public async Task Place_returns_totals_and_recent_visits()
[Fact] public async Task Place_merged_id_resolves_to_survivor()
[Fact] public async Task Place_unknown_or_orphan_is_404()
[Fact] public async Task Place_recent_visits_capped_at_50()
```

- [ ] **Step 2: Run to fail.** `dotnet test src/Sporer.sln --filter "FullyQualifiedName~PlaceEndpointTests"` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run all tests.** — Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "Add place detail API"`

---

### Task 6: Web app scaffold: build, router, API client, time utilities, test harness

**Files:** Create everything under `web/` listed in File structure except the map, sheet and views (those come in Tasks 7–12); `src/App.tsx` renders a placeholder shell. Modify `.gitignore` (`web/node_modules`, `src/Sporer.Api/wwwroot`, `web/test-results`, `web/playwright-report`).

**Interfaces:**
- `package.json` scripts: `dev` (Vite, proxy `/api` → `http://localhost:5097`), `build` (`tsc --noEmit && vite build`, `outDir: ../src/Sporer.Api/wwwroot`, `emptyOutDir: true`), `typecheck`, `test` (`vitest run`), `e2e` (`playwright test`). Exact versions from Tech Stack; `engines.node: ">=22"`.
- `playwright.config.ts`: Chromium only, two projects — `phone` (390×844, `isMobile`, `hasTouch`, deviceScaleFactor 3) and `desktop` (1280×800); `webServer` runs `vite preview` on a fixed port after `npm run build`; WebGL via `--use-angle=swiftshader` (`--enable-unsafe-swiftshader`); a shared fixture fails any test that logs a console error.
- `e2e/mockApi.ts`: `mockApi(page, overrides?)` routes every `/api/*` request to JSON fixtures in `e2e/fixtures/` (`config.json` points both styles at `/test-style.json`, a blank MapLibre style with a background layer only, in `public/`). Unmocked `/api` calls fail the test.
- `src/app/router.ts`:
  - `type Route = { view: "day"; date: string } | { view: "week"; start: string } | { view: "month"; month: string } | { view: "year"; year: number } | { view: "range"; from: string; to: string } | { view: "place"; id: number }`.
  - `parseRoute(pathname: string, today: string): Route | null`, `formatRoute(route: Route): string`, `useRoute(): Route` (`useSyncExternalStore` over `popstate` and an internal event), `navigate(route: Route, opts?: { replace?: boolean })`. `/`, unknown and invalid paths → today's day (replace). `/week/<date>` normalises to that week's Monday.
- `src/time/dates.ts` (pure, date-fns): `today(zone?)`, `addDays(date, n)`, `weekStart(date)` (Monday), `monthOf(date)`, `periodRange(route): { from: string; to: string }` for day/week/month/year/range, `step(route, delta: -1 | 1): Route` (day ±1 day, week ±7, month ±1 month, year ±1, range shifted by its own length), `periodLabel(route): string` (e.g. "Thursday 22 October", "19 – 25 Oct 2026", "October 2026", "2026", "12 Sep – 19 Sep 2026").
- `src/time/format.ts`: `formatTime(isoUtc, zone)` → "08:46" (24 h); `formatDuration(seconds)` → "8h 32m" / "24m" / "45s"; `formatDistance(meters)` → "850 m" / "1.1 km" / "412 km".
- `src/api/types.ts` mirrors the server JSON exactly: `DayResponse` (from `src/Sporer.Api/Features/Day/DayResponse.cs`), `RangeResponse`, `HeatResponse`, `PlaceResponse`, `StatusResponse`, `ConfigResponse`.
- `src/api/client.ts`: `getJson<T>(path, signal)` (throws `ApiError { status }` on non-2xx; the browser's HTTP cache handles ETags); `src/api/queries.ts`: `useDay(date)`, `useRange(from, to)`, `useHeat(from, to, enabled)`, `usePlace(id)`, `useStatus()`, `useConfig()`, and `prefetchNeighbours(queryClient, route)` — TanStack Query with `placeholderData: keepPreviousData`, `staleTime` 30 s, `refetchInterval` 30 s while the response `state` is `"pending"`.

- [ ] **Step 1: Write the failing tests** (Vitest):

```ts
test("parseRoute_round_trips_every_view")             // each Route → formatRoute → parseRoute is identity
test("parseRoute_rejects_invalid_and_defaults_to_today") // "/day/2026-02-30", "/nope", "/" → day today
test("week_route_normalises_to_monday")               // "/week/2026-10-22" → start "2026-10-19"
test("step_moves_by_period")                          // month 2026-01 −1 → 2025-12; range 3 days +1 → next 3 days
test("periodRange_covers_iso_week_and_month")         // week 2026-10-19 → 19..25; month 2026-02 → 01..28
test("formatTime_uses_segment_zone")                  // "2026-10-22T06:46:00Z" Oslo → "08:46"; New York → "02:46"
test("formatTime_on_dst_end_day")                     // "2026-10-25T00:30:00Z" and "…01:30:00Z" Oslo → "02:30" both
test("formatDuration_and_formatDistance")             // 30720 → "8h 32m"; 1440 → "24m"; 850 → "850 m"; 1100 → "1.1 km"
test("getJson_throws_ApiError_with_status")
```

And one Playwright smoke test `e2e/shell.spec.ts`: `app_loads_and_redirects_to_today` (mocked API; `/` → URL `/day/<today>`; no console errors) on both projects.

- [ ] **Step 2: Run to fail.** `cd web && npm ci && npm test` — Expected: FAIL.
- [ ] **Step 3: Implement** the scaffold, router, dates, format, types, client, queries.
- [ ] **Step 4: Verify.** `cd web && npm run typecheck && npm test && npm run build && npm run e2e` — Expected: all pass; `src/Sporer.Api/wwwroot/index.html` exists.
- [ ] **Step 5: Commit.** `git commit -m "Scaffold the web app: router, API client, time utilities, tests"`

---

### Task 7: Map view: MapLibre wrapper, English labels, theme, layers

**Files:** Create `web/src/map/{MapView.tsx, style.ts, layers.ts, bounds.ts}`; Tests `web/src/map/*.test.ts(x)`, `web/e2e/map.spec.ts`.

**Interfaces:**
- `style.ts`: `toEnglishLabels(style: StyleSpecification): StyleSpecification` — returns a copy where every `symbol` layer whose `layout["text-field"]` references the `name` property is replaced by `["coalesce", ["get", "name:en"], ["get", "name_en"], ["get", "name:latin"], ["get", "name"]]`; other layers untouched. `loadStyle(url, signal): Promise<StyleSpecification>` fetches JSON and applies it.
- `layers.ts` (pure): `MODE_COLORS`; `dayGeoJson(day: DayResponse)` → `{ routes: FeatureCollection<LineString>; stops: FeatureCollection<Point> }` (route features carry `mode`, `id`; stop features carry `order` 1..n, `name`, `id`); `rangeGeoJson(range: RangeResponse)` → `{ routes; places }` (place features carry `radius` = `4 + 12 * sqrt(seconds / max)` px and `label` for the top 5 by seconds); `heatGeoJson(heat: HeatResponse)` → points with `weight = seconds / maxSeconds`. Layer specs: routes as lines (width 4 day / 2.4 range, range opacity 0.35, flight dashed `[2, 2]`), white casing under day routes, stop pins as circles with the order number as a symbol, place dots as circles sized by `radius`, a MapLibre `heatmap` layer.
- `bounds.ts`: `boundsOf(features): LngLatBoundsLike | null`; handles flights crossing the antimeridian (unwrapped longitudes from the server).
- `MapView.tsx`: `<MapView styleUrl={…} data={{ routes, stops?, places?, heat? }} fitTo={features | null} padding={{ top, right, bottom, left }} onStyleError={…} />` — creates one `maplibregl.Map` on mount (attribution control on, compact), loads the style through `loadStyle`, re-adds sources/layers after every style load (theme switch), updates GeoJSON sources via `setData` when `data` changes, `fitBounds` with `padding` (and animation) when `fitTo` changes, calls `onStyleError` and keeps working when the style fails (Review Focus 4). Theme: picks `mapStyleLight`/`mapStyleDark` from `useConfig()` by `prefers-color-scheme`, switching live. Map buttons (recenter → refit current data; heat toggle is wired in Task 11) float at the right edge.
- In Vitest, `maplibre-gl` is mocked (jsdom has no WebGL); the e2e test exercises the real map with the blank style.

- [ ] **Step 1: Write the failing tests.**

```ts
test("toEnglishLabels_rewrites_name_text_fields_only")
test("dayGeoJson_numbers_stops_and_tags_modes")
test("rangeGeoJson_sizes_places_by_time_and_labels_top_five")
test("heatGeoJson_normalises_weights")
test("boundsOf_handles_antimeridian_flight")
test("MapView_reports_style_failure_without_throwing")   // mocked style fetch rejects → onStyleError called once, component still rendered
```

e2e `map.spec.ts`: `map_canvas_renders_with_attribution` (canvas visible, attribution text contains "OpenStreetMap").

- [ ] **Step 2: Run to fail.** `cd web && npm test` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify.** `cd web && npm run typecheck && npm test && npm run e2e` — Expected: pass.
- [ ] **Step 5: Commit.** `git commit -m "Add the map view with English labels and themed styles"`

---

### Task 8: App shell: top bar, bottom sheet / sidebar, states, status banner

**Files:** Create `web/src/views/{TopBar.tsx, States.tsx, StatusBanner.tsx}`, `web/src/sheet/{BottomSheet.tsx, Sidebar.tsx}`, `web/src/app/{useMediaQuery.ts, useStoredFlag.ts}`, CSS modules, `web/src/styles/{tokens.css, global.css}`; Modify `web/src/app/App.tsx`; Tests alongside + `web/e2e/shell.spec.ts`.

**Interfaces:**
- `TopBar`: floating glass card (mockup 1) with a segmented control `Day | Week | Month | Year | Range` (switching keeps the anchor date: day 2026-10-22 → week of it → month 2026-10 → year 2026; Range opens two native `<input type="date">` fields prefilled with the current period) and a date row `‹ label ›`; ‹/› call `step`; horizontal swipe (≥ 50 px, mostly horizontal) on the date row steps; ←/→ keys step on desktop when focus is not in an input.
- `BottomSheet` (phone): non-modal, always present, drag handle; snap points peek 96 px / half 50 vh / full `100vh − 120px`; pointer-drag with velocity snapping (flick > 0.5 px/ms goes to the next snap point in the flick direction); content scrolls only at full; exposes its current visible height via `onHeightChange` so the map padding follows it. Respects `env(safe-area-inset-bottom)`.
- `Sidebar` (desktop ≥ 900 px): fixed 320 px left panel containing the same panel content; map padding left = 320.
- `States`: `<Loading/>`, `<Empty message/>`, `<ErrorState error onRetry/>` (shows "Couldn't load — Retry").
- `StatusBanner`: from `useStatus()` (poll 30 s); shows "Processing your history… 42 %" while `backfill.percent < 100`, "Processing problem: <lastError>" when `lastError` is set; hidden otherwise.
- `useStoredFlag(key, default)`: boolean in `localStorage` with try/catch fallback to memory.
- `App`: map underneath; top bar; banner; sheet or sidebar with the view's panel (placeholder panels until Tasks 9–12); safe areas via `viewport-fit=cover` and `env(safe-area-inset-*)`.

- [ ] **Step 1: Write the failing tests.**

```ts
test("TopBar_switching_views_keeps_anchor_date")
test("TopBar_arrows_and_keys_step_period")
test("TopBar_swipe_steps_period")                      // pointer events: 80 px left swipe → next
test("BottomSheet_snaps_to_nearest_and_by_flick")
test("useStoredFlag_works_when_storage_throws")
test("StatusBanner_shows_progress_and_errors")
```

e2e `shell.spec.ts`: `phone_uses_bottom_sheet_desktop_uses_sidebar`; `error_then_retry_recovers` (Review Focus 3: day request 500 → error with Retry while the previous day's list stays; Retry with a good response shows the new day).

- [ ] **Step 2: Run to fail.** `cd web && npm test` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify.** `cd web && npm run typecheck && npm test && npm run e2e` — Expected: pass.
- [ ] **Step 5: Commit.** `git commit -m "Add the app shell: top bar, sheet, sidebar, states, status"`

---

### Task 9: Day view

**Files:** Create `web/src/views/DayPanel.tsx` (+ CSS); Modify `App.tsx`; Tests `web/src/views/DayPanel.test.tsx`, `web/e2e/day.spec.ts`; fixtures `web/e2e/fixtures/day-*.json`.

**Interfaces:**
- Map: `dayGeoJson` routes coloured by mode, flights dashed, numbered stop pins; fit to the day's features on load.
- `DayPanel`: summary chips (`n places`, distance, moving time); timeline rows in order — stay rows (pin with order number, place name or "Unnamed place", `HH:MM – HH:MM` in the stay's zone, duration; first stay shows "until HH:MM" when it began before the day, last shows "from HH:MM" when it runs past the day or is ongoing), move rows (coloured bar, mode word "Walk/Cycle/Drive/Flight", distance, duration), gap rows ("No data", duration); tapping a stay or move row fits the map to that segment; tapping a place name navigates to `/place/{id}`. "Updating…" chip while `state === "pending"`. Empty day → "No data for this day".
- Prefetch the previous and next day on show.

- [ ] **Step 1: Write the failing tests.**

```ts
test("DayPanel_renders_rows_in_order_with_zone_times")          // fixture with Oslo stays + a flight to New York
test("DayPanel_shows_segments_and_updating_note_while_pending")
test("DayPanel_empty_day_message")
test("DayPanel_row_tap_requests_fit_and_place_tap_navigates")
```

e2e `day.spec.ts`: `day_view_lists_timeline_and_steps_days` (phone + desktop: rows visible, › goes to the next date in the URL and list).

- [ ] **Step 2: Run to fail.** — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify.** `cd web && npm run typecheck && npm test && npm run e2e` — Expected: pass.
- [ ] **Step 5: Commit.** `git commit -m "Add the day view"`

---

### Task 10: Week, Month, Year and Range views

**Files:** Create `web/src/views/RangePanel.tsx` (+ CSS); Modify `App.tsx`; Tests `RangePanel.test.tsx`, `web/e2e/range.spec.ts`; fixtures.

**Interfaces:**
- Map (mockup 2A): `rangeGeoJson` faint routes and place dots sized by time, top-5 labels; fit to all features.
- `RangePanel`: summary chips (`n places`, distance, `n moves`); "Where your time went" — places ranked by `seconds` with bars relative to the top place (name, bar, `formatDuration`), tap → `/place/{id}`; the day list — each day with data (weekday + date, distance, places) → tap navigates to `/day/{date}`. "Updating…" while pending; empty period → "No data for this period".
- Prefetch the previous and next period.

- [ ] **Step 1: Write the failing tests.**

```ts
test("RangePanel_ranks_places_and_lists_days")
test("RangePanel_shows_updating_note_while_pending")
test("RangePanel_day_tap_navigates_to_day")
```

e2e `range.spec.ts`: `month_view_and_range_picker` (switch to Month → URL `/month/2026-10`; pick a Range via the date inputs → URL `/range/…`).

- [ ] **Step 2: Run to fail.** — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify.** — Expected: pass.
- [ ] **Step 5: Commit.** `git commit -m "Add week, month, year and range views"`

---

### Task 11: Heat layer toggle

**Files:** Modify `MapView.tsx`, `App.tsx`; Test `web/src/map/heat.test.tsx`, e2e assertion in `range.spec.ts`.

**Interfaces:**
- Map button (◐ in the mockup) toggles the heat layer at every time scale; state remembered with `useStoredFlag("heat", false)`; when on, `useHeat(from, to)` loads and the heatmap layer shows **in addition to** routes (routes drop to 20 % opacity while heat is on). The heatmap uses `heatmap-weight` from `weight`, radius growing with zoom.

- [ ] **Step 1: Write the failing tests.** `test("heat_toggle_is_remembered_and_fetches_only_when_on")`; e2e: toggling heat on issues exactly one `/api/heat` request for the period.
- [ ] **Step 2: Run to fail.** — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify.** — Expected: pass.
- [ ] **Step 5: Commit.** `git commit -m "Add the heat layer toggle"`

---

### Task 12: Place detail view

**Files:** Create `web/src/views/PlacePanel.tsx` (+ CSS); Modify `App.tsx`; Tests `PlacePanel.test.tsx`, e2e `place.spec.ts`.

**Interfaces:**
- `/place/{id}`: map flies to the place (single pin); panel shows name (or "Unnamed place"), address, total time, visits, first and last visit dates, recent visits (date, `HH:MM – HH:MM` in the visit's zone, duration) — tap → `/day/{date}`; a back control returns to the previous view (`history.back()` when there is history, else today's day). 404 → "This place no longer exists".

- [ ] **Step 1: Write the failing tests.** `PlacePanel_shows_totals_and_visits`, `PlacePanel_visit_tap_navigates_to_day`, `PlacePanel_not_found_message`; e2e `place_from_day_and_back`.
- [ ] **Step 2: Run to fail.** — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify.** — Expected: pass.
- [ ] **Step 5: Commit.** `git commit -m "Add the place detail view"`

---

### Task 13: Home-screen basics, Docker web stage, CI, README

**Files:** Create `web/public/manifest.webmanifest`, `web/public/icons/{icon.svg, apple-touch-icon.png (180), icon-192.png, icon-512.png}` (generate the PNGs once from the SVG with a small Python/PIL or Playwright script kept in `web/scripts/`), Modify `web/index.html`, `docker/dockerfile`, `.github/workflows/docker-publish.yml`, `README.md`, `.dockerignore`.

**Interfaces:**
- `index.html`: `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">`, `apple-mobile-web-app-capable`, `apple-mobile-web-app-status-bar-style` = `black-translucent`, `theme-color` light/dark, `apple-touch-icon`, manifest link. Manifest: name "Sporer", `display: standalone`, `start_url: "/"`, `scope: "/"`, icons. (Service worker: Plan 4.)
- Dockerfile: new first stage `FROM node:22-alpine AS build-web` → `npm ci` (from `web/package*.json` first for caching) → `npm run build` with `outDir` overridden to `/web-dist` (`vite build --outDir /web-dist`); the runtime stage copies `/web-dist` into `/app/wwwroot`. The .NET stages stay as they are.
- Workflow: a `web` job (ubuntu-latest, `actions/setup-node@v4` node 22 with npm cache, `npm ci`, `npm run typecheck`, `npm test`, `npx playwright install --with-deps chromium`, `npm run e2e`) that `build` needs alongside `test`; path filter adds `web/**`.
- README: the web app (URL, add to home screen on iPhone: Share → Add to Home Screen), `Map__StyleLight`/`Map__StyleDark`, front-end development (`cd web && npm ci && npm run dev` with the API on :5097, `npm test`, `npm run e2e`).

- [ ] **Step 1: Verify the image.** `docker build -f docker/dockerfile -t sporer:web .` — the Node and NuGet restores need the network; if this container's proxy blocks restores inside Docker (as in Plan 1 Task 14), verify with a pre-seeded build context the same way and record that CI performs the real build.
- [ ] **Step 2: Smoke-run.** Image + TimescaleDB container: `GET /` → HTML containing `<div id="root">`; `GET /day/2026-10-22` → same HTML; `GET /api/nope` → 404; `GET /manifest.webmanifest` → JSON.
- [ ] **Step 3: Validate the workflow YAML** with `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/docker-publish.yml'))"`.
- [ ] **Step 4: Commit.** `git commit -m "Build the web app into the image, test it in CI, document it"`

---

### Task 14: Performance check against spec §8 (server + web)

**Files:** Create `docs/superpowers/plans/2026-10-24-sporer-plan-2-perf.md`; any fixes in the files they concern.

- [ ] **Step 1: Server.** With the Plan 1 synthetic generator (`tools/Sporer.SyntheticData`, ≈ 10 M rows, backfill complete), measure p50/p95 for `/api/day` (200 random dates), `/api/range` (100 random months, 20 random years), `/api/heat` (month, year) and `/api/places/{id}`; record response sizes (raw and Brotli) and the year vertex count. Targets: day ≤ 200 ms server time, month ≤ 400 ms, year ≤ 800 ms; year payload ≤ 1.5 MB raw JSON and ≤ 60 000 vertices.
- [ ] **Step 2: Web.** Production build bundle sizes (JS gzip total; MapLibre separate); target ≤ 450 kB gzip including MapLibre. With Playwright (phone project, CPU throttling 4× via CDP `Emulation.setCPUThrottlingRate`) and the mocked API serving recorded real responses from Step 1: time from navigation to the day panel's rows visible and to the map's `idle` event for a day, a month and a year; targets from spec §8 (day ≤ 1 s, month ≤ 2 s, year ≤ 3 s excluding network).
- [ ] **Step 3: Fix misses** (with re-measurement), never by changing detection results.
- [ ] **Step 4: Write the results** to the perf doc and commit: `git commit -m "Record web and API performance"`
