# Sporer Plan 6 — what a point is, and routes at full strength

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Three requests from the owner after v1.2.0, released together as v1.3.0:
1. **In edit mode, the points the timeline ignores look different.** The day's raw points include fixes the timeline never uses (an accuracy worse than 100 m — the phone on cell towers without GPS —, an out-and-back glitch, a duplicate). Today they look like every other point, so a straight move that skips them looks like a bug.
2. **Tap a point and see everything there is about it**: its time, device, position, accuracy, speed, altitude and motion as stored, whether the timeline uses it (and why not), the stay or move it is in, and how far and how long it is from the points before and after.
3. **An option to draw the routes of a week, a month, a year or a range at full strength** instead of faded.

**Architecture:**
- **The server says which points the timeline ignores.** `PointCleaner` gains a classification (used, poor accuracy, glitch, duplicate) that `Clean` is built on, so the two can never disagree. The day's points carry it as a fifth element. A new endpoint returns one point in full, with what is derived from it.
- **Edit mode draws an ignored point hollow** (a grey ring, no fill). It can still be selected and removed.
- **A tap on a point** selects it as today and opens a card on the map at that point with its details. The card closes with ×, Escape, a tap on empty map, leaving edit mode or changing the day.
- **"Fade routes in weeks, months and years"** is a switch in a new Settings section, Map, on by default (today's look). It is kept on the device, like the heat toggle. Under a heat layer the routes fade as today, whatever the switch says.

**Tech Stack:** unchanged. No new dependencies. No migrations.

**Spec:** `docs/superpowers/specs/2026-10-23-sporer-web-app-design.md` — §4.7 (edit mode), §4.3 (period views), §4.8 (Settings), §6.3 (cleaning). These are owner requests after v1; where the spec is silent they decide.

Earlier decisions: the rulings docs of Plans 1–5 (`docs/superpowers/plans/*-rulings.md`), in particular P4-R45 (the edit-point halo layer), P5-R13 (the WebKit smoke set), P5-R16 (the edit bar at the peek).

## Environment setup (once per container)

As in Plan 5: .NET 10 SDK; Docker for Testcontainers (`nohup dockerd >/tmp/dockerd.log 2>&1 &` if `docker ps` fails); Node 22; Playwright's Chromium in `/opt/pw-browsers` (never `playwright install`; no WebKit here). No external host is reachable from tests.

## Global Constraints

- **Earlier constraints still apply:** `locationLog` is never updated or deleted and its schema is not changed; owner data is never rewritten by processing; ingest never waits; web dependencies exactly as pinned; CSS Modules plus custom properties; TypeScript strict; every view has loading, empty and error states with Retry; `GET /api/*` keeps the strong ETag and the 304; writes accept only JSON; no test makes an external request; never skip, disable or weaken a test; test output pristine; accessible names contain the visible text.
- **No migrations.**
- **One classification.** `PointCleaner.Clean` returns exactly the points the classification calls used, in the same order: every existing cleaner test passes unchanged.
- **Status codes on the wire:** `0` used, `1` poor accuracy (worse than `MaxAccuracyMeters`, or negative), `2` glitch, `3` duplicate (same device and time as an earlier point). The day's point becomes `[t, lon, lat, deviceIndex, status]`.
- **The classification of a day** is made over the day's points plus the nearest point before and after the day (what decides a glitch at the edges), with the detection options in effect.
- **The point endpoint** is `GET /api/points/detail?device=…&t=…` (`t` in epoch microseconds, as everywhere). 400 for a missing or malformed parameter; 404 for no such point; a removed point is answered with its status `removed` (it is still in `locationLog`).
- **Edit mode:** an ignored point is a grey ring with no fill, at the dot's size; selected, it is red like any other. Points stay one source and the tap test is unchanged (`editPointAt`).
- **The card** never takes the focus from the map on open, has a visible close button, and is announced as a region named "Point details". It shows the device's local time with its zone.
- **The routes switch** applies to the period views only (week, month, year, range, the trips map); a day's and a trip's routes are solid already. Faded is `0.35` (today), full is `1`; under heat `0.2` either way.

## Review Focus

1. The classification and `Clean` cannot disagree; a day's statuses match what the timeline used (an integration test over a day with a poor fix, a glitch and a duplicate).
2. The detail endpoint: every stored column, the derived fields correct (local time and zone, the segment, neighbours across the day's edges), 404/400, ETag/304.
3. Edit mode: ignored points visibly different in light and dark schemes; taps and boxes unchanged; the card's lifecycle (open, replace on another tap, close on ×, Escape, empty-map tap, day change, Done), loading/error/Retry.
4. The routes switch: persisted per device, applied without a reload, heat still fades.

---

## File structure

```
src/Sporer.Timeline/PointCleaner.cs                         modify: Classify, Clean on top of it
src/Sporer.Api/Features/Points/{DayPointsResponse, GetDayPointsEndpoint}.cs   modify: the status
src/Sporer.Api/Features/Points/{GetPointDetailEndpoint, PointDetailResponse}.cs   create
src/Sporer.Api/Features/Timeline/PointStore.cs              modify: what the two need
tests/Sporer.Timeline.Tests/PointCleanerTests.cs            modify
tests/Sporer.Api.Tests/PointsTests.cs (or a new PointDetailTests.cs)
web/src/api/{types.ts, queries.ts}                          the status, the detail query
web/src/map/{layers.ts, MapView.tsx, PointCard.tsx (+ .module.css)}   hollow points, the card
web/src/app/{App.tsx, useEditPoints.ts}                     the tapped point
web/src/views/{SettingsPanel.tsx, MapSettings.tsx}          the routes switch
web/e2e/{edit-points.spec.ts, settings.spec.ts, range.spec.ts}
README.md
```

---

### Task 1: The server: which points the timeline ignores, and one point in full

**Files:** `src/Sporer.Timeline/PointCleaner.cs`, `src/Sporer.Api/Features/Points/*`, `src/Sporer.Api/Features/Timeline/PointStore.cs`, tests.

- [ ] **Step 1: Classify, test first.** `PointCleaner.Classify(IReadOnlyList<TrackPoint> points, DetectionOptions o)` returns a status for each input point (in input order): `Duplicate` for a repeat of (device, time) after the first, `PoorAccuracy` for an accuracy that is negative or worse than `MaxAccuracyMeters`, `Glitch` for an out-and-back jump (the rule `Clean` has today, judged among the points that pass the first two), else `Used`. `Clean` becomes "the used ones, sorted by time" on top of it. Tests: each status; a duplicate that also has poor accuracy is `Duplicate`; every existing `Clean` test passes unchanged.
- [ ] **Step 2: The day's points carry the status.** `GET /api/day/{date}/points` answers `[t, lon, lat, deviceIndex, status]`. Classify over the day's span plus the nearest point before and after (loaded with their accuracy), with the options in effect (`DetectionOptions`). Integration test over a seeded day with a poor fix, a glitch and a duplicate: the statuses are right, the used ones are exactly the points the processor's cleaning keeps for that span, and the ETag/304 still work.
- [ ] **Step 3: One point in full.** `GET /api/points/detail?device=…&t=…` → `{ device, t, timeUtc, localTime, zone, lat, lon, accuracyM, speedMps, altitudeM, motion, status, previous, next, segment }`:
  - `status`: `used`, `poorAccuracy`, `glitch`, `duplicate` or `removed`, judged as in Step 2 (with the point's own neighbours);
  - `previous` / `next`: the nearest point of any device before / after it, not removed — `{ t, gapSeconds, distanceM, speedKmh }` — or null;
  - `segment`: the stored stay, move or gap whose time covers it — `{ kind, startUtc, endUtc, place?: { id, name }, mode? }` — or null;
  - nullable columns stay null (speed, accuracy, motion are missing on old rows).
  Tests: a used point with both neighbours and a stay; a point at the start of the history (no previous); a poor-accuracy point; a removed point; 404; 400 for a missing `device`, a missing or non-numeric `t`; ETag/304.
- [ ] **Step 4: Commit.** `Points: say which ones the timeline ignores, and serve one in full`.

### Task 2: Edit mode: ignored points are hollow

**Files:** `web/src/api/types.ts`, `web/src/map/layers.ts` (+ test), `web/e2e/edit-points.spec.ts`.

- [ ] **Step 1: Types.** `RawPoint` gains `status: 0 | 1 | 2 | 3`. Update fixtures (`web/e2e/fixtures/points-edit.json` and unit fixtures) with a few ignored points.
- [ ] **Step 2: Draw them hollow, test first.** `editPointsGeoJson` gives an ignored point a property (`ignored: true`, one shared object, as `NO_PROPERTIES` is today); the dot layer draws it with no fill (transparent colour) and a grey ring (a stroke of the dot's own layer is fine here: hollow dots do not paint over others), the halo layer leaves it out or keeps it light, in both schemes. Selected, it is red like any other.
- [ ] **Step 3: Say so.** The bar's hint under the row ("Tap a point, or use Select area on the map.") adds, when the day has ignored points: "Hollow points are ones the timeline already ignores (no GPS, a glitch or a repeat)." — one line, under the row (not in it: P5-R16's peek budget).
- [ ] **Step 4: e2e.** On the edit fixture day, an ignored point's pixel is not the ink colour and a used one's is (Chromium; the existing `expectDot` helpers); tapping an ignored point still selects it (red).
- [ ] **Step 5: Commit.** `Edit mode: draw the points the timeline ignores hollow`.

### Task 3: Tap a point, see it in full

**Files:** `web/src/api/queries.ts`, `web/src/map/PointCard.tsx` (+ `.module.css`, test), `web/src/map/MapView.tsx`, `web/src/app/useEditPoints.ts`, `web/src/app/App.tsx`, `web/e2e/edit-points.spec.ts`.

- [ ] **Step 1: The query.** `pointDetailQueryOptions(device, t)` on `GET /api/points/detail`. Typed response.
- [ ] **Step 2: The tapped point.** A tap that selects or deselects a point also makes it the "inspected" point (an area selection does not). It is cleared by ×, Escape, a tap on the map that hits no point, a new day, leaving edit mode, and by the point disappearing (removed).
- [ ] **Step 3: The card, test first.** A small card anchored at the point on the map (a MapLibre `Popup` with a React portal, or an absolutely positioned element following `map.project`; it moves with the map):
  - heading: the local time with seconds and the zone's short name, and the date;
  - rows: device; coordinates (6 decimals, copyable as text); accuracy (m); speed (km/h, from m/s); altitude (m); motion (comma-separated) — "not recorded" for a null;
  - the status in words: "Used by the timeline", or "Ignored: the GPS accuracy was 1,414 m (more than 100 m)", "Ignored: an out-and-back jump", "Ignored: a repeat of an earlier point", "Removed by you";
  - where it is: "In a stay at <place>" / "In a move by <mode>" / "In a gap" (with its times);
  - before and after: "1 min 1 s and 1.2 km after the previous point (72 km/h)" and the same for the next;
  - loading, error with Retry, and a 404 ("This point no longer exists") states; the × closes it.
  The card never takes the focus on open (the map keeps it, P5-R16's rule); it is a region named "Point details"; it fits on a 390 px phone (it may flip to stay on screen).
- [ ] **Step 4: e2e** (phone and desktop): tap a point → the card shows its time, accuracy and status; tap another → the card is replaced; tap empty map → closed; Escape → closed; Done → closed; a 500 on the detail → error with Retry that works.
- [ ] **Step 5: Commit.** `Edit mode: tap a point to see everything about it`.

### Task 4: Routes at full strength

**Files:** `web/src/views/MapSettings.tsx` (+ test), `web/src/views/SettingsPanel.tsx`, `web/src/app/App.tsx`, `web/src/map/{MapView.tsx, layers.ts}` (+ tests), `web/e2e/settings.spec.ts`, `web/e2e/range.spec.ts`.

- [ ] **Step 1: The switch, test first.** A Settings section "Map" with one switch, "Fade routes in weeks, months and years", on by default, kept with `useStoredFlag` (key `fadeRoutes`). A native checkbox styled as the app's controls, its label the visible text.
- [ ] **Step 2: Applied.** `MapView` takes `fadeRoutes`; `routeOpacity` returns `1` for the period route layers when it is off; under heat `0.2` as today. Changing it applies at once (a paint property, no reload, no new data). Unit tests for `routeOpacity`.
- [ ] **Step 3: e2e.** Settings shows the switch on; turning it off and opening a month draws a route pixel at full colour (Chromium, the existing pixel helpers); the choice survives a reload.
- [ ] **Step 4: Commit.** `Settings: draw the routes of long periods at full strength`.

### Task 5: README, checklist and the release notes

**Files:** `README.md`, `docs/superpowers/plans/2026-11-05-sporer-plan-6-release.md` (create).

- [ ] **Step 1: README.** The API table: the day's points' fifth element and `GET /api/points/detail`. Editing: hollow points and the card. Settings: the Map section. The editing checklist: "a point's card on the phone" and "hollow points on a day with no GPS". 
- [ ] **Step 2: Release notes** for v1.3.0 (owner-facing, short), in the release doc.
- [ ] **Step 3: Commit.** `Document the point card, hollow points and the routes switch`.

---

## Out of scope

- Showing raw points outside edit mode.
- Snapping routes to roads; marking moves that rest on few points (the owner chose only option 1 of two offered).
