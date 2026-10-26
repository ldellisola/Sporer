# Sporer Plan 2: web and API performance check (synthetic history, about 10 million rows)

Measured on 2026-10-26 against the same generated history as Plan 1's check, with the server and the web app as built at the end of
Plan 2. The owner's real data was not available: these numbers say how the server and the web app behave at the volume the spec
assumes (spec §8, §9), on a throttled desktop browser, not on the owner's phone. The real check is the owner's, on their iPhone over
the VPN, after the first backfill. Plan 1's server check is in `2026-10-23-sporer-plan-1-perf.md`; this one adds the range, heat and
place endpoints, the query plans, the bundle, the compression and the web timings.

**Two passes.** The first (commit `cd95664`) changed nothing in the server or the web app. It found that a cold day view could take
up to 1.1 s at 4× CPU to show its rows, over the 1 s target on the worst runs, because the panel waited for MapLibre; that the
bundle is over 450 kB only if MapLibre's worker is counted; and that the API's compression, left at ASP.NET's default, made Brotli
larger than gzip for JavaScript. Fix round 1 (rulings P2-R63 and P2-R64) judged the bundle on main-thread JavaScript, made the map
load MapLibre after the panel (commit `86a3703`), and compressed at the Optimal level (commit `4f96769`), and everything was measured
again. Fix round 2 corrected the tooling (the sampling seed did nothing, which made two runs not comparable), measured the server and
the compression levels again on one set of requests, hardened the map's loader and put the heaviest day's paint right. This document
gives the numbers of both passes; the tables say which is which.

## Result

After fix rounds 1 and 2 (the first pass in brackets for the web and compression rows):

| What (spec §8, Plan 2 brief) | Target | Measured | Verdict |
| --- | --- | --- | --- |
| **Server** `/api/day/{date}`, 200 random dates | ≤ 200 ms | p50 5.7 ms, p95 8.5 ms, max 15.3 ms (the same requests right after the API started: p95 12.9; another 200 dates: p95 9.5) | Met, 15 to 23 times under at p95 |
| `/api/range`, 100 random 31-day windows | ≤ 400 ms | p50 18.3 ms, p95 25.3 ms, max 30.5 ms (right after the start: p95 27.4; another 100 windows: 28.2) | Met, 14 to 16 times under |
| `/api/range`, 20 random 365-day windows | ≤ 800 ms | p50 63.1 ms, p95 77.2 ms, max 80.7 ms (right after the start: p95 82.5; another 20 windows: 74.3); the 400-day maximum 67-87 ms | Met, 10 to 11 times under |
| `/api/heat`, month and year windows | (none of its own; the range's) | month p95 8.1 ms, year p95 17.9 ms | Met |
| `/api/places/{id}`, 200 requests over the 79 places of the busiest year window | (none of its own; the day's, 200 ms) | p50 11.7 ms, p95 16.8 ms, max 23.1 ms (right after the start: p95 17.6, max 97.2) | Met |
| Year payload size | ≤ 1.5 MB raw JSON | median 532 kB, largest 559 kB raw (the calendar year 2025: 553 kB; 400 days: 600 kB); Brotli 148.9 kB median, 157.8 kB largest | Met, 2.7 times under |
| Year vertex count | ≤ 50,000 (spec §7.3; the plan wrote 60,000, which was the cap while this was measured: see the note under the table) | median 14,888, largest 15,746 (400 days: 16,810) | Met, 3.2 times under (the cap itself is not reached, see the caveats) |
| **Bundle** main-thread JavaScript, gzip (P2-R63) | ≤ 450 kB | **379.0 kB**: the page starts with 97.6 kB and the map fetches MapLibre's chunk, 281.4 kB, when it mounts. MapLibre's worker, apart: 147.9 kB | **Met**, 71 kB under. Stated plainly: counting every JavaScript file, worker included, it is 526.9 kB, 77 kB (17 %) over 450 kB |
| **Web, cold navigation to the panel's rows**, day (4× CPU, 7 runs) | ≤ 1 s | median 764 ms, worst 846 ms; heaviest day 757 / 1,020 ms (first pass: 947 / 1,016; heaviest 982 / 1,124) | Met; one run of seven of the heaviest day is 2 % over |
| same, month | ≤ 2 s | median 793 ms, worst 853 ms; heaviest month 874 / 1,007 ms (first pass: 1,154 / 1,197; heaviest 1,097 / 1,264) | Met, 2.5 times under |
| same, year | ≤ 3 s | median 1,128 ms, worst 1,303 ms (first pass: 1,252 / 1,527) | Met, 2.7 times under |
| **Web, tap › with the page open** (the §8 reading: "after navigating (‹ ›)"), day / month / year | ≤ 1 s / 2 s / 3 s | panel rows median 65 / 84 / 207 ms, worst 91 / 131 / 269 ms; routes on the map 138 / 214 / 706 ms median | Met, 11 to 24 times under on the rows |
| *Information:* panel rows **painted** (two frames after they are in the DOM), cold; day / heaviest day / month / heaviest month / year | read against the same | median 961 / **871** / 884 / 1,007 / 1,341 ms, worst 1,088 / **1,332** / 990 / 1,150 / 1,505 ms (first pass: median 992 / 1,019 / 1,213 / 1,137 / 1,395, worst 1,067 / **1,181** / 1,260 / 1,326 / 1,712) | The medians fell everywhere (day −31 ms, heaviest day −148, month −329, heaviest month −130, year −54). **The worst of seven rose for the two days:** the day 1,067 → 1,088 ms and the heaviest day 1,181 → **1,332** ms (one slow run of seven, whose rows in the DOM were also the slowest), both over 1 s; for the month and year it fell. See "Decisions" (P2-R66) |
| *Information:* **map `idle`** from cold navigation, day / month / year | read against the same, with the caveats below | median 1,894 / 1,792 / 2,492 ms, worst 2,437 / 2,058 / 2,768 ms (first pass: 1,947 / 1,943 / 2,754; worst 2,073 / 2,204 / 3,033) | Day over 1 s (the start is 1.3 s, then a 600 ms camera move); month and year inside. **Not a verdict:** software WebGL, see the caveats |
| API compression | Brotli smaller than gzip, at acceptable cost | the three scripts over the wire: Brotli 679.9 → **524.6 kB**, gzip 626.1 → 525.9 kB; the year's answer, Brotli median 160.1 → 148.9 kB (the calendar year 2025: 166.3 → 155.5 kB); year p95 70.8 → 79.6 ms (the same 20 windows) | Changed to Optimal, see "Compression" |

The panel's rows (in the DOM) are the primary signal for the web; `idle` and the paint are recorded and caveated. Everything in the
table is a number from the runs below.

*The vertex cap.* The spec says "aim for under about 50k" (§7.3) and binds over the plan's 60,000, which is what `VertexBudget.MaxVertices`
was while the numbers here were taken. It is 50,000 now (the final review's fix). Nothing in the synthetic history reached either (the
year's largest is 15.7 thousand vertices), so no number here would be different at the lower cap.

What fix round 1 changed, and what was left: the server's queries needed nothing (no query scans a large table, so no migration
0005; the one index that was weighed, on `segment.place_id`, is measured below and left out), the app's start no longer waits for
MapLibre, and the API sends 23 % fewer bytes of JavaScript to a browser that takes Brotli.

## Decisions

Rulings that shaped what was changed and what was left, so that the numbers are read with them:

- **P2-R61 (queries).** `EXPLAIN (ANALYZE, BUFFERS)` of every query of the read endpoints; an index only for a query that scans a large table or an
  endpoint that misses its target. Neither happened, so no migration 0005; the index on `segment.place_id` that was weighed is measured
  below and left out.
- **P2-R63 (bundle).** The 450 kB target is judged on main-thread JavaScript (379.0 kB: pass); MapLibre's worker (147.9 kB) is reported apart; the
  literal total (526.9 kB, 77 kB over) is stated.
- **P2-R64 (cold day over 1 s).** A real miss on the primary signal, fixed by loading MapLibre after the panel (commit `86a3703`).
- **P2-R66 (rows painted).** The map's load is **not** deferred any further (for example until the first data has been painted). The medians
  of the paint improved everywhere; the worst-of-seven swing (the typical day's 1,067 → 1,088 ms, the heaviest day's 1,181 → 1,332 ms) is within
  the run-to-run noise of this four-CPU machine with software WebGL, where a mocked API on loopback makes MapLibre's parsing coincide with the
  paint; and deferring the map would cost the owner's priority view, the map.
- **P2-R67 (loader and tooling).** A failure anywhere in making or setting up the map is reported through `onStyleError`, never thrown; the
  tooling is checked up front, scoped and labelled correctly (commit of fix round 2).
- **Compression.** Optimal for Brotli and gzip (commit `4f96769`, fix round 1), chosen after comparing the levels on requests that were drawn
  anew for each level, and confirmed in fix round 2 by comparing them on one set of requests (the tables in "Compression").

## Machine and setup

- 4 vCPU Intel Xeon @ 2.80 GHz, 15 GB RAM, Linux 6.18 in a container with Docker. Client and server share the machine, so the
  network costs nothing and the four CPUs are shared (during the web runs the API and the browser were not both busy: the API was
  stopped, the database idle).
- Server: TimescaleDB `timescale/timescaledb:2.17.2-pg16` in Docker on port 55432 with the image's own tuning; the API as in Plan 1
  (.NET SDK 10.0.113, `dotnet build -c Release`, `dotnet Sporer.Api.dll`, `Nominatim__Enabled=false`, every other setting at its
  default), over HTTP on 127.0.0.1:5100. Latency is curl's `time_total`, which includes connecting to localhost and, because the
  requests carry `Accept-Encoding: br` as a browser's do, the Brotli compression of the answer.
- Web: Node 22.22.0, Playwright 1.56.1 with its Chromium 141.0.7390.37 (headless). **No GPU: WebGL is software (SwiftShader),**
  as in the e2e suite (`--use-angle=swiftshader --enable-unsafe-swiftshader`). The page is the e2e suite's `phone` project: 390 × 844 CSS
  pixels at a device scale of 3 (so the map's canvas is 1170 × 2532 pixels), touch, mobile. The processor is held back 4 times with
  `Emulation.setCPUThrottlingRate` over CDP, set before the navigation. The app is the production build served by `vite preview`
  (the same build the API serves from its web root), never the dev server.

## The data

The same generator, options and seed as Plan 1:

```sh
dotnet run --project tools/Sporer.SyntheticData -c Release -- \
  --connection "Host=localhost;Port=55432;Username=postgres;Password=password;Database=perf" \
  --from 2024-06-01 --to 2026-10-22 --moving-interval 500ms --seed 42
```

| | |
| --- | --- |
| Rows written | 10,726,341 (checksum `0690878d1283b1fd`, the same as Plan 1's), in 80 s here |
| `locationlog` | 126 chunks |
| Backfill | 167 s from the start of the API to 100 % (Plan 1: 140-145 s; this run polled every 3 s and started 6 s after the API), `failedRanges` empty, `pendingRanges` 0; 170 s on the generation made again for fix rounds 1 and 2 |
| Timeline | 7,607 segments (3,797 stays, 3,801 moves, 9 gaps) on 816 days, 87 places: the same as Plan 1's |

What a real history will look like is not known; see the caveats.

## Server

### Method

`tools/perf/api-latency.sh <url> <first-date> <last-date>` (new): for each endpoint 20 requests warm it up, then the measured ones
follow, once each, on dates and windows drawn by a generator of the script's own, so that a seed gives the same requests every time:

- `/api/day/{date}`: 200 random dates;
- `/api/range` and `/api/heat`: 100 random windows of 31 days (a month: the longest one) and 20 random windows of 365 days (a year),
  starting on a random date, so they are not calendar months and years but as long as the longest of them;
- `/api/places/{id}`: 200 requests over the places (78 or 79, as the draw falls) that the busiest of the 20 year windows has.

A second pass asks for the same windows with no compression to measure the raw JSON and, for a range, to count the vertices of its
lines; it is not timed. The script checks that `jq` is there and that the API answers before it starts.

**The seed.** The first pass used awk's `srand(seed)`, which is what Plan 1's scripts do too. On this machine's `mawk` (what Debian and
Ubuntu have) it does nothing: the numbers come from `arc4random`, so each run drew other dates and windows, and the first pass's "seed 1"
and "seed 2" were two random draws. That is why two runs at the same compression level gave slightly different sizes (the day's Brotli
median 2,257 B in one and 2,370 B in the next) and a different number of places (79, then 78). The script has its own generator now
(Park-Miller in awk's doubles, exact on any awk), two runs of a seed give byte-identical sizes (checked), and the compression levels
below were compared on one set of requests. Plan 1's `tools/perf/day-latency.sh` still uses `srand` (its dates are random too, and its comment says otherwise), and
`ingest-latency.sh` draws its coordinates from bash's `$RANDOM`.
The history was generated again for fix round 1 (the same rows and checksum, 7,607 segments and 87 places again); the tables say which
generation they are from, and the compression levels were compared on one.

### Results

**Final configuration** (compression at `Optimal`), seed 1, the API warm: this is the table of the Result section. Times in ms; sizes in
bytes as curl counts the body.

| Endpoint | n | p50 | p95 | p99 | max | Brotli body, median / largest | Raw body, median / largest |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `/api/day/{date}` | 200 | 5.7 | 8.5 | 12.8 | 15.3 | 2,127 / 5,086 | 7,729 / 18,166 |
| `/api/range`, 31 days | 100 | 18.3 | 25.3 | 28.6 | 30.5 | 12,924 / 15,853 | 45,983 / 55,688 |
| `/api/range`, 365 days | 20 | 63.1 | 77.2 | 80.7 | 80.7 | 148,905 / 157,758 | 531,723 / 559,072 |
| `/api/heat`, 31 days | 100 | 4.9 | 8.1 | 9.9 | 14.6 | 277 / 411 | 690 / 1,081 |
| `/api/heat`, 365 days | 20 | 12.0 | 17.9 | 19.2 | 19.2 | 853 / 916 | 2,366 / 2,524 |
| `/api/places/{id}` | 200 | 11.7 | 16.8 | 21.2 | 23.1 | 368 / 1,327 | 1,055 / 6,059 |

The same requests in the first run, right after the API was started (the 20 warm-up requests are not a full warm-up: the first requests
of a fresh process are slower, see below): day p50 7.8 / p95 12.9 / max 28.3, month 18.6 / 27.4 / 33.3, year 67.6 / 82.5 / 87.1, heat 4.6 /
8.8 and 13.4 / 16.0, places 12.6 / 17.6 / 97.2. Seed 2 (other requests, warm): day 5.7 / 9.5 / 37.2, month 18.7 / 28.2 / 33.8, year 64.9 /
74.3 / 82.4, heat 4.8 / 7.8 and 12.3 / 18.9, places (78 ids) 12.6 / 19.3 / 48.7; its Brotli medians 1,953, 13,350 and 152,641 B for the
day, month and year, its raw medians 7,095, 46,997 and 540,990 B.

**First pass**, ASP.NET's default compression (`Fastest`), two random draws (see "The seed"), the second in brackets, on the first
generation of the history:

| Endpoint | n | p50 | p95 | p99 | max | Brotli body, median / largest | Raw body, median / largest |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `/api/day/{date}` | 200 | 5.5 (8.1) | 8.7 (12.8) | 10.6 (20.8) | 10.8 (27.5) | 2,257 / 6,712 | 7,456 / 18,752 |
| `/api/range`, 31 days | 100 | 17.6 (21.8) | 23.9 (29.8) | 27.3 (31.7) | 27.7 (32.1) | 13,544 / 16,559 | 46,152 / 55,881 |
| `/api/range`, 365 days | 20 | 53.9 (59.0) | 64.4 (73.0) | 68.4 (78.0) | 68.4 (78.0) | 161,234 / 166,050 | 536,318 / 552,318 |
| `/api/heat`, 31 days | 100 | 4.5 (4.8) | 7.1 (8.5) | 8.2 (12.0) | 10.8 (58.7) | 325 / 505 | 701 / 1,162 |
| `/api/heat`, 365 days | 20 | 13.1 (13.2) | 17.2 (18.0) | 18.6 (20.5) | 18.6 (20.5) | 984 / 1,210 | 2,339 / 2,846 |
| `/api/places/{id}` | 200 | 13.6 (13.4) | 20.1 (18.1) | 28.4 (23.6) | 31.4 (27.9) | 399 / 1,544 | 1,048 / 6,059 |

- **Vertices of a range's lines** (seed 1): 31 days median 1,215, largest 1,607; 365 days median 14,888, largest 15,746 (seed 2: 15,106 and
  15,725; first pass: 14,941 and 15,491). The largest range the API takes, 400 days (2025-01-01 to 2026-02-04): 1,789 moves, 16,810
  vertices, 600,334 bytes raw (first generation), 168,963 Brotli at Optimal (180,559 at Fastest), 67-87 ms over five requests.
- **The first requests of a fresh process are about twice as slow.** The calendar year 2025 (553 kB raw), 15 requests after 3 warm-ups on a
  freshly started API, took 115-122 ms at the median at `Fastest` and `Optimal`; the same 15 requests after the server had served a few
  hundred, 58-64 ms, the same as the year windows above. It is .NET compiling the hot paths (tiered JIT), not the year. An API that has
  just started (a release, a restart) answers its first year view in about 0.1 s and the rest in about 0.06 s; the day's first
  requests are slower in proportion (p50 7.8 ms right after the start, 5.7 ms after).
- Plan 1's own script, `tools/perf/day-latency.sh` (no compression), run again in the first pass: p50 5.2 ms, p95 8.6 ms, p99 10.7 ms,
  max 17.1 ms, against 5.0 / 7.0 / 7.9 / 12.4 in Plan 1: the same. `/api/status`: 9.0 ms once warm (the first request, 67 ms, is the JIT).
- The year answer is mostly its `moves` (1,643 moves, one line each); the vertex cap of `VertexBudget` (60,000 when this was measured,
  50,000 now) did not have to cut anything here (14.9 thousand vertices), so the synthetic history does not show what it does to a
  heavier year (the unit tests do).
- The place endpoint is the slowest per row of work (p50 11.7 ms) because it is two recursive queries and a transaction at
  `RepeatableRead`; it has no target of its own and sits at a tenth of the day's.

### Query plans (P2-R61)

`tools/perf/explain.sql` (new) holds every query the read endpoints run, copied from `SegmentStore`, `RangeStore`, `PlaceStore` and
`ProcessingQueue` with its parameters as psql variables, under `EXPLAIN (ANALYZE, BUFFERS)`:

```sh
docker exec -i sporer-perf-db psql -U postgres -d perf -X \
  -v day=2025-09-10 -v from=2025-01-01 -v to=2025-12-31 -v place=1 < tools/perf/explain.sql
```

Run against the history above after the backfill (autovacuum had analysed `segment` and `place`), for the year 2025 and for place 1,
the busiest (721 visits). The full plans are in the appendix; in short:

| Query | Plan | Execution | Buffers |
| --- | --- | --- | --- |
| Day: the day's segments | Index Scan `ix_segment_local_dates` (17 rows), `place` looked up per segment through a Memoize | 1.3 ms | 25 |
| Day: the zone before an empty day | Index Scan Backward on `ix_segment_stays`, limit 1 (1,767 stays passed before one matched) | 1.4 ms | 504 |
| Day and range: waiting work | Seq Scan on `dirty_range` (empty) and `processing_state` (1 row) | 0.03 ms | 2 |
| Range: the moves | Index Scan `ix_segment_local_dates`, filter `kind = 'move'`, sort | 8.6 ms | 602 |
| Range: the places | Index Scan `ix_segment_stays` (1,643 of 3,797 stays in range), the merge chain walked through `place` (87 rows, 1 page) | 7.7 ms | 1,079 |
| Range: the days | the same, and a group by date | 7.9 ms | 1,678 |
| Heat | Index Scan `ix_segment_stays` (3,797 stays, 1,643 in range) | 8.2 ms | 1,076 |
| Place: the totals | Index Scan `ix_segment_stays` over all 3,797 stays, hash semi join with the place's members | 2.8 ms | 1,081 |
| Place: the latest visits | Index Scan Backward on `ix_segment_stays`, `limit 50`, the same filter | 1.8 ms | |
| Status: state, backlog | Seq Scans on one-row and empty tables | 0.015-0.04 ms | 1-2 |
| Status: places in use | **Seq Scan on `segment`** (7,607 rows), hash join with `place` (87) | 3.6 ms | 610 |

**No query scans a large table.** Every `Seq Scan` above is on `place` (87 rows, one page), `processing_state` (one row) or the empty
`dirty_range`, except one: the status page's count of the places in use reads all of `segment`, 7,607 rows, in 3.6 ms. The queries
that find a place's stays by `segment.place_id` (the place view) have no index to use and filter all 3,797 stays instead, 1,076
buffers, 2-3 ms. `locationlog` is not read by any read endpoint. Every endpoint is far inside its target, so **no migration 0005 was
added**, which is what P2-R61's two conditions ask for. To see what the index would be worth, the same place and status queries were run on temporary copies of the
timeline (nothing in the database was touched), as it is and made 12 times as long (91,284 segments), without and with the index a
migration would add, `create index ix_segment_place on segment (place_id, start_utc desc)` (`tools/perf/place-index-whatif.sql`,
new; execution times from the plans in ms):

| Query | Now (7,607 segments): without → with | 12 times as long: without → with |
| --- | --- | --- |
| Place: the totals | 2.8 → 1.1 | 44-67 → 26-32 |
| Place: the latest visits | 1.9 → 4.0 (the same plan both times, the new index is not used: noise) | 25-30 → 24-42 (the same, no gain) |
| Status: the places in use | 2.4 → 0.36 | 43-60 → 0.8-2.9 |

(The 12-times figures are from three runs, hence the ranges.) At the size of this history the index would save a few milliseconds of
a 20 ms endpoint, and it makes the visits query no better; at twelve times the history the status page would be the one to gain
(about 50 ms to 1-3 ms), but a history of 12 times 2.3 years is 28 years. Adding it later is a migration that creates one object and
nothing else; it is left until the history is long enough for it to matter, as Plan 1's table of suspects left it.

### Compression

The API compresses what it reads with ASP.NET's response compression, Brotli first and gzip, and left at its defaults that is the
`Fastest` level of both. The first pass found that this makes Brotli the larger of the two for the web app's JavaScript, which is what
a browser that accepts both is given: measured from the API with the built web root (`curl -H 'Accept-Encoding: ...'`, which counts the
body as it is sent), 679.9 kB with Brotli against 626.1 kB with gzip. Fix round 1 compared the levels of `CompressionLevel` for both
providers (a temporary `Configure` of the two options, run as three API processes on the same history, the final web build in its web
root; Brotli quality 1, 4 and 11 for Fastest, Optimal and SmallestSize; gzip level 1, 6 and 9) and chose Optimal. Its API requests were
drawn anew for each level (the script's seed did nothing, see "The seed"), which made the day look 20 % smaller at Optimal and the year
6 %. Fix round 2 measured the levels again on matched requests, and the tables below are that comparison: `tools/perf/api-latency.sh`
with its seed 1, so **the three levels were asked the same 200 dates and the same 120 windows**, and on them the day is 14 % smaller
and the year 7 %, which confirmed the choice. Static files: size, and the time of 15 requests after 2 warm-up ones. The sizes are Brotli.

**The scripts** (bytes sent; time per request, median / p95 of 15, ms):

| File | Fastest: Brotli | Fastest: gzip | **Optimal: Brotli** | **Optimal: gzip** | SmallestSize: Brotli | SmallestSize: gzip |
| --- | --- | --- | --- | --- | --- | --- |
| `maplibre-*.js` (1,046 kB raw) | 368,926 B, 10.9 / 22.7 | 337,315 B, 20.5 / 26.6 | **280,595 B, 26.3 / 32.5** | 280,832 B, 41.3 / 48.4 | 230,070 B, **2,140 / 2,349** | 280,018 B, 54.5 / 72.0 |
| `maplibre-gl-worker-*.mjs` (519 kB) | 186,706 B, 6.3 / 7.5 | 173,711 B, 10.5 / 20.2 | **145,738 B, 14.0 / 19.0** | 147,471 B, 22.1 / 55.5 | 121,564 B, 1,017 / 1,128 | 147,120 B, 28.0 / 33.7 |
| `index-*.js` (317 kB) | 124,232 B, 5.6 / 15.9 | 115,102 B, 8.3 / 13.3 | **98,283 B, 12.1 / 17.2** | 97,581 B, 15.5 / 24.4 | 84,507 B, 682 / 874 | 97,408 B, 20.5 / 28.6 |
| **The three** | **679,864 B** | 626,128 B | **524,616 B** | 525,884 B | 436,141 B | 524,546 B |

**The API's answers** (the same requests at each level; Brotli sizes, median; p50 / p95 in ms):

| | Fastest | **Optimal** | SmallestSize |
| --- | --- | --- | --- |
| Year, 20 windows | 58.9 / 70.8, 160,145 B | **67.7 / 79.6, 148,905 B** | 1,103 / 1,205, 96,221 B |
| Month, 100 windows | 18.3 / 24.1, 13,568 B | **16.8 / 22.2, 12,924 B** | 87.1 / 108.3, 9,092 B |
| Day, 200 dates | 6.3 / 9.2, 2,475 B | **6.1 / 9.5, 2,127 B** | 17.1 / 26.3, 1,602 B |
| Heat, year: p95; places: p95 | 20.9; 17.0 | **17.5; 19.7** | 22.5; 27.4 |
| The calendar year 2025 (553 kB raw): Brotli and gzip sizes | 166,327 B and 186,015 B | **155,469 B and 157,560 B** | 99,913 B and 153,200 B |
| the same: Brotli median / p95 of 15 requests, fresh server; after a few hundred requests | 121.7 / 155.9; 58.0 / 79.8 | **115.3 / 179.3; 63.6 / 93.0** | 1,039 / 1,094; 1,058 / 1,206 |

(The `index` file in the first-pass comparison had another hash than the final build's, the same code, and the requests were
other ones: the numbers of this table replace it. The calendar year takes 115-122 ms on a fresh server and 58-64 ms after a few hundred
requests at Fastest and Optimal (at SmallestSize it is over a second); see the first requests of a fresh process in "Server / Results".)

**Decision: Optimal for both** (`Program.cs`, commit `4f96769`; a hosting test pins the level). Made in fix round 1, and confirmed by the
matched comparison of fix round 2, whose numbers these are. The ruling's condition was Brotli
smaller than gzip at an acceptable cost, and at Optimal it is smaller for the scripts together (524.6 against 525.9 kB, in the noise of
a tie: the library chunk 0.2 kB smaller, the worker 1.2 % smaller, `index` 0.7 % larger) and for the year's JSON (155.5 against 157.6 kB,
1.3 %), where at Fastest it was 9 % larger for the scripts. Brotli is what a browser that takes both is given, so the real gain is
against the default: **the scripts from 679.9 to 524.6 kB (−23 %)**, the year's answer 7 % smaller, the month's 5 %, the day's 14 %. The cost
is small: the year at p95 goes from 70.8 to 79.6 ms against a target of 800 ms, the month and the day do not change (inside the
run-to-run spread), and a script takes 12 to 26 ms to compress per request instead of 6 to 11 (they are fetched once per release, and
cached `immutable`). SmallestSize, the only level that beats gzip clearly (the scripts another 17 % smaller, 436 kB), is not
acceptable: 2.1 s for one script and 0.7 s for the smallest, and 1.1 s for the year, which is over its 800 ms target on its own. A
build-time precompression of the assets at Brotli quality 11 would give those 436 kB with no cost per request, but is a change to how
the API serves files, not made here.

## Web

### Bundle

`npm run build`, then `npm run perf:bundle` (`web/scripts/perf/bundle-size.mjs`, new). Sizes in kB (1 kB = 1,000 bytes), gzip at
level 9; Vite's own report (level 6) and Brotli at quality 11 for comparison. After fix round 1:

| File | Raw | gzip 9 | gzip 6 | Brotli 11 |
| --- | --- | --- | --- | --- |
| `index-*.js` (the app, React, TanStack Query, date-fns: what the page starts with) | 317.0 | 97.6 | 97.8 | 84.5 |
| `maplibre-*.js` (MapLibre library chunk, fetched by the map when it mounts) | 1,046.0 | 281.3 | 282.0 | 230.1 |
| `maplibre-entry-*.js` (the map's way in: two exports and the worker's address) | 0.1 | 0.1 | 0.1 | 0.1 |
| **Main-thread JavaScript (the three above)** | 1,363.1 | **379.0** | 379.9 | 314.7 |
| `maplibre-gl-worker-*.mjs` (MapLibre's worker, an asset of the build, apart) | 518.8 | 147.9 | 148.2 | 121.6 |
| **All JavaScript files** | 1,881.9 | **526.9** | 528.1 | 436.2 |
| CSS (the app's 3.5 kB; MapLibre's comes with its chunk) | | 13.5 | 13.6 | 11.3 |

Before fix round 1 the page started with all of it but the worker: 378.1 kB (`index` 96.8 and `maplibre` 281.3 kB gzip 9; all files 526.0 kB).
The change adds 0.9 kB: the loader, and the map's handling of a module that arrives later.

**Verdict (ruling P2-R63): met.** The target, "≤ 450 kB gzip including MapLibre", is judged on main-thread JavaScript, the chunks the
page runs: 379.0 kB, 71 kB (16 %) under it (Vite's own table prints 98.8 and 284.6 kB for the two chunks, 383 kB). MapLibre's worker,
which MapLibre parses tiles and GeoJSON in and which is not run on the main thread, is reported apart: 147.9 kB. **Stated plainly,
the literal miss:** counted as one number, every JavaScript file together, worker included, is 526.9 kB, 76.9 kB (17 %) over
450 kB. There is nothing to fix it with: MapLibre 6.15.0, pinned by the plan's Tech Stack, is 429.3 kB gzip with its worker by itself
(95 % of the target; React, its DOM and TanStack Query are 97 kB), and it ships one build. The hashed files are served `immutable`
for a year (Program.cs), so the installed app fetches them once per release. What goes over the wire to a browser is in
"Compression".

### Method

`npm run perf:record` records what the app asks the API for; `npm run perf` plays it back to a throttled phone-sized page and times it.
Neither is part of `npm run e2e` or of CI.

1. **Record (`web/scripts/perf/record.mjs <api-url> <first-date> <last-date> [year]`).** Against the API over the synthetic history it
   asks for every day and every whole calendar month, picks a **typical** weekday (the median by size of its answer: 2025-11-19, 15
   rows, 8.0 kB) and the **heaviest** day (2025-06-28, 11 rows, 18.8 kB, a hike), a typical month (2025-05, 46.0 kB) and the heaviest
   (2025-06, 53.9 kB), and the year 2025 (553.4 kB, the one full calendar year), and records the answers as the server wrote them, with
   `/api/status` and what the app prefetches around each: the days or periods one and two either side (the app prefetches the one
   before and the one after what is on show, so a tap on › asks for the one after that), 22 responses in all. They go to
   `web/perf/recorded/`, which is **not committed** (git ignores it, as it does `web/perf/results/`): a year of routes is 0.55 MB and
   the recording is made on the machine that measures. `/api/config` is the e2e fixture's, which names a local style
   (`/test-style.json`: a plain background), because no test and no measurement reaches the internet.
2. **Play back (`web/perf/web-timing.spec.ts`, config `web/playwright.perf.config.ts`, `npm run perf`).** Each run is a test of its
   own, so each gets a new browser context (an empty HTTP cache: a cold load) of the e2e suite's phone project. In it: the API is
   mocked with the e2e suite's `mockApi`, serving the recorded answers (a request with no recording fails the run); the CDP session
   sets `Emulation.setCPUThrottlingRate` to 4; a probe is installed before the page's scripts; `page.goto(url)`; the run waits until
   the panel's rows have been on screen, the map has been idle since, and 400 ms have passed. Then the page is at rest and the run
   **taps ›** ("Next day", "Next month", "Next year") and times that too: the next day or period was prefetched by the app as soon as
   the first was on show, which is the case the spec means by "after navigating (‹ ›)". One warm-up run is thrown away (a browser's
   first page pays for starting the GPU process and compiling the shaders), then 7 runs of each of five scenarios (typical day,
   heaviest day, typical month, heaviest month, year), the 35 of them in one browser, one after the other.
3. **What the probe times** (all `performance.now()`, that is ms from the start of the navigation; for the tap, from the click):
   - *API answer received*: `responseEnd` of the first `/api/day` or `/api/range` request.
   - *Panel rows in the DOM*: the first moment the panel (`[aria-label="Details"]`) has a list item, seen by a `MutationObserver`; and
     *painted*: two animation frames later. The rows of the day are its timeline, the rows of a month or a year are "Where your time
     went" (10 places) and its days (every date of a month, the days that have movement of a year): 15, 41 and 348 rows. On the phone
     the sheet starts at its peek, where its chips show and the rows are below the edge of the screen until the owner drags it up;
     they are rendered all the same, and that is the time.
   - *Map idle*: MapLibre's own `idle` event, the first one at or after the rows (so not the idle of an earlier, empty map). The probe
     gets the map from the React fiber of its component (the page has no handle on it; it is in the component's state) and listens to `idle`, `sourcedata` and
     `render`. *Routes drawn*: the first frame the map renders after its routes source has its data, which is when the line is on
     the screen; the camera may still be moving. *Map style loaded*: the map element's `data-map-state` becoming `ready`.
   - *Main thread blocked before the rows*: the sum of the long tasks (> 50 ms) that began before the rows.
4. A screenshot of the first run of each scenario was looked at to see that what was timed was a map with its routes and pins and a
   panel with its chips (they are under `web/perf/results/`, not committed).

### Results

4× CPU throttling, 7 runs of each, ms from the start of the navigation (from the tap, for the step); median / worst, then the range
of the 7 for the primary signal. The tables are after fix round 1; the first pass is below them.

**Cold navigation** (`page.goto`, an empty cache), after:

| | Typical day (15 rows) | Heaviest day (11 rows) | Typical month (41 rows) | Heaviest month (40 rows) | Year (348 rows) |
| --- | --- | --- | --- | --- | --- |
| API answer received | 653 / 687 | 644 / 834 | 650 / 728 | 655 / 781 | 675 / 768 |
| first contentful paint | 668 / 708 | 664 / 852 | 668 / 744 | 680 / 812 | 644 / 736 |
| **panel rows in the DOM** | **764 / 846** (681-846) | **757 / 1,020** (669-1,020) | **793 / 853** (752-853) | **874 / 1,007** (766-1,007) | **1,128 / 1,303** (992-1,303) |
| panel rows painted | 961 / 1,088 | 871 / 1,332 | 884 / 990 | 1,007 / 1,150 | 1,341 / 1,505 |
| map style loaded | 1,270 / 1,321 | 1,245 / 1,658 | 1,259 / 1,382 | 1,408 / 1,455 | 1,631 / 1,742 |
| routes drawn on the map | 1,688 / 1,809 | 1,685 / 2,058 | 1,764 / 2,058 | 2,122 / 2,280 | 2,492 / 2,768 |
| **map idle** | **1,894 / 2,437** (1,789-2,437) | **1,802 / 2,224** | **1,792 / 2,058** | **2,122 / 2,281** | **2,492 / 2,768** (2,174-2,768) |
| main thread blocked before the rows | 535 / 584 | 519 / 668 | 540 / 596 | 607 / 709 | 736 / 939 |
| *target* | ≤ 1,000 | ≤ 1,000 | ≤ 2,000 | ≤ 2,000 | ≤ 3,000 |

**Tap › with the page open** (the next day or period already prefetched), after:

| | Typical day | Heaviest day | Typical month | Heaviest month | Year |
| --- | --- | --- | --- | --- | --- |
| **panel rows** | **65 / 91** (35-91) | **43 / 84** | **84 / 131** | **69 / 106** | **207 / 269** |
| rows painted | 141 / 205 | 118 / 177 | 215 / 227 | 179 / 205 | 482 / 536 |
| routes drawn on the map | 138 / 205 | 117 / 167 | 214 / 224 | 179 / 204 | 706 / 791 |
| map idle | 1,017 / 1,309 | 1,376 / 1,610 | 1,333 / 1,501 | 1,010 / 1,156 | 1,493 / 1,969 |
| *target* | ≤ 1,000 | ≤ 1,000 | ≤ 2,000 | ≤ 2,000 | ≤ 3,000 |

**Before and after** (cold navigation, median / worst of 7; the first pass, commit `cd95664`, then fix round 1):

| | Panel rows in the DOM | Panel rows painted | First contentful paint | Map style loaded | Map idle |
| --- | --- | --- | --- | --- | --- |
| Typical day | 947 / 1,016 → **764 / 846** | 992 / 1,067 → 961 / 1,088 | 840 / 900 → 668 / 708 | 1,167 / 1,247 → 1,270 / 1,321 | 1,947 / 2,073 → 1,894 / 2,437 |
| Heaviest day | 982 / 1,124 → **757 / 1,020** | 1,019 / 1,181 → 871 / 1,332 | 848 / 940 → 664 / 852 | 1,196 / 1,395 → 1,245 / 1,658 | 1,746 / 1,993 → 1,802 / 2,224 |
| Typical month | 1,154 / 1,197 → **793 / 853** | 1,213 / 1,260 → 884 / 990 | 968 / 1,060 → 668 / 744 | 1,427 / 1,567 → 1,259 / 1,382 | 1,943 / 2,204 → 1,792 / 2,058 |
| Heaviest month | 1,097 / 1,264 → **874 / 1,007** | 1,137 / 1,326 → 1,007 / 1,150 | 944 / 1,068 → 680 / 812 | 1,377 / 1,571 → 1,408 / 1,455 | 1,976 / 2,142 → 2,122 / 2,281 |
| Year | 1,252 / 1,527 → **1,128 / 1,303** | 1,395 / 1,712 → 1,341 / 1,505 | 880 / 996 → 644 / 736 | 1,556 / 1,835 → 1,631 / 1,742 | 2,754 / 3,033 → 2,492 / 2,768 |

The tap is where it was (day 57 / 77 → 65 / 91 ms): nothing in it touches MapLibre's loading. An earlier run of the first pass, with
fewer instruments, gave the same picture within the spread (the day's rows 958 / 1,044 ms, the month's 1,022 / 1,152, the year's 1,254 / 1,413).

How to read it:

- **Where the time goes.** Before the change the page ran 1.4 MB of JavaScript on its main thread, MapLibre's chunk among it, before
  it could ask for anything (and MapLibre's worker, 0.5 MB, was fetched beside it); at a quarter of the speed the main thread was blocked for 0.7-0.9 s before the first row. Now the page starts with 317 kB
  of it (98 kB gzip): the first contentful paint is at 0.64-0.68 s (it was 0.84-0.97), the API answer arrives at 0.64-0.68 s (it was
  0.81-0.92), and the rows are in the DOM 110 ms (a day) to 450 ms (a year of 348 rows) after it: the day by 0.76 s, the month by 0.79 s,
  the year by 1.13 s. MapLibre's chunk starts when the map mounts, once the app's first render is done.
- **The rows are painted later than they are in the DOM**, by 0.1 to 0.2 s, where before the change the two were 40 to 60 ms apart for
  a day or a month (140 ms for the year). That is MapLibre arriving in the same stretch: the mocked API answers at once, the chunk is a
  local file that arrives at once too, and its parsing, a task of about 0.2 s at this speed, is queued before the frame that paints the
  rows. The change therefore bought the DOM 180 ms (day), 360 ms (month) and 120 ms (year) at the median, and the paint 30 ms, 330 ms
  and 55 ms. For the two days the paint is **not** a plain gain: the day's median is 961 ms (992 before) and its worst of seven 1,088 ms
  (1,067 before), and the heaviest day's median is 871 ms (1,019 before) but its worst of seven rose **from 1,181 to 1,332 ms**, with the
  slowest run of seven also the one whose rows reached the DOM last (1,020 ms), so both days have a worst run over 1 s on the paint.
  For the month, the heaviest month and the year the paint is better at the median and at the worst. On a phone with a real
  connection the answer to the request takes 100 ms or more, and a first load of the chunk, the slower of the two, would be expected to
  arrive after it, so that the rows paint first; with the chunk cached its task would come at the start, before the answer (neither
  is measured here, where the network is loopback). Making that certain, by letting the map's load wait for the first data to be
  painted, was considered and **not done** (ruling P2-R66, "Decisions"): the medians improved everywhere, the worst-of-seven swing of
  the two days is within the run-to-run noise of this machine, and the map is the owner's priority view.
- **The map comes later, a little.** The style is loaded at 1.25-1.63 s, about as before (±150 ms: it was 1.17-1.56 s); `idle` is
  within the run-to-run spread of what it was (the day's worst run, 2,437 ms, is one slow run of seven). `idle` is the camera move
  (600 ms by design, `FIT_DURATION_MS`) and the frames drawn during it, each of 1170 × 2532 pixels in software, on top of the
  start; see the caveats before reading it as a verdict.
- **The target for the day is the tap.** Spec §8 says "Day view data shown after navigating (‹ ›), past day ≤ 1 s (near-instant when
  prefetched)": 65 ms at the median, 91 at the worst, with the neighbour prefetched. A day that is not prefetched costs the request
  on top: the API's p95 of 8.5 ms plus the gap between "API answer received" and "rows" above (about 110 ms for a day, 140 ms for a
  month, 450 ms for a year). §8's own cold number is "open app (cold, installed) to map visible ≤ 2 s": the map's style was loaded at
  1.27 s (day), and the routes were on the map at 1.69 s (day), 1.76 s (month), 2.49 s (year).

### The fix: MapLibre loads after the panel (ruling P2-R64, commit `86a3703`)

The panel's rows waited for MapLibre: it is two thirds of the app's JavaScript, the page's bundle imported it, and parsing it is the
longest task of a start. Now the map fetches MapLibre itself, when it mounts, as a chunk of its own:

- `src/map/maplibre-entry.ts` is what the map imports dynamically: MapLibre's two exports it uses (a dynamic `import("maplibre-gl")`
  would keep all of them, 50 kB more), MapLibre's stylesheet and the address of its worker. They have to be here and not in the map's
  own file: the first build with the stylesheet in `MapView.tsx` made the page's bundle import MapLibre's chunk (to carry the
  stylesheet), and the page ran it at the start again, which only a look at the built `index.html` showed. An e2e test now reads the
  production build and fails when the page preloads MapLibre or imports its chunk statically (it was shown to fail on that build).
- `src/map/maplibre.ts` is the loader: one fetch for everyone, the worker told to the module before anyone has it, a failed fetch
  not kept (the next mount tries again). Vite keeps the chunk named `maplibre` as before.
- `MapView` shows the plain background (`data-map-state="loading"`) until the module arrives, then makes the map. What was given
  meanwhile (`data`, `fitTo`, `home`, `padding`) is used as the latest of each at that moment, and the map is brought to `fitTo`
  once. A chunk that cannot be fetched goes through `onStyleError`, so the page says "Map unavailable" and goes on, with no
  unhandled rejection. Under StrictMode one arrival makes one map.
- MapLibre's stylesheet now arrives after the app's (before, it came first). Its rule `.maplibregl-map { position: relative }` has the same
  weight as the app's `.map { position: absolute }`, so the later one won: the map's element had no height and the canvas was a default
  300 px high. The e2e suite found it on its first run; the app's rule is two classes now (`.root > .map`).
- Tests: the loader (once, worker first, a failure not kept), `MapView` (the plain background and no map before the module, what was given
  meanwhile applied and one fit, unmounted before the arrival, StrictMode, a failed load with no unhandled rejection; deleting the
  map's `fitTo` effect on arrival fails eight of them), and the e2e check of the build above. The 13 tests that assumed the map was
  there at the first render now wait for it.

### Does the throttle slow the map's worker?

MapLibre builds its GeoJSON tiles in a worker. A probe in the spec (`probe: does the CPU throttle reach a worker`) runs a fixed loop on
the page's thread and in a worker, unthrottled and at 4×: the page's thread slowed **4.5 times** (587 → 2,624 ms) and the worker **1.4
times** (846 → 1,162 ms) in one run; in the last run 4.8 times and 0.9 times (1,102 → 1,031 ms); over five runs the worker's
slowdown was 0.9 to 1.5 times. The CDP throttle does not reach the worker, or hardly. So the parts of the map's time
that run in the worker (parsing the year's 15,000 vertices into tiles) are measured **at close to full speed**, where the page's
own code runs at a quarter of it; on a slower phone the worker's share of `idle` and of *routes drawn* would be larger than here.

## What this does not show (caveats)

- **Software WebGL.** Every frame of the map is drawn by SwiftShader on the CPU, at 1170 × 2532 pixels, in a process the CPU
  throttle does not reach. A real iPhone's GPU draws that in a few milliseconds, so the map's `idle` and *routes drawn* include a
  rendering cost the phone does not have, and exclude the cost of the worker running at a quarter of the speed it would on a
  slow core (above). They go in opposite directions and neither is measured on the device; hence the panel's rows are the primary
  signal and `idle` is a record, not a verdict. Pan and zoom smoothness (spec §8's "smooth, including Year with routes") cannot be
  measured here at all.
- **The map's style and tiles.** The e2e style is a single background layer, with no vector tiles: the cost of fetching, decoding
  and drawing OpenFreeMap's tiles and their labels, and of the English-label rewrite of the real style, is not in any number. Nor is
  any network: the API is mocked from Node (`page.route`), and the app comes from `vite preview` over loopback. "Excluding network",
  as the targets say, but the real phone's first start also fetches 0.5 MB of JavaScript over the VPN (524.6 kB as the API sends it
  with Brotli, 426 kB of it MapLibre's, which the map fetches after the panel; cached after).
- **The mock and the loopback answer at once.** That puts MapLibre's parsing in the same stretch as the rows (see "Where the time
  goes"): their paint waits behind it by 0.1 to 0.2 s. A real network would separate them; that is expected, not measured.
- **The throttle.** 4× is the brief's figure, applied to the page's main thread; it is not a model of an iPhone, whose single-core
  speed is likely nearer this container's than a quarter of it. Run-to-run spread on this shared 4-core container is about ±10 %
  (the month's cold rows were 1,022 ms in one run of 7 and 1,154 ms in the next), and the worst of 7 is a sample of the tail, not
  a bound. The runs are in one browser process, one after another; the first thrown away.
- **The data.** Synthetic: a person who moves 1.7 hours a day on clean commutes, 7,607 segments, 1,643 moves in the busiest year
  and 15 thousand vertices after simplification. The vertex budget (60,000 then, 50,000 now) was never reached, and a history with places of thousands
  of visits, several devices or a year of long drives could cost more at the server and in the range panel's 348 rows. The row
  counts, 41 for a month and 348 for a year, are this person's.
- **Only the phone viewport** was timed (the desktop sidebar renders the same rows); only the light colour scheme; the heat layer
  was off (its answer is 1-3 kB and it adds one source); no service worker was involved (the app has none yet, so there is no cached shell to start from;
  every run is a cold load in a fresh context).
- **Server timings share the machine** with the client and use curl's `time_total` on loopback; they say what the server costs, not
  what the VPN, TLS in Traefik and Authentik add.
- Place naming (`Nominatim__Enabled=false`) was off, as in Plan 1.

## Repeat it

```sh
# --- The history and the server (as Plan 1; about 4 minutes) ---
docker run -d --name sporer-perf-db -e POSTGRES_PASSWORD=password -p 55432:5432 timescale/timescaledb:2.17.2-pg16
docker exec sporer-perf-db psql -U postgres -c "create database perf"
dotnet build src/Sporer.Api -c Release
api=src/Sporer.Api/bin/Release/net10.0/Sporer.Api.dll
export TSDB_CONNECTION_STRING="Host=localhost;Port=55432;Username=postgres;Password=password;Database=perf"
export Nominatim__Enabled=false ASPNETCORE_URLS=http://127.0.0.1:5100
Processing__Enabled=false dotnet $api & pid=$!; sleep 8; kill $pid          # creates the schema
dotnet run --project tools/Sporer.SyntheticData -c Release -- --connection "$TSDB_CONNECTION_STRING" \
  --from 2024-06-01 --to 2026-10-22 --moving-interval 500ms --seed 42       # 10.7 million rows, about 80 s
dotnet $api & pid=$!
until [ "$(curl -s localhost:5100/api/status | jq -r .backfill.percent)" = 100 ]; do sleep 3; done   # about 2.5-3 minutes

# --- The server: latencies, sizes, vertices; the plans; the index what-if ---
tools/perf/api-latency.sh http://127.0.0.1:5100 2024-06-01 2026-10-22            # about 40 s; the 9th argument is the seed
docker exec -i sporer-perf-db psql -U postgres -d perf -X \
  -v day=2025-09-10 -v from=2025-01-01 -v to=2025-12-31 -v place=1 < tools/perf/explain.sql
docker exec -i sporer-perf-db psql -U postgres -d perf -X -v copies=12 -v place=1 < tools/perf/place-index-whatif.sql

# --- The compression: the sizes the API sends, and what they cost (it serves the web build from its content root) ---
kill $pid; ASPNETCORE_CONTENTROOT=$PWD/src/Sporer.Api dotnet $api & pid=$!   # now it serves the web build (`npm run build` in web/ first)
sleep 8
for enc in gzip br; do curl -s -o /dev/null -H "Accept-Encoding: $enc" -w "$enc %{size_download} B %{time_total} s\n" \
  http://127.0.0.1:5100/assets/$(ls src/Sporer.Api/wwwroot/assets | grep '^maplibre-[A-Za-z0-9_-]*\.js$' | grep -v entry); done
# (the levels were compared by setting Brotli's and gzip's `Level` in Program.cs for each run: Fastest, Optimal, SmallestSize)

# --- The web: record the API's answers once, then measure (the API may be stopped for the second) ---
cd web
npm run perf:record -- http://127.0.0.1:5100 2024-06-01 2026-10-22 2025         # web/perf/recorded/, not committed
npm run perf                      # builds, serves the build, 37 tests, about 4 minutes; PERF_RUNS=7 PERF_CPU=4 by default
npm run perf:bundle               # after `npm run build`: gzip, Brotli, per file

kill $pid; docker rm -f sporer-perf-db
```

`npm run perf` prints the table and writes `web/perf/results/web-timing.json` (every run's numbers) and a screenshot of each scenario;
`PERF_RUNS` and `PERF_CPU` change the runs and the throttle. It needs the recorded answers and the Chromium Playwright already has
(it never installs one), uses port 4174 (the e2e suite's is 4173; the two are not to run at once, as both build into the API's web root) and no real network. It is a measurement, not a test of the app:
it asserts only that each run reached the rows and the map's idle and asked for nothing that was not recorded. `npm run e2e` and
CI do not run it.

## Appendix: the query plans

Run with `tools/perf/explain.sql` as above, on the history of this document, with literal parameters (the custom plans a statement
gets on its first executions). `Buffers` lines are all `shared hit`: the database was warm and in memory.

### Before: the queries as they are (the history of this document)

<details><summary>Day: the day`s segments (SegmentStore.FindDayAsync)</summary>

```
                                                                           QUERY PLAN
 Sort  (cost=2775.77..2780.53 rows=1906 width=215) (actual time=1.108..1.113 rows=17 loops=1)
   Sort Key: s.start_utc, s.id
   Sort Method: quicksort  Memory: 35kB
   Buffers: shared hit=25
   ->  Nested Loop Left Join  (cost=24.20..2671.92 rows=1906 width=215) (actual time=0.311..1.030 rows=17 loops=1)
         Buffers: shared hit=19
         ->  Index Scan using ix_segment_local_dates on segment s  (cost=0.28..456.35 rows=1906 width=778) (actual time=0.280..0.500 rows=17 loops=1)
               Index Cond: ((local_start_date <= '2025-09-10'::date) AND (local_end_date >= '2025-09-10'::date))
               Buffers: shared hit=11
         ->  Memoize  (cost=23.92..24.55 rows=1 width=152) (actual time=0.006..0.015 rows=1 loops=17)
               Cache Key: s.place_id
               Cache Mode: binary
               Hits: 10  Misses: 7  Evictions: 0  Overflows: 0  Memory Usage: 1kB
               Buffers: shared hit=8
               ->  Subquery Scan on p  (cost=23.91..24.54 rows=1 width=152) (actual time=0.012..0.035 rows=1 loops=7)
                     Buffers: shared hit=8
                     ->  CTE Scan on chain  (cost=23.91..24.53 rows=1 width=164) (actual time=0.011..0.034 rows=1 loops=7)
                           Filter: (merged_into_id IS NULL)
                           Buffers: shared hit=8
                           CTE chain
                             ->  Recursive Union  (cost=0.00..23.91 rows=31 width=164) (actual time=0.009..0.032 rows=1 loops=7)
                                   Buffers: shared hit=8
                                   ->  Seq Scan on place  (cost=0.00..1.80 rows=1 width=164) (actual time=0.004..0.007 rows=1 loops=7)
                                         Filter: (id = s.place_id)
                                         Rows Removed by Filter: 86
                                         Buffers: shared hit=7
                                   ->  Hash Join  (cost=0.26..2.18 rows=3 width=164) (actual time=0.016..0.016 rows=0 loops=7)
                                         Hash Cond: (next.id = chain_1.merged_into_id)
                                         Buffers: shared hit=1
                                         ->  Seq Scan on place next  (cost=0.00..1.64 rows=64 width=160) (actual time=0.001..0.001 rows=1 loops=1)
                                               Buffers: shared hit=1
                                         ->  Hash  (cost=0.22..0.22 rows=3 width=12) (actual time=0.001..0.001 rows=0 loops=7)
                                               Buckets: 1024  Batches: 1  Memory Usage: 8kB
                                               ->  WorkTable Scan on chain chain_1  (cost=0.00..0.22 rows=3 width=12) (actual time=0.001..0.001 rows=1 loops=7)
                                                     Filter: (depth < 32)
 Planning:
   Buffers: shared hit=629
 Planning Time: 4.945 ms
 Execution Time: 1.299 ms
```

</details>

<details><summary>Day: the zone before a day with no segment (SegmentStore.FindZoneBeforeAsync)</summary>

```
                                                                  QUERY PLAN
 Limit  (cost=0.28..0.48 rows=1 width=19) (actual time=1.373..1.374 rows=1 loops=1)
   Buffers: shared hit=504
   ->  Index Scan Backward using ix_segment_stays on segment  (cost=0.28..396.80 rows=2026 width=19) (actual time=1.372..1.372 rows=1 loops=1)
         Filter: (local_end_date < '2025-09-10'::date)
         Rows Removed by Filter: 1767
         Buffers: shared hit=504
 Planning:
   Buffers: shared hit=15
 Planning Time: 0.194 ms
 Execution Time: 1.392 ms
```

</details>

<details><summary>Day and range: waiting work (ProcessingQueue.HasPendingWorkAsync)</summary>

```
                                                                                                   QUERY PLAN
 Result  (cost=1.31..1.32 rows=1 width=1) (actual time=0.020..0.020 rows=1 loops=1)
   Buffers: shared hit=1
   InitPlan 1 (returns $0)
     ->  Seq Scan on dirty_range  (cost=0.00..25.60 rows=87 width=0) (actual time=0.004..0.004 rows=0 loops=1)
           Filter: ((from_utc < ('2026-01-01 14:00:00'::timestamp without time zone)::timestamp with time zone) AND (to_utc >= ('2024-12-31 10:00:00'::timestamp without time zone)::timestamp with time zone))
   InitPlan 2 (returns $1)
     ->  Seq Scan on processing_state  (cost=0.00..1.02 rows=1 width=0) (actual time=0.015..0.015 rows=0 loops=1)
           Filter: ((backfill_cursor < backfill_to) AND (id = 1) AND (backfill_cursor < ('2026-01-01 14:00:00'::timestamp without time zone)::timestamp with time zone))
           Rows Removed by Filter: 1
           Buffers: shared hit=1
 Planning:
   Buffers: shared hit=73
 Planning Time: 0.769 ms
 Execution Time: 0.033 ms
```

</details>

<details><summary>Range: the moves (RangeStore.FindAsync)</summary>

```
                                                                  QUERY PLAN
 Sort  (cost=701.20..706.07 rows=1947 width=69) (actual time=8.328..8.484 rows=1643 loops=1)
   Sort Key: start_utc, id
   Sort Method: quicksort  Memory: 522kB
   Buffers: shared hit=602
   ->  Index Scan using ix_segment_local_dates on segment  (cost=0.28..594.83 rows=1947 width=69) (actual time=0.048..7.608 rows=1643 loops=1)
         Index Cond: ((local_start_date <= '2025-12-31'::date) AND (local_end_date >= '2025-01-01'::date))
         Filter: (kind = 'move'::text)
         Rows Removed by Filter: 1647
         Buffers: shared hit=602
 Planning:
   Buffers: shared hit=11
 Planning Time: 0.218 ms
 Execution Time: 8.627 ms
```

</details>

<details><summary>Range: the places (RangeStore.FindAsync)</summary>

```
                                                                                                                           QUERY PLAN
 GroupAggregate  (cost=585.13..585.17 rows=1 width=136) (actual time=6.251..7.286 rows=60 loops=1)
   Group Key: p.id
   Buffers: shared hit=1079
   CTE stays
     ->  Index Scan using ix_segment_stays on segment  (cost=0.28..406.29 rows=971 width=39) (actual time=0.530..2.012 rows=1643 loops=1)
           Filter: ((place_id IS NOT NULL) AND (local_start_date <= '2025-12-31'::date) AND (local_end_date >= '2025-01-01'::date))
           Rows Removed by Filter: 2154
           Buffers: shared hit=1076
   CTE chain
     ->  Recursive Union  (cost=24.29..131.81 rows=372 width=28) (actual time=2.431..2.529 rows=60 loops=1)
           Buffers: shared hit=833
           ->  Hash Join  (cost=24.29..27.93 rows=32 width=28) (actual time=2.429..2.455 rows=60 loops=1)
                 Hash Cond: (stays.place_id = p_1.id)
                 Buffers: shared hit=832
                 ->  HashAggregate  (cost=21.85..23.85 rows=200 width=8) (actual time=2.379..2.388 rows=60 loops=1)
                       Group Key: stays.place_id
                       Batches: 1  Memory Usage: 40kB
                       Buffers: shared hit=831
                       ->  CTE Scan on stays  (cost=0.00..19.42 rows=971 width=8) (actual time=0.001..2.177 rows=1643 loops=1)
                             Buffers: shared hit=831
                 ->  Hash  (cost=1.64..1.64 rows=64 width=16) (actual time=0.029..0.030 rows=87 loops=1)
                       Buckets: 1024  Batches: 1  Memory Usage: 12kB
                       Buffers: shared hit=1
                       ->  Seq Scan on place p_1  (cost=0.00..1.64 rows=64 width=16) (actual time=0.002..0.009 rows=87 loops=1)
                             Buffers: shared hit=1
           ->  Hash Join  (cost=2.44..10.02 rows=34 width=28) (actual time=0.063..0.064 rows=0 loops=1)
                 Hash Cond: (chain_1.merged_into_id = next.id)
                 Buffers: shared hit=1
                 ->  WorkTable Scan on chain chain_1  (cost=0.00..7.20 rows=107 width=20) (actual time=0.003..0.007 rows=60 loops=1)
                       Filter: (depth < 32)
                 ->  Hash  (cost=1.64..1.64 rows=64 width=16) (actual time=0.035..0.036 rows=87 loops=1)
                       Buckets: 1024  Batches: 1  Memory Usage: 12kB
                       Buffers: shared hit=1
                       ->  Seq Scan on place next  (cost=0.00..1.64 rows=64 width=16) (actual time=0.009..0.016 rows=87 loops=1)
                             Buffers: shared hit=1
   ->  Sort  (cost=47.03..47.03 rows=1 width=200) (actual time=5.839..5.953 rows=1643 loops=1)
         Sort Key: p.id
         Sort Method: quicksort  Memory: 190kB
         Buffers: shared hit=1079
         ->  Hash Join  (cost=9.37..47.02 rows=1 width=200) (actual time=3.485..5.361 rows=1643 loops=1)
               Hash Cond: (st.place_id = chain.origin)
               Buffers: shared hit=1079
               ->  CTE Scan on stays st  (cost=0.00..36.41 rows=324 width=56) (actual time=0.776..2.326 rows=1643 loops=1)
                     Filter: (EXTRACT(epoch FROM (LEAST(end_utc, ('2026-01-01 00:00:00'::timestamp without time zone AT TIME ZONE start_tz)) - GREATEST(start_utc, ('2025-01-01 00:00:00'::timestamp without time zone AT TIME ZONE start_tz)))) > '0'::numeric)
                     Buffers: shared hit=245
               ->  Hash  (cost=9.36..9.36 rows=1 width=160) (actual time=2.685..2.687 rows=60 loops=1)
                     Buckets: 1024  Batches: 1  Memory Usage: 12kB
                     Buffers: shared hit=834
                     ->  Hash Join  (cost=7.47..9.36 rows=1 width=160) (actual time=2.652..2.670 rows=60 loops=1)
                           Hash Cond: (p.id = chain.id)
                           Buffers: shared hit=834
                           ->  Seq Scan on place p  (cost=0.00..1.64 rows=64 width=152) (actual time=0.007..0.011 rows=87 loops=1)
                                 Buffers: shared hit=1
                           ->  Hash  (cost=7.44..7.44 rows=2 width=16) (actual time=2.626..2.627 rows=60 loops=1)
                                 Buckets: 1024  Batches: 1  Memory Usage: 11kB
                                 Buffers: shared hit=833
                                 ->  CTE Scan on chain  (cost=0.00..7.44 rows=2 width=16) (actual time=2.438..2.590 rows=60 loops=1)
                                       Filter: (merged_into_id IS NULL)
                                       Buffers: shared hit=833
 Planning:
   Buffers: shared hit=25
 Planning Time: 0.772 ms
 Execution Time: 7.665 ms
```

</details>

<details><summary>Range: the days (RangeStore.FindAsync)</summary>

```
                                                                     QUERY PLAN
 Merge Left Join  (cost=569.18..1168.07 rows=812 width=60) (actual time=3.931..7.542 rows=338 loops=1)
   Merge Cond: (segment.local_start_date = st.local_start_date)
   Buffers: shared hit=1678
   CTE stays
     ->  Index Scan using ix_segment_stays on segment segment_1  (cost=0.28..406.29 rows=971 width=39) (actual time=0.440..1.935 rows=1643 loops=1)
           Filter: ((place_id IS NOT NULL) AND (local_start_date <= '2025-12-31'::date) AND (local_end_date >= '2025-01-01'::date))
           Rows Removed by Filter: 2154
           Buffers: shared hit=1076
   CTE chain
     ->  Recursive Union  (cost=24.29..131.81 rows=372 width=28) (actual time=2.396..2.501 rows=60 loops=1)
           Buffers: shared hit=833
           ->  Hash Join  (cost=24.29..27.93 rows=32 width=28) (actual time=2.394..2.418 rows=60 loops=1)
                 Hash Cond: (stays.place_id = p.id)
                 Buffers: shared hit=832
                 ->  HashAggregate  (cost=21.85..23.85 rows=200 width=8) (actual time=2.339..2.347 rows=60 loops=1)
                       Group Key: stays.place_id
                       Batches: 1  Memory Usage: 40kB
                       Buffers: shared hit=831
                       ->  CTE Scan on stays  (cost=0.00..19.42 rows=971 width=8) (actual time=0.000..2.054 rows=1643 loops=1)
                             Buffers: shared hit=831
                 ->  Hash  (cost=1.64..1.64 rows=64 width=16) (actual time=0.031..0.032 rows=87 loops=1)
                       Buckets: 1024  Batches: 1  Memory Usage: 12kB
                       Buffers: shared hit=1
                       ->  Seq Scan on place p  (cost=0.00..1.64 rows=64 width=16) (actual time=0.007..0.013 rows=87 loops=1)
                             Buffers: shared hit=1
           ->  Hash Join  (cost=2.44..10.02 rows=34 width=28) (actual time=0.072..0.073 rows=0 loops=1)
                 Hash Cond: (chain_1.merged_into_id = next.id)
                 Buffers: shared hit=1
                 ->  WorkTable Scan on chain chain_1  (cost=0.00..7.20 rows=107 width=20) (actual time=0.002..0.006 rows=60 loops=1)
                       Filter: (depth < 32)
                 ->  Hash  (cost=1.64..1.64 rows=64 width=16) (actual time=0.049..0.050 rows=87 loops=1)
                       Buckets: 1024  Batches: 1  Memory Usage: 12kB
                       Buffers: shared hit=1
                       ->  Seq Scan on place next  (cost=0.00..1.64 rows=64 width=16) (actual time=0.007..0.014 rows=87 loops=1)
                             Buffers: shared hit=1
   ->  GroupAggregate  (cost=0.28..592.37 rows=812 width=20) (actual time=0.043..3.043 rows=338 loops=1)
         Group Key: segment.local_start_date
         Buffers: shared hit=600
         ->  Index Scan using ix_segment_local_dates on segment  (cost=0.28..522.39 rows=3303 width=32) (actual time=0.021..1.585 rows=3289 loops=1)
               Index Cond: ((local_start_date >= '2025-01-01'::date) AND (local_start_date <= '2025-12-31'::date))
               Buffers: shared hit=600
   ->  GroupAggregate  (cost=30.79..30.97 rows=10 width=12) (actual time=3.821..4.159 rows=339 loops=1)
         Group Key: st.local_start_date
         Buffers: shared hit=1078
         ->  Sort  (cost=30.79..30.82 rows=10 width=12) (actual time=3.815..3.889 rows=1643 loops=1)
               Sort Key: st.local_start_date, chain.id
               Sort Method: quicksort  Memory: 113kB
               Buffers: shared hit=1078
               ->  Hash Join  (cost=7.47..30.63 rows=10 width=12) (actual time=2.999..3.398 rows=1643 loops=1)
                     Hash Cond: (st.place_id = chain.origin)
                     Buffers: shared hit=1078
                     ->  CTE Scan on stays st  (cost=0.00..19.42 rows=971 width=12) (actual time=0.442..0.561 rows=1643 loops=1)
                           Buffers: shared hit=245
                     ->  Hash  (cost=7.44..7.44 rows=2 width=16) (actual time=2.547..2.547 rows=60 loops=1)
                           Buckets: 1024  Batches: 1  Memory Usage: 11kB
                           Buffers: shared hit=833
                           ->  CTE Scan on chain  (cost=0.00..7.44 rows=2 width=16) (actual time=2.404..2.521 rows=60 loops=1)
                                 Filter: (merged_into_id IS NULL)
                                 Buffers: shared hit=833
 Planning:
   Buffers: shared hit=15
 Planning Time: 0.790 ms
 Execution Time: 7.944 ms
```

</details>

<details><summary>Heat (RangeStore.FindHeatAsync)</summary>

```
                                                                                                                                                                                                                                                       QUERY PLAN
 HashAggregate  (cost=515.94..522.30 rows=159 width=88) (actual time=7.903..8.050 rows=105 loops=1)
   Group Key: round((segment.latitude)::numeric, 3), round((segment.longitude)::numeric, 3)
   Batches: 1  Memory Usage: 96kB
   Buffers: shared hit=1076
   ->  Index Scan using ix_segment_stays on segment  (cost=0.28..512.32 rows=161 width=107) (actual time=0.512..6.177 rows=1643 loops=1)
         Filter: ((local_start_date <= '2025-12-31'::date) AND (local_end_date >= '2025-01-01'::date) AND (latitude >= '-90'::double precision) AND (latitude <= '90'::double precision) AND (longitude >= '-180'::double precision) AND (longitude <= '180'::double precision) AND (EXTRACT(epoch FROM (LEAST(end_utc, ('2026-01-01 00:00:00'::timestamp without time zone AT TIME ZONE start_tz)) - GREATEST(start_utc, ('2025-01-01 00:00:00'::timestamp without time zone AT TIME ZONE start_tz)))) > '0'::numeric))
         Rows Removed by Filter: 2154
         Buffers: shared hit=1076
 Planning:
   Buffers: shared hit=29
 Planning Time: 0.481 ms
 Execution Time: 8.153 ms
```

</details>

<details><summary>Place: the totals (PlaceStore.FindDetailAsync)</summary>

```
                                                                      QUERY PLAN
 Nested Loop  (cost=451.97..453.79 rows=1 width=184) (actual time=2.585..2.610 rows=1 loops=1)
   Buffers: shared hit=1081
   CTE resolved
     ->  Recursive Union  (cost=0.00..23.91 rows=31 width=20) (actual time=0.003..0.024 rows=1 loops=1)
           Buffers: shared hit=2
           ->  Seq Scan on place  (cost=0.00..1.80 rows=1 width=20) (actual time=0.002..0.006 rows=1 loops=1)
                 Filter: (id = '1'::bigint)
                 Rows Removed by Filter: 86
                 Buffers: shared hit=1
           ->  Hash Join  (cost=0.26..2.18 rows=3 width=20) (actual time=0.014..0.016 rows=0 loops=1)
                 Hash Cond: (next.id = resolved.merged_into_id)
                 Buffers: shared hit=1
                 ->  Seq Scan on place next  (cost=0.00..1.64 rows=64 width=16) (actual time=0.001..0.002 rows=1 loops=1)
                       Buffers: shared hit=1
                 ->  Hash  (cost=0.22..0.22 rows=3 width=12) (actual time=0.004..0.005 rows=0 loops=1)
                       Buckets: 1024  Batches: 1  Memory Usage: 8kB
                       ->  WorkTable Scan on resolved  (cost=0.00..0.22 rows=3 width=12) (actual time=0.003..0.004 rows=1 loops=1)
                             Filter: (depth < 32)
   CTE root
     ->  CTE Scan on resolved resolved_1  (cost=0.00..0.62 rows=1 width=8) (actual time=0.004..0.022 rows=1 loops=1)
           Filter: (merged_into_id IS NULL)
           Buffers: shared hit=2
   CTE members
     ->  Recursive Union  (cost=0.00..21.68 rows=11 width=12) (actual time=0.005..0.054 rows=1 loops=1)
           Buffers: shared hit=3
           ->  CTE Scan on root  (cost=0.00..0.02 rows=1 width=12) (actual time=0.005..0.022 rows=1 loops=1)
                 Buffers: shared hit=2
           ->  Hash Join  (cost=0.26..2.15 rows=1 width=12) (actual time=0.027..0.030 rows=0 loops=1)
                 Hash Cond: (merged.merged_into_id = members_1.id)
                 Buffers: shared hit=1
                 ->  Seq Scan on place merged  (cost=0.00..1.64 rows=64 width=16) (actual time=0.001..0.006 rows=87 loops=1)
                       Buffers: shared hit=1
                 ->  Hash  (cost=0.22..0.22 rows=3 width=12) (actual time=0.006..0.007 rows=1 loops=1)
                       Buckets: 1024  Batches: 1  Memory Usage: 9kB
                       ->  WorkTable Scan on members members_1  (cost=0.00..0.22 rows=3 width=12) (actual time=0.001..0.001 rows=1 loops=1)
                             Filter: (depth < 32)
   InitPlan 5 (returns $6)
     ->  Result  (cost=1.84..1.86 rows=1 width=8) (actual time=0.075..0.083 rows=1 loops=1)
           One-Time Filter: $5
           Buffers: shared hit=4
           InitPlan 4 (returns $5)
             ->  Hash Semi Join  (cost=0.36..710.74 rows=480 width=0) (actual time=0.074..0.081 rows=1 loops=1)
                   Hash Cond: (s_1.place_id = members_2.id)
                   Buffers: shared hit=4
                   ->  Seq Scan on segment s_1  (cost=0.00..685.07 rows=7607 width=8) (actual time=0.002..0.002 rows=1 loops=1)
                         Buffers: shared hit=1
                   ->  Hash  (cost=0.22..0.22 rows=11 width=8) (actual time=0.058..0.064 rows=1 loops=1)
                         Buckets: 1024  Batches: 1  Memory Usage: 9kB
                         Buffers: shared hit=3
                         ->  CTE Scan on members members_2  (cost=0.00..0.22 rows=11 width=8) (actual time=0.006..0.051 rows=1 loops=1)
                               Buffers: shared hit=3
           ->  CTE Scan on root root_1  (cost=1.84..1.86 rows=1 width=8) (actual time=0.000..0.001 rows=1 loops=1)
   ->  Seq Scan on place p  (cost=0.00..1.80 rows=1 width=184) (actual time=0.084..0.090 rows=1 loops=1)
         Filter: (id = $6)
         Rows Removed by Filter: 86
         Buffers: shared hit=5
   ->  Aggregate  (cost=403.90..403.92 rows=1 width=32) (actual time=2.496..2.497 rows=1 loops=1)
         Buffers: shared hit=1076
         ->  Hash Semi Join  (cost=0.64..400.30 rows=240 width=16) (actual time=0.038..2.289 rows=721 loops=1)
               Hash Cond: (s.place_id = members.id)
               Buffers: shared hit=1076
               ->  Index Scan using ix_segment_stays on segment s  (cost=0.28..387.31 rows=3797 width=24) (actual time=0.018..1.686 rows=3797 loops=1)
                     Buffers: shared hit=1076
               ->  Hash  (cost=0.22..0.22 rows=11 width=8) (actual time=0.006..0.006 rows=1 loops=1)
                     Buckets: 1024  Batches: 1  Memory Usage: 9kB
                     ->  CTE Scan on members  (cost=0.00..0.22 rows=11 width=8) (actual time=0.000..0.001 rows=1 loops=1)
 Planning:
   Buffers: shared hit=17
 Planning Time: 0.770 ms
 Execution Time: 2.842 ms
```

</details>

<details><summary>Place: the latest visits (PlaceStore.FindDetailAsync)</summary>

```
                                                                           QUERY PLAN
 Limit  (cost=52.03..329.81 rows=50 width=67) (actual time=1.427..1.559 rows=50 loops=1)
   Buffers: shared hit=504
   CTE resolved
     ->  Recursive Union  (cost=0.00..23.91 rows=31 width=20) (actual time=0.009..0.031 rows=1 loops=1)
           Buffers: shared hit=2
           ->  Seq Scan on place  (cost=0.00..1.80 rows=1 width=20) (actual time=0.007..0.011 rows=1 loops=1)
                 Filter: (id = '1'::bigint)
                 Rows Removed by Filter: 86
                 Buffers: shared hit=1
           ->  Hash Join  (cost=0.26..2.18 rows=3 width=20) (actual time=0.017..0.018 rows=0 loops=1)
                 Hash Cond: (next.id = resolved.merged_into_id)
                 Buffers: shared hit=1
                 ->  Seq Scan on place next  (cost=0.00..1.64 rows=64 width=16) (actual time=0.001..0.001 rows=1 loops=1)
                       Buffers: shared hit=1
                 ->  Hash  (cost=0.22..0.22 rows=3 width=12) (actual time=0.002..0.003 rows=0 loops=1)
                       Buckets: 1024  Batches: 1  Memory Usage: 8kB
                       ->  WorkTable Scan on resolved  (cost=0.00..0.22 rows=3 width=12) (actual time=0.002..0.002 rows=1 loops=1)
                             Filter: (depth < 32)
   CTE root
     ->  CTE Scan on resolved resolved_1  (cost=0.00..0.62 rows=1 width=8) (actual time=0.010..0.030 rows=1 loops=1)
           Filter: (merged_into_id IS NULL)
           Buffers: shared hit=2
   CTE members
     ->  Recursive Union  (cost=0.00..21.68 rows=11 width=12) (actual time=0.011..0.062 rows=1 loops=1)
           Buffers: shared hit=3
           ->  CTE Scan on root  (cost=0.00..0.02 rows=1 width=12) (actual time=0.010..0.031 rows=1 loops=1)
                 Buffers: shared hit=2
           ->  Hash Join  (cost=0.26..2.15 rows=1 width=12) (actual time=0.029..0.030 rows=0 loops=1)
                 Hash Cond: (merged.merged_into_id = members_1.id)
                 Buffers: shared hit=1
                 ->  Seq Scan on place merged  (cost=0.00..1.64 rows=64 width=16) (actual time=0.001..0.009 rows=87 loops=1)
                       Buffers: shared hit=1
                 ->  Hash  (cost=0.22..0.22 rows=3 width=12) (actual time=0.008..0.009 rows=1 loops=1)
                       Buckets: 1024  Batches: 1  Memory Usage: 9kB
                       ->  WorkTable Scan on members members_1  (cost=0.00..0.22 rows=3 width=12) (actual time=0.001..0.001 rows=1 loops=1)
                             Filter: (depth < 32)
   ->  Incremental Sort  (cost=5.82..1339.17 rows=240 width=67) (actual time=1.426..1.548 rows=50 loops=1)
         Sort Key: s.start_utc DESC, s.id DESC
         Presorted Key: s.start_utc
         Full-sort Groups: 2  Sort Method: quicksort  Average Memory: 27kB  Peak Memory: 27kB
         Buffers: shared hit=504
         ->  Nested Loop Semi Join  (cost=0.28..1328.37 rows=240 width=67) (actual time=1.277..1.483 rows=51 loops=1)
               Join Filter: (members.id = s.place_id)
               Rows Removed by Join Filter: 1702
               Buffers: shared hit=501
               ->  Index Scan Backward using ix_segment_stays on segment s  (cost=0.28..387.31 rows=3797 width=47) (actual time=0.017..0.719 rows=1753 loops=1)
                     Buffers: shared hit=498
               ->  CTE Scan on members  (cost=0.00..0.22 rows=11 width=8) (actual time=0.000..0.000 rows=1 loops=1753)
                     Buffers: shared hit=3
 Planning:
   Buffers: shared hit=11
 Planning Time: 0.492 ms
 Execution Time: 1.763 ms
```

</details>

<details><summary>Status: the processing state (ProcessingQueue.GetStateAsync)</summary>

```
                                                QUERY PLAN
 Seq Scan on processing_state  (cost=0.00..1.01 rows=1 width=84) (actual time=0.007..0.008 rows=1 loops=1)
   Filter: (id = 1)
   Buffers: shared hit=1
 Planning:
   Buffers: shared hit=20
 Planning Time: 0.228 ms
 Execution Time: 0.015 ms
```

</details>

<details><summary>Status: the backlog (ProcessingQueue.GetBacklogAsync)</summary>

```
                                                  QUERY PLAN
 Aggregate  (cost=19.75..19.76 rows=1 width=8) (actual time=0.005..0.006 rows=1 loops=1)
   ->  Seq Scan on dirty_range  (cost=0.00..17.80 rows=780 width=0) (actual time=0.002..0.002 rows=0 loops=1)
 Planning:
   Buffers: shared hit=3
 Planning Time: 0.130 ms
 Execution Time: 0.022 ms

                                                  QUERY PLAN
 Sort  (cost=30.18..30.83 rows=260 width=60) (actual time=0.019..0.020 rows=0 loops=1)
   Sort Key: from_utc, id
   Sort Method: quicksort  Memory: 25kB
   ->  Seq Scan on dirty_range  (cost=0.00..19.75 rows=260 width=60) (actual time=0.002..0.002 rows=0 loops=1)
         Filter: (attempts > 0)
 Planning:
   Buffers: shared hit=3
 Planning Time: 0.154 ms
 Execution Time: 0.042 ms
```

</details>

<details><summary>Status: the places in use (PlaceStore.CountInUseAsync)</summary>

```
                                                            QUERY PLAN
 Aggregate  (cost=709.37..709.38 rows=1 width=24) (actual time=3.564..3.566 rows=1 loops=1)
   Buffers: shared hit=610
   ->  Hash Join  (cost=706.05..708.57 rows=64 width=8) (actual time=3.531..3.552 rows=87 loops=1)
         Hash Cond: (p.id = s.place_id)
         Buffers: shared hit=610
         ->  Seq Scan on place p  (cost=0.00..1.64 rows=64 width=16) (actual time=0.007..0.015 rows=87 loops=1)
               Filter: (merged_into_id IS NULL)
               Buffers: shared hit=1
         ->  Hash  (cost=704.96..704.96 rows=87 width=8) (actual time=3.511..3.511 rows=87 loops=1)
               Buckets: 1024  Batches: 1  Memory Usage: 12kB
               Buffers: shared hit=609
               ->  HashAggregate  (cost=704.09..704.96 rows=87 width=8) (actual time=3.471..3.479 rows=88 loops=1)
                     Group Key: s.place_id
                     Batches: 1  Memory Usage: 24kB
                     Buffers: shared hit=609
                     ->  Seq Scan on segment s  (cost=0.00..685.07 rows=7607 width=8) (actual time=0.003..2.142 rows=7607 loops=1)
                           Buffers: shared hit=609
 Planning:
   Buffers: shared hit=17
 Planning Time: 0.403 ms
 Execution Time: 3.635 ms
```

</details>

### With an index on `segment.place_id`: what-if on a temporary copy (`tools/perf/place-index-whatif.sql`, `copies=1`)

The same place and status queries on a copy of the 7,607 segments, first without the index (the plans differ a little from the ones above only in that the copy's tables are temporary and freshly analysed), then with `create index ix_segment_place on segment (place_id, start_utc desc)`. No migration was added, so these are the only plans "after".

<details><summary>Place: the totals (PlaceStore.FindDetailAsync), without the index</summary>

```
                                                                      QUERY PLAN
 Nested Loop  (cost=452.74..454.85 rows=1 width=184) (actual time=2.459..2.480 rows=1 loops=1)
   Buffers: local hit=1353 read=12
   CTE resolved
     ->  Recursive Union  (cost=0.00..27.36 rows=31 width=20) (actual time=0.003..0.037 rows=1 loops=1)
           Buffers: local hit=2
           ->  Seq Scan on place  (cost=0.00..2.09 rows=1 width=20) (actual time=0.002..0.006 rows=1 loops=1)
                 Filter: (id = '1'::bigint)
                 Rows Removed by Filter: 86
                 Buffers: local hit=1
           ->  Hash Join  (cost=0.26..2.50 rows=3 width=20) (actual time=0.027..0.029 rows=0 loops=1)
                 Hash Cond: (next.id = resolved.merged_into_id)
                 Buffers: local hit=1
                 ->  Seq Scan on place next  (cost=0.00..1.87 rows=87 width=16) (actual time=0.001..0.001 rows=1 loops=1)
                       Buffers: local hit=1
                 ->  Hash  (cost=0.22..0.22 rows=3 width=12) (actual time=0.004..0.006 rows=0 loops=1)
                       Buckets: 1024  Batches: 1  Memory Usage: 8kB
                       ->  WorkTable Scan on resolved  (cost=0.00..0.22 rows=3 width=12) (actual time=0.004..0.004 rows=1 loops=1)
                             Filter: (depth < 32)
   CTE root
     ->  CTE Scan on resolved resolved_1  (cost=0.00..0.62 rows=1 width=8) (actual time=0.005..0.035 rows=1 loops=1)
           Filter: (merged_into_id IS NULL)
           Buffers: local hit=2
   CTE members
     ->  Recursive Union  (cost=0.00..24.84 rows=11 width=12) (actual time=0.006..0.078 rows=1 loops=1)
           Buffers: local hit=3
           ->  CTE Scan on root  (cost=0.00..0.02 rows=1 width=12) (actual time=0.005..0.036 rows=1 loops=1)
                 Buffers: local hit=2
           ->  Hash Join  (cost=0.26..2.47 rows=1 width=12) (actual time=0.037..0.040 rows=0 loops=1)
                 Hash Cond: (merged.merged_into_id = members_1.id)
                 Buffers: local hit=1
                 ->  Seq Scan on place merged  (cost=0.00..1.87 rows=87 width=16) (actual time=0.001..0.006 rows=87 loops=1)
                       Buffers: local hit=1
                 ->  Hash  (cost=0.22..0.22 rows=3 width=12) (actual time=0.008..0.009 rows=1 loops=1)
                       Buckets: 1024  Batches: 1  Memory Usage: 9kB
                       ->  WorkTable Scan on members members_1  (cost=0.00..0.22 rows=3 width=12) (actual time=0.001..0.001 rows=1 loops=1)
                             Filter: (depth < 32)
   InitPlan 5 (returns $6)
     ->  Result  (cost=1.80..1.82 rows=1 width=8) (actual time=0.106..0.109 rows=1 loops=1)
           One-Time Filter: $5
           Buffers: local hit=4
           InitPlan 4 (returns $5)
             ->  Hash Semi Join  (cost=0.36..693.74 rows=480 width=0) (actual time=0.105..0.107 rows=1 loops=1)
                   Hash Cond: (s_1.place_id = members_2.id)
                   Buffers: local hit=4
                   ->  Seq Scan on segment s_1  (cost=0.00..668.07 rows=7607 width=8) (actual time=0.002..0.002 rows=1 loops=1)
                         Buffers: local hit=1
                   ->  Hash  (cost=0.22..0.22 rows=11 width=8) (actual time=0.083..0.084 rows=1 loops=1)
                         Buckets: 1024  Batches: 1  Memory Usage: 9kB
                         Buffers: local hit=3
                         ->  CTE Scan on members members_2  (cost=0.00..0.22 rows=11 width=8) (actual time=0.008..0.076 rows=1 loops=1)
                               Buffers: local hit=3
           ->  CTE Scan on root root_1  (cost=1.80..1.82 rows=1 width=8) (actual time=0.000..0.001 rows=1 loops=1)
   ->  Seq Scan on place p  (cost=0.00..2.09 rows=1 width=184) (actual time=0.115..0.121 rows=1 loops=1)
         Filter: (id = $6)
         Rows Removed by Filter: 86
         Buffers: local hit=5
   ->  Aggregate  (cost=398.10..398.11 rows=1 width=32) (actual time=2.339..2.342 rows=1 loops=1)
         Buffers: local hit=1348 read=12
         ->  Hash Semi Join  (cost=0.64..394.50 rows=240 width=16) (actual time=0.082..2.123 rows=721 loops=1)
               Hash Cond: (s.place_id = members.id)
               Buffers: local hit=1348 read=12
               ->  Index Scan using ix_segment_stays on segment s  (cost=0.28..381.50 rows=3797 width=24) (actual time=0.061..1.548 rows=3797 loops=1)
                     Buffers: local hit=1348 read=12
               ->  Hash  (cost=0.22..0.22 rows=11 width=8) (actual time=0.005..0.006 rows=1 loops=1)
                     Buckets: 1024  Batches: 1  Memory Usage: 9kB
                     ->  CTE Scan on members  (cost=0.00..0.22 rows=11 width=8) (actual time=0.000..0.001 rows=1 loops=1)
 Planning:
   Buffers: shared hit=124, local read=1
 Planning Time: 1.503 ms
 Execution Time: 2.820 ms
```

</details>

<details><summary>Place: the latest visits (PlaceStore.FindDetailAsync), without the index</summary>

```
                                                                           QUERY PLAN
 Limit  (cost=58.62..335.20 rows=50 width=67) (actual time=1.668..1.742 rows=50 loops=1)
   Buffers: local hit=617
   CTE resolved
     ->  Recursive Union  (cost=0.00..27.36 rows=31 width=20) (actual time=0.008..0.030 rows=1 loops=1)
           Buffers: local hit=2
           ->  Seq Scan on place  (cost=0.00..2.09 rows=1 width=20) (actual time=0.007..0.011 rows=1 loops=1)
                 Filter: (id = '1'::bigint)
                 Rows Removed by Filter: 86
                 Buffers: local hit=1
           ->  Hash Join  (cost=0.26..2.50 rows=3 width=20) (actual time=0.015..0.017 rows=0 loops=1)
                 Hash Cond: (next.id = resolved.merged_into_id)
                 Buffers: local hit=1
                 ->  Seq Scan on place next  (cost=0.00..1.87 rows=87 width=16) (actual time=0.003..0.003 rows=1 loops=1)
                       Buffers: local hit=1
                 ->  Hash  (cost=0.22..0.22 rows=3 width=12) (actual time=0.002..0.003 rows=0 loops=1)
                       Buckets: 1024  Batches: 1  Memory Usage: 8kB
                       ->  WorkTable Scan on resolved  (cost=0.00..0.22 rows=3 width=12) (actual time=0.002..0.002 rows=1 loops=1)
                             Filter: (depth < 32)
   CTE root
     ->  CTE Scan on resolved resolved_1  (cost=0.00..0.62 rows=1 width=8) (actual time=0.010..0.028 rows=1 loops=1)
           Filter: (merged_into_id IS NULL)
           Buffers: local hit=2
   CTE members
     ->  Recursive Union  (cost=0.00..24.84 rows=11 width=12) (actual time=0.011..0.064 rows=1 loops=1)
           Buffers: local hit=3
           ->  CTE Scan on root  (cost=0.00..0.02 rows=1 width=12) (actual time=0.010..0.029 rows=1 loops=1)
                 Buffers: local hit=2
           ->  Hash Join  (cost=0.26..2.47 rows=1 width=12) (actual time=0.031..0.033 rows=0 loops=1)
                 Hash Cond: (merged.merged_into_id = members_1.id)
                 Buffers: local hit=1
                 ->  Seq Scan on place merged  (cost=0.00..1.87 rows=87 width=16) (actual time=0.001..0.005 rows=87 loops=1)
                       Buffers: local hit=1
                 ->  Hash  (cost=0.22..0.22 rows=3 width=12) (actual time=0.009..0.010 rows=1 loops=1)
                       Buckets: 1024  Batches: 1  Memory Usage: 9kB
                       ->  WorkTable Scan on members members_1  (cost=0.00..0.22 rows=3 width=12) (actual time=0.003..0.003 rows=1 loops=1)
                             Filter: (depth < 32)
   ->  Incremental Sort  (cost=5.80..1333.37 rows=240 width=67) (actual time=1.667..1.730 rows=50 loops=1)
         Sort Key: s.start_utc DESC, s.id DESC
         Presorted Key: s.start_utc
         Full-sort Groups: 2  Sort Method: quicksort  Average Memory: 27kB  Peak Memory: 27kB
         Buffers: local hit=617
         ->  Nested Loop Semi Join  (cost=0.28..1322.57 rows=240 width=67) (actual time=1.560..1.701 rows=51 loops=1)
               Join Filter: (members.id = s.place_id)
               Rows Removed by Join Filter: 1702
               Buffers: local hit=617
               ->  Index Scan Backward using ix_segment_stays on segment s  (cost=0.28..381.50 rows=3797 width=47) (actual time=0.014..0.755 rows=1753 loops=1)
                     Buffers: local hit=614
               ->  CTE Scan on members  (cost=0.00..0.22 rows=11 width=8) (actual time=0.000..0.000 rows=1 loops=1753)
                     Buffers: local hit=3
 Planning:
   Buffers: shared hit=19
 Planning Time: 0.655 ms
 Execution Time: 1.920 ms
```

</details>

<details><summary>Status: the places in use (PlaceStore.CountInUseAsync), without the index</summary>

```
                                                            QUERY PLAN
 Aggregate  (cost=693.20..693.21 rows=1 width=24) (actual time=2.331..2.332 rows=1 loops=1)
   Buffers: local hit=593
   ->  Hash Join  (cost=689.05..692.11 rows=87 width=8) (actual time=2.298..2.319 rows=87 loops=1)
         Hash Cond: (p.id = s.place_id)
         Buffers: local hit=593
         ->  Seq Scan on place p  (cost=0.00..1.87 rows=87 width=16) (actual time=0.005..0.014 rows=87 loops=1)
               Filter: (merged_into_id IS NULL)
               Buffers: local hit=1
         ->  Hash  (cost=687.96..687.96 rows=87 width=8) (actual time=2.281..2.281 rows=87 loops=1)
               Buckets: 1024  Batches: 1  Memory Usage: 12kB
               Buffers: local hit=592
               ->  HashAggregate  (cost=687.09..687.96 rows=87 width=8) (actual time=2.236..2.244 rows=88 loops=1)
                     Group Key: s.place_id
                     Batches: 1  Memory Usage: 24kB
                     Buffers: local hit=592
                     ->  Seq Scan on segment s  (cost=0.00..668.07 rows=7607 width=8) (actual time=0.002..1.522 rows=7607 loops=1)
                           Buffers: local hit=592
 Planning:
   Buffers: shared hit=13, local hit=3 read=1
 Planning Time: 0.392 ms
 Execution Time: 2.401 ms

CREATE INDEX
ANALYZE
```

</details>

<details><summary>Place: the totals (PlaceStore.FindDetailAsync), with the index</summary>

```
                                                                        QUERY PLAN
 Nested Loop  (cost=396.09..398.20 rows=1 width=184) (actual time=0.877..0.887 rows=1 loops=1)
   Buffers: local hit=478 read=4
   CTE resolved
     ->  Recursive Union  (cost=0.00..27.36 rows=31 width=20) (actual time=0.003..0.031 rows=1 loops=1)
           Buffers: local hit=2
           ->  Seq Scan on place  (cost=0.00..2.09 rows=1 width=20) (actual time=0.002..0.006 rows=1 loops=1)
                 Filter: (id = '1'::bigint)
                 Rows Removed by Filter: 86
                 Buffers: local hit=1
           ->  Hash Join  (cost=0.26..2.50 rows=3 width=20) (actual time=0.022..0.024 rows=0 loops=1)
                 Hash Cond: (next.id = resolved.merged_into_id)
                 Buffers: local hit=1
                 ->  Seq Scan on place next  (cost=0.00..1.87 rows=87 width=16) (actual time=0.001..0.001 rows=1 loops=1)
                       Buffers: local hit=1
                 ->  Hash  (cost=0.22..0.22 rows=3 width=12) (actual time=0.004..0.004 rows=0 loops=1)
                       Buckets: 1024  Batches: 1  Memory Usage: 8kB
                       ->  WorkTable Scan on resolved  (cost=0.00..0.22 rows=3 width=12) (actual time=0.003..0.004 rows=1 loops=1)
                             Filter: (depth < 32)
   CTE root
     ->  CTE Scan on resolved resolved_1  (cost=0.00..0.62 rows=1 width=8) (actual time=0.004..0.030 rows=1 loops=1)
           Filter: (merged_into_id IS NULL)
           Buffers: local hit=2
   CTE members
     ->  Recursive Union  (cost=0.00..24.84 rows=11 width=12) (actual time=0.006..0.071 rows=1 loops=1)
           Buffers: local hit=3
           ->  CTE Scan on root  (cost=0.00..0.02 rows=1 width=12) (actual time=0.005..0.031 rows=1 loops=1)
                 Buffers: local hit=2
           ->  Hash Join  (cost=0.26..2.47 rows=1 width=12) (actual time=0.038..0.039 rows=0 loops=1)
                 Hash Cond: (merged.merged_into_id = members_1.id)
                 Buffers: local hit=1
                 ->  Seq Scan on place merged  (cost=0.00..1.87 rows=87 width=16) (actual time=0.001..0.005 rows=87 loops=1)
                       Buffers: local hit=1
                 ->  Hash  (cost=0.22..0.22 rows=3 width=12) (actual time=0.010..0.010 rows=1 loops=1)
                       Buckets: 1024  Batches: 1  Memory Usage: 9kB
                       ->  WorkTable Scan on members members_1  (cost=0.00..0.22 rows=3 width=12) (actual time=0.001..0.001 rows=1 loops=1)
                             Filter: (depth < 32)
   InitPlan 5 (returns $7)
     ->  Result  (cost=1.24..1.26 rows=1 width=8) (actual time=0.158..0.160 rows=1 loops=1)
           One-Time Filter: $6
           Buffers: local hit=4 read=2
           InitPlan 4 (returns $6)
             ->  Nested Loop  (cost=0.53..339.62 rows=480 width=0) (actual time=0.157..0.158 rows=1 loops=1)
                   Buffers: local hit=4 read=2
                   ->  HashAggregate  (cost=0.25..0.36 rows=11 width=8) (actual time=0.075..0.075 rows=1 loops=1)
                         Group Key: members_2.id
                         Batches: 1  Memory Usage: 24kB
                         Buffers: local hit=3
                         ->  CTE Scan on members members_2  (cost=0.00..0.22 rows=11 width=8) (actual time=0.006..0.070 rows=1 loops=1)
                               Buffers: local hit=3
                   ->  Index Only Scan using ix_segment_place on segment s_1  (cost=0.28..30.40 rows=44 width=8) (actual time=0.081..0.081 rows=1 loops=1)
                         Index Cond: (place_id = members_2.id)
                         Heap Fetches: 1
                         Buffers: local hit=1 read=2
           ->  CTE Scan on root root_1  (cost=1.24..1.26 rows=1 width=8) (actual time=0.001..0.001 rows=1 loops=1)
   ->  Seq Scan on place p  (cost=0.00..2.09 rows=1 width=184) (actual time=0.171..0.174 rows=1 loops=1)
         Filter: (id = $7)
         Rows Removed by Filter: 86
         Buffers: local hit=5 read=2
   ->  Aggregate  (cost=342.01..342.03 rows=1 width=32) (actual time=0.704..0.705 rows=1 loops=1)
         Buffers: local hit=473 read=2
         ->  Nested Loop  (cost=0.53..338.41 rows=240 width=16) (actual time=0.019..0.514 rows=721 loops=1)
               Buffers: local hit=473 read=2
               ->  HashAggregate  (cost=0.25..0.36 rows=11 width=8) (actual time=0.002..0.003 rows=1 loops=1)
                     Group Key: members.id
                     Batches: 1  Memory Usage: 24kB
                     ->  CTE Scan on members  (cost=0.00..0.22 rows=11 width=8) (actual time=0.000..0.001 rows=1 loops=1)
               ->  Index Scan using ix_segment_place on segment s  (cost=0.28..30.51 rows=22 width=24) (actual time=0.016..0.446 rows=721 loops=1)
                     Index Cond: (place_id = members.id)
                     Filter: (kind = 'stay'::text)
                     Buffers: local hit=473 read=2
 Planning:
   Buffers: shared hit=28, local read=1
 Planning Time: 1.069 ms
 Execution Time: 1.141 ms
```

</details>

<details><summary>Place: the latest visits (PlaceStore.FindDetailAsync), with the index</summary>

```
                                                                           QUERY PLAN
 Limit  (cost=58.62..335.20 rows=50 width=67) (actual time=3.499..3.577 rows=50 loops=1)
   Buffers: local hit=617
   CTE resolved
     ->  Recursive Union  (cost=0.00..27.36 rows=31 width=20) (actual time=0.012..0.034 rows=1 loops=1)
           Buffers: local hit=2
           ->  Seq Scan on place  (cost=0.00..2.09 rows=1 width=20) (actual time=0.011..0.014 rows=1 loops=1)
                 Filter: (id = '1'::bigint)
                 Rows Removed by Filter: 86
                 Buffers: local hit=1
           ->  Hash Join  (cost=0.26..2.50 rows=3 width=20) (actual time=0.015..0.018 rows=0 loops=1)
                 Hash Cond: (next.id = resolved.merged_into_id)
                 Buffers: local hit=1
                 ->  Seq Scan on place next  (cost=0.00..1.87 rows=87 width=16) (actual time=0.001..0.001 rows=1 loops=1)
                       Buffers: local hit=1
                 ->  Hash  (cost=0.22..0.22 rows=3 width=12) (actual time=0.002..0.004 rows=0 loops=1)
                       Buckets: 1024  Batches: 1  Memory Usage: 8kB
                       ->  WorkTable Scan on resolved  (cost=0.00..0.22 rows=3 width=12) (actual time=0.002..0.002 rows=1 loops=1)
                             Filter: (depth < 32)
   CTE root
     ->  CTE Scan on resolved resolved_1  (cost=0.00..0.62 rows=1 width=8) (actual time=0.013..0.031 rows=1 loops=1)
           Filter: (merged_into_id IS NULL)
           Buffers: local hit=2
   CTE members
     ->  Recursive Union  (cost=0.00..24.84 rows=11 width=12) (actual time=0.014..0.069 rows=1 loops=1)
           Buffers: local hit=3
           ->  CTE Scan on root  (cost=0.00..0.02 rows=1 width=12) (actual time=0.013..0.032 rows=1 loops=1)
                 Buffers: local hit=2
           ->  Hash Join  (cost=0.26..2.47 rows=1 width=12) (actual time=0.033..0.036 rows=0 loops=1)
                 Hash Cond: (merged.merged_into_id = members_1.id)
                 Buffers: local hit=1
                 ->  Seq Scan on place merged  (cost=0.00..1.87 rows=87 width=16) (actual time=0.001..0.005 rows=87 loops=1)
                       Buffers: local hit=1
                 ->  Hash  (cost=0.22..0.22 rows=3 width=12) (actual time=0.010..0.011 rows=1 loops=1)
                       Buckets: 1024  Batches: 1  Memory Usage: 9kB
                       ->  WorkTable Scan on members members_1  (cost=0.00..0.22 rows=3 width=12) (actual time=0.002..0.003 rows=1 loops=1)
                             Filter: (depth < 32)
   ->  Incremental Sort  (cost=5.80..1333.37 rows=240 width=67) (actual time=3.498..3.562 rows=50 loops=1)
         Sort Key: s.start_utc DESC, s.id DESC
         Presorted Key: s.start_utc
         Full-sort Groups: 2  Sort Method: quicksort  Average Memory: 27kB  Peak Memory: 27kB
         Buffers: local hit=617
         ->  Nested Loop Semi Join  (cost=0.28..1322.57 rows=240 width=67) (actual time=3.373..3.511 rows=51 loops=1)
               Join Filter: (members.id = s.place_id)
               Rows Removed by Join Filter: 1702
               Buffers: local hit=617
               ->  Index Scan Backward using ix_segment_stays on segment s  (cost=0.28..381.50 rows=3797 width=47) (actual time=0.017..0.695 rows=1753 loops=1)
                     Buffers: local hit=614
               ->  CTE Scan on members  (cost=0.00..0.22 rows=11 width=8) (actual time=0.001..0.001 rows=1 loops=1753)
                     Buffers: local hit=3
 Planning:
   Buffers: shared hit=20
 Planning Time: 0.587 ms
 Execution Time: 3.952 ms
```

</details>

<details><summary>Status: the places in use (PlaceStore.CountInUseAsync), with the index</summary>

```
                                                                  QUERY PLAN
 Aggregate  (cost=59.80..59.81 rows=1 width=24) (actual time=0.302..0.303 rows=1 loops=1)
   Buffers: local hit=251 read=11
   ->  Nested Loop Semi Join  (cost=0.28..58.71 rows=87 width=8) (actual time=0.031..0.287 rows=87 loops=1)
         Buffers: local hit=251 read=11
         ->  Seq Scan on place p  (cost=0.00..1.87 rows=87 width=16) (actual time=0.008..0.017 rows=87 loops=1)
               Filter: (merged_into_id IS NULL)
               Buffers: local hit=1
         ->  Index Only Scan using ix_segment_place on segment s  (cost=0.28..8.12 rows=44 width=8) (actual time=0.003..0.003 rows=1 loops=87)
               Index Cond: (place_id = p.id)
               Heap Fetches: 87
               Buffers: local hit=250 read=11
 Planning:
   Buffers: shared hit=4, local hit=9 read=1
 Planning Time: 0.453 ms
 Execution Time: 0.355 ms
```

</details>

