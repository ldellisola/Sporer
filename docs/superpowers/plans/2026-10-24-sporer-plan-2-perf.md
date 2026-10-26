# Sporer Plan 2: web and API performance check (synthetic history, about 10 million rows)

Measured on 2026-10-26 against the same generated history as Plan 1's check, with the server and the web app as built at the end of
Plan 2 (nothing in either was changed for this check). The owner's real data was not available: these numbers say how the server and
the web app behave at the volume the spec assumes (spec §8, §9), on a throttled desktop browser, not on the owner's phone. The real
check is the owner's, on their iPhone over the VPN, after the first backfill. Plan 1's server check is in
`2026-10-23-sporer-plan-1-perf.md`; this one adds the range, heat and place endpoints, the query plans, the bundle and the web timings.

## Result

| What (spec §8, Plan 2 brief) | Target | Measured | Verdict |
| --- | --- | --- | --- |
| **Server** `/api/day/{date}`, 200 random dates | ≤ 200 ms | p50 5.5 ms, p95 8.7 ms, max 10.8 ms (repeat: p95 12.8, max 27.5) | Met, 23 times under at p95 |
| `/api/range`, 100 random 31-day windows | ≤ 400 ms | p50 17.6 ms, p95 23.9 ms, max 27.7 ms (repeat: p95 29.8, max 32.1) | Met, 17 times under |
| `/api/range`, 20 random 365-day windows | ≤ 800 ms | p50 53.9 ms, p95 64.4 ms, max 68.4 ms (repeat: p95 73.0, max 78.0); the 400-day maximum 55-71 ms | Met, 11 to 12 times under |
| `/api/heat`, month and year windows | (no target of its own; the range's) | month p95 7.1 ms, year p95 17.2 ms (repeat: 8.5, 18.0) | Met |
| `/api/places/{id}`, 200 requests over 79 places | (no target of its own; the day's, 200 ms) | p50 13.6 ms, p95 20.1 ms, max 31.4 ms (repeat: p95 18.1) | Met |
| Year payload size | ≤ 1.5 MB raw JSON | median 536 kB, largest 552 kB (the calendar year 2025: 553 kB; the 400-day maximum: 600 kB); Brotli 161 kB median, 166 kB largest | Met, 2.7 times under |
| Year vertex count | ≤ 60,000 | median 14,941, largest 15,491 (the 400-day maximum: 16,810) | Met, 3.9 times under (the cap itself is not reached, see the caveats) |
| **Bundle** JavaScript, gzip, with MapLibre | ≤ 450 kB | **526.0 kB** with MapLibre's worker, 378.1 kB without it (Vite's own report: 382.5 kB for the chunks it lists) | **Miss with the worker (+76 kB, 17 %); met without it.** No fix available, see "Bundle" |
| **Web, cold navigation to the panel's rows**, day (4× CPU, 7 runs) | ≤ 1 s | median 947 ms, worst 1,016 ms (heaviest day: 982 / 1,124 ms) | Met at the median; the worst run is 2 % over (heaviest day 12 %) |
| same, month | ≤ 2 s | median 1,154 ms, worst 1,197 ms (heaviest month: 1,097 / 1,264 ms) | Met, 1.7 times under |
| same, year | ≤ 3 s | median 1,252 ms, worst 1,527 ms | Met, 2.4 times under |
| **Web, tap › with the page open** (the §8 reading: "after navigating (‹ ›)"), day / month / year | ≤ 1 s / 2 s / 3 s | panel rows median 57 / 82 / 219 ms, worst 77 / 99 / 258 ms; routes on the map 108 / 200 / 683 ms median | Met, 12 to 24 times under on the rows |
| **Web, map `idle` from cold navigation**, day / month / year | read against the same 1 s / 2 s / 3 s, with the caveats below | median 1,947 / 1,943 / 2,754 ms, worst 2,073 / 2,204 / 3,033 ms | Day over (the boot alone is 1.2 s, then a 600 ms camera move); month and year at the number at the median, over at the worst run. **Not a verdict:** software WebGL, see the caveats |

The panel's rows are the primary signal for the web; `idle` is recorded and caveated. Everything in the
table is a number from the runs below; where a run was repeated both are given.

Nothing was fixed: every server target was met by a wide margin and no query scans a large table (so no migration 0005), the web
panel targets were met at the median, and the one miss (the bundle with MapLibre's worker) has no fix short of changing the
pinned MapLibre. Three levers are measured below so that the decision about them can be made on numbers: an index on
`segment.place_id`, lazy-loading MapLibre, and compressing the bundle better.

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
| Backfill | 167 s from the start of the API to 100 % (Plan 1: 140-145 s; this run polled every 3 s and started 6 s after the API), `failedRanges` empty, `pendingRanges` 0 |
| Timeline | 7,607 segments (3,797 stays, 3,801 moves, 9 gaps) on 816 days, 87 places: the same as Plan 1's |

What a real history will look like is not known; see the caveats.

## Server

### Method

`tools/perf/api-latency.sh <url> <first-date> <last-date>` (new): for each endpoint 20 requests warm it up, then the measured ones
follow, once each, on dates and windows drawn with awk's seeded generator, so a run repeats exactly:

- `/api/day/{date}`: 200 random dates;
- `/api/range` and `/api/heat`: 100 random windows of 31 days (a month: the longest one) and 20 random windows of 365 days (a year),
  starting on a random date, so they are not calendar months and years but as long as the longest of them;
- `/api/places/{id}`: 200 requests over the 79 places that the busiest of the 20 year windows has.

A second pass asks for the same windows with no compression to measure the raw JSON and, for a range, to count the vertices of its
lines; it is not timed. Seeds 1 and 2 (the repeat) were run, one after the other, the second after a restart of the API (each has its own 20 warm-up requests).

### Results

First run (seed 1), the second in brackets. Times in ms; sizes in bytes as curl counts the body.

| Endpoint | n | p50 | p95 | p99 | max | Brotli body, median / largest | Raw body, median / largest |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `/api/day/{date}` | 200 | 5.5 (8.1) | 8.7 (12.8) | 10.6 (20.8) | 10.8 (27.5) | 2,257 / 6,712 | 7,456 / 18,752 |
| `/api/range`, 31 days | 100 | 17.6 (21.8) | 23.9 (29.8) | 27.3 (31.7) | 27.7 (32.1) | 13,544 / 16,559 | 46,152 / 55,881 |
| `/api/range`, 365 days | 20 | 53.9 (59.0) | 64.4 (73.0) | 68.4 (78.0) | 68.4 (78.0) | 161,234 / 166,050 | 536,318 / 552,318 |
| `/api/heat`, 31 days | 100 | 4.5 (4.8) | 7.1 (8.5) | 8.2 (12.0) | 10.8 (58.7) | 325 / 505 | 701 / 1,162 |
| `/api/heat`, 365 days | 20 | 13.1 (13.2) | 17.2 (18.0) | 18.6 (20.5) | 18.6 (20.5) | 984 / 1,210 | 2,339 / 2,846 |
| `/api/places/{id}` | 200 | 13.6 (13.4) | 20.1 (18.1) | 28.4 (23.6) | 31.4 (27.9) | 399 / 1,544 | 1,048 / 6,059 |

- **Vertices of a range's lines:** 31 days median 1,219, largest 1,616; 365 days median 14,941, largest 15,491 (repeat: 14,925 and
  15,802). The largest range the API takes, 400 days (2025-01-01 to 2026-02-04): 1,789 moves, 16,810 vertices, 600,334 bytes raw,
  180,559 Brotli, 55-71 ms over five requests.
- Plan 1's own script, `tools/perf/day-latency.sh` (no compression), run again today: p50 5.2 ms, p95 8.6 ms, p99 10.7 ms, max 17.1 ms,
  against 5.0 / 7.0 / 7.9 / 12.4 in Plan 1: the same. `/api/status`: 9.0 ms once warm (the first request, 67 ms, is the JIT).
- The year answer is mostly its `moves` (1,643 moves, one line each); the 60,000-vertex cap of `VertexBudget` did not have to cut
  anything here (14.9 thousand vertices), so the synthetic history does not show what it does to a heavier year (the unit tests do).
- The place endpoint is the slowest per row of work (p50 13.6 ms) because it is two recursive queries and a transaction at
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
| Place: the latest visits | 1.9 → 4.0 (the planner prefers the stays index, and a sort, with it) | 25-30 → 24-42 (no gain) |
| Status: the places in use | 2.4 → 0.36 | 43-60 → 0.8-2.9 |

(The 12-times figures are from three runs, hence the ranges.) At the size of this history the index would save a few milliseconds of
a 20 ms endpoint, and it makes the visits query no better; at twelve times the history the status page would be the one to gain
(about 50 ms to 1-3 ms), but a history of 12 times 2.3 years is 28 years. Adding it later is a migration that creates one object and
nothing else; it is left until the history is long enough for it to matter, as Plan 1's table of suspects left it.

## Web

### Bundle

`npm run build`, then `npm run perf:bundle` (`web/scripts/perf/bundle-size.mjs`, new). Sizes in kB (1 kB = 1,000 bytes), gzip at
level 9; Vite's own report (level 6) and Brotli at quality 11 for comparison:

| File | Raw | gzip 9 | gzip 6 | Brotli 11 |
| --- | --- | --- | --- | --- |
| `maplibre-*.js` (MapLibre library chunk) | 1,046.0 | 281.3 | 282.0 | 230.0 |
| `maplibre-gl-worker-*.mjs` (MapLibre's worker, an asset of the build the map starts) | 518.8 | 147.9 | 148.2 | 121.6 |
| `index-*.js` (the app, React, TanStack Query, date-fns) | 315.1 | 96.8 | 97.0 | 83.9 |
| **JavaScript, total** | 1,879.9 | **526.0** | 527.2 | 435.4 |
| MapLibre alone (library chunk and worker) | 1,564.8 | 429.2 | 430.2 | 351.5 |
| the rest | 315.1 | 96.8 | 97.0 | 83.9 |
| without the worker (the two chunks Vite reports) | 1,361.1 | 378.1 | 379.0 | 313.9 |
| CSS | | 13.5 | 13.6 | 11.3 |

Vite's own table prints 97.90 and 284.61 kB gzip for the two chunks (382.5 kB together) and no gzip size for the worker.

**Verdict: a miss, counted in full.** The target is "≤ 450 kB gzip including MapLibre", and MapLibre is two files: the library chunk
(281 kB) and the worker (148 kB) that the map cannot draw without (MapLibre parses tiles and GeoJSON in it). With both the total
is 526 kB, 76 kB (17 %) over. Counting only the two chunks Vite's table lists it is 378-383 kB, 15 % under. Why it is not fixed:

- MapLibre 6.15.0, pinned by the plan's Tech Stack, is 429 kB gzip by itself: 95 % of the target, so the rest of the app would
  have to fit in 21 kB; React, its DOM and TanStack Query are 97 kB.
- MapLibre ships one build (`dist/maplibre-gl.mjs` and its worker; `-dev` is larger); there is nothing smaller to import.
- Splitting the code (the spec's §7.3 "code-split so first paint loads only the shell and map") moves bytes in time, not the total.

What would move it, for a decision to be made on these numbers: the bytes that matter on the phone are the ones the API sends, and **the API
compresses static files at ASP.NET's default `Fastest` level, which comes out larger than gzip 9**: measured from the API with the
built web root (`curl -H 'Accept-Encoding: ...'`), the three JavaScript files are 625 kB with gzip and **679 kB with Brotli** (123.1,
368.8 and 186.7 kB), against 526 kB for gzip 9 and 435 kB for Brotli 11. The files are named by their content and served `immutable`
for a year, so this is paid once per release, over the VPN. Precompressing `assets/` at Brotli 11 at build time and serving the
`.br` files would put the transfer under 450 kB (435 kB); the response compression of the API's JSON must stay at the fast
level (the year's JSON at Brotli quality 11 takes 1.2 s to compress against 11 ms at quality 1, for 100 kB against 166 kB). That is a change to hosting, not to
the web app, and is not made here.

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
     gets the map from the React fiber of its component (the page has no handle on it) and listens to `idle`, `sourcedata` and
     `render`. *Routes drawn*: the first frame the map renders after its routes source has its data, which is when the line is on
     the screen; the camera may still be moving. *Map style loaded*: the map element's `data-map-state` becoming `ready`.
   - *Main thread blocked before the rows*: the sum of the long tasks (> 50 ms) that began before the rows.
4. A screenshot of the first run of each scenario was looked at to see that what was timed was a map with its routes and pins and a
   panel with its chips (they are under `web/perf/results/`, not committed).

### Results

4× CPU throttling, 7 runs of each, ms from the start of the navigation (from the tap, for the step); median / worst, then the range
of the 7. An earlier run of the same code (before the *routes drawn* rows existed) gave the same picture within
the spread: the day's rows 958 / 1,044 ms, the month's 1,022 / 1,152, the year's 1,254 / 1,413.

**Cold navigation** (`page.goto`, an empty cache):

| | Typical day (15 rows) | Heaviest day (11 rows) | Typical month (41 rows) | Heaviest month (40 rows) | Year (348 rows) |
| --- | --- | --- | --- | --- | --- |
| API answer received | 814 / 866 | 819 / 916 | 921 / 1,029 | 915 / 1,033 | 875 / 1,011 |
| first contentful paint | 840 / 900 | 848 / 940 | 968 / 1,060 | 944 / 1,068 | 880 / 996 |
| **panel rows in the DOM** | **947 / 1,016** (875-1,016) | **982 / 1,124** (918-1,124) | **1,154 / 1,197** (1,067-1,197) | **1,097 / 1,264** (916-1,264) | **1,252 / 1,527** (1,144-1,527) |
| panel rows painted | 992 / 1,067 | 1,019 / 1,181 | 1,213 / 1,260 | 1,137 / 1,326 | 1,395 / 1,712 |
| map style loaded | 1,167 / 1,247 | 1,196 / 1,395 | 1,427 / 1,567 | 1,377 / 1,571 | 1,556 / 1,835 |
| routes drawn on the map | 1,651 / 1,797 | 1,626 / 1,851 | 1,929 / 2,127 | 1,974 / 2,040 | 2,692 / 2,994 |
| **map idle** | **1,947 / 2,073** (1,673-2,073) | **1,746 / 1,993** | **1,943 / 2,204** | **1,976 / 2,142** | **2,754 / 3,033** (2,253-3,033) |
| main thread blocked before the rows | 689 / 738 | 710 / 840 | 826 / 876 | 775 / 920 | 887 / 1,121 |
| *target* | ≤ 1,000 | ≤ 1,000 | ≤ 2,000 | ≤ 2,000 | ≤ 3,000 |

**Tap › with the page open** (the next day or period already prefetched):

| | Typical day | Heaviest day | Typical month | Heaviest month | Year |
| --- | --- | --- | --- | --- | --- |
| **panel rows** | **57 / 77** (8-77) | **50 / 59** | **82 / 99** | **77 / 119** | **219 / 258** |
| rows painted | 108 / 183 | 98 / 158 | 206 / 271 | 162 / 218 | 495 / 566 |
| routes drawn on the map | 108 / 182 | 98 / 149 | 200 / 266 | 161 / 217 | 683 / 857 |
| map idle | 1,119 / 1,302 | 1,182 / 1,371 | 1,266 / 1,671 | 1,038 / 1,180 | 1,543 / 1,859 |
| *target* | ≤ 1,000 | ≤ 1,000 | ≤ 2,000 | ≤ 2,000 | ≤ 3,000 |

How to read it:

- **Where the cold time goes.** The API answer arrives at about 0.8-0.9 s: that is the boot, not the request. Parsing and running
  1.9 MB of JavaScript at a quarter of the speed keeps the main thread blocked for 0.7-0.9 s before the first row, the first
  contentful paint is at 0.8-1.0 s, and the answer, rendered by React, is on screen 130 ms (a day) to 380 ms (a year of 348 rows)
  later. Only 14 % (day) to 30 % (year) of the rows time comes after the answer; the rest is the app starting. A real iPhone has the shell from the
  service worker and a faster core than a quarter of this container's; the throttle is a pessimistic stand-in.
- **The target for the day is the tap.** Spec §8 says "Day view data shown after navigating (‹ ›), past day ≤ 1 s (near-instant when
  prefetched)": 57 ms at the median, 77 at the worst, with the neighbour prefetched. A day that is not prefetched costs the request
  on top: the API's p95 of 8.7 ms plus the gap between "API answer received" and "rows" above (about 130 ms for a day, 230 ms for a
  month, 380 ms for a year), still a small fraction of the targets. The cold navigation is the stricter reading, and the brief's:
  the typical day passes it at the median (947 ms; one run of seven, 1,016 ms, is over it), and the heaviest day at the median too
  (982 ms) but with three runs of seven over (1,010, 1,078 and 1,124 ms: up to 12 %). §8's own cold number is "open app (cold, installed) to map visible ≤ 2 s": the map's
  style was loaded at 1.17 s (day), and the routes were on the map at 1.65 s (day), 1.93 s (month), 2.69 s (year).
- **Map idle is dominated by what is not the data.** On a cold load `idle` comes 0.3 s (day) or less (month, year) after the routes
  are drawn, and on a tap about 1 s after them. It includes (a) the camera move, `fitBounds` over 600 ms by design
  (`FIT_DURATION_MS`), so it is at least 0.6 s after the data however fast the rest, and (b) the frames MapLibre draws during it,
  each of 1170 × 2532 pixels in software on the CPU (8 to 10 frames in a cold load, at the median). The tap's idle (1.0-1.9 s) against its routes-drawn time (0.1-0.7 s) shows it. The day's cold idle of
  1.9 s against a number of 1 s is that boot plus the camera, not a slow map; see the caveats before reading `idle` as a verdict.

### Lever measured and left out: lazy-load MapLibre

The cold time is the boot, and MapLibre is two thirds of the JavaScript, so `MapView` was made a `React.lazy` import behind a
`Suspense` with no fallback (an experiment on a scratch edit of `App.tsx`, 5 runs of each scenario, reverted: it is **not** in the
commit). Medians, cold navigation, ms (the 7-run baseline of the table above in brackets):

| | Panel rows | First contentful paint | Map style loaded | Map idle |
| --- | --- | --- | --- | --- |
| Day | 745 (947) | 644 (840) | 1,317 (1,167) | 1,970 (1,947) |
| Month | 852 (1,154) | 708 (968) | 1,378 (1,427) | 2,131 (1,943) |
| Year | 916 (1,252) | 616 (880) | 1,620 (1,556) | 2,407 (2,754) |

The rows come 200-340 ms sooner (the day's worst run went from 1,016 to 860 ms); the map's style loads about as late or 150 ms later,
and `idle` is within the run-to-run spread (±200 ms). It would turn the day's worst-run overshoot into a margin of 14 % and takes
a few lines in `App.tsx`; the cost is that the map element appears a frame or two after the panel on a cold open, and the
unit tests that render `App` would have to wait for it. Not done: the day target is met at the median, the spec asks for first paint
to carry "the shell and map", and the owner's phone is the judge of whether opening feels slow.

### Does the throttle slow the map's worker?

MapLibre builds its GeoJSON tiles in a worker. A probe in the spec (`probe: does the CPU throttle reach a worker`) runs a fixed loop on
the page's thread and in a worker, unthrottled and at 4×: the page's thread slowed **4.5 times** (587 → 2,624 ms), the worker **1.4
times** (846 → 1,162 ms; 1.2 to 1.5 times over four runs of the probe). The CDP throttle reaches the worker only a little. So the parts of the map's time
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
  as the targets say, but the real phone's first start also fetches 0.5-0.7 MB of JavaScript over the VPN (cached after).
- **The throttle.** 4× is the brief's figure, applied to the page's main thread; it is not a model of an iPhone, whose single-core
  speed is likely nearer this container's than a quarter of it. Run-to-run spread on this shared 4-core container is about ±10 %
  (the month's cold rows were 1,022 ms in one run of 7 and 1,154 ms in the next), and the worst of 7 is a sample of the tail, not
  a bound. The runs are in one browser process, one after another; the first thrown away.
- **The data.** Synthetic: a person who moves 1.7 hours a day on clean commutes, 7,607 segments, 1,643 moves in the busiest year
  and 15 thousand vertices after simplification. The 60,000-vertex budget was never reached, and a history with places of thousands
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

# --- The web: record the API's answers once, then measure (the API may be stopped for the second) ---
cd web
npm run perf:record -- http://127.0.0.1:5100 2024-06-01 2026-10-22 2025         # web/perf/recorded/, not committed
npm run perf                      # builds, serves the build, 37 tests, about 4 minutes; PERF_RUNS=7 PERF_CPU=4 by default
npm run perf:bundle               # after `npm run build`: gzip, Brotli, per file

kill $pid; docker rm -f sporer-perf-db
```

`npm run perf` prints the table and writes `web/perf/results/web-timing.json` (every run's numbers) and a screenshot of each scenario;
`PERF_RUNS` and `PERF_CPU` change the runs and the throttle. It needs the recorded answers and the Chromium Playwright already has
(it never installs one), uses port 4174 (the e2e suite's is 4173) and no real network. It is a measurement, not a test of the app:
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

