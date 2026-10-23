# Sporer Plan 1 — Server: safe ingest, timeline processing, day API

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the existing ingest-only API into a .NET 10 server that keeps ingesting exactly as today, turns two years of raw points into stops, routes, gaps and named places in the background, and serves a day's timeline as JSON.

**Architecture:** Pure detection logic lives in a new class library `Sporer.Timeline` (no database, no HTTP — fully unit-tested on synthetic tracks). `Sporer.Api` owns persistence (Dapper + Npgsql on TimescaleDB), migrations (DbUp), two background services (timeline processing, place naming via Nominatim) and FastEndpoints endpoints. Processing works on UTC time ranges anchored on stored stays, so backfill, live ingest and later edits all use one `ReprocessAsync(from, to)` path.

**Tech Stack:** .NET 10, FastEndpoints 8.3, Dapper 2.1, Npgsql 10, DbUp (dbup-postgresql 7), GeoTimeZone 6.1, TimescaleDB 2.x on PostgreSQL 16; tests: xUnit v3, Microsoft.AspNetCore.Mvc.Testing 10, Testcontainers.PostgreSql 4 with image `timescale/timescaledb:2.17.2-pg16`.

**Spec:** `docs/superpowers/specs/2026-10-23-sporer-web-app-design.md` (approved). Executors read both.

**Plan series.** The spec's build order (§10) is split into four plans, each shipping working software. This is plan 1 (spec phases 1–2 plus the day read API). Later plans are written after the previous one lands, against the real interfaces:
- Plan 2 — Web app: React/Vite shell in `web/`, Day / Week / Month / Year / Range views, heat layer (+ heat cells in processing), place detail, range & heat APIs, Docker Node stage, forwarded-headers handling behind Traefik.
- Plan 3 — Home periods and trips: detection, trips list, trip view.
- Plan 4 — Editing (rename/merge places, remove/restore points incl. the `excluded_point` table and its use in cleaning, trip edits), Settings (incl. pausing backfill), PWA polish, performance pass against spec §8.

## Environment setup (once per container)

- .NET 10 SDK: `apt-get update && apt-get install -y dotnet-sdk-10.0` (Ubuntu 24.04 `noble-updates` carries it). Verify: `dotnet --version` prints `10.0.x`.
- Docker daemon for Testcontainers: if `docker ps` fails, start it with `nohup dockerd >/tmp/dockerd.log 2>&1 &` and wait until `docker ps` succeeds.
- All commands run from the repo root unless stated.

## Global Constraints

- Target framework `net10.0` for every project; keep `<Nullable>enable</Nullable>` and `<ImplicitUsings>enable</ImplicitUsings>`.
- **Existing `locationLog` rows are never changed.** The table's only schema change is two added nullable columns without defaults (`horizontal_accuracy double precision`, `motion text[]`, migration 0002). No other `ALTER TABLE`, index, constraint, compression or policy change on it; no `UPDATE`/`DELETE` of its rows, ever. The app only `INSERT`s (ingest) and `SELECT`s. All other migrations create new objects only.
- Ingest success response body is exactly `{"result":"ok"}`.
- Raw points are never lost: the `locationLog` insert must succeed or fail on its own, independent of every new write.
- Nominatim: ≤ 1 request/second, descriptive `User-Agent` from configuration, `accept-language=en`, results cached in the database.
- No PostGIS. Geometry is computed in C#.
- All times stored as UTC `timestamptz`; every segment stores its IANA time zone(s) and local date(s).
- Units: metres, seconds, km/h only where the spec states km/h thresholds.
- Detection defaults (spec §6, configurable under `Detection:`): accuracy cut 100 m; glitch 300 km/h; stay 100 m for ≥ 5 min; flight ≥ 200 km/h and ≥ 100 km; gap ≥ 30 min; walk < 7 km/h, cycle 7–25 km/h, drive > 25 km/h; place match 75 m; simplification 5 m (detail) / 50 m (coarse).
- FastEndpoints route prefix stays `api`.
- No real location data in the repository — tests and fixtures use synthetic coordinates only.
- Never skip, disable or quarantine a test.

## Review Focus

1. **Odd Overland payloads** — missing `speed`/`horizontal_accuracy`/`motion`, negative speed, timestamps with a non-UTC offset: ingest still returns `{"result":"ok"}`, stores the point, and the stored time is the correct instant. (Task 3, test `Ingest_accepts_sparse_and_offset_payloads`.)
2. **A failure in a new write must not lose points** — if the `dirty_range` write throws, the `locationLog` rows are still committed and Overland still gets `ok`. (Task 3, test `Ingest_keeps_points_when_secondary_writes_fail`.)
3. **Daylight-saving night** — a stay across the Europe/Oslo DST change (night of 2026-10-24→25) has its true duration and appears on both local dates. (Task 4 `LocalTime_handles_dst_end`; Task 12 `Day_includes_stay_crossing_midnight_on_both_dates`.)
4. **Flights across the antimeridian** — a Tokyo→San Francisco flight's geometry has no ±360° jumps between consecutive coordinates. (Task 4, test `GreatCircle_is_continuous_across_antimeridian`.)
5. **Nominatim down, rate-limited or returning junk** — the place stays unnamed, is retried later, and processing is unaffected. (Task 11, tests `Namer_backs_off_on_429` and `Namer_survives_invalid_json`.)

---

## File structure

```
src/Sporer.sln                                    modify: add projects below
src/Sporer.Api/Sporer.Api.csproj                  modify: net10.0, packages, embedded migrations, ref Sporer.Timeline
src/Sporer.Api/Program.cs                         modify: data source, options, migrator, hosted services, `public partial class Program`
src/Sporer.Api/DB/01-Create-table.sql             delete (superseded by Database/Migrations/0001_baseline.sql)
src/Sporer.Api/Configuration/
    DataBaseOptions.cs                            keep
    OverlandOptions.cs                            create — Token
    ProcessingOptions.cs                          create — worker cadence
    NominatimOptions.cs                           create — BaseUrl, UserAgent, Enabled, MinInterval
src/Sporer.Api/Database/
    Migrations/0001_baseline.sql                  create — idempotent copy of the old script
    Migrations/0002_ingest_columns.sql            create — two locationLog columns, dirty_range
    Migrations/0003_timeline.sql                  create — place, segment, geocode_cache, processing_state
    DatabaseMigrator.cs                           create — DbUp run
    DatabaseInspector.cs                          create — read-only retention/compression checks
src/Sporer.Api/Features/Overland/                 modify: token check, accuracy/motion columns, dirty ranges
src/Sporer.Api/Features/Timeline/
    PointStore.cs                                 create — load points for a range
    PlaceStore.cs                                 create — load/create places
    SegmentStore.cs                               create — anchors, replace range, day query
    TimelineProcessor.cs                          create — ReprocessAsync(from,to)
    ProcessingQueue.cs                            create — dirty ranges, backfill state
    TimelineWorker.cs                             create — BackgroundService + RunOnceAsync
    AlgorithmVersion.cs                           create — effective version string
src/Sporer.Api/Features/Places/
    NominatimClient.cs                            create
    PlaceNamer.cs                                 create — BackgroundService + RunOnceAsync
src/Sporer.Api/Features/Day/GetDayEndpoint.cs, DayResponse.cs        create
src/Sporer.Api/Features/Status/GetStatusEndpoint.cs, StatusResponse.cs create
src/Sporer.Timeline/Sporer.Timeline.csproj        create
src/Sporer.Timeline/
    Geo.cs                                        GeoPoint, distance, great circle
    LocalTime.cs                                  tz lookup, local date
    TrackPoint.cs
    DetectionOptions.cs
    PointCleaner.cs
    Segments.cs                                   Segment records, TravelMode
    Segmenter.cs
    ModeClassifier.cs
    LineSimplifier.cs
    PlaceMatcher.cs
tests/Sporer.Testing/                             create — shared test helpers (TrackBuilder, Spots); class library
tests/Sporer.Timeline.Tests/                      create — unit tests
tests/Sporer.Api.Tests/                           create — DatabaseFixture, ApiFactory, integration tests
tools/Sporer.SyntheticData/                       create — multi-year synthetic track generator
docker/dockerfile                                 modify: .NET 10, tzdata, publish Api project
.github/workflows/docker-publish.yml              modify: path filter, test job
README.md                                         modify: setup, configuration, Overland URL, Traefik note
```

---

### Task 1: .NET 10 upgrade and integration-test harness

**Files:**
- Modify: `src/Sporer.Api/Sporer.Api.csproj`, `src/Sporer.Api/Program.cs`, `src/Sporer.Api/Features/Overland/ConsumeEndpoint.cs`, `src/Sporer.sln`
- Create: `tests/Sporer.Api.Tests/Sporer.Api.Tests.csproj`, `tests/Sporer.Api.Tests/DatabaseFixture.cs`, `tests/Sporer.Api.Tests/ApiFactory.cs`, `tests/Sporer.Api.Tests/OverlandIngestTests.cs`

**Interfaces:**
- Produces:
  - `DatabaseFixture : IAsyncLifetime` (xUnit v3 collection fixture, collection name `"db"`), starts one `timescale/timescaledb:2.17.2-pg16` container; `Task<string> CreateDatabaseAsync()` creates a fresh database (`CREATE DATABASE t_<guid-n>`), returns its connection string.
  - `ApiFactory(string connectionString, IDictionary<string,string?>? settings = null) : WebApplicationFactory<Program>`; sets `TSDB_CONNECTION_STRING` and defaults `Processing:Enabled=false`, `Nominatim:Enabled=false` via `UseSetting`; `settings` override.
  - `Program` is `public partial class Program;` (append to `Program.cs`).
  - `NpgsqlDataSource` registered as a singleton from `DataBaseOptions.ConnectionString`; endpoints and stores take `NpgsqlDataSource`.

- [ ] **Step 1: Retarget and upgrade packages.** `Sporer.Api.csproj`: `net10.0`; FastEndpoints, FastEndpoints.Generator, FastEndpoints.Swagger `8.3.0`; Dapper `2.1.89`; Npgsql `10.0.3`. Create the test project (`net10.0`, packages `xunit.v3 4.0.2`, `xunit.runner.visualstudio 4.0.1`, `Microsoft.NET.Test.Sdk 18.11.0`, `Microsoft.AspNetCore.Mvc.Testing 10.0.13`, `Testcontainers.PostgreSql 4.16.0`, project reference to `Sporer.Api`) and add it to `src/Sporer.sln` (`dotnet sln src/Sporer.sln add tests/Sporer.Api.Tests/Sporer.Api.Tests.csproj`).

- [ ] **Step 2: Write the failing smoke test** in `OverlandIngestTests.cs` (collection `"db"`). Until Task 2 adds migrations, the test creates the table itself by running the old script text.

```csharp
[Fact]
public async Task Ingest_stores_point_like_today()
{
    var cs = await db.CreateDatabaseAsync();
    await Sql.ExecAsync(cs, OldCreateTableScript); // CREATE EXTENSION/TABLE/create_hypertable as in DB/01-Create-table.sql
    await using var api = new ApiFactory(cs);
    var res = await api.CreateClient().PostAsync("/api/overland", Json(Payload.One(
        time: "2026-10-22T07:00:00Z", lon: 10.75, lat: 59.91, speed: -1, altitude: 12, device: "phone")));
    Assert.Equal(HttpStatusCode.OK, res.StatusCode);
    Assert.Equal("""{"result":"ok"}""", await res.Content.ReadAsStringAsync());
    var row = await Sql.SingleAsync(cs, "select time, longitude, latitude, device, speed, altitude from locationlog");
    Assert.Equal(new DateTime(2026,10,22,7,0,0,DateTimeKind.Utc), row.time);
    Assert.Equal((10.75, 59.91, "phone"), ((double)row.longitude, (double)row.latitude, (string)row.device));
    Assert.Null(row.speed);
    Assert.Equal(12m, row.altitude);
}
```
`Sql` (static helper in the test project: `ExecAsync`, `SingleAsync`, `ScalarAsync<T>`, `QueryAsync`) wraps Dapper. `Payload` builds Overland JSON (`{"locations":[{"type":"Feature","geometry":{"type":"Point","coordinates":[lon,lat]},"properties":{...}}]}`); make optional properties omittable — later tasks reuse it.

- [ ] **Step 3: Run it to see it fail.** Run: `dotnet test src/Sporer.sln --filter "FullyQualifiedName~OverlandIngestTests"` — Expected: build errors (FastEndpoints 8 API changes, no `Program` partial) or failure.

- [ ] **Step 4: Make it pass.** Port `ConsumeEndpoint` to FastEndpoints 8's response API (the v5 `SendOkAsync` methods were replaced by the `Send` property — follow the compile errors), inject `NpgsqlDataSource`, keep the SQL and mapped values unchanged. Add `public partial class Program;`.

- [ ] **Step 5: Run the test.** Same command — Expected: PASS.

- [ ] **Step 6: Commit.** `git add -A src tests && git commit -m "Upgrade to .NET 10 and add integration test harness"`

---

### Task 2: Migrations runner and read-only database inspection

**Files:**
- Create: `src/Sporer.Api/Database/Migrations/0001_baseline.sql`, `0002_ingest_columns.sql`, `src/Sporer.Api/Database/DatabaseMigrator.cs`, `src/Sporer.Api/Database/DatabaseInspector.cs`, `tests/Sporer.Api.Tests/MigrationTests.cs`
- Modify: `Sporer.Api.csproj` (add `dbup-postgresql 7.0.1`; `<EmbeddedResource Include="Database\Migrations\*.sql" />`; remove the `DB\01-Create-table.sql` item), `Program.cs`, `OverlandIngestTests.cs` (drop the manual table creation)
- Delete: `src/Sporer.Api/DB/01-Create-table.sql`

**Interfaces:**
- Produces:
  - `DatabaseMigrator.Migrate(string connectionString, ILogger log)` — runs embedded scripts in name order with DbUp, one transaction per script, journal table `schemaversions`; throws on failure (the app then fails to start — spec §7.1 accepts this).
  - `DatabaseInspector.InspectAsync(NpgsqlDataSource) -> Task<IReadOnlyList<string>>` — human-readable warnings; registered as singleton `DatabaseWarnings` (`IReadOnlyList<string> Items`) filled at startup and logged at `Warning`.
  - `Program.cs` runs `Migrate` then `InspectAsync` after `builder.Build()` and before `app.Run()`.

`0001_baseline.sql` (idempotent; a no-op on the owner's existing database):
```sql
CREATE EXTENSION IF NOT EXISTS timescaledb;
CREATE TABLE IF NOT EXISTS locationLog (
    time TIMESTAMPTZ NOT NULL, longitude DOUBLE PRECISION NOT NULL, latitude DOUBLE PRECISION NOT NULL,
    device text NOT NULL, speed DOUBLE PRECISION NULL, altitude numeric NOT NULL);
SELECT create_hypertable('locationLog', by_range('time'), if_not_exists => TRUE);
```
`0002_ingest_columns.sql`:
```sql
ALTER TABLE locationLog ADD COLUMN IF NOT EXISTS horizontal_accuracy double precision NULL;
ALTER TABLE locationLog ADD COLUMN IF NOT EXISTS motion text[] NULL;
CREATE TABLE dirty_range (
    id bigserial PRIMARY KEY, from_utc timestamptz NOT NULL, to_utc timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(), attempts int NOT NULL DEFAULT 0,
    next_attempt_at timestamptz NULL, last_error text NULL);  -- NULL = due now
```

- [ ] **Step 1: Write the failing tests.**

```csharp
[Fact] public async Task Migrates_fresh_database()
{   // start ApiFactory on an empty database, hit GET /swagger or any route to force startup
    Assert.Equal(new[] {"time","longitude","latitude","device","speed","altitude","horizontal_accuracy","motion"}, await ColumnNames(cs, "locationlog"));
    Assert.True(await Sql.ScalarAsync<bool>(cs, "select to_regclass('dirty_range') is not null"));
}
[Fact] public async Task Migrates_existing_database_keeping_rows()
{   // run the OLD script by hand, insert 3 rows, snapshot columns + indexes + rows, then start the app
    Assert.Equal(columnsBefore.Concat(new[] { ("horizontal_accuracy","double precision","YES"), ("motion","ARRAY","YES") }),
                 await Columns(cs, "locationlog"));                // name, data_type, is_nullable from information_schema
    Assert.Equal(indexesBefore, await Indexes(cs, "locationlog")); // pg_indexes unchanged
    Assert.Equal(rowsBefore, await Rows(cs));                      // original 6 columns of all 3 rows identical; new columns null
}
[Fact] public async Task Warns_when_retention_policy_exists()
{   // old script + SELECT add_retention_policy('locationlog', INTERVAL '5 years'); start app
    var warnings = api.Services.GetRequiredService<DatabaseWarnings>().Items;
    Assert.Contains(warnings, w => w.Contains("retention", StringComparison.OrdinalIgnoreCase));
}
[Fact] public async Task Warns_when_compression_enabled()
{   // old script + ALTER TABLE locationlog SET (timescaledb.compress) — done by the TEST on a throwaway DB
    Assert.Contains(warnings, w => w.Contains("compression", StringComparison.OrdinalIgnoreCase));
}
```

- [ ] **Step 2: Run them to see them fail.** `dotnet test src/Sporer.sln --filter "FullyQualifiedName~MigrationTests"` — Expected: FAIL.

- [ ] **Step 3: Implement `DatabaseMigrator` and `DatabaseInspector`.** Inspector reads only catalog views: `timescaledb_information.jobs` (`proc_name = 'policy_retention' AND hypertable_name = 'locationlog'`) and `timescaledb_information.hypertables.compression_enabled` for `locationlog`. Remove the manual table creation from `OverlandIngestTests`.

- [ ] **Step 4: Run all tests.** `dotnet test src/Sporer.sln` — Expected: PASS.

- [ ] **Step 5: Commit.** `git commit -am "Add DbUp migrations with idempotent baseline and read-only inspection"` (add the new files first).

---

### Task 3: Ingest — token, accuracy/motion columns, dirty ranges

**Files:**
- Create: `src/Sporer.Api/Configuration/OverlandOptions.cs`
- Modify: `src/Sporer.Api/Features/Overland/Request.cs`, `ConsumeEndpoint.cs`, `Program.cs` (register `TimeProvider.System`), `tests/Sporer.Api.Tests/ApiFactory.cs` (optional `TimeProvider? time` constructor parameter that replaces the registration), `tests/Sporer.Api.Tests/OverlandIngestTests.cs`

**Interfaces:**
- Produces:
  - `OverlandOptions { string? Token }` bound from `OVERLAND_TOKEN` (env/config key), falling back to section `Overland:Token`.
  - `Metadata` gains `[JsonPropertyName("horizontal_accuracy")] double? HorizontalAccuracy` and `string[]? Motion`; `Speed` becomes `double?`, `Altitude` stays `double` (default 0 when absent — matches `NOT NULL`).
  - Ingest writes, in order: (1) the `locationLog` insert in its own transaction — today's columns and values plus `horizontal_accuracy` and `motion`; (2) best-effort afterwards: one `dirty_range(from_utc = min time, to_utc = max time, created_at = TimeProvider now)` — times come from the injected `TimeProvider`, never the database's `now()`, so tests control the clock. A failure in (2) is logged at `Error` and does not change the response.

- [ ] **Step 1: Write the failing tests.**

```csharp
[Fact] public async Task Ingest_is_open_when_no_token_configured()            // 200, row stored
[Fact] public async Task Ingest_rejects_missing_or_wrong_token()              // settings OVERLAND_TOKEN=s3cret; no token → 401; ?token=nope → 401; nothing stored
[Fact] public async Task Ingest_accepts_token_in_query_or_bearer_header()     // ?token=s3cret → 200; Authorization: Bearer s3cret → 200
[Fact] public async Task Ingest_writes_accuracy_motion_and_dirty_range()
{   // two points 07:00Z and 07:05Z, accuracy 8 and 12, motion ["walking"]
    Assert.Equal(new double?[] {8, 12}, await Sql.QueryAsync<double?>(cs, "select horizontal_accuracy from locationlog order by time"));
    Assert.Equal(new[] {"walking"}, await Sql.ScalarAsync<string[]>(cs, "select motion from locationlog order by time limit 1"));
    var r = await Sql.SingleAsync(cs, "select from_utc, to_utc from dirty_range");
    Assert.Equal((Utc(7,0), Utc(7,5)), ((DateTime)r.from_utc, (DateTime)r.to_utc));
}
[Fact] public async Task Ingest_accepts_sparse_and_offset_payloads()
{   // point A: no speed, no horizontal_accuracy, no motion, no altitude; point B: "2026-10-22T09:00:00+02:00"
    Assert.Equal("""{"result":"ok"}""", body);
    Assert.Contains(Utc(7,0), times);   // B stored as 07:00Z
}
[Fact] public async Task Ingest_keeps_points_when_secondary_writes_fail()
{   // test drops dirty_range (throwaway DB) before posting
    Assert.Equal("""{"result":"ok"}""", body);
    Assert.Equal(1, await Sql.ScalarAsync<long>(cs, "select count(*) from locationlog"));
}
[Fact] public async Task Ingest_duplicate_batch_does_not_fail()              // same payload twice → 200 both times
```

- [ ] **Step 2: Run them to see them fail.** `dotnet test src/Sporer.sln --filter "FullyQualifiedName~OverlandIngestTests"` — Expected: FAIL.

- [ ] **Step 3: Implement.** Token check in the endpoint (`?token=` query, else `Authorization: Bearer`), compared with `CryptographicOperations.FixedTimeEquals` on UTF-8 bytes; `401` with empty body on mismatch. When `Token` is empty, log one startup `Warning` ("Overland ingest is open; set OVERLAND_TOKEN"). Timestamps: convert to UTC before writing (`ToUniversalTime()`), which stores the same instant as today for `Z` inputs.

- [ ] **Step 4: Run all tests.** `dotnet test src/Sporer.sln` — Expected: PASS.

- [ ] **Step 5: Commit.** `git commit -m "Ingest: optional token, accuracy/motion columns, dirty ranges"`

---

### Task 4: `Sporer.Timeline` library — geometry, local time, test track builder

**Files:**
- Create: `src/Sporer.Timeline/Sporer.Timeline.csproj` (package `GeoTimeZone 6.1.0`), `Geo.cs`, `LocalTime.cs`, `TrackPoint.cs`, `DetectionOptions.cs`
- Create: `tests/Sporer.Testing/Sporer.Testing.csproj` (class library referencing `Sporer.Timeline`), `TrackBuilder.cs`, `Spots.cs`
- Create: `tests/Sporer.Timeline.Tests/Sporer.Timeline.Tests.csproj` (xUnit v3 packages as Task 1, references `Sporer.Testing`), `GeoTests.cs`, `LocalTimeTests.cs`
- Modify: `src/Sporer.sln` (add all three), `src/Sporer.Api/Sporer.Api.csproj` (project reference to `Sporer.Timeline`), `tests/Sporer.Api.Tests/Sporer.Api.Tests.csproj` (reference `Sporer.Testing`)

**Interfaces:**
- Produces:
  - `readonly record struct GeoPoint(double Latitude, double Longitude)`
  - `static class Geo`: `double DistanceMeters(GeoPoint a, GeoPoint b)` (haversine, R = 6 371 008.8 m); `GeoPoint Offset(GeoPoint from, double northMeters, double eastMeters)`; `IReadOnlyList<GeoPoint> GreatCircle(GeoPoint a, GeoPoint b, int points = 64)` — longitudes unwrapped so consecutive |Δlon| ≤ 180.
  - `sealed record TrackPoint(DateTime TimeUtc, string Device, double Latitude, double Longitude, double? SpeedMps, double? AccuracyMeters, string[]? Motion)` with `GeoPoint Position`.
  - `static class LocalTime`: `string TimeZoneAt(GeoPoint p)` (GeoTimeZone `TimeZoneLookup.GetTimeZone(lat, lon).Result`); `DateOnly LocalDate(DateTime utc, string ianaZone)`; `DateTime ToLocal(DateTime utc, string ianaZone)`. Use `TimeZoneInfo.FindSystemTimeZoneById` (IANA ids work natively on Linux).
  - `sealed record DetectionOptions` — every default from Global Constraints: `MaxAccuracyMeters=100, GlitchSpeedKmh=300, StayRadiusMeters=100, StayMinDuration=5 min, StationaryGapMaxSpeedMps=1.0, WalkingSpeedMps=1.4, GapMinDuration=30 min, FlightSpeedKmh=200, FlightMinDistanceKm=100, WalkMaxKmh=7, CycleMaxKmh=25, PlaceRadiusMeters=75, DetailToleranceMeters=5, CoarseToleranceMeters=50`.
  - Test helper (in `Sporer.Testing`; xUnit v3 test projects are executables, so helpers must not live in a test project) `TrackBuilder(DateTime startUtc, GeoPoint start, string device = "phone")`: `Stay(TimeSpan duration, TimeSpan every)`, `Travel(GeoPoint to, double kmh, TimeSpan every)`, `Silence(TimeSpan duration)` (time passes, no points), `Teleport(GeoPoint to, TimeSpan after)` (one point after a gap), `Spike(double metersEast)` (one point 10 s later, then the next point resumes at the previous position), `WithAccuracy(double? m)`, `WithMotion(params string[] m)`, `GeoPoint Here`, `DateTime Now`, `List<TrackPoint> Build()`. Shared synthetic places in `static class Spots` (`Home = (59.9200, 10.7500)`, `Cafe = Offset(Home, 900, 500)`, `Office = Offset(Home, 2500, 3000)`, `Gym = Offset(Home, 1200, 2600)`, `Lisbon = (38.7223, -9.1393)`, `Tokyo = (35.5494, 139.7798)`, `SanFrancisco = (37.6213, -122.3790)`).

- [ ] **Step 1: Write the failing tests.**

```csharp
[Fact] public void Distance_oslo_to_lisbon_is_about_2765_km()
    => Assert.InRange(Geo.DistanceMeters(Spots.Home, Spots.Lisbon), 2_755_000, 2_775_000);
[Fact] public void Offset_moves_requested_distance()
    => Assert.InRange(Geo.DistanceMeters(Spots.Home, Geo.Offset(Spots.Home, 300, 400)), 499, 501);
[Fact] public void GreatCircle_is_continuous_across_antimeridian()
{   var arc = Geo.GreatCircle(Spots.Tokyo, Spots.SanFrancisco);
    Assert.Equal(64, arc.Count);
    Assert.All(arc.Zip(arc.Skip(1)), p => Assert.True(Math.Abs(p.First.Longitude - p.Second.Longitude) <= 180)); }
[Fact] public void TimeZone_of_home_is_oslo() => Assert.Equal("Europe/Oslo", LocalTime.TimeZoneAt(Spots.Home));
[Fact] public void LocalDate_uses_zone() // 2026-10-22T22:30Z is 2026-10-23 in Oslo (UTC+2)
    => Assert.Equal(new DateOnly(2026,10,23), LocalTime.LocalDate(new DateTime(2026,10,22,22,30,0,DateTimeKind.Utc), "Europe/Oslo"));
[Fact] public void LocalTime_handles_dst_end() // DST ends 2026-10-25 01:00Z: 00:30Z is 02:30 CEST and 01:30Z is 02:30 CET
{   Assert.Equal(new DateTime(2026,10,25,2,30,0), LocalTime.ToLocal(new DateTime(2026,10,25,0,30,0,DateTimeKind.Utc), "Europe/Oslo"));
    Assert.Equal(new DateTime(2026,10,25,2,30,0), LocalTime.ToLocal(new DateTime(2026,10,25,1,30,0,DateTimeKind.Utc), "Europe/Oslo")); }
[Fact] public void TrackBuilder_travel_spacing_matches_speed()  // Travel 1 km at 6 km/h every 10 s → ~61 points, last point ≈ target
```

- [ ] **Step 2: Run them to see them fail.** `dotnet test src/Sporer.sln --filter "FullyQualifiedName~Sporer.Timeline.Tests"` — Expected: build failure.

- [ ] **Step 3: Implement** `Geo`, `LocalTime`, `TrackPoint`, `DetectionOptions`, `TrackBuilder`.

- [ ] **Step 4: Run the tests.** Same command — Expected: PASS.

- [ ] **Step 5: Commit.** `git commit -m "Add Sporer.Timeline geometry and local time"`

---

### Task 5: Point cleaning

**Files:** Create `src/Sporer.Timeline/PointCleaner.cs`, `tests/Sporer.Timeline.Tests/PointCleanerTests.cs`

**Interfaces:**
- Consumes: `TrackPoint`, `DetectionOptions`, `Geo`.
- Produces: `static IReadOnlyList<TrackPoint> PointCleaner.Clean(IEnumerable<TrackPoint> points, DetectionOptions o)` — sorted by `TimeUtc`, all devices merged into one timeline (spec §6.3, owner: one phone).

Rules, in order: (1) drop exact duplicates by `(Device, TimeUtc)`; (2) drop points with `AccuracyMeters > MaxAccuracyMeters` (null accuracy is kept); (3) glitch pass — drop `p[k]` (not first/last) when speed `p[k-1]→p[k]` and `p[k]→p[k+1]` both exceed `GlitchSpeedKmh` **and** `Distance(p[k-1], p[k+1]) < 0.25 × min(Distance(p[k-1],p[k]), Distance(p[k],p[k+1]))`.

- [ ] **Step 1: Write the failing tests.**

```csharp
[Fact] public void Removes_duplicates()                       // same point twice → once
[Fact] public void Drops_inaccurate_points_keeps_unknown()    // accuracy 250 dropped; null kept; 40 kept
[Fact] public void Drops_out_and_back_spike()
{   var t = new TrackBuilder(T0, Spots.Home).Stay(TimeSpan.FromMinutes(2), TimeSpan.FromSeconds(10)).Spike(5_000)
                                            .Stay(TimeSpan.FromMinutes(2), TimeSpan.FromSeconds(10)).Build();
    var c = PointCleaner.Clean(t, new());
    Assert.Equal(t.Count - 1, c.Count);
    Assert.All(c, p => Assert.True(Geo.DistanceMeters(p.Position, Spots.Home) < 50)); }
[Fact] public void Keeps_sustained_high_speed()                // Travel Home→Lisbon at 800 km/h every 60 s → nothing dropped
[Fact] public void Merges_devices_in_time_order()               // two devices interleaved → one sorted list
```

- [ ] **Step 2: Run to fail.** `dotnet test src/Sporer.sln --filter "FullyQualifiedName~PointCleanerTests"` — Expected: FAIL.
- [ ] **Step 3: Implement `PointCleaner.Clean`.**
- [ ] **Step 4: Run to pass.** Same command — Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "Add point cleaning"`

---

### Task 6: Segmentation — stays, moves, gaps, flights

**Files:** Create `src/Sporer.Timeline/Segments.cs`, `src/Sporer.Timeline/Segmenter.cs`, `tests/Sporer.Timeline.Tests/SegmenterTests.cs`

**Interfaces:**
- Consumes: cleaned `TrackPoint` list, `DetectionOptions`.
- Produces:
  - `abstract record Segment(DateTime StartUtc, DateTime EndUtc)`;
    `sealed record StaySegment(DateTime StartUtc, DateTime EndUtc, GeoPoint Centre, IReadOnlyList<TrackPoint> Points) : Segment`;
    `sealed record MoveSegment(DateTime StartUtc, DateTime EndUtc, IReadOnlyList<TrackPoint> Points, bool IsFlight) : Segment`;
    `sealed record GapSegment(DateTime StartUtc, DateTime EndUtc, GeoPoint From, GeoPoint To) : Segment`.
  - `enum TravelMode { Walk, Cycle, Drive, Flight }` (in `Segments.cs`).
  - `static IReadOnlyList<Segment> Segmenter.Split(IReadOnlyList<TrackPoint> cleaned, DetectionOptions o)` — ordered, non-overlapping; each move/gap's `StartUtc` equals the previous segment's `EndUtc`; moves and gaps lie between stays or at the ends.

Algorithm (the tests below pin it; R = `StayRadiusMeters`, Tmin = `StayMinDuration`):
```
stays: i = 0
  while i < n:
    j = i; while j+1 < n and dist(p[i], p[j+1]) <= R: j++
    end = p[j].Time
    if j+1 < n:                                   // sparse logging while still
      gap = p[j+1].Time - p[j].Time; d = dist(p[j], p[j+1])
      if gap >= Tmin and d / gap.TotalSeconds < StationaryGapMaxSpeedMps:
        end = p[j+1].Time - TimeSpan.FromSeconds(d / WalkingSpeedMps)
    if end - p[i].Time >= Tmin: emit stay(p[i..j], start = p[i].Time, end, centre = mean of p[i..j]); i = j + 1
    else i++
merge: consecutive stays with centres within R and the time between them < Tmin become one stay
between stays (and before the first / after the last): the points in between, plus the
  neighbouring stays' last/first point for geometry continuity, are split by consecutive pairs:
    flight-hop pair: implied speed >= FlightSpeedKmh
    gap pair:        not a flight hop and Δt >= GapMinDuration
    normal pair:     otherwise
  maximal runs of flight-hop pairs whose summed distance >= FlightMinDistanceKm → MoveSegment(IsFlight = true);
  shorter flight-hop runs count as normal pairs;
  each gap pair → GapSegment; runs of normal pairs → MoveSegment(IsFlight = false);
  drop moves with < 2 points; segment times are made contiguous (each starts where the previous ends).
```

- [ ] **Step 1: Write the failing tests** (each builds a track with `TrackBuilder`, cleans it, splits it; helper `Kinds(segs)` maps segments to `stay` / `move` / `gap`, and `flight` for moves with `IsFlight`):

```csharp
[Fact] public void Commute_day_gives_stays_and_moves()
{   // Home 1 h (every 2 min) → walk to Cafe 5 km/h (10 s) → Cafe 25 min → cycle to Office 18 km/h → Office 8 h
    Assert.Equal(new[] {"stay","move","stay","move","stay"}, Kinds(segs));
    Assert.True(Geo.DistanceMeters(((StaySegment)segs[2]).Centre, Spots.Cafe) < 30); }
[Fact] public void Short_stop_under_five_minutes_is_not_a_stay()   // 3 min pause at a light → one move
[Fact] public void Silent_night_at_home_is_one_stay()
{   // Home point 22:00, Silence 9 h, next point 07:05 at 300 m away, then walking
    var s = (StaySegment)segs[0];
    Assert.Equal(T(22,0), s.StartUtc);
    Assert.Equal(T(7,5) - TimeSpan.FromSeconds(300 / 1.4), s.EndUtc, TimeSpan.FromSeconds(5)); }
[Fact] public void Gps_drift_out_and_back_keeps_one_stay()          // 2 min at 130 m then back, inside a 2 h stay → one stay
[Fact] public void Phone_off_while_travelling_is_a_gap()           // move, Teleport 40 km after 2 h, move → move, gap, move
[Fact] public void Flight_between_stays()                           // Home stay, Teleport Lisbon after 4 h (≈ 690 km/h), Lisbon stay
{   Assert.Equal(new[] {"stay","flight","stay"}, Kinds(segs)); }
[Fact] public void High_speed_train_burst_is_not_a_flight()          // 20 km at 250 km/h inside a drive → no flight
[Fact] public void Segments_are_contiguous()                         // property over the commute track: segs[k].End == segs[k+1].Start
```

- [ ] **Step 2: Run to fail.** `dotnet test src/Sporer.sln --filter "FullyQualifiedName~SegmenterTests"` — Expected: FAIL.
- [ ] **Step 3: Implement `Segmenter.Split`** per the algorithm.
- [ ] **Step 4: Run to pass.** Same command — Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "Add stay/move/gap/flight segmentation"`

---

### Task 7: Move mode and line simplification

**Files:** Create `src/Sporer.Timeline/ModeClassifier.cs`, `src/Sporer.Timeline/LineSimplifier.cs`, `tests/Sporer.Timeline.Tests/ModeClassifierTests.cs`, `LineSimplifierTests.cs`

**Interfaces:**
- Produces:
  - `static TravelMode ModeClassifier.Classify(MoveSegment m, DetectionOptions o)` — `IsFlight` → `Flight`. Else, when ≥ 50 % of points carry `Motion`: majority among mapped values (`walking`/`running` → Walk, `cycling` → Cycle, `driving`/`automotive` → Drive; others ignored); if none map, fall through. Else median speed (point `SpeedMps` when ≥ 0, otherwise implied speed from the previous point) in km/h: `< WalkMaxKmh` Walk, `< CycleMaxKmh` Cycle, else Drive.
  - `static double ModeClassifier.DistanceMeters(MoveSegment m)` — great-circle distance first→last for flights, else sum of consecutive distances.
  - `static IReadOnlyList<GeoPoint> LineSimplifier.Simplify(IReadOnlyList<GeoPoint> line, double toleranceMeters)` — Douglas–Peucker on a local equirectangular projection around the line's first point; always keeps first and last.

- [ ] **Step 1: Write the failing tests.**

```csharp
[Theory] [InlineData(5, TravelMode.Walk)] [InlineData(15, TravelMode.Cycle)] [InlineData(50, TravelMode.Drive)]
public void Speed_decides_mode_without_motion(double kmh, TravelMode expected)
[Fact] public void Motion_beats_speed()                 // 15 km/h but every point Motion=["driving"] → Drive
[Fact] public void Unknown_motion_falls_back_to_speed() // Motion=["stationary"] at 5 km/h → Walk
[Fact] public void Negative_speed_uses_implied_speed()  // SpeedMps = -1 everywhere, travelling 15 km/h → Cycle
[Fact] public void Flight_distance_is_great_circle()     // Home→Lisbon flight ≈ 2 765 km ± 10 km
[Fact] public void Simplify_straight_line_keeps_ends()   // 100 collinear points, 5 m → 2 points
[Fact] public void Simplify_keeps_corner_beyond_tolerance() // L-shape with 200 m legs → corner kept at 50 m
```

- [ ] **Step 2: Run to fail.** `dotnet test src/Sporer.sln --filter "FullyQualifiedName~ModeClassifierTests|FullyQualifiedName~LineSimplifierTests"` — Expected: FAIL.
- [ ] **Step 3: Implement both.**
- [ ] **Step 4: Run to pass.** Same command — Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "Add mode classification and line simplification"`

---

### Task 8: Place matching

**Files:** Create `src/Sporer.Timeline/PlaceMatcher.cs`, `tests/Sporer.Timeline.Tests/PlaceMatcherTests.cs`

**Interfaces:**
- Produces: `sealed class PlaceMatcher(IEnumerable<(long Id, GeoPoint Centre)> places, double radiusMeters)`; `long? Match(GeoPoint p)` — nearest place within the radius, else null; `void Add(long id, GeoPoint centre)` so places created during a run match later stays in the same run. Use a grid of ~`radiusMeters` cells (lat/lon bucket) so lookups touch 9 cells.

- [ ] **Step 1: Write the failing tests.**

```csharp
[Fact] public void Matches_nearest_within_radius()      // places at 40 m and 60 m → the 40 m one
[Fact] public void No_match_beyond_radius()             // nearest at 80 m with radius 75 → null
[Fact] public void Added_place_is_matched()             // Add(9, Cafe) then Match(Cafe + 10 m) == 9
[Fact] public void Works_near_cell_borders()            // points either side of a grid line 20 m apart match
```

- [ ] **Step 2: Run to fail.** `dotnet test src/Sporer.sln --filter "FullyQualifiedName~PlaceMatcherTests"` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to pass.** Same command — Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "Add place matching"`

---

### Task 9: Timeline schema, stores and `TimelineProcessor`

**Files:**
- Create: `src/Sporer.Api/Database/Migrations/0003_timeline.sql`, `src/Sporer.Api/Features/Timeline/PointStore.cs`, `PlaceStore.cs`, `SegmentStore.cs`, `TimelineProcessor.cs`, `tests/Sporer.Api.Tests/TimelineProcessorTests.cs`, `tests/Sporer.Api.Tests/PointSeeder.cs`
- Modify: `Program.cs` (bind `DetectionOptions` from section `Detection`, register stores and `ITimelineProcessor` as singletons)

`0003_timeline.sql`:
```sql
CREATE TABLE place (
    id bigserial PRIMARY KEY, latitude double precision NOT NULL, longitude double precision NOT NULL,
    osm_name text NULL, address text NULL, city text NULL, country text NULL,
    user_name text NULL, merged_into_id bigint NULL REFERENCES place(id),
    geocode_state text NOT NULL DEFAULT 'pending' CHECK (geocode_state IN ('pending','done','failed')),
    geocode_attempts int NOT NULL DEFAULT 0, geocode_next_attempt_at timestamptz NULL,  -- NULL = due now
    created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE segment (
    id bigserial PRIMARY KEY,
    kind text NOT NULL CHECK (kind IN ('stay','move','gap')),
    start_utc timestamptz NOT NULL, end_utc timestamptz NOT NULL,
    start_tz text NOT NULL, end_tz text NOT NULL,
    local_start_date date NOT NULL, local_end_date date NOT NULL,
    place_id bigint NULL REFERENCES place(id),
    latitude double precision NULL, longitude double precision NULL,
    mode text NULL CHECK (mode IN ('walk','cycle','drive','flight')),
    distance_m double precision NULL,
    geometry_detail jsonb NULL, geometry_coarse jsonb NULL,
    point_count int NOT NULL DEFAULT 0);
CREATE INDEX ix_segment_start ON segment (start_utc);
CREATE INDEX ix_segment_local_dates ON segment (local_start_date, local_end_date);
CREATE INDEX ix_segment_stays ON segment (start_utc) WHERE kind = 'stay';
CREATE TABLE geocode_cache (
    lat_key numeric(7,4) NOT NULL, lon_key numeric(8,4) NOT NULL, response jsonb NOT NULL,
    fetched_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (lat_key, lon_key));
CREATE TABLE processing_state (
    id int PRIMARY KEY CHECK (id = 1), algorithm_version text NULL,
    backfill_from timestamptz NULL, backfill_to timestamptz NULL, backfill_cursor timestamptz NULL,
    paused boolean NOT NULL DEFAULT false, last_run_at timestamptz NULL, last_error text NULL);
INSERT INTO processing_state (id) VALUES (1);
```

**Interfaces:**
- Consumes: `PointCleaner`, `Segmenter`, `ModeClassifier`, `LineSimplifier`, `PlaceMatcher`, `LocalTime`, `Geo`.
- Produces:
  - `PointStore.LoadAsync(DateTime fromUtc, DateTime toUtc, bool includeNextPoint) -> Task<List<TrackPoint>>` — from `locationlog` (including `horizontal_accuracy` and `motion`), `time >= from AND time <= to`, ordered by time; with `includeNextPoint` also the first point after `to`.
  - `SegmentStore.FindAnchorsAsync(DateTime fromUtc, DateTime toUtc) -> Task<(DateTime T0, DateTime? T1)>`: `T0` = start of the last stored stay with `start_utc < from`, else `from`; `T1` = end of the first stored stay with `start_utc > to`, else null (= end of data).
  - `SegmentStore.ReplaceAsync(DateTime t0, DateTime? t1, IReadOnlyList<StoredSegment> segments)` — one transaction: `DELETE FROM segment WHERE start_utc >= t0 AND (t1 IS NULL OR start_utc < t1)`, then insert.
  - `record StoredSegment(string Kind, DateTime StartUtc, DateTime EndUtc, string StartTz, string EndTz, DateOnly LocalStartDate, DateOnly LocalEndDate, long? PlaceId, double? Latitude, double? Longitude, string? Mode, double? DistanceM, string? GeometryDetailJson, string? GeometryCoarseJson, int PointCount)` — geometry JSON is `[[lon,lat],...]` rounded to 6 decimals; flights use `Geo.GreatCircle(first, last)` for both levels.
  - `PlaceStore.LoadActiveAsync() -> Task<List<(long Id, GeoPoint Centre)>>` (rows with `merged_into_id IS NULL`); `PlaceStore.CreateAsync(GeoPoint centre) -> Task<long>`.
  - `interface ITimelineProcessor { Task<int> ReprocessAsync(DateTime fromUtc, DateTime toUtc, CancellationToken ct); }` implemented by `TimelineProcessor` (returns segments written; tests can substitute it):
    ```
    (T0, T1) = FindAnchors(from, to)
    points = PointStore.Load(T0, T1 ?? DateTime.MaxValue, includeNextPoint: T1 != null)
    segs   = Segmenter.Split(PointCleaner.Clean(points, options), options)
    keep only segments with StartUtc < T1 (when T1 != null)
    stays → PlaceMatcher.Match(centre) ?? PlaceStore.Create(centre) (and matcher.Add)
    map to StoredSegment:
      time zones — stay: zone at centre for both ends; move/gap: zone at first/last point
      move — mode = ModeClassifier.Classify (lower-case), distance = ModeClassifier.DistanceMeters,
             geometry = LineSimplifier.Simplify(positions, DetailToleranceMeters / CoarseToleranceMeters)
      stay — place id, centre lat/lon, point count
    SegmentStore.Replace(T0, T1, mapped)
    ```

- [ ] **Step 1: Write the failing tests** (`PointSeeder.InsertAsync(cs, IEnumerable<TrackPoint>)` bulk-inserts into `locationlog` with Npgsql binary `COPY`):

```csharp
[Fact] public async Task Processes_a_commute_day()             // seed Task 6 commute; ReprocessAsync(day start, day end)
{   Assert.Equal(new[] {"stay","move","stay","move","stay"}, kinds);
    Assert.Equal(3, await Sql.ScalarAsync<long>(cs, "select count(*) from place"));
    Assert.All(stays, s => Assert.Equal("Europe/Oslo", s.start_tz)); }
[Fact] public async Task Reprocessing_is_idempotent()          // run twice → identical rows (excluding id) and same place ids
[Fact] public async Task Places_survive_reprocessing()          // set place.user_name='Mine' for Office; reprocess → Office stay still points at that place id
[Fact] public async Task Middle_range_reprocess_keeps_neighbours() // 3 days; reprocess day 2 only → day 1 and day 3 rows unchanged (ignoring id); no overlaps (each start >= previous end - 1 s)
[Fact] public async Task Stay_crossing_midnight_has_two_local_dates() // Home 21:00Z → 06:00Z next day → local_start_date != local_end_date
[Fact] public async Task Locationlog_is_never_modified()          // checksum of locationlog rows before == after processing
```

- [ ] **Step 2: Run to fail.** `dotnet test src/Sporer.sln --filter "FullyQualifiedName~TimelineProcessorTests"` — Expected: FAIL.
- [ ] **Step 3: Implement migration, stores and processor.**
- [ ] **Step 4: Run all tests.** `dotnet test src/Sporer.sln` — Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "Persist timeline segments and places with anchored reprocessing"`

---

### Task 10: Processing queue, worker, backfill and algorithm version

**Files:**
- Create: `src/Sporer.Api/Configuration/ProcessingOptions.cs`, `src/Sporer.Api/Features/Timeline/ProcessingQueue.cs`, `TimelineWorker.cs`, `AlgorithmVersion.cs`, `tests/Sporer.Api.Tests/TimelineWorkerTests.cs`
- Modify: `Program.cs` (register `TimeProvider.System`, queue, worker; `AddHostedService<TimelineWorker>()` only when `Processing:Enabled` is true)

**Interfaces:**
- Produces:
  - `ProcessingOptions { bool Enabled = true; TimeSpan PollInterval = 5 s; TimeSpan Debounce = 60 s; int BackfillChunkDays = 7; TimeSpan BackfillPause = 200 ms; }`
  - `AlgorithmVersion.Compute(DetectionOptions o) -> string` = `"{CodeVersion}:{first 12 hex of SHA-256 of the options' JSON}"`, `const int CodeVersion = 1`. Changing a threshold or the code version re-triggers backfill.
  - `ProcessingQueue`: `DueRangesAsync(DateTime nowUtc)` (rows with `created_at <= now - Debounce` and `next_attempt_at IS NULL OR next_attempt_at <= now`, merged when overlapping or within 1 h); `CompleteAsync(ids)`; `FailAsync(ids, string error, DateTime nowUtc)` (attempts+1, `next_attempt_at = now + min(2^attempts min, 6 h)`, `last_error`); `GetStateAsync()`/`SaveStateAsync(...)` on `processing_state`.
  - `TimelineWorker : BackgroundService` with `Task<bool> RunOnceAsync(CancellationToken)` (returns whether it did work). One pass: (1) if stored `algorithm_version` ≠ computed → set `backfill_from = min(time) from locationlog`, `backfill_to = now`, `backfill_cursor = backfill_from`, save version; (2) process all due dirty ranges via `ReprocessAsync`, completing or failing each; (3) if `!paused` and `cursor < backfill_to`: reprocess `[cursor, cursor + BackfillChunkDays)`, advance cursor, then wait `BackfillPause`; (4) set `last_run_at`. `ExecuteAsync` loops `RunOnceAsync`, sleeping `PollInterval` when it returns false. Exceptions in a range are recorded and never stop the loop; ingest never waits on the worker.
  - Uses an injected `TimeProvider` so tests control time.

- [ ] **Step 1: Write the failing tests** (factory with `Processing:Enabled=false`; tests resolve `TimelineWorker` from DI and call `RunOnceAsync`; `FakeTimeProvider` from `Microsoft.Extensions.TimeProvider.Testing 10.11.0`, set to a "now" after the seeded data and passed to `ApiFactory`):

```csharp
[Fact] public async Task First_run_backfills_all_history()      // seed 3 weeks; loop RunOnceAsync until false → stays exist in all 3 weeks; cursor >= backfill_to
[Fact] public async Task Dirty_range_waits_for_debounce()        // post via /api/overland; RunOnce at +10 s → no segments; at +61 s → segments
[Fact] public async Task Failed_range_is_retried_later()          // ITimelineProcessor replaced (ConfigureTestServices) by a stub that throws once → last_error set, attempts=1; RunOnce before next_attempt_at → untouched; after → completed
[Fact] public async Task Changed_threshold_triggers_backfill()    // finish backfill; restart factory with Detection:StayRadiusMeters=150 → cursor reset to min(time)
[Fact] public async Task Paused_backfill_does_not_advance()       // processing_state.paused = true → cursor unchanged; dirty ranges still processed
```

- [ ] **Step 2: Run to fail.** `dotnet test src/Sporer.sln --filter "FullyQualifiedName~TimelineWorkerTests"` — Expected: FAIL.
- [ ] **Step 3: Implement queue, version and worker.**
- [ ] **Step 4: Run all tests.** `dotnet test src/Sporer.sln` — Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "Add processing worker with debounced dirty ranges and versioned backfill"`

---

### Task 11: Place naming via Nominatim

**Files:**
- Create: `src/Sporer.Api/Configuration/NominatimOptions.cs`, `src/Sporer.Api/Features/Places/NominatimClient.cs`, `PlaceNamer.cs`, `tests/Sporer.Api.Tests/PlaceNamerTests.cs`
- Modify: `Program.cs` (typed `HttpClient` for `NominatimClient`; `AddHostedService<PlaceNamer>()` only when `Nominatim:Enabled` and `Nominatim:UserAgent` is non-empty; otherwise add a `DatabaseWarnings`-style warning "Place naming disabled: set Nominatim:UserAgent")

**Interfaces:**
- Produces:
  - `NominatimOptions { bool Enabled = true; string BaseUrl = "https://nominatim.openstreetmap.org"; string? UserAgent; TimeSpan MinInterval = 1.1 s; }`
  - `NominatimClient.ReverseAsync(GeoPoint p, CancellationToken) -> Task<NominatimResult?>` — `GET {BaseUrl}/reverse?format=jsonv2&lat=..&lon=..&zoom=18&addressdetails=1&accept-language=en` with the configured `User-Agent`; returns null on 404/empty; throws `NominatimUnavailableException` on 429/5xx/network/invalid JSON.
  - `record NominatimResult(string? Name, string? Address, string? City, string? Country, string RawJson)` — `Name` = `name` if non-empty, else `"{road} {house_number}"` trimmed, else `suburb`; `City` = first of `city`, `town`, `village`, `municipality`; `Address` = `"{road} {house_number}, {city}"` trimmed of empty parts.
  - `PlaceNamer : BackgroundService` with `Task<bool> RunOnceAsync(CancellationToken)`: picks one place with `geocode_state IN ('pending','failed') AND (geocode_next_attempt_at IS NULL OR geocode_next_attempt_at <= now)` ordered by id; checks `geocode_cache` by `(round(lat,4), round(lon,4))` first; else calls Nominatim and stores the cache row; on success sets names and `done`; on `NominatimUnavailableException` sets `failed`, attempts+1, next attempt `now + min(2^attempts min, 24 h)`. When less than `MinInterval` has passed since the last Nominatim request (measured with `TimeProvider`), `RunOnceAsync` makes no request and returns false; `ExecuteAsync` loops with a short sleep.

- [ ] **Step 1: Write the failing tests** (fake `HttpMessageHandler` capturing requests; canned JSON responses):

```csharp
[Fact] public async Task Names_place_in_english()                 // request has accept-language=en and the configured User-Agent; place gets name, city, country, state 'done'
[Fact] public async Task Falls_back_to_road_when_no_poi_name()    // name "" + road "Storgata" + house_number "5" → "Storgata 5"
[Fact] public async Task Uses_cache_without_calling_service()      // second place within same 4-decimal key → handler call count stays 1
[Fact] public async Task Namer_backs_off_on_429()                  // 429 → state 'failed', attempts 1, next attempt ≈ now + 2 min; processing tables untouched
[Fact] public async Task Namer_survives_invalid_json()             // "<html>" body → 'failed', no exception escapes RunOnceAsync
[Fact] public async Task Respects_minimum_interval()               // two pending places (no cache hit): RunOnce twice without advancing time → 1 request; Advance(1.1 s), RunOnce → 2 requests
[Fact] public async Task Disabled_without_user_agent()             // UserAgent empty → no PlaceNamer hosted service; warning present
```

- [ ] **Step 2: Run to fail.** `dotnet test src/Sporer.sln --filter "FullyQualifiedName~PlaceNamerTests"` — Expected: FAIL.
- [ ] **Step 3: Implement client and namer.**
- [ ] **Step 4: Run all tests.** `dotnet test src/Sporer.sln` — Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "Name places via Nominatim with cache and backoff"`

---

### Task 12: Day API

**Files:** Create `src/Sporer.Api/Features/Day/GetDayEndpoint.cs`, `DayResponse.cs`, `tests/Sporer.Api.Tests/DayEndpointTests.cs`; Modify `SegmentStore.cs` (day query)

**Interfaces:**
- Consumes: `segment`, `place`, `dirty_range`, `processing_state`.
- Produces — `GET /api/day/{date}` (`date` = `yyyy-MM-dd`; anything else → 400), the contract Plan 2's Day view consumes:
```json
{
  "date": "2026-10-22",
  "timeZone": "Europe/Oslo",
  "state": "done",
  "summary": { "places": 3, "distanceMeters": 4520.0, "movingSeconds": 1620 },
  "segments": [
    { "kind": "stay", "id": 11, "start": "2026-10-21T20:00:00Z", "end": "2026-10-22T06:32:00Z",
      "startTimeZone": "Europe/Oslo", "endTimeZone": "Europe/Oslo",
      "place": { "id": 3, "name": "Storgata 5", "city": "Oslo", "country": "Norway", "lat": 59.92, "lon": 10.75 } },
    { "kind": "move", "id": 12, "start": "...", "end": "...", "startTimeZone": "...", "endTimeZone": "...",
      "mode": "walk", "distanceMeters": 1100.0, "geometry": [[10.75, 59.92], [10.751, 59.921]] },
    { "kind": "gap", "id": 13, "start": "...", "end": "...", "startTimeZone": "...", "endTimeZone": "...",
      "from": { "lat": 0, "lon": 0 }, "to": { "lat": 0, "lon": 0 } }
  ]
}
```
  Selection: `local_start_date <= date AND local_end_date >= date`, ordered by `start_utc`. `place.name` = `coalesce(user_name, osm_name)` (null when unnamed). `timeZone` = first segment's `startTimeZone`, else the zone of the most recent stay before the day, else `"UTC"`. `summary.places` = distinct place ids among stays; distance and moving seconds sum the moves. `state` = `"pending"` when a dirty range overlaps the day's UTC span or the backfill cursor hasn't passed it, else `"done"`. Moves use `geometry_detail`.

- [ ] **Step 1: Write the failing tests.**

```csharp
[Fact] public async Task Day_returns_commute_in_order()              // kinds stay,move,stay,move,stay; summary.places == 3; geometry non-empty
[Fact] public async Task Day_includes_stay_crossing_midnight_on_both_dates() // stay 2026-10-24 20:00Z → 2026-10-25 07:00Z (DST night) is in both days; its end-start == 11 h
[Fact] public async Task Empty_day_is_ok()                           // 200 with segments [] and summary zeros
[Fact] public async Task Invalid_date_is_400()                       // "/api/day/22-10-2026" and "/api/day/2026-02-30" → 400
[Fact] public async Task Pending_when_range_dirty()                  // unprocessed dirty range over the day → state "pending"
[Fact] public async Task User_name_wins()                            // user_name 'Mine' → place.name "Mine"
```

- [ ] **Step 2: Run to fail.** `dotnet test src/Sporer.sln --filter "FullyQualifiedName~DayEndpointTests"` — Expected: FAIL.
- [ ] **Step 3: Implement the endpoint and query.**
- [ ] **Step 4: Run all tests.** `dotnet test src/Sporer.sln` — Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "Add day timeline API"`

---

### Task 13: Status API

**Files:** Create `src/Sporer.Api/Features/Status/GetStatusEndpoint.cs`, `StatusResponse.cs`, `tests/Sporer.Api.Tests/StatusEndpointTests.cs`

**Interfaces:**
- Produces — `GET /api/status`:
```json
{
  "algorithmVersion": "1:3fa2b9c01d2e",
  "backfill": { "from": "...", "to": "...", "cursor": "...", "percent": 42.5, "paused": false },
  "pendingRanges": 2,
  "failedRanges": [ { "from": "...", "to": "...", "attempts": 3, "lastError": "..." } ],
  "lastRunAt": "...",
  "places": { "total": 812, "unnamed": 40, "failed": 3 },
  "warnings": [ "..." ]
}
```
  `percent` = elapsed share of `[from, to]` at `cursor` (100 when no backfill); `failedRanges` = dirty ranges with `attempts > 0`; `warnings` = `DatabaseWarnings` + naming-disabled warning + "Overland ingest is open" when no token.

- [ ] **Step 1: Write the failing tests.**

```csharp
[Fact] public async Task Status_reports_backfill_progress()   // set state from=Jan 1, to=Jan 11, cursor=Jan 6 → percent 50
[Fact] public async Task Status_lists_failed_ranges()          // one dirty_range with attempts 2 and last_error → listed
[Fact] public async Task Status_warns_open_ingest()            // no OVERLAND_TOKEN → warning present; with token → absent
```

- [ ] **Step 2: Run to fail.** `dotnet test src/Sporer.sln --filter "FullyQualifiedName~StatusEndpointTests"` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run all tests.** `dotnet test src/Sporer.sln` — Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "Add processing status API"`

---

### Task 14: Docker image, CI and README

**Files:** Modify `docker/dockerfile`, `.github/workflows/docker-publish.yml`, `README.md`

- Dockerfile: SDK `mcr.microsoft.com/dotnet/sdk:10.0-alpine`, runtime `mcr.microsoft.com/dotnet/aspnet:10.0-alpine`; copy `src/` (both projects); `dotnet publish src/Sporer.Api/Sporer.Api.csproj -c Release -o /app`; runtime stage `RUN apk add --no-cache tzdata` (time-zone conversion needs `/usr/share/zoneinfo`); keep `ASPNETCORE_URLS=http://+:80`, labels and entrypoint.
- Workflow: path filter `docker/dockerfile` (lowercase) plus `tests/**`; add a `test` job on `ubuntu-latest` (`actions/setup-dotnet@v4` with `dotnet-version: 10.0.x`, `dotnet test src/Sporer.sln`) that `build` needs. Keep tag rules as they are (`:latest` comes from `v*.*.*` tags — confirmed by the owner).
- README: what Sporer is; environment variables (`TSDB_CONNECTION_STRING`, `OVERLAND_TOKEN`, `Nominatim__UserAgent` with contact details, `Detection__*`, `Processing__*`); Overland receiver URL `https://sporer.lud.ar/api/overland?token=<OVERLAND_TOKEN>`; Traefik/Authentik note — exempt `/api/overland` from forward-auth; "before the first release, take a schema-only dump: `pg_dump --schema-only`"; releases = push a `vX.Y.Z` tag; local development (dotnet 10, Docker for tests).

- [ ] **Step 1: Build the image.** `docker build -f docker/dockerfile -t sporer:dev .` — Expected: success.
- [ ] **Step 2: Smoke-run it against a TimescaleDB container.** Start `timescale/timescaledb:2.17.2-pg16` (`POSTGRES_PASSWORD=password`) on a Docker network, run `sporer:dev` with `TSDB_CONNECTION_STRING` pointing at it, `curl -s -X POST localhost:<port>/api/overland -H 'content-type: application/json' -d '<one-point payload>'` — Expected: `{"result":"ok"}`; `curl -s localhost:<port>/api/status` returns JSON with `"algorithmVersion"`; `curl -s localhost:<port>/api/day/2026-10-22` returns 200.
- [ ] **Step 3: Validate the workflow YAML** with `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/docker-publish.yml'))"` — Expected: no output.
- [ ] **Step 4: Commit.** `git commit -m "Build .NET 10 image with tzdata, run tests in CI, document setup"`

---

### Task 15: Synthetic multi-year data and server performance check

**Files:** Create `tools/Sporer.SyntheticData/Sporer.SyntheticData.csproj` (console, `net10.0`, references `Sporer.Timeline`), `Program.cs`, `Simulator.cs`; add to `src/Sporer.sln`; Create `docs/superpowers/plans/2026-10-23-sporer-plan-1-perf.md` (results)

**Interfaces:**
- Produces: `dotnet run --project tools/Sporer.SyntheticData -- --connection "<cs>" --from 2024-06-01 --to 2026-10-22 --moving-interval 5s --seed 42` — writes a fictional person's history straight into `locationlog` with binary `COPY` (accuracy and motion filled only for the last 90 days, like real history). The simulator covers what spec §9 lists: weekday commutes with walk/cycle/drive, sparse logging while still (one point, then silence), occasional GPS spikes, monthly evening errands, three trips with flights (one crossing time zones, one of 3+ weeks), one house move, and a few phone-off gaps. Deterministic for a given seed. Prints the row count.

- [ ] **Step 1: Generate about 10 million rows** into a fresh TimescaleDB container database (tune `--moving-interval` until the printed count is ≥ 10 000 000).
- [ ] **Step 2: Run the backfill.** Start the API against it with `Processing:Enabled=true`, `Nominatim:Enabled=false`; poll `/api/status` until `percent` is 100. Record the wall-clock time and that `failedRanges` is empty.
- [ ] **Step 3: Measure the day API.** Request 50 random dates once each to warm up, then 200 random dates; record p50/p95 server time (e.g. `curl -w '%{time_total}'`). Target (supports spec §8's ≤ 1 s day view): p95 ≤ 200 ms on this machine.
- [ ] **Step 4: Measure ingest under backfill.** While a backfill runs (bump `Detection:StayRadiusMeters` to restart it), post 200 single-batch payloads; record p95. Target (spec §8): p95 < 200 ms.
- [ ] **Step 5: Write the results** (numbers, machine, any misses and their cause) to `docs/superpowers/plans/2026-10-23-sporer-plan-1-perf.md`. A missed target is fixed in this task (index, query or chunk-size change, each with its re-measurement) before committing.
- [ ] **Step 6: Commit.** `git commit -m "Add synthetic data generator and record server performance"`
