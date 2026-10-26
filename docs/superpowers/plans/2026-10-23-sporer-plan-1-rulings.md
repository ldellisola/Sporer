# Sporer Plan 1 — rulings, open findings and deferred minors

Decisions made on the owner's behalf while building Plan 1 (built task by task with a separate review of each task), each with what it costs if wrong. Generated from the build ledger on 2026-10-23.

## Open before the first release

- N-1 (Important): set-aside isolation fails when the failing chunk is the LAST backfill chunk, when the next chunk stores no stay, or after a restart — later dirty ranges anchor back into the set-aside stretch and fail, so live data can freeze again (probe-confirmed) — Ruling: real and load-bearing for spec §6.2; no second fix wave per process, surfaced to the owner; recommended fix before the first v* tag: derive the anchor floor from the database (set-aside rows) for every rebuild, backfill and dirty ranges alike, plus a last-chunk-failure test. Trigger needs deterministic processing failure on real data (none seen on 10.7M synthetic rows; all 440 GeoTimeZone ids resolve).
- N-2 (Minor): a set-aside retry can leave a permanent seam (overlapping segments) when the boundary cut a stay — Ruling: real, fix together with N-1 (record set-aside row to min(chunkEnd + chunk length, backfill_to)).
- N-3 (Minor): R18 reset doesn't delete set-aside rows → duplicate failedRanges after a version change — Ruling: deferred.
- N-4 (Minor): M-4 bound depends on next stored stay (long range over a stay-less stored stretch still loads in one go; output correct) — Ruling: deferred.
- nit: cursor guard in set-aside SQL protects nothing — Ruling: deferred.
- out-of-scope: a failing live dirty range already freezes later live data (pre-existing, same root as N-1); OOM-type failures never counted (container restart-loops) — Ruling: fold into the N-1 follow-up.

## Rulings

- Ruling R1: TimelineWorker and PlaceNamer are always registered as singletons (resolvable for tests); their hosted-service registrations (AddHostedService(sp => sp.GetRequiredService<T>())) are added only when `Processing:Enabled` is true (master switch for background work, false in tests), and PlaceNamer's additionally only when `Nominatim:Enabled` and `Nominatim:UserAgent` is set. PlaceNamer.RunOnceAsync itself returns false without a request when naming is disabled. — Plan's tests call RunOnceAsync directly; a concurrently running hosted loop would race them. — If wrong: production must keep Processing:Enabled=true (default) for naming to run; trivial to split later.
- Ruling R2: The "place naming disabled" warning appears only when `Nominatim:Enabled` is true and `UserAgent` is empty; `Enabled=false` is a deliberate choice and gives no warning. — Avoids a permanent warning in tests/dev. — If wrong: one more warning line to add.
- Ruling R3: Keep xUnit v3 on VSTest (`IsTestingPlatformApplication=false`) so the plan's `dotnet test ... --filter "FullyQualifiedName~X"` commands work unchanged — Microsoft.Testing.Platform opt-in would change every plan command — If wrong: a later switch to MTP is a csproj + global.json change.
- Ruling R4: Async calls in tests pass `TestContext.Current.CancellationToken` (fixes xUnit1051) rather than suppressing the analyzer — keeps test output pristine — If wrong: noisier test code only.
- Ruling R5: Task 2 (which adds many new test DB calls) also adds an optional `CancellationToken ct = default` to the Sql helpers and DatabaseFixture.CreateDatabaseAsync, and new calls pass TestContext.Current.CancellationToken — enables R4 cheaply before call sites multiply — If wrong: small scope creep in Task 2.
- Ruling R6: PointCleaner (Task 5) treats negative horizontal_accuracy (iOS "invalid") as invalid and drops the point, in addition to the > 100 m cut — ingest stores raw values, so -1 would otherwise pass as highly accurate — If wrong: a few points with invalid fixes dropped.
- Ruling R7: The plan's Oslo→Lisbon distance (≈ 2 765 km) is a plan defect; the true haversine distance for Spots.Home→Spots.Lisbon is 2 738.8 km (controller verified). Task 4 test uses 2 733–2 745 km; Task 7's Flight_distance_is_great_circle uses ≈ 2 739 km ± 10 km; Task 6's flight is ≈ 685 km/h — If wrong: none, arithmetic checked.
- Ruling R8: The two cheap Task 4 minors touching Review Focus #4 and test-helper aliasing (antimeridian direction assertion; copy Motion array in TrackBuilder) ride along in Task 5's dispatch, which already edits Sporer.Timeline tests — Review Focus items deserve a pinned test — If wrong: small scope creep in Task 5.
- Ruling R9 (Task 6 clarifications): (a) merged stays: start = first.Start, end = second.End, Points = both stays' points (the drift points between are discarded), centre = mean of those points; (b) contiguity: a move/flight/gap between stays starts at the previous stay's EndUtc and ends at the next stay's StartUtc; a leading move starts at its first point's time, a trailing move ends at its last point's time; segments split inside one between-stays run share boundaries at the splitting point's time; (c) a "flight" in test Kinds = MoveSegment with IsFlight; (d) Task 6's Teleport-to-Lisbon flight is ≈ 685 km/h (R7). — The plan's algorithm leaves these to interpretation and the tests (contiguity, drift merge) depend on them — If wrong: segment boundary bookkeeping changes, local to Segmenter.
- Ruling R10: Accept the implementer's reading that the first pair after a stay measures Δt from the stay's EndUtc (so the silent-night walk-off is a move, not a 3.5 min gap) — consistent with R9(b) contiguity and the spec's intent that "No data" rows mean real absence of data — If wrong: one expression in SplitBetween.
- Ruling R11: Demoted short flight-hop runs are re-classified pair by pair as Gap (Δt ≥ GapMinDuration) or Normal, as implemented (Segmenter.cs:185), rather than the brief's literal "normal" — a long silent jump is a gap whatever its speed; identical under default options — If wrong: only matters when FlightMinDistanceKm > FlightSpeedKmh × GapMinDuration.
- Ruling R12: Empty Motion arrays do not count as carrying motion (non-null AND non-empty); tied motion votes fall back to the speed rule — an empty array carries no information, and a tie is no majority — If wrong: one token + one test.
- Ruling R13: Motion vote stays as implemented — points with any Motion count toward the 50 % share, only mapped values vote, unique plurality wins (ties → speed) — matches brief text + R12; real-data tuning (spec §9) will show whether stray values matter — If wrong: a few moves mislabelled until tuned; change is local to ModeClassifier.
- Ruling R14 (Task 9): when the upper anchor T1 is null (end of data), PointStore loads with no upper bound rather than passing DateTime.MaxValue — Npgsql rejects non-UTC-kind DateTime for timestamptz and MaxValue is a sentinel anyway — If wrong: none.
- Ruling R15 (Task 9): moves and gaps with EndUtc <= StartUtc (possible with same-timestamp multi-device points, Task 6 minor) are dropped before persisting; stays are always kept — a zero-length row has nothing to show and breaks duration maths — If wrong: a 0 s segment missing from the timeline.
- Ruling R16: Confirmed gap (from implementer concern 1): ReprocessAsync must stay bounded. When T1 is null, load points up to `to` plus the next point after it (instead of to end of data); Replace still deletes stored segments with start >= T0 when T1 is null. Truncated trailing segments are recomputed by the next chunk/dirty range because its T0 anchors on the last stored stay. Keeps the spec's oldest-first backfill and bounded memory — If wrong: the trailing segment of a chunk is briefly truncated until the next chunk runs.
- Ruling R16 (amended): when T1 is null, load up to U = max(to, end_utc of the last stored segment) plus the next point after U; Replace with T1 null deletes start >= T0 (as now). Plus an equivalence test: oldest-first chunked processing with boundaries mid-stay and mid-move yields the same rows (ignoring ids) as one full run — Reviewer showed plain R16 drops the tail of a stored move when a late point arrives mid-move — If wrong: chunk boundaries could leave seams; the equivalence test guards it.
- Ruling R17 (for Task 10): while a backfill is incomplete (cursor < backfill_to), dirty ranges with to_utc >= backfill_cursor are deferred (left due, not processed, not failed); ranges entirely behind the cursor are processed. Paused backfill keeps deferring ranges ahead of the cursor. Day API already reports such days as pending. Task 10's Paused_backfill_does_not_advance test changes accordingly: cursor unchanged, a range behind the cursor is processed, a range ahead stays pending — Prevents reprocessing across the unprocessed hole between frontier and live end — If wrong: live data shows "pending" until the first backfill completes (one-time, at install or after a threshold change).
- Ruling R18 (for Task 10): when the effective algorithm version changes and the backfill is reset, delete all rows from `segment` (never `place`, never `locationlog`) in the same step — re-backfilling over old-version segments anchors on stays that are not boundaries under the new algorithm (brief overlaps); with segments cleared, every chunk takes the bounded fresh-install path and R17 deferral applies — If wrong: days show "pending" until the re-backfill passes them (they would have been stale anyway).
- Ruling R19: Backoff exponent uses the attempts count after incrementing (first failure → 2 min, then 4, 8 … capped) for both the worker (6 h cap) and the namer (24 h cap) — matches the plan's Task 11 test "attempts 1 → next attempt ≈ now + 2 min" — If wrong: first retry 1 min later than intended.
- Ruling R20 (for Task 11): the namer only picks active places (merged_into_id IS NULL) referenced by at least one segment — orphan places from failed runs or moved stay centres would otherwise spend public Nominatim calls (usage policy: no bulk) — If wrong: an orphan that becomes referenced later is named on the next pass anyway.
- Ruling R21: After any NominatimUnavailableException (429, 5xx, network, invalid JSON) the namer pauses ALL requests for a global cool-down — 5 min, doubling on consecutive failures up to 1 h, reset by a success — on top of per-place backoff. Public Nominatim usage policy: a 429 means back off; retrying every pending place at 1/s after a 429 risks a block — If wrong: naming resumes up to an hour later than necessary after an outage.
- Ruling R22: A house number without a road is not used as the place name (falls through to suburb), as implemented — "5" is not a name — If wrong: a few places named by suburb instead of a bare number.
- Ruling R23: HTTP 404 from Nominatim is treated as unavailable (failed + per-place backoff + R21 cool-down), not as "no result"; an empty 200 or a 200 `{"error":...}` means no result → place done unnamed, and that result is cached too — public /reverse answers "no result" with 200 {"error"}, so a 404 means a misconfigured BaseUrl/path, which must not silently finalise every place — If wrong: genuine 404s retry with backoff instead of finishing.
- Ruling R24 (Task 12): day "pending" = a dirty range overlaps the day's UTC span (local midnight→next midnight in the response timeZone; fallback span date−14h..date+1+14h), or backfill incomplete with cursor < day end; merged places resolve to the survivor — the plan says "UTC span" without defining it for a zone-less day — If wrong: a day could show pending slightly longer than needed.
- Ruling R25: Task 13 replaces the max_connections=1000 workaround: test helpers clear their per-database Npgsql pool at teardown (or use Pooling=false for helper connections) and the container goes back to the default — a raised limit only hides future connection leaks — If wrong: test infra only.
- Ruling R26: Task 13 also widens the day "pending" span to the union of the zone day span and [min(start_utc), max(end_utc)] of the day's selected segments — covers days with a westward zone change and overnight-stay tails — If wrong: a day stays pending slightly longer.
- Ruling R27: status `places` counts (total/unnamed/failed) cover only places the namer would consider — active (merged_into_id IS NULL) AND referenced by at least one segment (R20) — so orphans never inflate "unnamed" forever — If wrong: counts exclude orphan rows the UI never shows anyway.
- Ruling R28: `pendingRanges` counts every dirty_range row (deferred and failed included), consistent with the day endpoint's pending; `failedRanges` lists those with attempts > 0 — If wrong: one-word SQL change.
- Ruling R29 (Task 14): use the Ubuntu-based images `mcr.microsoft.com/dotnet/sdk:10.0` and `mcr.microsoft.com/dotnet/aspnet:10.0` (Ubuntu 24.04, ships /usr/share/zoneinfo — controller verified) instead of alpine + `apk add tzdata` — the Alpine package mirror is blocked from this build container so the plan's Dockerfile cannot be verified here, and the noble image needs no package install at all — If wrong: image ~100 MB larger; trivially switchable back to alpine+tzdata in CI-only builds.
- Ruling R30: Apply the Segmenter merged-stay running-sum fix now (bit-identical centres; existing Segmenter/processor tests + equivalence tests guard it), with the pathological stress case (1 Hz logging, frequent GPS blips during a long stay) as a bounded-time test — indoor GPS drift at 1 Hz is realistic for real phones and turns a 30-day chunk into ~2 min of CPU (O(merges × points)) — If wrong: ~10 lines changed in Segmenter.
- Ruling R31: Ingest inserts each batch in one statement (e.g. INSERT … SELECT FROM unnest(@arrays), same columns, same values, same speed<0→NULL rule) instead of one INSERT per point — Overland batches can be 500–1000 points; at ~0.75 ms/point that misses the spec's ingest p95 < 200 ms target — If wrong: revert to per-row; the 11 ingest tests guard behaviour.
- Ruling R32 (I-2): isolate a failing backfill chunk — after 3 consecutive failures of the same chunk, record it as a failed dirty_range (attempts 3, last_error, backoff), advance and persist the cursor, and run the next chunk with an anchor floor (T0 never earlier than the next chunk's from) so it doesn't reload the failed chunk; the failed range is then retried behind the cursor with backoff — spec §6.2/§8: failures never block other days — If wrong: a boundary seam at the skipped chunk until its retry succeeds.
- Ruling R33 (I-1): normalise at write — local_start_date = least(start-zone date, end-zone date), local_end_date = greatest(...); no algorithm-version bump (never deployed); add a Tokyo→San Francisco after-midnight test through processor and day API — keeps ix_segment_local_dates usable and gives Plan 2 a correct span — If wrong: none.
- Ruling R34: fold in M-1 (a merged dirty group is due once its OLDEST row has waited Debounce, taking newer rows with it), M-2 (README: restart policy `unless-stopped`), M-3 (inspection runs before migrations), M-4 (worker splits dirty ranges longer than BackfillChunkDays into oldest-first sub-ranges), M-5 (0002/0003 idempotent: IF NOT EXISTS / ON CONFLICT DO NOTHING; editing applied scripts is safe pre-release), plus triage items (inspector catches any non-cancellation exception; clamp PollInterval/BackfillPause/Debounce to sane bounds; README Overland__Token alias and "Processing__Enabled=false also disables naming"; workflow path filter adds .dockerignore and the workflow file). M-6 (ETag/Cache-Control) → Plan 2 — all cheap guards against "app cannot run"/spec §6.2 — If wrong: small extra changes.

## Deferred minors (for later plans or a cleanup pass)

- Task 1: minor (deferred): Sql helpers and DatabaseFixture.CreateDatabaseAsync take no CancellationToken (Sql.cs:9-27, DatabaseFixture.cs:20-29)
- Task 1: minor (deferred): Sql.ScalarAsync<T> on SQL NULL returns default for value types — callers must use nullable T
- Task 1: minor (deferred): Docker build broken until Task 14; Task 14 must copy tests/ or restore/build only the Api csproj (sln references tests)
- Task 1: minor (deferred): ConsumeEndpoint passes ct to OpenConnectionAsync but not ExecuteAsync
- Task 1: minor (deferred): sln gained x64/x86 config rows from dotnet sln add (harmless)
- Task 1: minor (deferred): Payload.Many/Point unused yet (reused later)
- Task 2: minor (deferred): DatabaseWarnings.Items exposes backing List
- Task 2: minor (deferred): inspector queries don't filter hypertable_schema
- Task 2: minor (deferred): DbUp log format strings passed as MEL templates
- Task 2: minor (deferred): DbUp journal tied to resource names; rename would re-run 0002 (CREATE TABLE dirty_range without IF NOT EXISTS)
- Task 2: minor (deferred): untested: warning log level, failing-script-stops-startup, policy/compression unchanged after startup
- Task 2: minor (deferred): 8-column expected array duplicated in MigrationTests
- Task 2: minor (deferred): test image preinstalls timescaledb in template1, so 0001's CREATE EXTENSION path is never exercised on a DB lacking it
- Task 2: minor (deferred): DatabaseInspector catches only NpgsqlException; a Dapper cast exception from a changed column type could still escape (suggest catch Exception when not OperationCanceledException)
- Task 3: minor (deferred): point without device_id 500s the whole batch (device NOT NULL, pre-existing) — Overland would retry forever
- Task 3: minor (deferred): auth runs after body binding (malformed unauthenticated JSON → 400 not 401)
- Task 3: minor (deferred): FixedTimeEquals leaks token length (hash both to avoid)
- Task 3: minor (deferred): offset-timestamp test only catches missing ToUniversalTime on non-UTC host
- Task 3: minor (deferred): OverlandOptions mixes GetValue and indexer reads
- Task 3: minor (deferred): no test pins that factory settings are visible before Build (Task 10 will exercise it)
- Task 4: minor (deferred): GeoTests.cs:8 comment says "road atlas", should be great-circle
- Task 4: minor (deferred → carried into Task 5 dispatch, R8): antimeridian test only checks |Δlon|≤180; add assertion pinning the crossing direction (e.g. last longitude = SF lon + 360 or max lon > 180)
- Task 4: minor (deferred → carried into Task 5 dispatch, R8): TrackBuilder.WithMotion shares the params array across points; copy it
- Task 4: minor (deferred): TrackBuilder constructor point never carries WithAccuracy/WithMotion (documented)
- Task 4: minor (deferred): Geo.Interpolate public but no direct test; antipodal fallback
- Task 5: minor (deferred): tests don't pin dedupe key (same key, different fields), rule order, the 0.25 factor, last-kept-neighbour choice, interior bounds
- Task 5: minor (deferred): tie order for equal timestamps depends on input order (add ThenBy Device for determinism)
- Task 5: minor (deferred): readability — unparenthesised ||/&& and nested ternary in PointCleaner; ungrammatical doc comment
- Task 5: minor (deferred): solution-wide --filter prints "No test matches" for the other test project (plan-prescribed command)
- Task 6: minor (deferred): no test pins R11 demotion (custom FlightMinDistanceKm); unpinned boundaries (3+ merges, gap as first pair after stay, leading/trailing flight, exact GapMin/FlightSpeed/FlightMinDistance, merge at exactly Tmin)
- Task 6: minor (deferred): merged centre recomputed from all points per Absorb — O(merges × points); use running sums
- Task 6: minor (deferred → carried to Task 9): zero-duration segments possible with same-timestamp multi-device points; Task 9 must tolerate/filter
- Task 6: minor (deferred → carried to Task 7): after an extended stay, move.Points[0] time < move.StartUtc; don't derive durations from point times
- Task 6: minor (deferred): test name Commute_day_stays_run_from_the_first_to_the_last_point_in_range overclaims
- Task 7: minor (deferred): projection uses cos(lat0) of first point — distorts tolerance on long N–S lines (~36 % Oslo→Lisbon); pole edge case
- Task 7: minor (deferred): simplifier fixtures mostly axis-aligned Offset steps; unwrapped-line test is a smoke test
- Task 7: minor (deferred): ModeClassifierTests.cs:155 comment mismatches code (says 15 km/h, uses 5)
- Task 7: minor (deferred): 100k-point test doesn't pin no-recursion or a time bound; tolerance strictness unpinned
- Task 8: minor (deferred): Match returns null for invalid query while Add throws — invalid stay centre would create a place row before Add throws (low risk: centres from cleaned points)
- Task 8: minor (deferred): tests hard-code Earth radius in 3 places
- Task 8: minor (deferred): invalid-query test lacks |lat| > 90 case
- Task 9: minor (deferred): orphan places from failed runs or moved centres — namer could skip places with no segment
- Task 9: minor (deferred): SemaphoreSlim gate is per-process; advisory lock would cover multi-instance
- Task 9: minor (deferred): buffered point query holds two copies; row-by-row inserts; Positions(move) built twice
- Task 9: minor (deferred): T0 = from fallback can overlap a stored leading move (data start only)
- Task 9: minor (deferred): NaN/out-of-range points inside moves would break ::jsonb geometry (not producible by Overland JSON)
- Task 9: minor (deferred): no test for reprocess after late points change data mid-range
- Task 9: minor (deferred): data-start seam: first chunk with no qualifying stay leaves a cut leading segment (fix: fall back to earliest stored segment start instead of from)
- Task 9: minor (deferred): TimelineProcessorTests.cs:257 comment claims irregular edges fall mid-walk; they don't
- Task 10: minor (deferred): PollInterval ≥ ~49.7 days makes Task.Delay throw out of ExecuteAsync (validate/clamp options)
- Task 10: minor (deferred → carried to Task 13): an always-failing backfill chunk defers all live ranges forever (R17); status must surface it clearly; last_error briefly cleared after restart
- Task 10: minor (deferred): backfill_to = server Now — future-stamped points edge case
- Task 10: minor (deferred): `delete from segment` lives in ProcessingQueue rather than SegmentStore
- Task 10: minor (deferred): ProcessingState.Paused silently ignored by SaveStateAsync (footgun; pause-mid-pass untested)
- Task 10: minor (deferred): FailAsync select+update per row; hosted-loop test weak (fixed 500 ms delay); poll/pause sleeps use real time
- Task 11: minor (deferred): enablement rule read twice (Program.cs raw config vs NominatimOptions.NamingEnabled)
- Task 11: minor (deferred): typed client in singleton without SetHandlerLifetime(Infinite)
- Task 11: minor (deferred): min-interval uses wall clock (GetUtcNow) not monotonic timestamp; _lastRequestAt not thread-safe
- Task 11: minor (deferred): cool-down set after SaveFailureAsync — a failing DB write skips cool-down; persistent SaveNameAsync failure re-requests every MinInterval
- Task 11: minor (deferred): cache hits can wait behind an uncached place during a cool-down; cool-down in memory (restart clears it)
- Task 11: minor (deferred): cached "no result" rows never expire — a misbehaving proxy's empty 200 would permanently mark that ~11 m key unnamed
- Task 12: minor (deferred → carried to Task 13, R25): max_connections=1000 masks per-test Npgsql pools never cleared (Sql.cs/PointSeeder new NpgsqlConnection per unique DB); clear pools at teardown and revert the bump
- Task 12: minor (deferred → carried to Task 13, R26): pending span only from response zone; widen to also cover [min(start_utc), max(end_utc)] of the selected segments
- Task 12: minor (deferred): segments vs pending read on separate connections (narrow stale-"done" race)
- Task 12: minor (deferred → Task 15 perf): ix_segment_local_dates order makes recent-day lookups scan from start of history; (local_end_date, local_start_date) index would help
- Task 12: minor (deferred): DaySpan nonexistent/doubled-midnight branches untested; AddHours(1) assumes 1 h jump
- Task 12: minor (deferred): MoveDto.Mode nullable without JsonIgnore(Never)
- Task 13: minor (deferred): status reads not one snapshot; failedRanges unbounded; partly-set backfill state untested; ClearAllPools in CreateDatabaseAsync relies on single serialised collection
- Task 13: minor (deferred): PlaceStore.InUse constant not parenthesised; segment.place_id has no index (semi-join per status call / namer pass)
- Task 14: minor (deferred): workflow path filter misses .dockerignore and the workflow file itself
- Task 14: minor (deferred): .dockerignore covers only build output (local untracked json/.env could enter local images)
- Task 14: minor (deferred): README omits Overland__Token alias; HTTP_PORTS override warning (set ASPNETCORE_HTTP_PORTS=); UseAppHost=false; no CI build cache; one long README line
- Task 14: minor (deferred): runtime noise — libgssapi_krb5 message, missing wwwroot warning
- Task 15: minor (deferred): generator determinism claimed cross-platform (only same-platform holds); "finer interval logs the same life" comment inaccurate; checksum comment overstates fields hashed
- Task 15: minor (deferred): generator silently skips trips/move that don't fit short ranges; ingest test altitudes exact (no odd double→numeric probe)
- Task 15: minor (deferred): nits — SegmenterTests.cs:190 "Five pieces"; seed int.Parse overflow not caught; perf doc 0.45 vs 0.4 s; duplicate MetersPerDegree; perf doc says city is "made up" though landmarks are real public places

## Notes for Plan 2

- Task 12: note for Plan 2: midnight-crossing moves count fully in both days; days after backfill_to pending while backfill open; timeZone = zone the day started in
- ETag / Cache-Control for the day API (spec §7.3) belongs to Plan 2; it needs a per-day processing version as a basis.
