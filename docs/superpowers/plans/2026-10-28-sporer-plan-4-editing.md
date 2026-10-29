# Sporer Plan 4 — Editing and Settings: rename and merge places, remove points, trip edits, home override

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the owner correct what detection got wrong, from the phone:
- rename and merge places (and separate a wrong merge);
- remove bad GPS points from a day, with Undo and a list to restore them;
- rename, re-date and delete trips;
- override home, and set the trip distance;
- see the processing status and retry failures.

Every correction survives reprocessing and algorithm-version rebuilds.

**Architecture:**
- **Owner data lives in tables processing never rewrites.**
  - Places: `place.user_name` and `place.merged_into_id`, which exist since Plan 1.
  - Removed points: new `excluded_point`.
  - Trip edits: new `trip_edit`.
  - Home overrides: `home_period` rows with `source = 'user'`, which exist since Plan 3.
  - The trip distance: new `app_setting`.
- **Edits that change segments enqueue work.** A point removal or restore inserts a dirty range that is due at once, and the worker rebuilds that stretch of the timeline as it does for ingest.
- **Edits that only change homes and trips recompute at once.** Merges, home overrides, trip edits and the trip distance recompute homes and trips in the request, from the stored nights: a few thousand rows, tens of milliseconds. The recompute is serialized with the worker's refresh.
- **Reads need no change for edits.** Names already resolve as `coalesce(user_name, osm_name)` through merges at read time. ETags are a hash of the body, so a GET changes as soon as its data does.
- **Web app.** It gains write helpers, inline edit forms in the place, trip and day panels, an edit mode on the day map (tap or drag a box over raw points), and a `/settings` page behind a gear button.

**Tech Stack:** unchanged from Plan 3. No new dependencies on either side. Dates are picked with native `<input type="date">`.

**Spec:** `docs/superpowers/specs/2026-10-23-sporer-web-app-design.md` (approved). Sections used:
- §4.5: trip edits;
- §4.6: rename, merge;
- §4.7: edit mode;
- §4.8: Settings;
- §6.3: user exclusions;
- §6.6: user overrides, home override, trip edits;
- §7.2: the `excluded_point` and `trip` columns;
- §9: tests for merges and renames surviving reprocessing, excluded points, and the e2e flows.

Earlier decisions:
- `docs/superpowers/plans/2026-10-23-sporer-plan-1-rulings.md`
- `docs/superpowers/plans/2026-10-24-sporer-plan-2-rulings.md`
- `docs/superpowers/plans/2026-10-26-sporer-plan-3-rulings.md`

The last of these holds the Plan 4 notes this plan picks up.

**Plan series.** Plans 1–3 are merged. This is Plan 4, which builds spec phase 6 (editing and Settings). Plan 5 builds phase 7:
- the service worker;
- a WebKit CI project and CI browser caching;
- the final §8 performance pass;
- the remaining tidy-ups (Plan 1's `day-latency.sh` seed, a refresh warm-up).

## Environment setup (once per container)

As in Plan 3:
- .NET 10 SDK;
- Docker for Testcontainers (`nohup dockerd >/tmp/dockerd.log 2>&1 &` if `docker ps` fails);
- Node 22;
- Playwright's Chromium in `/opt/pw-browsers`. Never run `playwright install`.

No external host is reachable from tests.

## Global Constraints

- **Earlier constraints.** Every Plan 1–3 constraint still applies:
  - `locationLog` rows are never updated or deleted, and its schema is not changed again.
  - Ingest never waits on processing.
  - Web dependencies stay exactly as pinned; styling is CSS Modules plus custom properties.
  - TypeScript stays strict.
  - Every view has loading, empty and error states with Retry.
  - `GET /api/*` keeps the strong ETag and the 304.
  - No test makes an external request.
  - Never skip, disable or quarantine a test. Test output stays pristine.
  - Accessible names contain the visible text (P2-R46).
- **Migrations.** One new migration, `0006_edits.sql`. It creates new tables. It may add nullable columns to Sporer's own derived table `trip`, which is rebuilt from nights on every refresh. Nothing else is altered.
- **Owner data is never rewritten by processing.** That covers:
  - `place.user_name` and `place.merged_into_id`;
  - `excluded_point`;
  - `trip_edit`;
  - `home_period` rows with `source = 'user'`;
  - `app_setting`.

  `ProcessingQueue.RestartBackfillAsync` (an algorithm-version rebuild) keeps all of them. A test pins it for each.
- **Raw points are never deleted.** "Remove" inserts `(device, time)` into `excluded_point`. Every read of raw points for processing leaves them out: the segmenter's load, and the nearest point of a night. "Restore" deletes the row.
- **Writes.**
  - Writes are `POST`, `PUT` and `DELETE` under `/api`.
  - Bodies are JSON. A write with a body whose `Content-Type` is not `application/json` gets **415**. A cross-site form can then never trigger one once Authentik cookies exist; there is no CORS. `POST /api/overland` keeps its own rules.
  - Answers:
    - **400**, problem details with `title` and `detail`, for a value that is not valid;
    - **404** for an unknown id;
    - **409** for a conflict (merging a place into itself, overlapping trips or home overrides).
- **Recompute.** `ITripRefresher.RecomputeAsync(ct)` recomputes homes and trips from the stored nights; it rebuilds no nights. It runs in the request of every edit that changes homes or trips. It and `RefreshAsync` hold the same Postgres transaction-level advisory lock, so a worker refresh and an edit never interleave their writes.
- **A point edit is due at once.** Its dirty range is inserted with `created_at = now − Processing:Debounce`, and the worker picks it up on its next pass (`PollInterval`, 5 s).
- **Names** are trimmed. An empty name means "back to the automatic one" (`null`). At most **100 characters**, else 400.
- **Removal size.** At most **50 000 points** per request, else 400.
- **A point is identified by `(device, time)` exactly.** Times travel as **epoch microseconds**, which is `timestamptz`'s precision and an exact integer in a JavaScript number. Milliseconds or ISO strings rounded by the client would miss the stored row.
- **Trip distance.** The `app_setting` key is `tripMinDistanceKm`. Valid values are **5 to 1000** km. A null value means `Detection:TripMinDistanceKm` (default 50). It is not part of the algorithm version, so changing it recomputes trips and never rebuilds the timeline.
- **Web writes.**
  - `postJson`, `putJson` and `deleteJson` in `api/client.ts` throw `ApiError` like `getJson`.
  - After any successful write the app calls `queryClient.invalidateQueries()` with no filter: active queries refetch, and the others are marked stale.
  - Every edit control shows its pending state, and shows an error message with Retry on failure. The panel never goes blank.
  - Forms are inline in the panel or sheet. There are no modal dialogs.

## Review Focus

1. **Edits survive reprocessing and rebuilds.**
   - A renamed place keeps its name after a rebuild.
   - A merge still holds. A future stay near the absorbed place goes to the survivor.
   - Removed points stay removed. Trip edits are re-applied. A user home still wins.
   - Covered by Task 2 `Merge_survives_a_rebuild_and_future_stays_go_to_the_survivor`, Task 3 `Removed_points_stay_out_after_a_rebuild`, Task 4 `Trip_edits_are_reapplied_after_a_refresh`, Task 5 `User_home_period_wins_and_survives_a_rebuild`, and Task 1 `RestartBackfill_keeps_owner_data`.
2. **Merges.**
   - Chains: B merged into A, then A into C, reads as C.
   - No cycles: 409.
   - Separating restores both sides.
   - A survivor whose own segments are gone still counts and is named, if a place merged into it has segments (Plan 2 note).
   - Homes and trips follow a merge at once.
3. **Removing points.**
   - Points are identified by `(device, time)`.
   - The rebuild covers the stays that cross the removed stretch, as ingest's dirty ranges do. The nights of that stretch are refreshed.
   - Undo restores exactly that batch.
   - A point removed twice stays in its first batch.
4. **Concurrency.**
   - An edit during a worker refresh: both finish, and the stored trips match the edit. This rests on the advisory lock.
   - Ingest p95 is unaffected.
5. **Trip edits across a refresh.** An edit is keyed by the detected trip's first night. It still applies after new data moves that detection by a night: the match falls back to the largest overlap.

---

## File structure

```
src/Sporer.Timeline/
    PlaceMatcher.cs                     modify: match merged places' centres, answer the survivor
    HomeOverrides.cs                    create: user periods clip detected ones (pure)
    TripEdits.cs                        create: apply edits to detected trips (pure)
src/Sporer.Api/
    Database/Migrations/0006_edits.sql  create: excluded_point, trip_edit, app_setting; trip.name, trip.detected_id
    Http/JsonWritesMiddleware.cs        create: 415 for a non-JSON write
    Features/Places/{RenamePlaceEndpoint, MergePlaceEndpoint, SeparatePlaceEndpoint, PlaceCandidatesEndpoint}.cs   create
    Features/Places/{GetPlaceEndpoint, PlaceResponse}.cs   modify: merged places
    Features/Points/{GetDayPointsEndpoint, RemovePointsEndpoint, RemovedPointsEndpoints, ExcludedPointStore}.cs   create
    Features/Trips/{EditTripEndpoint, DeleteTripEndpoint, DeletedTripsEndpoints, TripEditStore}.cs   create
    Features/Homes/{HomesEndpoints, HomeStore}.cs          create
    Features/Settings/{SettingsEndpoints, SettingStore}.cs create
    Features/Status/RetryFailedEndpoint.cs                 create
    Features/Timeline/{PointStore, PlaceStore, ProcessingQueue, TimelineProcessor}.cs   modify
    Features/Trips/{TripRefresher, TripStore}.cs           modify: RecomputeAsync, lock, edits, overrides, threshold
tests/Sporer.Timeline.Tests/{PlaceMatcherTests, HomeOverridesTests, TripEditsTests}.cs
tests/Sporer.Api.Tests/{WritesTests, RenameMergeTests, PointsTests, TripEditTests, HomesSettingsTests}.cs
web/src/api/{client.ts, types.ts, queries.ts, mutations.ts}
web/src/app/{router.ts, App.tsx, useViewMap.ts}
web/src/views/{TopBar, PlacePanel, PlacePicker, TripPanel, DayPanel, EditBar, SettingsPanel, Toast}.tsx (+ .module.css)
web/src/map/{layers.ts, MapView.tsx, AreaSelect.tsx}
web/e2e/{edit-place.spec.ts, edit-points.spec.ts, edit-trip.spec.ts, settings.spec.ts, sheet.ts}
README.md, docs/superpowers/plans/2026-10-28-sporer-plan-4-perf.md
```

---

### Task 1: Write foundation and renaming a place (server)

**Files:**
- Create: `0006_edits.sql`, `Http/JsonWritesMiddleware.cs`, `Features/Places/RenamePlaceEndpoint.cs`
- Modify: `Program.cs`, `ProcessingQueue.cs`
- Test: `WritesTests.cs`, `RenameMergeTests.cs`, `MigrationTests.cs`

**Interfaces:**
- **Migration `0006_edits.sql`:**
  ```sql
  create table if not exists excluded_point (
      device text not null, time timestamptz not null, batch_id uuid not null,
      excluded_at timestamptz not null default now(), primary key (device, time));
  create index if not exists ix_excluded_point_batch on excluded_point (batch_id);
  create table if not exists trip_edit (
      detected_id date primary key,                 -- the detected trip's first night when the edit was made
      detected_last_night date not null,
      name text null, start_date date null, end_date date null,  -- local dates; null = as detected
      deleted boolean not null default false, deleted_label text null,
      updated_at timestamptz not null default now());
  create table if not exists app_setting (key text primary key, value jsonb not null, updated_at timestamptz not null default now());
  alter table trip add column if not exists name text null;           -- the owner's name, null = automatic
  alter table trip add column if not exists detected_id date null;    -- the detected first night when the trip was edited
  ```
- **`PUT /api/places/{id}/name`** with body `{ "name": string | null }`.
  - The id resolves to its survivor, and the name is set on the survivor.
  - Answers 200 with the place detail (the same shape as `GET /api/places/{id}`).
  - A name over 100 characters gets 400. An unknown place gets 404.
- **`JsonWritesMiddleware`:** a `POST`, `PUT` or `PATCH` under `/api` (except `/api/overland`) with a body that is not `application/json` (charset allowed) gets 415.

- [ ] **Step 1: Write the failing tests.**
  - `Write_with_a_form_body_is_415`
  - `Write_with_json_passes`
  - `Overland_keeps_its_own_rules`
  - `Rename_sets_the_name_everywhere`: the place, day and range answers, and a trip city line where the place is a highlight.
  - `Rename_of_a_merged_id_names_the_survivor`
  - `Rename_empty_resets_to_the_osm_name`
  - `Rename_too_long_is_400`
  - `Rename_unknown_is_404`
  - `Rename_survives_a_rebuild`: bump the algorithm version and backfill again.
  - `RestartBackfill_keeps_owner_data`: user name, merge, excluded point, trip_edit, user home period, app_setting.
  - `Migration_0006_creates_its_tables_and_leaves_locationlog_alone`
- [ ] **Step 2: Run to fail.** Command: `dotnet test src/Sporer.sln --filter "FullyQualifiedName~Writes|FullyQualifiedName~Rename|FullyQualifiedName~Migration"`.
- [ ] **Step 3: Implement.**
  - Register the middleware before endpoints, inside the exception handler.
  - Make `RestartBackfillAsync` keep the new tables. It never touches them today; the test pins it.
  - Rename is one `update place set user_name = @Name where id = <survivor>`.
- [ ] **Step 4: Run to pass**, then run the full `dotnet test src/Sporer.sln`.
- [ ] **Step 5: Commit.** Message: `Accept JSON writes only, and rename places`.

---

### Task 2: Merge and separate places (server)

**Files:**
- Modify: `src/Sporer.Timeline/PlaceMatcher.cs`, `PlaceStore.cs`, `TimelineProcessor.cs`, `TripRefresher.cs`, `GetPlaceEndpoint.cs`, `PlaceResponse.cs`
- Create: `MergePlaceEndpoint.cs`, `SeparatePlaceEndpoint.cs`, `PlaceCandidatesEndpoint.cs`
- Test: `PlaceMatcherTests.cs`, `RenameMergeTests.cs`, `TripRefresherTests.cs`

**Interfaces:**
- **`POST /api/places/{id}/merge`** with body `{ "place": long, "name": string | null }`.
  - The place `place` (resolved to its survivor) is merged into `id` (resolved to its survivor): `merged_into_id = id`. The place you are on survives.
  - A non-null `name` becomes the survivor's `user_name`. The client sends the name the owner chose to keep.
  - Answers 200 with the survivor's detail.
  - The same survivor on both sides gets 409. An unknown place gets 404.
- **`DELETE /api/places/{id}/merged/{other}`.** Only a place merged **directly** into `id` can be separated; it gets `merged_into_id = null`. Answers 204, or 404 for a place that is not merged into `id`.
- **`GET /api/places/{id}` gains** `"merged": [{ "id", "name" }]`, the places merged directly into it, by name.
- **`GET /api/places/{id}/candidates?q=`.** At most 20 places in use (survivors, not `id`), each `{ "id", "name", "address", "distanceM", "visits" }`.
  - Without `q`: the nearest first.
  - With `q`: those whose name or address contains `q` (case-insensitive), nearest first.
- **Matching.** `PlaceMatcher` takes `(Id, Centre, SurvivorId)` for **every** place. A stay within the radius of a merged place's centre matches its survivor; the nearest centre wins, as today. `PlaceStore.LoadMatchableAsync` replaces `LoadActiveAsync` in `TimelineProcessor`.
- **In use.** `PlaceStore.InUse` counts the segments of the places merged into a survivor. A survivor that has lost its own segments is still named and counted (Plan 2 note).
- **`ITripRefresher.RecomputeAsync(CancellationToken)`.** It rebuilds no nights: it recomputes homes and trips from the stored nights. It shares the advisory lock with `RefreshAsync` (`pg_advisory_xact_lock(<one constant>)`, taken in the writing transaction before anything is read for it). Merge and separate call it before answering.

- [ ] **Step 1: Write the failing tests.**
  - `PlaceMatcher_matches_a_merged_place_to_its_survivor`
  - `PlaceMatcher_nearest_centre_wins_across_merged_and_active`
  - `Merge_moves_visits_and_keeps_the_chosen_name`: the day, range and place totals; `visits` adds up.
  - `Merge_chain_reads_as_the_last_survivor`
  - `Merge_into_itself_is_409`
  - `Merge_unknown_is_404`
  - `Merged_place_response_id_differs_from_route_id`: Plan 2 note.
  - `Separate_restores_both_places`
  - `Separate_a_place_not_merged_here_is_404`
  - `Survivor_without_own_segments_is_still_named_and_counted`
  - `Merge_survives_a_rebuild_and_future_stays_go_to_the_survivor`
  - `Merge_recomputes_homes_at_once`: two home fragments more than 250 m apart, merged, become one home.
  - `Recompute_and_refresh_do_not_interleave`: two concurrent calls; the stored trips are those of the second.
  - `Candidates_nearest_first_and_by_name`
- [ ] **Step 2: Run to fail.** **Step 3: Implement.** **Step 4: Run to pass** (full suite).
- [ ] **Step 5: Commit.** Message: `Merge and separate places, and match future stays to the survivor`.

---

### Task 3: Remove and restore points (server)

**Files:**
- Create: `Features/Points/*`
- Modify: `PointStore.cs`, `ProcessingQueue.cs`
- Test: `PointsTests.cs`

**Interfaces:**
- **`GET /api/day/{date}/points`.** The raw points of the local day that are not removed: `{ "date", "devices": [string], "points": [[t, lon, lat, deviceIndex]] }`, in time order, where `t` is the point's exact time in **epoch microseconds**.
  - The day's span comes from `DaySpan.Of(date, zone)`, with the zone that `GET /api/day` would use for that date; the builder finds it there.
  - A day with no points gets `points: []`.
- **`POST /api/points/remove`** with body `{ "points": [{ "device": string, "t": epochMicros }] }`.
  - Inserts the points into `excluded_point` with one new `batch_id`, using `on conflict do nothing`.
  - Then inserts one dirty range from the first to the last removed time, due at once.
  - Answers `{ "batch": uuid, "count": int }`, where `count` is the number inserted.
  - Points that do not exist are ignored. More than 50 000 points gets 400.
- **`GET /api/points/removed`.** One entry per batch, newest first: `{ "batch", "removedAt", "count", "from", "to", "localDates": [yyyy-MM-dd] }`.
- **`DELETE /api/points/removed/{batch}`.** Restores the batch: deletes its rows and inserts a dirty range over its span, due at once. Answers 204, or 404 for an unknown batch.
- **Reads leave removed points out.** `PointStore.LoadAsync` and `NearestAsync` use `not exists (select 1 from excluded_point e where e.device = l.device and e.time = l.time)`.

- [ ] **Step 1: Write the failing tests.**
  - `Points_of_a_day_in_its_own_zone`
  - `Points_leave_out_removed_ones`
  - `Remove_hides_points_and_rebuilds_the_day`: a GPS spike removed; after the worker runs, the move no longer goes through it.
  - `Remove_is_due_at_once`
  - `Remove_twice_keeps_the_first_batch`
  - `Remove_matches_a_point_with_sub_millisecond_time`
  - `Remove_over_limit_is_400`
  - `Restore_brings_the_batch_back_and_rebuilds`
  - `Restore_unknown_batch_is_404`
  - `Removed_points_stay_out_after_a_rebuild`
  - `Night_point_ignores_removed_points`
  - `Removed_list_newest_first_with_local_dates`
- [ ] **Steps 2–4** as in Task 1.
- [ ] **Step 5: Commit.** Message: `Remove and restore raw points without deleting them`.

---

### Task 4: Trip edits (server)

**Files:**
- Create: `src/Sporer.Timeline/TripEdits.cs`, `Features/Trips/{EditTripEndpoint, DeleteTripEndpoint, DeletedTripsEndpoints, TripEditStore}.cs`
- Modify: `TripRefresher.cs`, `TripStore.cs`, `TripsResponse.cs`
- Test: `TripEditsTests.cs`, `TripEditTests.cs`

**Interfaces:**
- **`TripEdit(DateOnly DetectedId, DateOnly DetectedLastNight, string? Name, DateOnly? StartDate, DateOnly? EndDate, bool Deleted)`.**
- **`static IReadOnlyList<EditedTrip> TripEdits.Apply(IReadOnlyList<DetectedTrip> trips, IReadOnlyList<TripEdit> edits, Func<DateTime, string?> zoneAt)`.** Each edit matches the detected trip whose first night is its `DetectedId`. Failing that, it matches the detected trip that overlaps `[DetectedId, DetectedLastNight]` most. One edit per trip. An edit that matches nothing waits, unapplied.
  - A deleted trip is dropped.
  - `Name` is carried.
  - Start and end dates replace the local start and end dates. The span then runs from local midnight of the start date to local midnight after the end date, in the zones of those instants (`LocalTime.ToUtc`). The nights are `[start, end − 1]`, and the trip is no longer ongoing.
  - `EditedTrip` is `DetectedTrip` plus `Name` and `DetectedId`.
- **`PUT /api/trips/{id}`** with body `{ "name": string | null, "startDate": "yyyy-MM-dd" | null, "endDate": "yyyy-MM-dd" | null }`. It replaces the edit of that trip; nulls mean "as detected".
  - `{id}` is the trip's current id, and the edit is keyed by the trip's `detected_id`, or its id when it has none.
  - Start must be before end, else 400. An edited span that overlaps another trip gets 409.
  - The endpoint recomputes, then answers `{ "id" }`, the trip's new id: its first night may have moved. An unknown trip gets 404.
- **`DELETE /api/trips/{id}`.** Sets `deleted` and records `deleted_label` (`"Lisbon · 12 – 16 Sep 2026"`), then recomputes. Answers 204.
- **`GET /api/trips/deleted`.** `[{ "key": detectedId, "label", "deletedAt" }]`, newest first.
- **`POST /api/trips/deleted/{key}/restore`.** Clears `deleted` and recomputes. Answers 204.
- **The refresher applies edits.** Both `RefreshAsync` and `RecomputeAsync` apply the edits after `TripDetector.Detect`. They store `trip.name` and `trip.detected_id`, the latter only when it differs from the id.
- **Reads.** The trip and trips responses use `trip.name` over the automatic name, and gain `"edited": bool`.

- [ ] **Step 1: Write the failing tests.**
  - `TripEdits_rename_keeps_dates`
  - `TripEdits_dates_move_the_span_to_local_midnights_in_their_zones`
  - `TripEdits_delete_drops_the_trip`
  - `TripEdits_fall_back_to_the_largest_overlap_when_detection_moves_a_night`
  - `TripEdits_unmatched_edit_waits`
  - `Trip_rename_shows_in_list_and_detail`
  - `Trip_dates_change_id_days_and_stats`
  - `Trip_dates_overlapping_another_trip_is_409`
  - `Trip_start_after_end_is_400`
  - `Trip_delete_and_restore`
  - `Trip_edits_are_reapplied_after_a_refresh`
  - `Trip_edits_survive_a_rebuild`
- [ ] **Steps 2–4** as before.
- [ ] **Step 5: Commit.** Message: `Rename, re-date and delete trips, re-applied on every refresh`.

---

### Task 5: Home override, trip distance, retry (server)

**Files:**
- Create: `src/Sporer.Timeline/HomeOverrides.cs`, `Features/Homes/*`, `Features/Settings/*`, `Features/Status/RetryFailedEndpoint.cs`
- Modify: `TripRefresher.cs`, `TripStore.cs`, `ProcessingQueue.cs`, `GetTripsEndpoint.cs`
- Test: `HomeOverridesTests.cs`, `HomesSettingsTests.cs`

**Interfaces:**
- **`static IReadOnlyList<HomePeriod> HomeOverrides.Apply(IReadOnlyList<HomePeriod> detected, IReadOnlyList<HomePeriod> user)`.** User periods win on their dates; detected periods are cut or split around them. The result is in date order with no overlaps. An open user period runs to the end.
- **The refresher uses the effective homes.** `RefreshAsync` and `RecomputeAsync` read the user periods and pass `HomeOverrides.Apply(detected, user)` to `TripDetector`. They load positions for the user periods' places too. Only detected rows are rewritten.
- **The trip distance.** The refresher reads `app_setting.tripMinDistanceKm` and passes `options with { TripMinDistanceKm = … }`.
- **`GET /api/homes`.** `{ "periods": [{ "id", "placeId", "placeName", "from", "to", "source" }] }`: detected and user periods, in date order.
- **`POST /api/homes`** with body `{ "placeId", "from", "to": date | null }`.
  - From after to gets 400. An unknown place gets 404. Overlapping another user period gets 409.
  - Recomputes, then answers 201 with the period.
- **`DELETE /api/homes/{id}`.** Only a user period can be deleted; a detected one gets 409. Recomputes, then answers 204.
- **`GET /api/settings`.** `{ "tripMinDistanceKm": number, "tripMinDistanceKmDefault": number }`.
- **`PUT /api/settings`** with body `{ "tripMinDistanceKm": number | null }`. A value outside 5–1000 gets 400. Recomputes, then answers 200 with the settings.
- **`POST /api/status/retry`.** Makes every failed dirty range due now: `attempts = 0`, `next_attempt_at = null`. Answers `{ "retried": int }`.
- **Thumbnail end.** The list's `HomeAtEnd` is the home of the night **after** the trip (P3-R34a), so a trip that ends at a new home draws its line to the new home.

- [ ] **Step 1: Write the failing tests.**
  - `HomeOverrides_user_period_splits_a_detected_one`
  - `HomeOverrides_open_user_period_runs_to_the_end`
  - `HomeOverrides_none_keeps_detected`
  - `User_home_period_wins_and_survives_a_rebuild`: the trips are recomputed against it.
  - `Home_override_overlapping_user_period_is_409`
  - `Deleting_a_detected_period_is_409`
  - `Trip_distance_setting_recomputes_trips_without_a_rebuild`: the algorithm version is unchanged, and a 60 km trip disappears at 80 km.
  - `Trip_distance_out_of_range_is_400`
  - `Retry_makes_failed_ranges_due`
  - `Thumbnail_of_a_trip_ending_at_a_new_home_ends_there`
- [ ] **Steps 2–4** as before.
- [ ] **Step 5: Commit.** Message: `Override home, set the trip distance, retry failed work`.

---

### Task 6: Web write helpers, Settings route and page shell

**Files:**
- Modify: `client.ts`, `types.ts`, `queries.ts`, `router.ts`, `App.tsx`, `TopBar.tsx`, `useViewMap.ts`
- Create: `api/mutations.ts`, `views/SettingsPanel.tsx`, `views/Toast.tsx`
- Test: unit tests; `e2e/settings.spec.ts`

**Interfaces:**
- **Client helpers:** `postJson<T>(path, body)`, `putJson<T>(path, body)` and `deleteJson(path)` send `Content-Type: application/json`.
- **Mutations.** `useWrite(fn)` wraps `useMutation`. It invalidates every query on success.
- **Route `/settings`.**
  - `{ view: "settings" }`; `isPeriodRoute` is false for it.
  - A **gear button** labelled "Settings" sits next to Trips in the top bar.
  - The map draws nothing new: the drawing of the route before stays, as for a place.
- **SettingsPanel sections**, in this order: Home, Trips, Deleted trips, Removed points, Processing, About.
  - This task fills **Processing** and **About**; Tasks 9 and 10 fill the others.
  - **Processing:** backfill percent, last processed time, pending ranges, failed ranges with their error, and **Retry failed**.
  - **About:** the full credit with links (OpenStreetMap contributors, OpenFreeMap, OpenMapTiles) and the algorithm version.
- **`Toast`:** a small message at the bottom of the panel with an optional action button. Used for Undo in Task 8.

- [ ] **Step 1: Write the failing tests.**
  - client: the three helpers set the JSON content type and throw on failure.
  - mutations: success invalidates every query; an error is exposed for the UI.
  - router: `/settings` round-trips.
  - TopBar: the Settings button navigates.
  - SettingsPanel: processing shows the failed ranges and Retry calls `POST /api/status/retry`; About shows the three credits.
  - e2e: phone and desktop open Settings from the gear and see Processing and About.
- [ ] **Step 2: Run to fail.** **Step 3: Implement.** **Step 4: Run to pass**: typecheck, vitest and e2e.
- [ ] **Step 5: Commit.** Message: `Add write helpers and a Settings page`.

---

### Task 7: Rename, merge and separate places (web)

**Files:**
- Modify: `PlacePanel.tsx`
- Create: `views/PlacePicker.tsx`
- Test: `PlacePanel.test.tsx`, `PlacePicker.test.tsx`, `e2e/edit-place.spec.ts`

**Interfaces:**
- **Rename.** "Rename" opens an inline field with the current name; the OSM name is the placeholder. Save sends `PUT /api/places/{id}/name`. Cancel and Escape close it.
- **Merge.**
  - "Merge with…" opens `PlacePicker`: a search field, debounced 300 ms, over `GET /api/places/{id}/candidates`, and the list (name, address, distance, visits).
  - Choosing one shows a confirm block: "Merge {B} into {A}?", with radio buttons for the name to keep (A's or B's), then **Merge** and **Cancel**.
  - Merge sends `POST /api/places/{id}/merge`.
- **Merged places.** A section lists the places merged into this one, each with **Separate**.
- **Picker reuse.** The picker is reused by Task 10 for the home override.

- [ ] **Step 1: Write the failing tests.**
  - Rename: save, cancel, an empty name resets, and an error shows with Retry.
  - The picker searches and lists.
  - The merge confirm keeps the chosen name.
  - Separate.
  - e2e on phone and desktop: rename a place, then merge another into it. Both show in the place list and the day list.
- [ ] **Steps 2–4** as in Task 6.
- [ ] **Step 5: Commit.** Message: `Rename, merge and separate places from the place view`.

---

### Task 8: Edit mode for points (web)

**Files:**
- Modify: `DayPanel.tsx`, `layers.ts`, `MapView.tsx`, `useViewMap.ts`, `queries.ts`
- Create: `views/EditBar.tsx`, `map/AreaSelect.tsx`
- Test: unit tests; `e2e/edit-points.spec.ts`

**Interfaces:**
- **Entering edit mode.** An **Edit points** button in the Day panel header, on a day with data, turns edit mode on. The mode is component state, not URL state: leaving the day leaves edit mode.
- **The points on the map.**
  - `useDayPoints(date, enabled)` reads them.
  - They are drawn as 4 px dots in layer `sporer-edit-points`, above the routes. A selected point is 7 px and red, through feature state on a numeric id.
- **Selecting.**
  - Tapping a point toggles it. Use the existing tap slop: the nearest point within 12 px.
  - **Select area**, a map button shown only in edit mode, turns area selection on. Dragging then draws a rectangle instead of panning, and on release adds every point inside it. It stays on until tapped again.
  - On desktop, shift-drag does the same. MapLibre's `boxZoom` is off while in edit mode.
- **`EditBar`**, in the sheet and the sidebar, shows "{n} selected", **Clear**, **Remove {n} points** and **Done**.
- **Removing.**
  - Remove sends `POST /api/points/remove`. It shows the Toast "Removed {n} points" with **Undo** for 10 s; Undo sends `DELETE /api/points/removed/{batch}`.
  - The day goes `pending`. While pending after an edit, the day refetches every **3 s for up to 2 min**, then the usual 30 s.
- **Large days.** Dense synthetic days have about 40 000 points. Selection uses feature state, never `setData` per tap.

- [ ] **Step 1: Write the failing tests.**
  - The layer and feature state for selection.
  - Tap toggles; area select adds the points inside.
  - The EditBar counts.
  - Remove, then Undo.
  - Polling while pending.
  - e2e on phone and desktop: remove two points of a fixture day by tap, and a cluster by area. Undo restores them. The day shows pending, then the rebuilt answer (mocked).
- [ ] **Steps 2–4** as before.
- [ ] **Step 5: Commit.** Message: `Edit mode: remove points by tap or area, with Undo`.

---

### Task 9: Trip edits (web)

**Files:**
- Modify: `TripPanel.tsx`, `SettingsPanel.tsx`
- Test: `TripPanel.test.tsx`, `SettingsPanel.test.tsx`, `e2e/edit-trip.spec.ts`

**Interfaces:**
- **Edit form.** **Edit** in the Trip panel opens an inline form:
  - **Name**, with the automatic name as placeholder;
  - **Start date** and **End date**, native date inputs prefilled with the trip's local dates;
  - **Save** and **Cancel**.
- **After saving,** the app navigates (replace) to `/trip/{newId}` when the id changed. A 409 shows "Overlaps another trip".
- **Deleting.** **Delete trip** asks inline: "Delete this trip? It stays deleted when your data is reprocessed. You can restore it in Settings." with **Delete** and **Cancel**. After deleting, the app navigates to `/trips`.
- **Settings: Deleted trips** lists them with **Restore**.

- [ ] **Step 1: Write the failing tests.**
  - Rename.
  - Changing dates navigates to the new id.
  - The overlap error.
  - Delete navigates to the list.
  - Restore in Settings.
  - e2e on phone and desktop.
- [ ] **Steps 2–4** as before.
- [ ] **Step 5: Commit.** Message: `Rename, re-date, delete and restore trips`.

---

### Task 10: Settings: home, trip distance, removed points (web)

**Files:**
- Modify: `SettingsPanel.tsx`, `TripsPanel.tsx`
- Test: `SettingsPanel.test.tsx`, `TripsPanel.test.tsx`, `e2e/settings.spec.ts`

**Interfaces:**
- **Home.** The periods are listed in date order: place name, dates, and "Detected" or "Set by you". **Set home** opens an inline form with a place picker (`PlacePicker`), From, and To (optional). A user period has **Remove**.
- **Trips.** A number field for the trip distance in km, with **Save** and **Reset to default ({default} km)**.
- **Removed points.** Batches, newest first: local dates, count and when removed, each with **Restore**.
- **Empty trips list.** Its message reads the distance from `GET /api/settings` instead of "50 km" (P3-R31).

- [ ] **Step 1: Write the failing tests** for each section's load, save, error and Retry, and the empty-state text. e2e on phone and desktop: set a home override, change the distance, restore a batch.
- [ ] **Steps 2–4** as before.
- [ ] **Step 5: Commit.** Message: `Settings: home override, trip distance and removed points`.

---

### Task 11: Performance, README and the owner's checklist

**Files:**
- Create: `docs/superpowers/plans/2026-10-28-sporer-plan-4-perf.md`
- Modify: `README.md`, `tools/perf/` (edit timings), `web/e2e/sheet.ts`

- [ ] **Step 1: Server, on the 10.7 M-row synthetic history** (the method of the Plan 3 perf doc). Measure:
  - **Backfill** with 1 000 excluded points spread over the history. Target: at most +5 % on Plan 3's figure on this machine.
  - **Edits.** The p95 over 20 of `PUT /api/trips/{id}`, `POST /api/places/{id}/merge` and `PUT /api/settings`, which run the recompute. Target: at most 300 ms.
  - **`GET /api/day/{date}/points`.** The p95 for typical days, and the heaviest day with its size. Target: at most 400 ms, the same as a month.
  - The `EXPLAIN` of the removal anti-join in `LoadAsync`.
- [ ] **Step 2: Web.** Phone project at 4× CPU: time from entering edit mode to the points drawn, on the heaviest day. Target: at most 2 s.
- [ ] **Step 3: Fix misses,** with a re-measurement, and never by changing results.
- [ ] **Step 4: `sheetAtRest`** waits for the restored view's content after a navigation (P3-R34b).
- [ ] **Step 5: README.**
  - The new endpoints and editing.
  - What survives a rebuild.
  - The **owner's checklist**:
    - rename a place, and merge two places (one of them home);
    - remove a GPS spike and undo it, then remove it for good;
    - re-date and rename a trip, delete one and restore it;
    - set a home override and see the trips follow;
    - change the trip distance.
- [ ] **Step 6: Commit.** Message: `Record editing performance and document editing`.

---

## Out of scope (Plan 5)

- The service worker (cached app shell), a WebKit smoke project in CI, and caching the Playwright browsers in CI.
- The final §8 performance pass on the owner's phone.
- Plan 1's `day-latency.sh` seed under mawk, and a warm-up for the first refresh after a start (P3-R26).
- Undo for a merge beyond **Separate**, and editing which points belong to a stay.
