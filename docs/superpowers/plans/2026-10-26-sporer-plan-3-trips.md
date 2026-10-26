# Sporer Plan 3 — Home and trips: detection, trips list, trip view, house icon

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Find where the owner lives and when they were away overnight. Show the trips as a list and as a map ("where I've been on trips"), and mark home with a house icon in the Day view.

**Architecture:**
- **Server.** The background worker gains one step after it rebuilds segments. It works out the night location of every night touched (03:00 local) and stores it in `night`. From all stored nights it then recomputes the home periods and the trips. That is cheap: a few thousand rows held in memory, using pure functions in `Sporer.Timeline`. The results are stored in `home_period` and `trip`.
- **Read endpoints.** `/api/trips` and `/api/trips/{id}` read those tables. Names, cities and day summaries are put together at read time, so they follow geocoding and future renames without reprocessing.
- **Web app.** It gains `/trips` and `/trip/{id}` routes, a Trips entry in the top bar, a trips panel with route thumbnails, and a trip panel. The map shows every trip's cities on `/trips`, and one trip's routes with city dots ("Lisbon · 4 nights") on `/trip/{id}`.

**Tech Stack:** unchanged from Plan 2. No new dependencies on either side.

**Spec:** `docs/superpowers/specs/2026-10-23-sporer-web-app-design.md` (approved). Sections used: §4.1 (routes and entry points), §4.2 (house icon), §4.5 (trips), §6.6 (home, trips), §7.1–7.3, and §9 (tests: home moving, one-night and many-night trips, a time-zone change mid-trip). Mockup 3: `docs/superpowers/specs/assets/2026-10-23-map-views-mockup.html`. Earlier decisions: `docs/superpowers/plans/2026-10-23-sporer-plan-1-rulings.md` and `docs/superpowers/plans/2026-10-24-sporer-plan-2-rulings.md`.

**Plan series.** Plans 1 and 2 are merged. This is Plan 3, which builds spec phase 5. Plan 4 adds editing: rename and merge places, remove and restore points, trip edits (rename, dates, delete), and Settings with the home override and the trip threshold. It also adds the service worker, a WebKit CI project and the final performance pass.

## Environment setup (once per container)

As in Plan 2:
- .NET 10 SDK.
- The Docker daemon for Testcontainers. If `docker ps` fails, run `nohup dockerd >/tmp/dockerd.log 2>&1 &` and wait.
- Node 22.
- Playwright browsers in `/opt/pw-browsers`. Never run `playwright install` locally.
- No map hosts are reachable: web tests use the local test style and mocked API responses.

## Global Constraints

- **Earlier constraints.** Every Plan 1 and Plan 2 constraint still applies:
  - Existing `locationLog` rows are never updated or deleted. Its schema is not changed again.
  - Migrations create new objects only.
  - Ingest never waits on processing.
  - Web dependencies stay exactly as pinned; styling is CSS Modules plus custom properties.
  - TypeScript stays strict.
  - Every view has loading, empty and error states with Retry.
  - `GET /api/*` keeps the strong ETag, `Cache-Control: no-cache` and 304.
  - No test makes an external request.
  - Never skip, disable or quarantine a test. Test output stays pristine.
- **A night** is identified by the date of its evening. The night of `2026-10-22` is located at **03:00 local time on 2026-10-23** (spec §6.6), in the zone of where the person was then.
- **The night location** is the stay covering that instant. Failing that, it is the nearest raw point within **12 hours**. Failing that, the night is unknown.
- **Home** is a place that is the night location on **at least 60 of 90** consecutive nights (calendar nights; unknown nights count against it).
  - A new home is backdated to its first night in that 90-night window. The first home ever is backdated to the first night of the history.
  - A stay below the bar never becomes home; it stays a trip.
- **Away** means the night location is **≥ 50 km** (default; configurable) from the home in effect that night. A night with no home in effect is never away.
- **A trip** is a maximal run of consecutive away nights.
  - Unknown nights between two away nights belong to the trip. Unknown nights never start or end one.
  - The trip leaves when the last stay within the threshold of home ends, and returns when the first such stay begins.
  - A trip whose last away night is the last stored night is **ongoing** and has no end.
- **Trip id** = the date of the trip's first away night, `YYYY-MM-DD`. It is stable across reprocessing as long as the trip starts the same night.
  - Routes: `/trips` and `/trip/YYYY-MM-DD`.
  - Endpoints: `GET /api/trips` and `GET /api/trips/{id}`. An id that is not a stored trip gets a 404.
- **Names and labels are in English** (owner). City and country come from the places' Nominatim fields (`accept-language=en`).
  - The trip label format is `"Lisbon · 4 nights"`, or `"1 night"` for one.
  - Auto-names follow the spec §6.6 rules, refined in Task 5.
- **Trips list** is newest first.
- **The home in effect** for a stay is the home period that covers the day being viewed.
  - The Day view draws a home stay with a house icon in place of its number.
  - The numbers count only the other stays with a place, on the map and in the list alike (refines P2-R16).

## Review Focus

1. **Phone off overnight.** No stay covers 03:00 because a gap or a flight crosses the night.
   - The nearest point within 12 h decides the night; with none, the night is unknown.
   - A trip carries on across unknown nights between away nights, and is never started by one. Two short trips separated only by a phone-off night are one trip.
   - Covered by Task 1 `HomeDetector_ignores_unknown_nights…`, Task 2 `TripDetector_bridges_unknown_nights_inside_a_trip_but_never_starts_one`, and Task 3 `NightBuilder_uses_the_nearest_point…` and `…unknown_when_nothing_is_within_12_hours`.
2. **Crossing time zones.**
   - Lisbon→Tokyo nights are located at 03:00 Tokyo time.
   - The trip's local start and end dates are each in their own zone.
   - A night that crosses the clocks-go-back change still has exactly one 03:00.
   - Covered by Task 1 `NightClock_follows_a_flight_into_another_zone` and `NightClock_on_the_night_the_clocks_go_back`, and Task 2 `TripDetector_trip_across_zones_has_local_dates_in_its_own_zones`.
3. **Stays of 3+ weeks and moving house** (owner: "maybe").
   - A 24-night stay abroad stays a trip, and home does not flip.
   - A house move (7 km in the synthetic data) switches home on the move night, found late but backdated.
   - Covered by Task 1 `HomeDetector_keeps_home_through_a_long_stay_below_the_bar` and `…switches_home_after_60_of_90_nights_and_backdates…`, and Task 4 `Synthetic_year_gives_its_three_trips_and_the_house_move`.
4. **Away right now.**
   - The current trip is listed as ongoing with no end, and its days run to the last night.
   - Tonight, which has not happened yet, is never counted.
   - Covered by Task 2 `TripDetector_trip_reaching_the_last_night_is_ongoing`, Task 3 `NightBuilder_skips_nights_that_have_not_happened`, Task 5 `Trips_ongoing_trip_has_no_end`, and Task 9 `TripsPanel_shows_an_ongoing_trip`.
5. **Places not geocoded yet** (Nominatim backlog or failures).
   - A trip still gets a sensible name: country, else "Trip".
   - The name updates when geocoding finishes, without reprocessing.
   - Covered by Task 5 `Trips_name_follows_geocoding_without_reprocessing` and `TripNaming_*`.

---

## File structure

```
src/Sporer.Timeline/
    DetectionOptions.cs                 modify: NightHour, NightPointWindow, HomeWindowNights, HomeMinNights, TripMinDistanceKm
    Nights.cs                           create: Night, HomePeriod, StayPosition, DetectedTrip records
    NightClock.cs                       create: the 03:00 instant of a night
    HomeDetector.cs                     create
    TripDetector.cs                     create
src/Sporer.Api/
    Database/Migrations/0005_home_trips.sql      create: night, home_period, trip, night_refresh
    Features/Timeline/TimelineProcessor.cs       modify: ReprocessAsync returns ReprocessResult
    Features/Timeline/TimelineWorker.cs          modify: record rebuilt windows, refresh nights and trips once per pass
    Features/Timeline/ProcessingQueue.cs         modify: RestartBackfillAsync also clears night, detected home_period, trip, night_refresh
    Features/Timeline/AlgorithmVersion.cs        modify: CodeVersion = 2
    Features/Timeline/PointStore.cs              modify: NearestAsync
    Features/Timeline/SegmentStore.cs            modify: FindCoveringAsync, LoadStayPositionsAsync
    Features/Timeline/PlaceStore.cs              modify: LoadSurvivorsAsync, LoadPositionsAsync
    Features/Trips/NightBuilder.cs               create: nights of a window from segments and points
    Features/Trips/NightStore.cs                 create
    Features/Trips/TripStore.cs                  create: write side (homes, trips, pending window) and read side
    Features/Trips/TripRefresher.cs              create
    Features/Trips/TripNaming.cs                 create: names, city groups, day lines (pure)
    Features/Trips/{GetTripsEndpoint, GetTripEndpoint, TripsResponse, TripResponse}.cs   create
    Features/Day/{DayResponse, GetDayEndpoint}.cs   modify: stays carry "home"
    Program.cs                                   modify: register the new services
tools/Sporer.SyntheticData/Simulator.cs          modify: Simulator.Describe(options) exposes the planned trips and move day
tests/Sporer.Timeline.Tests/{NightClockTests, HomeDetectorTests, TripDetectorTests}.cs
tests/Sporer.Api.Tests/{NightBuilderTests, TripRefresherTests, TripsEndpointTests, TripEndpointTests, TripNamingTests, SyntheticTripsTests}.cs
web/src/app/router.ts                            modify: trips and trip routes, isPeriodRoute
web/src/api/{types.ts, queries.ts}               modify: trip types and queries
web/src/views/{TopBar.tsx, TripsPanel.tsx, TripPanel.tsx, TripThumbnail.tsx, DayPanel.tsx} (+ .module.css)
web/src/map/{layers.ts, MapView.tsx}             modify: trip and trips drawings, house icon
web/src/app/{App.tsx, useViewMap.ts}             modify: panels and map kinds for trips and trip
web/e2e/{trips.spec.ts, fixtures/trips.json, fixtures/trip-*.json}
docs/superpowers/plans/2026-10-26-sporer-plan-3-perf.md       create (Task 12)
README.md                                        modify (Task 12)
```

---

### Task 1: Nights, the 03:00 clock and home detection (pure)

**Files:**
- Modify: `src/Sporer.Timeline/DetectionOptions.cs`
- Create: `src/Sporer.Timeline/Nights.cs`, `src/Sporer.Timeline/NightClock.cs`, `src/Sporer.Timeline/HomeDetector.cs`
- Test: `tests/Sporer.Timeline.Tests/NightClockTests.cs`, `tests/Sporer.Timeline.Tests/HomeDetectorTests.cs`, `tests/Sporer.Timeline.Tests/DetectionOptionsTests.cs`

**Interfaces:**
- **Produces, in `DetectionOptions`** (bound from `Detection:` as today):
  - `int NightHour = 3`
  - `TimeSpan NightPointWindow = 12 h`
  - `int HomeWindowNights = 90`
  - `int HomeMinNights = 60`
  - `double TripMinDistanceKm = 50`
- **Produces, in `Nights.cs`:**
  - `record Night(DateOnly Date, DateTime InstantUtc, string Zone, long? PlaceId, GeoPoint? Position)`. A null `Position` means an unknown night. `PlaceId` is the survivor id; the caller resolves merges.
  - `record HomePeriod(long PlaceId, DateOnly From, DateOnly? To)`. Both ends are inclusive night dates; a null `To` is open.
  - `record StayPosition(DateTime StartUtc, DateTime EndUtc, GeoPoint Position)`
  - `record DetectedTrip(DateOnly FirstNight, DateOnly LastNight, int Nights, DateTime StartUtc, DateTime? EndUtc, string StartZone, string EndZone, DateOnly LocalStartDate, DateOnly LocalEndDate)`. Task 2 fills it in.
- **Produces:**
  - `static (DateTime InstantUtc, string Zone)? NightClock.InstantOf(DateOnly night, Func<DateTime, string?> zoneAt, int hour)`
  - `static IReadOnlyList<HomePeriod> HomeDetector.Detect(IReadOnlyList<Night> nights, DetectionOptions options)`, with the result in date order.

- [ ] **Step 1: Write the failing tests.**

```csharp
// NightClockTests: zoneAt is a lambda over a fixed zone, or a step at a given instant
NightClock_is_03_00_local_on_the_next_day        // Oslo, night 2026-10-22 -> 2026-10-23T01:00Z, "Europe/Oslo"
NightClock_on_the_night_the_clocks_go_back       // Oslo, night 2026-10-24 -> 2026-10-25T02:00Z (03:00 CET, once)
NightClock_on_the_night_the_clocks_go_forward    // Oslo, night 2026-03-28 -> 2026-03-29T01:00Z
NightClock_follows_a_flight_into_another_zone    // zoneAt = Lisbon before 2026-05-10T12:00Z, Tokyo after; night 2026-05-10 -> 2026-05-10T18:00Z, "Asia/Tokyo"
NightClock_is_null_without_data                  // zoneAt always null -> null
// HomeDetectorTests: a helper builds consecutive nights from (placeId, count) runs; null place = unknown
HomeDetector_names_the_first_home_from_the_first_night          // A×90 -> [A from night 1, open]
HomeDetector_finds_nothing_below_the_bar                        // A×59 -> []
HomeDetector_switches_home_after_60_of_90_nights_and_backdates_to_the_first_night_there
    // A×100, B×80 -> [A 1..100, B 101..open]
HomeDetector_keeps_home_through_a_long_stay_below_the_bar       // A×100, T×45, A×30 -> [A 1..open]
HomeDetector_ignores_unknown_nights_and_nights_without_a_place  // A×70, unknown×30, A×10 -> [A 1..open]
HomeDetector_moves_back_when_the_old_home_qualifies_again       // A×100, B×90, A×90 -> three periods, the third backdated to the return
DetectionOptions_defaults_for_nights_homes_and_trips            // 3, 12 h, 90, 60, 50
```

- [ ] **Step 2: Run to fail.** `dotnet test src/Sporer.sln --filter "FullyQualifiedName~NightClock|FullyQualifiedName~HomeDetector|FullyQualifiedName~DetectionOptions"`. Expected: FAIL (types missing).

- [ ] **Step 3: Implement `NightClock.InstantOf`.**

  Local `hour:00` on `night + 1` is converted with `TimeZoneInfo`. A time that does not exist moves forward by the gap; an ambiguous one takes its first occurrence. Use `LocalTime`'s zone lookup.

```
z0 = zoneAt(UTC midnight of night+1 + hour h)        -- a first guess, read in UTC
if z0 is null: return null
t1 = local(night+1, hour, z0) as UTC;  z1 = zoneAt(t1) ?? z0
if z1 == z0: return (t1, z0)
t2 = local(night+1, hour, z1) as UTC;  return (t2, z1)   -- two steps at most
```

- [ ] **Step 4: Implement `HomeDetector.Detect`.**

  Nights are by calendar date; a missing date is an unknown night.

```
current = none; periods = []
for each date d from the first night to the last:
    window = nights with date in [d − W + 1, d]           (W = HomeWindowNights)
    best   = the place with the most window nights        (at most one can reach M = HomeMinNights, since 2M > W)
    if count(best) >= M and best != current:
        start = current is none ? first night date : max(earliest window night at best, current.From + 1)
        if current: close current at start − 1
        open a period for best from start; current = best
the last period stays open
```

- [ ] **Step 5: Run to pass.** Run the same command. Expected: PASS.
- [ ] **Step 6: Commit.** Message: `git commit -m "Locate each night at 03:00 and detect home periods"`.

---

### Task 2: Trip detection (pure)

**Files:**
- Create: `src/Sporer.Timeline/TripDetector.cs`
- Test: `tests/Sporer.Timeline.Tests/TripDetectorTests.cs`

**Interfaces:**
- **Consumes:** Task 1's records and options.
- **Produces:** `static IReadOnlyList<DetectedTrip> TripDetector.Detect(IReadOnlyList<Night> nights, IReadOnlyList<HomePeriod> homes, IReadOnlyDictionary<long, GeoPoint> placePositions, IReadOnlyList<StayPosition> stays, DetectionOptions options)`. The result is in date order. `stays` are all stays in time order; they are used only to find when the person left home and when they came back.

- [ ] **Step 1: Write the failing tests.**

  The tests use a home at Oslo, a place 1 km from it, Lisbon (2,700 km away) and Tokyo, with stays built by a helper.

```csharp
TripDetector_one_night_away_is_a_one_night_trip
    // nights home, LIS, home: one trip, FirstNight = LastNight, Nights = 1;
    // StartUtc = end of the last stay within 50 km before the away night, EndUtc = start of the first one after
TripDetector_counts_consecutive_away_nights_as_one_trip                  // 6 Lisbon nights -> one trip, Nights = 6
TripDetector_bridges_unknown_nights_inside_a_trip_but_never_starts_one   // home, LIS, ?, ?, LIS, home -> one trip of 4 nights;
                                                                         // home, ?, LIS, home -> the trip starts at LIS
TripDetector_threshold_is_inclusive_at_50_km                             // 49.9 km -> no trip; 50.0 km -> trip
TripDetector_trip_across_zones_has_local_dates_in_its_own_zones          // Lisbon -> Tokyo: LocalStartDate in Europe/Lisbon, LocalEndDate in the zone it ended in
TripDetector_trip_reaching_the_last_night_is_ongoing                     // last night away -> EndUtc null, LocalEndDate = LastNight + 1
TripDetector_uses_the_home_in_effect_each_night                          // after a home change 17 km away, nights at the new home are not away
TripDetector_finds_nothing_without_a_home
TripDetector_falls_back_to_the_night_instants_without_home_area_stays    // no stay within 50 km between the nights -> start = previous night's instant
```

- [ ] **Step 2: Run to fail.** `dotnet test src/Sporer.sln --filter "FullyQualifiedName~TripDetector"`. Expected: FAIL.

- [ ] **Step 3: Implement `TripDetector.Detect`.**

  Each night is Away, Home or Unknown:
  - **Unknown**: no position.
  - **Home**: no home period covers the date, or the distance from the period's place is below `TripMinDistanceKm`.
  - **Away**: otherwise.

  Missing dates count as Unknown. Each run is cut out like this:

```
runs = maximal stretches that start and end on an Away night and contain no Home night (Unknown nights inside are kept)
for each run [first, last]:
    before = the latest Home night before `first` (unknown nights between them are skipped), or none
    after  = the earliest Home night after `last`, or none
    home position = the home period's place at `first` (for leaving) and at `last` (for returning)
    StartUtc = end of the last stay within the threshold of home that ends in (before.Instant, first.Instant];
               if there is none, before.Instant; if there is no `before`, first.Instant
    EndUtc   = start of the first stay within the threshold of home that starts in [last.Instant, after.Instant);
               if there is none, after.Instant; if there is no `after` (only unknown nights, or none, follow) -> null (ongoing)
    StartZone = before?.Zone ?? first.Zone;  EndZone = after?.Zone ?? last.Zone
    LocalStartDate = local date of StartUtc in StartZone
    LocalEndDate   = EndUtc is null ? last + 1 day : local date of EndUtc in EndZone
    Nights = last − first + 1
```

- [ ] **Step 4: Run to pass.** Run the same command. Expected: PASS.
- [ ] **Step 5: Commit.** Message: `git commit -m "Detect trips from away nights"`.

---

### Task 3: Storage and the nights of a window

**Files:**
- Create: `src/Sporer.Api/Database/Migrations/0005_home_trips.sql`, `src/Sporer.Api/Features/Trips/NightBuilder.cs`, `src/Sporer.Api/Features/Trips/NightStore.cs`
- Modify: `PointStore.cs`, `SegmentStore.cs`, `PlaceStore.cs`
- Test: `tests/Sporer.Api.Tests/NightBuilderTests.cs`; extend `tests/Sporer.Api.Tests/MigrationTests.cs`

**Interfaces:**
- **Migration `0005`** creates only new objects:

```sql
create table if not exists night (
    date date primary key, instant_utc timestamptz not null, zone text not null,
    source text not null check (source in ('stay','point','none')),
    place_id bigint null references place(id), latitude double precision null, longitude double precision null);
create table if not exists home_period (
    id bigserial primary key, place_id bigint not null references place(id),
    from_date date not null, to_date date null, source text not null check (source in ('detected','user')));
create index if not exists ix_home_period_dates on home_period (from_date);
create table if not exists trip (
    id date primary key, last_night date not null, nights int not null,
    start_utc timestamptz not null, end_utc timestamptz null, start_tz text not null, end_tz text not null,
    local_start_date date not null, local_end_date date not null);
create table if not exists night_refresh (
    id int primary key check (id = 1), from_utc timestamptz null, to_utc timestamptz null);
insert into night_refresh (id) values (1) on conflict do nothing;
```

- **New store methods:**
  - `PointStore.NearestAsync(DateTime instantUtc, TimeSpan within, ct) : Task<TrackPoint?>`. It makes two indexed queries (the latest point at or before the instant, the earliest after it) and returns the closer one within `within`.
  - `SegmentStore.FindCoveringAsync(DateTime fromUtc, DateTime toUtc, ct) : Task<IReadOnlyList<StoredSegment>>`. It returns the segments overlapping the window, extended by 36 h on both sides, in time order.
  - `SegmentStore.LoadStayPositionsAsync(ct) : Task<IReadOnlyList<StayPosition>>`. It returns every stay with a position.
  - `PlaceStore.LoadSurvivorsAsync(ct) : Task<IReadOnlyDictionary<long, long>>`. It maps each merged place to its survivor, following chains up to 32 links.
  - `PlaceStore.LoadPositionsAsync(IEnumerable<long> ids, ct) : Task<IReadOnlyDictionary<long, GeoPoint>>`
- **`NightStore`:**
  - `ReplaceAsync(DateOnly from, DateOnly to, IReadOnlyList<(Night Night, string Source)> nights, ct)` deletes the dates in `[from, to]`, then inserts. It takes the shape `NightBuilder` returns.
  - `LoadAllAsync(ct) : Task<IReadOnlyList<Night>>`
- **`NightBuilder.BuildAsync(DateTime fromUtc, DateTime toUtc, ct) : Task<(DateOnly From, DateOnly To, IReadOnlyList<(Night Night, string Source)> Nights)>`.** It covers the UTC dates of `fromUtc` − 1 day to `toUtc` + 1 day.
  - **`zoneAt(t)`** is answered in this order:
    1. The segment covering `t`. A stay gives its zone. A move or gap gives its start zone before its midpoint and its end zone after.
    2. Else the end zone of the latest segment ending before `t`, within 36 h.
    3. Else the start zone of the next segment starting after `t`, within 36 h.
    4. Else null.
  - **The location** is the stay covering the instant (source `stay`: its place, its centre). Else it is `PointStore.NearestAsync` within `NightPointWindow` (source `point`). Its place is the nearest active place within `PlaceRadiusMeters`, using `PlaceMatcher` as the processor does. Else the night is unknown (source `none`, no position).
  - **Nights not yet happened.** A night whose instant is after the latest stored segment end is left out. Its stored row is removed by the replace.

- [ ] **Step 1: Write the failing tests** (Testcontainers; segments via `TimelineSeeder`, points via `PointSeeder`).

```csharp
Migration_0005_creates_the_trip_tables_and_leaves_locationLog_alone   // tables exist; locationlog columns unchanged
NightBuilder_takes_the_stay_covering_03_00                            // source "stay", place id and centre of that stay
NightBuilder_uses_the_nearest_point_when_no_stay_covers_the_night     // a gap over 03:00 -> source "point", the nearer point's position
NightBuilder_matches_a_point_night_to_a_place_within_75_m
NightBuilder_marks_a_night_unknown_when_nothing_is_within_12_hours    // source "none", Position null
NightBuilder_skips_nights_that_have_not_happened                      // the night after the last segment is not built
NightBuilder_locates_a_night_in_Tokyo_at_03_00_Tokyo_time
NightStore_replaces_only_the_window
```

- [ ] **Step 2: Run to fail.** `dotnet test src/Sporer.sln --filter "FullyQualifiedName~NightBuilder|FullyQualifiedName~NightStore|FullyQualifiedName~Migration"`. Expected: FAIL.
- [ ] **Step 3: Implement** the migration, the store methods, `NightStore` and `NightBuilder`.
- [ ] **Step 4: Run to pass.** Run the same command. Expected: PASS.
- [ ] **Step 5: Commit.** Message: `git commit -m "Store nights, homes and trips; build the nights of a window"`.

---

### Task 4: Refresh homes and trips in the worker

**Files:**
- Create: `src/Sporer.Api/Features/Trips/TripStore.cs` (the write side), `src/Sporer.Api/Features/Trips/TripRefresher.cs`
- Modify:
  - `TimelineProcessor.cs`
  - `TimelineWorker.cs`
  - `ProcessingQueue.cs`
  - `AlgorithmVersion.cs`
  - `Program.cs`
  - `tools/Sporer.SyntheticData/Simulator.cs`
- Test:
  - `tests/Sporer.Api.Tests/TripRefresherTests.cs`
  - `tests/Sporer.Api.Tests/TimelineWorkerTests.cs`
  - `tests/Sporer.Api.Tests/SyntheticTripsTests.cs`
  - `tests/Sporer.SyntheticData.Tests/SimulatorTests.cs`

**Interfaces:**
- **Processor result.** `ITimelineProcessor.ReprocessAsync` now returns `Task<ReprocessResult>`, where `record ReprocessResult(int Written, DateTime RebuiltFromUtc, DateTime RebuiltToUtc)`. The window is `T0` to `T1 ?? upper`. Update every caller and fake.
- **`TripStore` write side:**
  - `ExtendPendingAsync(DateTime fromUtc, DateTime toUtc, ct)` unions the window into `night_refresh`.
  - `TakePendingAsync(ct) : Task<(DateTime From, DateTime To)?>`
  - `ClearPendingAsync(ct)`
  - `ReplaceDetectedAsync(IReadOnlyList<HomePeriod> homes, IReadOnlyList<DetectedTrip> trips, ct)` runs in one transaction. It deletes the `detected` home periods and every trip, then inserts.
- **`TripRefresher.RefreshAsync(DateTime fromUtc, DateTime toUtc, ct)`** runs these steps:
  1. Run `NightBuilder` and store the result with `NightStore.ReplaceAsync`.
  2. Load all nights, resolving place ids through `LoadSurvivorsAsync`.
  3. `HomeDetector.Detect`.
  4. Load the home places' positions and all stay positions.
  5. `TripDetector.Detect`.
  6. `ReplaceDetectedAsync`.
- **Worker:**
  - After every successful `ReprocessAsync` (dirty-range pieces and the backfill step), call `ExtendPendingAsync(result window)`.
  - At the end of the pass, if anything is pending: `RefreshAsync(pending)`, then `ClearPendingAsync`.
  - A refresh failure never fails a range or a chunk. It is logged, recorded as `last_error` through `RecordErrorAsync`, kept pending and retried on the next pass. The pending window is in the database, so it survives a restart.
- **`RestartBackfillAsync`** also deletes all `night` and `trip` rows and the `detected` home periods, and clears `night_refresh`, all in its transaction.
- **`AlgorithmVersion.CodeVersion` = 2.** The new options change the hash anyway; the bump records the code change. The next start rebuilds everything once.
- **`Simulator.Describe(SimulatorOptions) : SimulatorPlan`**, with `record SimulatorPlan(IReadOnlyList<(string Name, DateOnly Start, int Nights)> Trips, DateOnly MoveDay)`. It builds the same plan as `Run` without emitting points.

- [ ] **Step 1: Write the failing tests.**

```csharp
TripRefresher_stores_nights_homes_and_trips_for_the_window       // seeded 100 home nights + 3 Lisbon nights -> 1 home period, 1 trip
TripRefresher_recomputes_all_trips_when_one_window_changes       // a later window that removes the away nights deletes the trip
TripRefresher_resolves_merged_places_to_their_survivor
Worker_refreshes_trips_once_per_pass_after_rebuilding            // fake processor windows -> one RefreshAsync over their union
Worker_keeps_a_failed_refresh_pending_and_does_not_fail_the_range // range completed; last_error set; next pass retries; pending cleared on success
Worker_restart_clears_nights_homes_and_trips
AlgorithmVersion_code_version_is_2
Simulator_describe_matches_what_run_emits                        // the trips' dates and move day appear in the emitted track
Synthetic_year_gives_its_three_trips_and_the_house_move
    // Seed 7, 2025-01-01..2025-12-31, MovingInterval 60 s: ingest rows, run the worker until the backfill is done.
    // Expect three trips: first nights = Describe(...).Trips starts, nights 2, 6, 24.
    // Expect two home periods, the second from MoveDay (± 1 night).
```

- [ ] **Step 2: Run to fail.** `dotnet test src/Sporer.sln --filter "FullyQualifiedName~TripRefresher|FullyQualifiedName~TimelineWorker|FullyQualifiedName~Synthetic|FullyQualifiedName~AlgorithmVersion|FullyQualifiedName~Simulator"`. Expected: FAIL.
- [ ] **Step 3: Implement** the code above. Register `NightBuilder`, `NightStore`, `TripStore` and `TripRefresher` as singletons, next to the timeline services.
- [ ] **Step 4: Run to pass.** First run the same filter, then the whole suite: `dotnet test src/Sporer.sln`. Expected: PASS. Ingest tests are unchanged and the worker tests are green.
- [ ] **Step 5: Commit.** Message: `git commit -m "Refresh homes and trips after every rebuild"`.

---

### Task 5: Trips list API and naming

**Files:**
- Create:
  - `src/Sporer.Api/Features/Trips/TripNaming.cs`
  - `src/Sporer.Api/Features/Trips/GetTripsEndpoint.cs`
  - `src/Sporer.Api/Features/Trips/TripsResponse.cs`
- Modify: `TripStore.cs` (read side)
- Test: `tests/Sporer.Api.Tests/TripNamingTests.cs`, `tests/Sporer.Api.Tests/TripsEndpointTests.cs`

**Interfaces:**
- **`GET /api/trips`** returns `200` with this body:

```json
{ "trips": [ {
    "id": "2026-09-12", "name": "Lisbon", "firstNight": "2026-09-12", "lastNight": "2026-09-17", "nights": 6,
    "start": "2026-09-12T15:20:00Z", "end": "2026-09-18T19:05:00Z",
    "startTimeZone": "Europe/Oslo", "endTimeZone": "Europe/Oslo",
    "localStartDate": "2026-09-12", "localEndDate": "2026-09-18", "ongoing": false,
    "cities": [ { "name": "Lisbon", "country": "Portugal", "nights": 6, "lat": 38.71, "lon": -9.14 } ],
    "thumbnail": [[10.75, 59.91], [-9.14, 38.71], [10.75, 59.91]] } ] }
```

  - Trips are newest first. `end` is null and `ongoing` is true for an ongoing trip.
  - `cities` come from the trip's nights, grouped by city and country, most nights first. Ties go to the earlier first night.
  - A night whose place has no city is grouped under its country (`name` = the country). A night with neither, or no place, is not in `cities`.
  - Each city's `lat`/`lon` is the mean of its nights' positions.
  - `thumbnail` is the home position at the first night, then the nights' positions with consecutive repeats within 1 km collapsed and unknown nights skipped, then the home position at the last night.
  - The response is read in one RepeatableRead transaction. It never 500s on an empty database; that gives `{ "trips": [] }`.
- **`TripNaming.Name(IReadOnlyList<(DateOnly Night, string? City, string? Country)> nights) : string`** takes one entry per known night and groups them itself: most nights first, ties to the earlier first night. It follows spec §6.6, refined:
  1. The ordered cities. One city: `"Lisbon"`. Two: `"Lisbon & Porto"`.
  2. With three or more cities, use the countries in the same order. One country: `"Portugal"`. Two: `"Portugal & Spain"`. Three: `"Portugal, Spain & France"`. More: `"Portugal, Spain & 3 more"`.
  3. With no city, apply the country rule (steps 2's country forms) to whatever countries there are.
  4. With nothing at all: `"Trip"`.
- **`TripNaming.NightsLabel(int nights) : string`**: `"1 night"`, `"4 nights"`. The web app uses the same wording.

- [ ] **Step 1: Write the failing tests.**

```csharp
TripNaming_one_city / _two_cities / _three_cities_in_one_country / _two_countries / _three_countries / _five_countries / _no_city_uses_country / _nothing_is_Trip
TripNaming_nights_label_singular_and_plural
Trips_lists_newest_first_with_names_cities_nights_and_thumbnail
Trips_ongoing_trip_has_no_end
Trips_name_follows_geocoding_without_reprocessing     // update place.city, GET again -> new name, no refresh run
Trips_empty_database_gives_an_empty_list
Trips_answers_with_an_etag_and_304                    // the existing middleware covers it; pin it for this endpoint
```

- [ ] **Step 2: Run to fail.** `dotnet test src/Sporer.sln --filter "FullyQualifiedName~TripNaming|FullyQualifiedName~TripsEndpoint"`. Expected: FAIL.
- [ ] **Step 3: Implement** the read query, grouping, naming and endpoint. Follow the Range endpoint's patterns: FastEndpoints and `Send.*`.
- [ ] **Step 4: Run to pass.** Run the same command. Expected: PASS.
- [ ] **Step 5: Commit.** Message: `git commit -m "List trips with names, cities and thumbnails"`.

---

### Task 6: Trip detail API

**Files:**
- Create: `src/Sporer.Api/Features/Trips/GetTripEndpoint.cs`, `src/Sporer.Api/Features/Trips/TripResponse.cs`
- Modify: `TripStore.cs`, `TripNaming.cs`
- Test: `tests/Sporer.Api.Tests/TripEndpointTests.cs`, `tests/Sporer.Api.Tests/TripNamingTests.cs`

**Interfaces:**
- **`GET /api/trips/{id}`** (`id` = `YYYY-MM-DD`). An id that is not a date, or not a stored trip, gets `404`. Otherwise it returns `200`: the same fields as a list item (without `thumbnail`), plus:

```json
{ "stats": { "flights": 2, "cities": 2, "places": 9, "groundDistanceMeters": 48210 },
  "moves": [ { "id": 5, "mode": "flight", "distanceMeters": 2738800, "geometry": [[10.7,59.9],[-9.1,38.7]] } ],
  "days": [ { "date": "2026-09-12", "description": "Oslo → Lisbon", "highlights": ["Time Out Market"],
              "groundDistanceMeters": 3200, "flights": 1 } ] }
```

- **The trip span** is `start` to `end`. For an ongoing trip it ends at the latest stored segment end.
  - `moves` are the move segments overlapping the span, with coarse geometry, put through `VertexBudget.Fit`. A missing mode is left out, as in the range endpoint.
  - `stats.flights` counts the flight moves in the span.
  - `stats.cities` counts the distinct (city, country) of stays in the span.
  - `stats.places` counts the distinct survivor places of stays in the span.
  - `groundDistanceMeters` is the sum of the non-flight move distances in the span.
- **`days`** cover every local date from `localStartDate` to `localEndDate`. Each takes the segments in the span that touch the date (`local_start_date <= d <= local_end_date`).
  - **`description`** is `TripNaming.DayLine(IReadOnlyList<(string? City, string? PlaceName)> staysInOrder, bool hasMoves) : string`:
    - The cities of the stays that day, in time order, with consecutive repeats collapsed, joined by `" → "`.
    - Without any city, the stays' place names.
    - Without stays: `"Travelling"` if there are moves, else `"No data"`.
  - **`highlights`** are up to three named places (`user_name ?? osm_name`) with the most stay time that day. The places where the night before and the night of that date were spent are left out (the hotel).
  - **`groundDistanceMeters`** is the sum of the non-flight move distances for moves starting that date. **`flights`** counts the flight moves touching it.

- [ ] **Step 1: Write the failing tests.**

```csharp
Trip_detail_returns_stats_moves_and_days_in_order
Trip_detail_day_line_collapses_repeated_cities_and_falls_back             // "Oslo → Lisbon"; names; "Travelling"; "No data"
Trip_detail_highlights_leave_out_the_night_place
Trip_detail_of_an_ongoing_trip_runs_to_the_latest_data
Trip_detail_moves_respect_the_vertex_budget
Trip_detail_unknown_or_malformed_id_is_404                                // "2026-01-01" not stored; "abc"
```

- [ ] **Step 2: Run to fail.** `dotnet test src/Sporer.sln --filter "FullyQualifiedName~TripEndpoint|FullyQualifiedName~TripNaming"`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to pass.** Run the same command. Expected: PASS.
- [ ] **Step 5: Commit.** Message: `git commit -m "Describe one trip: stats, routes and its days"`.

---

### Task 7: Mark home stays in the day API

**Files:**
- Modify: `src/Sporer.Api/Features/Day/DayResponse.cs`, `src/Sporer.Api/Features/Day/GetDayEndpoint.cs`, `TripStore.cs`
- Test: `tests/Sporer.Api.Tests/DayEndpointTests.cs`

**Interfaces:**
- **`StayDto`** gains `bool Home`, always serialised, after `place`.
- **`TripStore.FindHomeOnAsync(DateOnly date, ct) : Task<long?>`** returns the place of the home period covering the date.
- **The day endpoint** sets `home: true` on stays whose survivor place is that place.
  - A stay without a place, or a day with no home in effect, gets `false`.
  - The day's ETag changes when its home changes, because the body changes.

- [ ] **Step 1: Write the failing tests.**

```csharp
Day_marks_stays_at_the_home_in_effect          // two stays: home place -> true, café -> false
Day_without_a_home_marks_nothing
Day_uses_the_home_of_the_day_viewed_after_a_move   // the old home's place on a day after the move -> false
```

- [ ] **Step 2: Run to fail.** `dotnet test src/Sporer.sln --filter "FullyQualifiedName~DayEndpoint"`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to pass.** Run the same command. Expected: PASS.
- [ ] **Step 5: Commit.** Message: `git commit -m "Tell which stays are at home"`.

---

### Task 8: Web routes, data and the Trips entry

**Files:**
- Modify:
  - `web/src/app/router.ts` (+ test)
  - `web/src/api/types.ts`
  - `web/src/api/queries.ts` (+ test)
  - `web/src/views/TopBar.tsx` (+ test, + CSS)
  - `web/src/app/App.tsx`
  - `web/src/app/useViewMap.ts`
- Test: `web/e2e/trips.spec.ts` (first case); `web/e2e/fixtures/trips.json`, `web/e2e/fixtures/trip-2026-09-12.json`

**Interfaces:**
- **`Route`** gains `{ view: "trips" }` and `{ view: "trip"; id: string }`, where `id` must pass `isDate`. The paths are `/trips` and `/trip/2026-09-12`.
- **`PeriodRoute`** becomes `Extract<Route, { view: "day" | "week" | "month" | "year" | "range" }>`. Add `isPeriodRoute(route): route is PeriodRoute`.
  - Every check that means "this route has no period" must use it. Today those are written `route.view === "place"`: in TopBar `anchorOf`/`switchView`/`period`, in useViewMap `usePeriodMap`/`useHeatMap`, in `prefetchNeighbours` and in App's `Panel`.
  - Grep for them all. A trips route must never reach `periodRange`.
- **`types.ts`:** add `TripsResponse`, `TripSummary`, `TripCity`, `TripResponse`, `TripStats`, `TripMove` and `TripDay`, mirroring Tasks 5–6. `StaySegment` gains `home: boolean`.
- **`queries.ts`:** add `useTrips()` and `useTrip(id: string | null)`. A trip's 404 is not retried, like a place's. The neighbours of a trip route are the previous and next trips in the `useTrips()` list; prefetch their detail.
- **TopBar:**
  - A **Trips button** sits at the trailing edge, with the accessible name "Trips" and an inline SVG suitcase. It navigates to `/trips` and is `aria-pressed` on the trips and trip routes.
  - **On `/trips`**, the date row is replaced by a title row reading "Trips". No segmented button is pressed; choosing one returns to that view at the last day shown (P2-R28).
  - **On `/trip/{id}`**, the title row shows the trip's name and dates. ‹ › and ←/→ step to the older and newer trip in the list order, and are disabled at the ends.
- **App's `Panel`** shows placeholders "Trips" and "Trip" until Tasks 9–10. **`useViewMap`** draws nothing for these routes until then.

- [ ] **Step 1: Write the failing tests.**

```ts
test("parseRoute_reads_trips_and_trip_and_rejects_a_bad_trip_id")   // "/trip/abc" -> null; formatRoute round-trips
test("isPeriodRoute_is_false_for_place_trips_and_trip")
test("TopBar_trips_button_opens_the_trips_list_and_is_pressed_there")
test("TopBar_on_a_trip_steps_to_the_older_and_newer_trip")           // ‹ › and keys; disabled at the ends
test("useTrip_does_not_retry_a_404")
```

  e2e `trips.spec.ts` gets `trips_button_opens_the_trips_list` (phone and desktop).

- [ ] **Step 2: Run to fail.** `cd web && npm test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify.** `cd web && npm run typecheck && npm test && npm run e2e`. Expected: pass, with every existing spec still green.
- [ ] **Step 5: Commit.** Message: `git commit -m "Route to trips and a trip, with an entry in the top bar"`.

---

### Task 9: Trips list and the map of all trips

**Files:**
- Create: `web/src/views/TripsPanel.tsx`, `web/src/views/TripThumbnail.tsx` (+ CSS, + tests)
- Modify: `web/src/map/layers.ts` (+ test), `web/src/app/useViewMap.ts` (+ test), `web/src/app/App.tsx`, `web/e2e/trips.spec.ts`

**Interfaces:**
- **`TripsPanel`** reuses `States`, `Shown`/`useKeptData` and `Rows.module.css`. It lists cards newest first. Each card shows:
  - the thumbnail
  - the name
  - the dates (`"12 – 18 Sep 2026"`, as `dateRangeLabel` does)
  - the nights label
  - the cities, joined by `" · "`
  - an "Ongoing" chip for an ongoing trip

  Tapping a card navigates to `/trip/{id}`. Its accessible name contains the visible name and dates.
  - The empty state reads: `"No trips yet. A trip is a night spent 50 km or more from home."`
- **`TripThumbnail({ line })`** is an inline 72×48 SVG.
  - The line is projected equirectangularly into its bounding box with 4 px of padding, using `cos(mid-latitude)` for x.
  - It draws a polyline in the accent colour, with a dot at each interior point.
  - A single point or an empty line draws one dot.
- **`tripsGeoJson(trips: TripsResponse): { routes: empty; places: PlaceCollection }`** makes one dot per (city, country) across all trips.
  - Nights are summed. The radius is `4 + 12 * sqrt(nights / max)`, as `rangeGeoJson` does.
  - The five with the most nights carry `label` = `"Lisbon · 9 nights"`.
  - Every dot has `id: 0`. MapView's tap handler must ignore features with `id <= 0`, so city dots are not places; test this.
- **`RouteView`** gains `"trips"` (dots and labels shown, no route layers) and `"trip"` (Task 10).
- **`useViewMap`** for `/trips`: the data is `tripsGeoJson`, fitted once per visit, with `home` = all dots. The heat is unavailable on this route.

- [ ] **Step 1: Write the failing tests.**

```ts
test("TripsPanel_lists_cards_newest_first_and_opens_a_trip")
test("TripsPanel_shows_an_ongoing_trip")
test("TripsPanel_empty_loading_and_error_states")
test("TripThumbnail_projects_the_line_into_its_box")        // known points -> known path "M4,44 L68,4 …"
test("tripsGeoJson_sums_nights_per_city_and_labels_the_top_five")
test("MapView_city_dots_are_not_tappable")                  // a click on an id 0 dot calls no onPlaceTap
test("useViewMap_fits_the_trips_map_once")
```

  e2e: `trips_list_shows_cards_and_the_map_of_all_trips` (phone and desktop).

- [ ] **Step 2: Run to fail.** `cd web && npm test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify.** `cd web && npm run typecheck && npm test && npm run e2e`. Expected: pass.
- [ ] **Step 5: Commit.** Message: `git commit -m "List trips with thumbnails and map where they went"`.

---

### Task 10: Trip view

**Files:**
- Create: `web/src/views/TripPanel.tsx` (+ CSS, + test)
- Modify: `web/src/map/layers.ts` (+ test), `web/src/app/useViewMap.ts` (+ test), `web/src/app/App.tsx`, `web/e2e/trips.spec.ts`

**Interfaces:**
- **`TripPanel`** shows the following. A 404 shows `"This trip no longer exists"`, with a link to `/trips`.
  - **Chips:** flights, cities, places, ground distance (`formatDistance`).
  - **Day by day:** one row per `days` entry, showing `shortDayLabel(date)`, the description, the highlights joined by `", "`, the ground distance, and a ✈ count when `flights > 0`. Tapping a row navigates to `/day/{date}`; its accessible name contains the visible text.
  - **Ongoing:** an ongoing trip shows "Ongoing".
  - **States:** loading, error and Retry, using `useKeptData`.
- **`tripGeoJson(trip: TripResponse): { routes: RouteCollection; places: PlaceCollection }`**
  - Routes are coloured by mode, and flights are dashed.
  - There is one dot per city, sized by nights as in Task 9, and every city is labelled with `TripNaming`'s wording (`"Lisbon · 4 nights"`).
- **`RouteView "trip"`** draws routes with the day layers (bold, casing) and dots and labels with the place layers. Range routes are hidden. Unit-test the visibility for every view.
- **`useViewMap`** for `/trip/{id}`:
  - It fits once per trip, with `home` = everything drawn.
  - The heat covers the trip's `localStartDate` to `localEndDate` when it is on.
  - The kept data is dropped when the route leaves trips, as for the other views (P2-R43).

- [ ] **Step 1: Write the failing tests.**

```ts
test("TripPanel_shows_stats_and_days_and_opens_a_day")
test("TripPanel_trip_that_no_longer_exists")
test("tripGeoJson_labels_every_city_with_its_nights")       // "Lisbon · 4 nights", "Sintra · 1 night"
test("layerSpecs_trip_shows_bold_routes_and_city_dots")
test("useViewMap_draws_a_trip_and_never_a_stale_one")       // trip A -> trips -> trip B (uncached): nothing until B arrives
```

  e2e: `opening_a_trip_from_the_list_shows_its_days_and_steps_to_the_next_trip` (phone and desktop; spec §9 "opening a trip").

- [ ] **Step 2: Run to fail.** `cd web && npm test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify.** `cd web && npm run typecheck && npm test && npm run e2e`. Expected: pass.
- [ ] **Step 5: Commit.** Message: `git commit -m "Show one trip: its routes, cities and days"`.

---

### Task 11: House icon on home stops

**Files:**
- Modify:
  - `web/src/map/layers.ts` (+ test)
  - `web/src/map/MapView.tsx` (+ test)
  - `web/src/views/DayPanel.tsx` (+ test, + CSS)
  - `web/e2e/day.spec.ts`
  - `web/e2e/fixtures/day-*.json`

**Interfaces:**
- **`stopOrders`** numbers only stays with a place that are not `home`. The map and the list keep one source of numbering (P2-R16).
- **`dayGeoJson`:**
  - A home stay's stop feature has `home: true` and an empty `label`.
  - Co-located home stays merge into one house pin, never into a numbered label (refines P2-R20).
  - Non-home stops are as today.
- **Map:**
  - On every style load, MapView adds an SDF image `"sporer-home"`: a simple house drawn on a 32×32 canvas. Skip it when canvas is unavailable, e.g. in jsdom.
  - A symbol layer `LAYER_IDS.stopHome` (`"sporer-stop-home"`) draws the icon on the pin, white, for `home == true`. The number layer filters to `home != true`.
  - Home pins stay tappable, opening the place, as today.
- **DayPanel:** a home stay row shows the same house glyph (inline SVG, `aria-hidden`) where the number goes. Its button name is `"Show home, {name}, on the map"`.

- [ ] **Step 1: Write the failing tests.**

```ts
test("stopOrders_skips_home_stays")
test("dayGeoJson_marks_home_stops_and_never_merges_them_into_numbers")
test("layerSpecs_home_icon_layer_and_numbers_filter")
test("MapView_adds_the_house_image_on_every_style_load")    // fake map addImage called after a style switch too
test("DayPanel_home_row_shows_the_house_and_no_number")
```

  e2e `day.spec.ts`: `day_view_marks_home_with_a_house` checks the row icon and the numbering of the other rows.

- [ ] **Step 2: Run to fail.** `cd web && npm test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify.** `cd web && npm run typecheck && npm test && npm run e2e`. Expected: pass.
- [ ] **Step 5: Commit.** Message: `git commit -m "Draw home with a house"`.

---

### Task 12: Performance, README and the owner's checklist

**Files:**
- Create: `docs/superpowers/plans/2026-10-26-sporer-plan-3-perf.md`
- Modify: `tools/perf/` (add trips to the API script), `web/perf/` (add a trip view timing), `README.md`

- [ ] **Step 1: Server.** Use the 10 M-row synthetic dataset, with the backfill complete, the method of Plan 2's perf doc, and the fixed `api-latency.sh` seeding. Measure:
  - **Backfill:** total time against Plan 2's figure. Target: night and trip work adds ≤ 20 %.
  - **Refresh:** p50/p95 for one live refresh after a dirty range. Target: ≤ 200 ms.
  - **`/api/trips`:** p50/p95 over 50 requests. Target: ≤ 200 ms server time.
  - **`/api/trips/{id}`:** p50/p95 for each trip, with response sizes. Target: ≤ 400 ms, the same as a month.
  - **Plans:** `EXPLAIN` for the trips list and detail queries.
- [ ] **Step 2: Web.** Use the phone project at 4× CPU, with recorded responses. Measure cold navigation to the trip view's day rows and to the trips list's cards. Target: ≤ 2 s, the same as a month.
- [ ] **Step 3: Fix misses**, with re-measurement. Never fix one by changing detection results.
- [ ] **Step 4: README.**
  - Trips and home: what a trip is, the 03:00 rule, the 60-of-90 home bar, and the new `Detection__TripMinDistanceKm`, `Detection__HomeMinNights`, `Detection__HomeWindowNights`, `Detection__NightHour` and `Detection__NightPointWindow` settings.
  - The API list.
  - A short **owner's checklist** (spec §9 acceptance):
    - home periods look right, including any move;
    - each remembered trip is listed, with sensible dates, name and nights;
    - a long stay is not mistaken for a move;
    - home stops show a house;
    - the trip view's day lines read well;
    - the times of the trip view and of the trips list on the phone.
- [ ] **Step 5: Commit.** Message: `git commit -m "Record trip performance and document trips"`.

---

## Out of scope (Plan 4)

- Trip edits (rename, adjust dates, delete; stored separately and matched by date span) and the trip threshold in Settings.
- Home overrides in Settings. The `home_period.source = 'user'` rows are read by Plan 4, which must make `TripRefresher` honour them over the detected ones.
- Rename and merge places, and remove and restore points.
- The service worker, a WebKit CI project, and the final §8 pass on the owner's phone.
