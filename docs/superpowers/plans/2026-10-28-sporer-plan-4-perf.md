# Sporer Plan 4: editing performance check (synthetic history, about 10 million rows)

Measured on 2026-10-29 against the same generated history as Plans 1 to 3 (the same rows and checksum), with the server and the web app as
built at the end of Plan 4 (the server code is that of `20e088e`; the commit of this check adds measuring scripts, a test helper, the README
and this document, and no server or app code). The owner's real data was not available: these numbers say how what Plan 4 built behaves at
the volume the spec assumes (spec §6.6, §8, §9), on a throttled desktop browser, not on the owner's phone. The real check is the owner's, on
the iPhone over the VPN: the README's "Owner's checklist: editing" asks for it. Plan 3's check is in `2026-10-26-sporer-plan-3-perf.md`,
whose method this one follows; this one adds what Plan 4 built (the removal of points and its effect on the backfill, the edits that
recompute the homes and trips inside their request, the points of a day, the place search, and edit mode on a phone) and says what it did
to what was there before.

**One pass, and no miss.** Every target was met, so nothing in the server or the web app was changed for performance and no migration or
index was added. What the check adds is the measuring: the scripts (`tools/perf/`), the scenario of edit mode in the web run, and this
document. The measuring did find one thing in the measuring itself, not in the product: the first way of timing "the points are drawn" was
too early by about 0.4 s (see "Web"), and was changed before any number was kept.

## Result

| What (Plan 4 brief) | Target | Measured | Verdict |
| --- | --- | --- | --- |
| **Backfill**, the whole history with **1,000 removed points** spread over it, to 100 % with nothing pending | ≤ +5 % on `main`'s mean, on this machine | `main` 119.9 / 113.4 s (mean 116.7), Plan 4 120.8 / 116.5 / 114.6 s (mean 117.3): **+0.6 %** on the means; the two back-to-back pairs +0.8 % and +2.7 %. (Plan 4 with no point removed: 113.4 s) | Met, 4.4 points under |
| **`PUT /api/trips/{id}`** (rename), 20 in a running process | p95 ≤ 300 ms | p50 **18.2-31.1 ms**, p95 **23.0-33.7 ms** over three runs; the name taken back, p95 19.6-33.8 ms | Met, 9 to 13 times under |
| **`POST /api/places/{id}/merge`** (the old home into the new home), 20 | p95 ≤ 300 ms | p50 25.7-38.9 ms, p95 **27.4-49.0 ms**; its `Separate`, p95 18.2-33.2 ms | Met, 6 to 11 times under |
| **`PUT /api/settings`** (the trip distance 60 km), 20 | p95 ≤ 300 ms | p50 16.2-28.9 ms, p95 **17.7-44.3 ms**; and back to `null`, p95 17.6-31.8 ms | Met, 7 to 17 times under |
| *The first edit after a start*: the first round of a new process | read against the same | rename **232 ms** (and 259 ms, the max of a run with no warm-up), merge 89 ms, distance 42 ms (the JIT; in a warm process 22, 26 and 17 ms) | Inside 300 ms, by 14 % at worst: see "Edits" |
| **`GET /api/day/{date}/points`**, every one of the 874 days once | p95 ≤ 400 ms | p50 15.9-17.8 ms, **p95 34.9-42.6 ms**, max 81.0 ms over three runs; 27 days have no points, the median day has 472,553 B raw | Met, 9 to 11 times under |
| ... a typical day (2024-09-18, 11,585 points), 50 requests | ≤ 400 ms | p50 18.1-21.5 ms, **p95 24.6-27.9 ms**; 96,752 B Brotli, 472,553 B raw | Met |
| ... **the heaviest day** (2025-06-28), **36,940 points**, 50 requests | ≤ 400 ms | p50 66.8-71.0 ms, **p95 80.3-86.0 ms**, max 95.9 ms; 320,612 B Brotli, 1,506,308 B raw | Met, 4.7 times under at the worst p95 |
| **`GET /api/places/search`**, no `q`, and a `q` of three letters, 200 each | p95 ≤ 200 ms | named, over three runs: no `q`: p50 5.4-5.5, p95 **5.9-6.2** ms; a `q` of 2-3 letters: p50 5.5-5.7, p95 **5.8-5.9** ms (unnamed, one run: 6.5 and 2.6 ms, the `q` finds none). 252 B Brotli, 1,195 B raw (20 places) | Met, 32 times under |
| **Plans** (`EXPLAIN (ANALYZE, BUFFERS)`) of the removal's anti-join, the day's points and the search | no query scans a large table | a week of 113,958 points with 9 of the 1,000 removals: 49.0 ms against 38.9 ms without the anti-join (a merge anti join against the removals, sorted: 0.23 ms); the same week's next point and a night's nearest point: 1.4 and 0.5 ms (probes of the removals' key); the heaviest day: 13.0 ms; the search: 6.7 and 4.1 ms, which reads the 7,607 segments twice | Met; the search is the one that grows with the history, see "Plans" |
| **Web, edit mode: from the tap on Edit points to the points drawn**, the heaviest day, phone project, 4× CPU, 7 runs | ≤ 2 s | median **1,023 ms**, worst 1,269 ms (the answer is there at 84 / 89 ms; the map has the tiles of the points at 1,010 / 1,180 ms, and draws them in the same frame) | Met, 1.6 times under at the worst |
| *Information:* the **reads that were there**, Plan 4 (three runs) against `main` on this machine and history (named places, p50 / p95 ms) | Plan 3's targets | day 6.0-7.4 / 6.6-9.6 against 7.4 / 9.0; range 31 days 10.0 / 12.1-12.3 against 10.1 / 12.1; places 7.2-7.3 / 8.2-8.8 against 6.6 / 7.6; trips 4.8-5.0 / 5.2-7.1 against 4.6 / 6.1; trip of 25 nights 6.9-7.1 / 7.5-8.3 against 6.7 / 8.0 | The same, within the spread (about 1 ms); the trips' answers are 33 B larger (`ownName` and the edit flags) |
| *Information:* the **web app's start** | Plan 2's: main-thread JavaScript ≤ 450 kB gzip | 397.8 kB (Plan 3: 383.9): the page's own chunk 116.4 kB (102.6), MapLibre's chunk 281.4 kB (281.4) | Met, 52 kB under; the editing is 13.8 kB gzip of the page's chunk |
| *Information:* the views that were there, **rows in the DOM, Plan 4 against `main`'s** web app (median of 7, ms) | Plan 3's: ≤ 1 s / 2 s / 3 s | day 453 against 389, then in alternating pairs 394 / 439 against 395 / 407; year 528 against 526, then 511 / 535 against 504 / 485; the heaviest day, the months, the trips: −4 % to +5 % | The same, within the spread of the runs (the first pass had the day 16 % over, which the pairs do not repeat: 0 % and +8 %) |

Everything in the table is a number from the runs below.

## Decisions

- **The backfill's baseline is measured here, back to back, on one generation.** Plan 3's 175-181 s is of another day: `main` takes 113-120 s
  on this machine now. The target (at most +5 % on `main`'s mean) is judged against the code of `main` (`e87cd42`, Plan 3's head and the
  map credit; a `git worktree` of it, built in Release), run on this machine over the same raw history, a copy of it for each run (a template
  database), so that each backfill starts from the same rows and no timeline. Runs in the order `main`, Plan 4, `main`, Plan 4, Plan 4 with no
  point removed, Plan 4. `main` ran over a schema that has the Plan 4 tables, which it does not touch. The runs of the same code differ by 5.7 % (`main`)
  and 5.4 % (Plan 4), under the 10 % at which a pair would be run again.
- **1,000 points are removed before the Plan 4 backfill**, by `tools/perf/exclude-points.sql`: the points are picked evenly by time
  from the first to the last of the history (twice as many instants as points, the first point at or after each, and one in each of 1,000
  equal runs of those, so that the phone's silent gaps do not give fewer), one batch, as the app's Remove makes them. A thousand is far
  more than anyone removes by hand, and every week of the history has about 8 of them, so every step of the backfill has the anti-join at
  work. The raw points stay in `locationlog`; the rows go to `excluded_point`.
- **The edits are timed in pairs that put what they changed back**, in rounds of three (`tools/perf/edit-latency.sh`): rename the trip of 25
  nights and take the name back; merge the old home (place 1) into the new home (place 53) and separate it; set the distance to 60 km and
  back to `null`. Merging the two homes is the merge that changes what home detection sees. The forward write of each pair is the one the
  target is judged on (20 of them, after 3 rounds that are not measured); the write that puts it back runs the same recompute and is
  timed and printed as well. A write goes with a JSON body and `Content-Type: application/json`, as the app sends it, and its time is curl's
  `time_total` over loopback. After each run the script looks again at what is stored: the trip is named as detected, nothing is merged,
  the setting is the configured one (and the tables hold what they did: 2 home periods, 3 trips, no trip edit, no setting).
- **The day's points are taken for every day of the history, once, and then for two days repeatedly** (`tools/perf/points-latency.sh`):
  all 874 dates in turn with no compression (the sizes pick the next two, and each answer is the first read of its day since the start of
  the API), then the day of the median size among those that have points and the day of the most bytes, 50 requests each after 20 that
  are not measured, with `Accept-Encoding: br` as a browser asks. The heaviest day of this history is the generator's long drive, 36,940
  points of one device.
- **The place search is timed in `api-latency.sh`**, with the other small lists: 200 requests with no `q` and 200 with a `q` of two or three
  letters (`pla`, `str`, `ace`, `pl`, `tre`, `ee`, the terms of `name-places.sql`'s "Place 12" and "Street 12"), with the places named (a history with no
  names finds nothing for a `q`, which is the same work for a smaller answer: both are given).
- **The web scenario is the day with the most points, opened cold and then Edit points tapped** (`edit-points` in `web/perf/web-timing.spec.ts`,
  recorded by `record.mjs`, which asks for the points of every day to find the day): the same phone project, 4× throttle, recording
  mocked from the server, 7 runs and warm-up as the others. It times from the tap to the answer with the points, to the map having the tiles
  of its source of them, to the first frame after that, and to the map's idle. The day is open and at rest when it is tapped, as the owner's is.
- **The places are named in the run that is reported** (as in Plan 3): `tools/perf/name-places.sql` gives the 87 places a city, a country and, to
  three in four, an OSM name ("Place 12") and an address ("Street 12"). The backfill is of the history before the names, which it does not
  depend on; `main` is measured with the names too where the reads are compared.
- **No fix for performance.** Nothing missed, so nothing was changed in the server or the app for it.

## Machine and setup

The same machine and tools as Plan 3's, and faster that day for the backfill: `main`'s took 113 to 120 s here, against 175 to 181 s in Plan 3's
runs (its reads were not faster). So **no number here is compared with Plan 3's tables**: where Plan 4 could have changed a figure it is
compared with `main` on this machine, in the same hour.

- 4 vCPU Intel Xeon @ 2.80 GHz, 15 GB RAM, Linux 6.18 in a container with Docker. Client and server share the machine and its four CPUs
  (during the web runs the API was stopped and the database idle).
- Server: TimescaleDB `timescale/timescaledb:2.17.2-pg16` in Docker on port 55432 with the image's own tuning; the API as in Plan 3
  (.NET SDK 10, `dotnet build -c Release`, `dotnet Sporer.Api.dll`, `Nominatim__Enabled=false`, every setting at its default), over HTTP on
  127.0.0.1:5100. Latency is curl's `time_total` with `Accept-Encoding: br` (identity where it says so).
- Web: Node 22, Playwright 1.56.1 with its Chromium (headless), software WebGL (SwiftShader), the e2e suite's `phone` project (390 × 844 CSS
  pixels at a device scale of 3, touch), the processor held back 4 times with `Emulation.setCPUThrottlingRate`, the production build served by
  `vite preview`: as in Plans 2 and 3.

## The data

The same generator, options and seed as Plans 1 to 3 (`tools/Sporer.SyntheticData`, `--from 2024-06-01 --to 2026-10-22 --moving-interval
500ms --seed 42`).

| | |
| --- | --- |
| Rows written | 10,726,341 (checksum `0690878d1283b1fd`, the same as Plan 1's), in 52 s here |
| Backfill | 113.4 to 120.8 s from the start of the API to 100 % and the last refresh done, `failedRanges` empty, `pendingRanges` 0 (`main`: 113.4 and 119.9 s) |
| Timeline | 7,607 segments on 816 days, 87 places, 874 nights, 2 home periods, 3 trips: the same with and without the 1,000 removed points, and the same as Plan 3's |
| Removed points | 1,000, in one batch, from 2024-06-01 05:00 to 2026-10-22 07:55 UTC; 9 of them in the week the plans are of |
| The heaviest day | 2025-06-28: 36,940 points of one device, 1,506,308 B as JSON; its timeline answer is 18.9 kB |

What a real history will look like is not known; see the caveats.

## Server

### Backfill

`tools/perf/backfill-time.sh <api-dll> [db-container] [database]`, as in Plan 3, over a copy of the raw history for each run.

| Run | `main` (`e87cd42`) | Plan 4, 1,000 points removed | Plan 4, none removed |
| --- | --- | --- | --- |
| 1 | 119.9 s | 120.8 s | |
| 2 | 113.4 s | 116.5 s | 113.4 s |
| 3 | | 114.6 s | |
| **Mean** | **116.7 s** | **117.3 s** (+0.6 %) | |

Each run was a new copy of the same raw history (7,607 segments every time, so the work is the same). The removals cost what the plan says
(below): the segmenter's load of a step of seven days gains a merge anti join, which is about 10 ms on a week of 114,000 points (49 against 39
ms), and a backfill has 126 such steps: about 1.3 s of the 117, which is within the spread of the runs (a run with no point removed
took 113.4 s, the same as `main`'s second).

### Edits

`tools/perf/edit-latency.sh <base-url> [rounds=20] [warmup=3]` (new). The API ran over the finished backfill with the 1,000 points removed
and the places named. Times in ms, n = 20; three runs, the first and the third in a process that was started for them, the second in the
process of the first.

| | Run 1: p50 / p95 / max | Run 2 (warm): p50 / p95 / max | Run 3, no warm-up: p50 / p95 / max |
| --- | --- | --- | --- |
| `PUT /api/trips/{id}`, the name set | 28.0 / **33.2** / 33.2 | 18.2 / **23.0** / 23.8 | 31.1 / **33.7** / 258.5 |
| ... and taken back | 29.3 / 33.8 / 38.3 | 17.9 / 19.6 / 20.9 | 30.3 / 33.1 / 48.6 |
| `POST /api/places/{id}/merge` | 37.3 / **46.1** / 48.8 | 25.7 / **27.4** / 29.0 | 38.9 / **49.0** / 86.2 |
| ... and `DELETE .../merged/{other}` | 25.7 / 33.2 / 40.1 | 16.1 / 18.2 / 18.7 | 27.7 / 31.8 / 42.8 |
| `PUT /api/settings`, 60 km | 25.7 / **32.0** / 43.9 | 16.2 / **17.7** / 17.7 | 28.9 / **44.3** / 44.9 |
| ... and back to `null` | 25.5 / 30.8 / 31.0 | 15.9 / 17.6 / 21.6 | 27.3 / 31.8 / 37.6 |

Every write answered 2xx, and what was stored was what it was after each run. **An edit costs 16 to 49 ms.** The recompute is what costs: it
reads every night and the position of every stay, works the homes and the trips out in memory and writes them in one transaction
(`TripRefresher.RecomputeAsync`, which Plan 3's refresh also does, after building the nights). The cheapest edit, the setting, does nothing
else but write one row (16 ms warm); the rename costs the same within 2 ms, and the merge about 10 ms more, for its own write, the read of the
survivor and a recompute that moves a home. The spread between the runs (18 against 31 ms for the same rename) is the machine's: the runs were
minutes apart.

**The first edit after a start is the slow one**, as the first refresh is in Plan 3: 232 ms for the rename of the first round of run 1, 259 ms
in run 3 (the max of the rename's column), 89 ms for the merge and 42 ms for the distance, where the same writes take 22, 26 and 17 ms in a
warm process. It is the JIT compiling the recompute and Dapper building its readers the first time. It is under 300 ms in both starts (by
14 % in the worse) and happens once per start, in the request of the owner's first edit. Nothing was done about it (a warm-up at the
start is a change to the product for a request that is already inside its target).

### The day's points

`tools/perf/points-latency.sh <base-url> <first-date> <last-date>` (new). Times in ms, sizes in bytes; three runs, the third in a process
started for it.

| | n | p50 | p95 | p99 | max | Brotli | Raw | Points |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Every day, once (uncompressed) | 874 | 15.9-17.8 | 34.9-42.6 | 45.3-64.0 | 54.0-81.0 | | median 472,553, p95 1,037,125, max 1,506,308 | |
| A typical day, 2024-09-18 | 50 | 18.1-21.5 | 24.6-27.9 | 25.8-30.1 | 25.8-30.1 | 96,752 | 472,553 | 11,585 |
| The heaviest day, 2025-06-28 | 50 | 66.8-71.0 | 80.3-86.0 | 84.4-95.9 | 84.4-95.9 | 320,612 | 1,506,308 | 36,940 |

The cost is the points: about 1.8 ms for each thousand (67 ms for 36,940). 13 ms of it is the query (3.9 ms the index scan, the rest the anti-join and
the sort, see the plans), and the rest is the application reading the rows, making them JSON (a point is `[t, lon, lat, device]`, 41 B) and
compressing 1.5 MB. The removal's own limit is 50,000 points. A real day of long drives with two devices may be heavier than the generator's one.

### Place search

`GET /api/places/search`, 200 requests each (in `api-latency.sh`, now), after 20 that are not measured. Times in ms.

| | p50 | p95 | p99 | max | Brotli | Raw |
| --- | --- | --- | --- | --- | --- | --- |
| No `q`, named places (three runs) | 5.4-5.5 | 5.9-6.2 | 6.5-8.0 | 7.3-8.6 | 252 | 1,195 |
| A `q` of 2-3 letters, named places (three runs; all of them match: 20 places) | 5.5-5.7 | 5.8-5.9 | 5.9-6.6 | 6.7-10.0 | 252 | 1,195 |
| No `q`, no place named (one run) | 6.0 | 6.5 | 9.2 | 13.8 | 153 | 981 |
| A `q`, no place named (one run; it finds none) | 2.4 | 2.6 | 2.8 | 4.5 | 6 | 2 |

The search is two reads of `segment` (7,607 rows) in one query (4 to 7 ms in the plans), which is all of the endpoint's time and does not depend
on the `q`. It is also the one query here that grows with the history: ten times the segments would be about ten times as long, which is not
measured and would be under the target; at today's size it is 32 times under it.

### Plans

`tools/perf/explain-edits.sql` (new) holds the queries Plan 4 added or changed, copied from `PointStore` and `PlaceStore`, as psql
variables (`from` for a week, `day_from` and `day_to` for the points of a day). Run after the backfill, with the 1,000 removals in
`excluded_point`, for the week of 2025-06-24 (113,958 points, 9 removals) and the heaviest day; the plans are in the appendix.

```sh
docker exec -i sporer-perf-db psql -U postgres -d perf -X -v from='2025-06-24 00:00:00+00' \
  -v day_from='2025-06-27 22:00:00+00' -v day_to='2025-06-28 22:00:00+00' < tools/perf/explain-edits.sql
```

| Query | Plan | Execution | Buffers |
| --- | --- | --- | --- |
| A step of seven days, as the segmenter loads it (`LoadAsync`), with the removals | the two chunks of the week through the time index, **Merge Anti Join** against `excluded_point` (a Seq Scan of its 1,000 rows, sorted by time: 0.23 ms), incremental sort | **49.0 ms** (113,949 rows) | 2,313 |
| The same without the anti-join | the same scan, the incremental sort | 38.9 ms (113,958 rows) | 2,300 |
| The point after the step (`includeNextPoint`) | the first chunk that holds a later point, through the time index, probed against the removals' key (`Index Only Scan` on `excluded_point_pkey`): 3 points read for one; the other 69 chunks are never executed | 1.4 ms (and 19 ms of planning, of 70 chunks, the first of the session) | 11 |
| The nearest point of a night (`NearestAsync`) | one chunk (56 excluded at startup), two points read, probed against the key | 0.5 ms | 8 |
| The points of the heaviest day (`LoadPositionsAsync`) | the one chunk through the index, Merge Anti Join, incremental sort: 36,940 rows | 13.0 ms | 758 |
| The place search, no query | the stays counted through `ix_segment_stays` (3,796 rows), the places in use found by a Seq Scan of `segment` (7,607 rows), the chain of merges over 87 places | 6.7 ms | 1,871 |
| The place search, a `q` of three letters | the same, and the `strpos` filter on the 87 places | 4.1 ms | 1,868 |

**The anti-join does what its comment in `PointStore` says**: the time index still reads the chunks of the range and no more, and the removals
are either probed by their primary key for each point when few points are read (the next point, the nearest, a day with a few) or merged
against the whole table when many are (a step, a heavy day). The merge reads and sorts `excluded_point` each time, 0.23 ms for a thousand rows
and in proportion, so that a hundred thousand removals (a hundred times what the 1,000 are) would cost about 25 ms a step. It costs about 10
ms a step here (26 %), which is 1 % of a backfill. No query scans a large table: the search reads `segment` twice, 7,607 rows, which
is the timeline and not the raw points. **No index and no migration was added.**

## Web

### Method

The same as Plans 2 and 3's (`npm run perf:record`, then `npm run perf`), with edit mode added.

1. **Record** (`web/scripts/perf/record.mjs`, extended): it also asks for the points of every day that has a timeline (816 requests, about half a
   minute) to find the day with the most, and records that day, its neighbours (which the app prefetches) and its points. The scenario is
   `edit-points`: 10 scenarios, 31 responses.
2. **Play back** (`web/perf/web-timing.spec.ts`, extended): the cold navigation to the day as for the others, and then, with the page at rest, the
   tap on "Edit points". The probe notes the click, the end of the response with the points (the resource timing), the first time the map has all
   the tiles of its `sporer-edit-points` source after it, the first frame the map draws after that, and the map's idle after that frame. The run
   asserts that nothing outside the recording was asked for and that the bar says there are points to select. The 72 tests (10 scenarios of
   7 runs, the warm-up and the probe of the throttle) take about 4 minutes.
3. **How the probe was checked.** The first version took the map's own event that its source has the data (the worker has parsed it) for the
   moment of loading, and the frame after it for the drawing: median 672 ms. During a run, screenshots taken as fast as the page gave them
   (14 in two seconds, with the clock of the page's tap and of the shots in common) showed the points on the screen only when the map was
   idle, 0.4 s after that "drawn": that event comes before the worker has made the tiles, and a frame after it has nothing of the points yet.
   The probe now waits for a tile event of the source with every tile loaded, and then for a frame; with it, the first shot with the points
   (the route is gone under them: see the caveats) started 98 ms after the previous shot, which had the route, and 4 ms after the "drawn" of the
   probe, and the map's idle is that same frame.

### Results

4× CPU throttling, 7 runs of the scenario, ms from the tap on Edit points; median / worst. The day was opened cold before it (rows in the DOM
411 / 440 ms, map idle 1,231 / 1,296 ms).

| | The heaviest day (36,940 points, 1,506 kB) |
| --- | --- |
| The answer with the points received | 84 / 89 |
| The map has the tiles of the points | 1,010 / 1,180 |
| **The points drawn** (the first frame after) | **1,023 / 1,269** |
| The map's idle | 1,023 / 1,269 |
| *target* | ≤ 2,000 |

How to read it: **1.0 s at the median and 1.3 s at the worst, 1.6 times under the target.** The answer (a mocked one over loopback, so no
network) is there in 0.1 s, and the rest, 0.9 s, is the page making 36,940 features of the rows, handing them to the map's worker and getting
its tiles back; the map draws them in the frame that has the tiles, and is idle in it. Not broken down further: it is inside the target by
a margin of 1.6.

**What Plan 4 did to the views that were there** (the control): the day, month, year and trips scenarios were run on this machine with
`main`'s web app too (a `git worktree` of `e87cd42`, the same Chromium and the same recorded answers), once for all of them and then, in four
alternating runs (main, Plan 4, main, Plan 4), for the day and the year only. Rows in the DOM, median / worst of 7, ms:

| | Typical day | Heaviest day | Typical month | Heaviest month | Year | Trips | Trip, 25 nights |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `main` | 389 / 409 | 386 / 435 | 412 / 469 | 421 / 475 | 526 / 588 | 387 / 420 | 390 / 435 |
| Plan 4 | 453 / 462 | 387 / 448 | 427 / 439 | 437 / 500 | 528 / 637 | 371 / 402 | 389 / 406 |

| Alternating runs, the day 2025-12-05 and the year 2025 | Day, `main` | Day, Plan 4 | Year, `main` | Year, Plan 4 |
| --- | --- | --- | --- | --- |
| first pair | 395 / 436 | 394 / 419 | 504 / 612 | 511 / 588 |
| second pair | 407 / 425 | 439 / 497 | 485 / 598 | 535 / 566 |

In the first pass the year is the same as `main`'s (528 against 526 ms, +0.4 %) and the day is 16 % over (453 against 389 ms); the pairs do not
repeat the day (394-439 ms against 395-407: 0 % and +8 % in the two pairs) and have the year at 511-535 against 485-504 (+1 % and +10 %), which is what one
run of seven shows of this machine. The heaviest day, the months and the trips are within −4 % and +5 % of `main`'s in the first pass. Plan 4 added edit mode to the shell and the
map and a button to the day; it changed nothing else of these views.

**Bundle** (`npm run build`, `npm run perf:bundle`): the main-thread JavaScript is **397.8 kB** gzip (Plan 3: 383.9 kB), 52 kB under the 450 kB
of P2-R63: the page starts with 116.4 kB (102.6) and the map fetches MapLibre's chunk, 281.4 kB (the same) when it mounts; MapLibre's worker, apart,
147.9 kB (the same); every JavaScript file 545.7 kB (531.8). What Plan 4 added (the editing forms, Settings, edit mode and its
bar) is 13.8 kB gzip of the page's own chunk.

## What this does not show (caveats)

Plan 2's and Plan 3's caveats hold for everything on the web side: software WebGL; no real map style, tiles or network; a mocked API on loopback; a 4×
throttle that is not an iPhone; one phone-sized viewport and the light scheme; a run-to-run spread of ±10 % on this shared machine; server
timings on loopback that exclude the VPN, Traefik and Authentik. Also:

- **The throttle does not reach the worker.** The probe of this run: the page's thread 4.5 times slower, the worker 1.0 times. In edit mode the
  tiles of 37,000 points are made in the map's worker, so on an iPhone that part will take longer than measured here, by what the phone's
  worker is slower than this machine's, and the 4× on the page's thread does not stand in for it. The real check is the owner's: the README's
  checklist asks how long Edit points takes on the phone.
- **The history's heaviest day has 36,940 points of one device** and the API answers a day in 0.08 s; the app gets 320 kB Brotli (1.5 MB raw)
  over the VPN for it, about 0.1 to 0.2 s on a connection of 15 to 25 Mbit/s, which the mocked run does not include.
- **The points are drawn as they are, and at the zoom the day fits at they are one white band**: each point is a dark dot with a light halo,
  drawn in time order, so the halo of a point covers the dot of the one before it, and where the points are less than a pixel apart (11 m
  apart at 80 km/h, and a pixel of this map is tens of metres) the band is all halo, with the dots of the isolated points (the generator's spikes)
  dark on its sides. A dot is a dot once the map is zoomed in far enough for the points to be more than a few pixels apart, which is where
  one is tapped. This is how Plan 4's layer draws, and no number here depends on it.
- **The edits are timed on 874 nights, 3 trips and 2 homes.** The recompute reads every night and every stay's position, so its cost grows
  with the history: about 30 ms for these, and four times the nights would be about four times that, which is still under 300 ms. Not measured.
- **The anti-join is measured with 1,000 removals**, 9 in the week; the plans say what 100,000 would cost (about 25 ms a step), not a measurement.
- **The search reads `segment` twice**: 7,607 rows, 6.7 ms. Ten times the segments would be about ten times that, under the target.
- **The first edit after a start is 0.23 to 0.26 s** (the JIT), under the target by 14 % in the worse of two starts.
- **Seven runs of the web scenarios** are a sample of the tail, not a bound.

## Repeat it

```sh
# --- The history: one raw copy, and a database from it for each timing of a backfill (as Plans 1-3; about 4 minutes) ---
docker run -d --name sporer-perf-db -e POSTGRES_PASSWORD=password -p 55432:5432 timescale/timescaledb:2.17.2-pg16
docker exec sporer-perf-db psql -U postgres -c "create database perf_raw"
dotnet build src/Sporer.Api -c Release
api=src/Sporer.Api/bin/Release/net10.0/Sporer.Api.dll
export TSDB_CONNECTION_STRING="Host=localhost;Port=55432;Username=postgres;Password=password;Database=perf_raw"
export Nominatim__Enabled=false ASPNETCORE_URLS=http://127.0.0.1:5100
Processing__Enabled=false dotnet $api & pid=$!; sleep 8; kill $pid          # creates the schema
dotnet run --project tools/Sporer.SyntheticData -c Release -- --connection "$TSDB_CONNECTION_STRING" \
  --from 2024-06-01 --to 2026-10-22 --moving-interval 500ms --seed 42       # 10.7 million rows, about a minute
# a copy needs the template to have no other session: the TimescaleDB scheduler is one, so end it in the same run that copies
for db in perf_main perf; do
  printf "select pg_terminate_backend(pid) from pg_stat_activity where datname = 'perf_raw' and pid <> pg_backend_pid();\ncreate database $db template perf_raw strategy file_copy;\n" |
    docker exec -i sporer-perf-db psql -U postgres
done

# --- The backfill: `main` against Plan 4 with 1,000 removed points, each on a database of its own (about 2 minutes each) ---
git worktree add ../sporer-main e87cd42 && dotnet build ../sporer-main/src/Sporer.Api -c Release
TSDB_CONNECTION_STRING="${TSDB_CONNECTION_STRING/perf_raw/perf_main}" \
  tools/perf/backfill-time.sh ../sporer-main/src/Sporer.Api/bin/Release/net10.0/Sporer.Api.dll sporer-perf-db perf_main
docker exec -i sporer-perf-db psql -U postgres -d perf -X -v count=1000 < tools/perf/exclude-points.sql   # before the Plan 4 run
export TSDB_CONNECTION_STRING="${TSDB_CONNECTION_STRING/perf_raw/perf}"
KEEP=1 tools/perf/backfill-time.sh $api sporer-perf-db perf               # leaves the API running (stop it by its pid); to repeat, drop the
                                                                          # database, make it again from perf_raw and remove the points again
# Its last lines give "nights 874, home periods 2, trips 3" on this history, with and without the removals.

# --- The server: the reads (unnamed, then named), the day's points, the edits, the plans ---
tools/perf/api-latency.sh http://127.0.0.1:5100 2024-06-01 2026-10-22          # about 40 seconds now; the place search is its last two lines
docker exec -i sporer-perf-db psql -U postgres -d perf -X < tools/perf/name-places.sql
tools/perf/api-latency.sh http://127.0.0.1:5100 2024-06-01 2026-10-22
tools/perf/points-latency.sh http://127.0.0.1:5100 2024-06-01 2026-10-22       # about 30 seconds
tools/perf/edit-latency.sh http://127.0.0.1:5100 20 3                          # a few seconds; start the API again first to see the first edit of a start
docker exec -i sporer-perf-db psql -U postgres -d perf -X -v from='2025-06-24 00:00:00+00' \
  -v day_from='2025-06-27 22:00:00+00' -v day_to='2025-06-28 22:00:00+00' < tools/perf/explain-edits.sql

# --- The web: record once (the API running over the history), then measure (the API may be stopped) ---
cd web
npm run perf:record -- http://127.0.0.1:5100 2024-06-01 2026-10-22 2025       # web/perf/recorded/, not committed; 31 responses, about half a minute
npm run perf                      # builds, serves the build, 72 tests, about 4 minutes; PERF_RUNS=7 PERF_CPU=4 by default
npm run perf -- --grep "edit-points|warm-up"                                   # the scenario of edit mode alone, with its screenshots in web/perf/results/
npm run perf:bundle               # after `npm run build`

# a control, `main`'s web app on the same recording: in the worktree, with web/node_modules linked and web/perf/recorded copied into it
npm run perf -- --grep-invert edit-points

docker rm -fv sporer-perf-db; git worktree remove ../sporer-main
```

`npm run perf` and the rest are described in Plan 2's and Plan 3's "Repeat it"; what is new is that the recording holds the points of the heaviest day and that the
run plays back the ten scenarios, the one of edit mode among them.

## Appendix: the query plans

Run with `tools/perf/explain-edits.sql` as above, on the history of this document with the places named and 1,000 points removed, with literal
parameters (the custom plans a statement gets on its first executions). `Buffers` lines are all `shared hit`: the database was warm and in memory.

<details><summary>A step of seven days, as the segmenter loads it, with the anti-join (PointStore.LoadAsync)</summary>

```
                                                                                             QUERY PLAN
-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
 Incremental Sort  (cost=70.31..9474.48 rows=111818 width=88) (actual time=0.316..45.483 rows=113949 loops=1)
   Sort Key: l."time", l.device
   Presorted Key: l."time"
   Full-sort Groups: 3561  Sort Method: quicksort  Average Memory: 27kB  Peak Memory: 27kB
   Buffers: shared hit=2313
   ->  Merge Anti Join  (cost=70.26..4442.67 rows=111818 width=88) (actual time=0.285..29.554 rows=113949 loops=1)
         Merge Cond: (l."time" = e."time")
         Join Filter: (e.device = l.device)
         Buffers: shared hit=2310
         ->  Custom Scan (ChunkAppend) on locationlog l  (cost=0.42..4073.30 rows=112818 width=88) (actual time=0.012..20.266 rows=113958 loops=1)
               Order: l."time"
               Chunks excluded during startup: 0
               Buffers: shared hit=2300
               ->  Index Scan Backward using _hyper_1_56_chunk_locationlog_time_idx on _hyper_1_56_chunk l_1  (cost=0.42..1139.38 rows=31658 width=88) (actual time=0.012..3.992 rows=32325 loops=1)
                     Index Cond: (("time" >= '2025-06-24 00:00:00+00'::timestamp with time zone) AND ("time" <= ('2025-06-24 00:00:00+00'::timestamp with time zone + '7 days'::interval)))
                     Buffers: shared hit=654
               ->  Index Scan Backward using _hyper_1_57_chunk_locationlog_time_idx on _hyper_1_57_chunk l_2  (cost=0.42..2933.92 rows=81160 width=88) (actual time=0.027..9.732 rows=81633 loops=1)
                     Index Cond: (("time" >= '2025-06-24 00:00:00+00'::timestamp with time zone) AND ("time" <= ('2025-06-24 00:00:00+00'::timestamp with time zone + '7 days'::interval)))
                     Buffers: shared hit=1646
         ->  Sort  (cost=69.83..72.33 rows=1000 width=24) (actual time=0.234..0.250 rows=458 loops=1)
               Sort Key: e."time"
               Sort Method: quicksort  Memory: 71kB
               Buffers: shared hit=10
               ->  Seq Scan on excluded_point e  (cost=0.00..20.00 rows=1000 width=24) (actual time=0.005..0.111 rows=1000 loops=1)
                     Buffers: shared hit=10
 Planning:
   Buffers: shared hit=139
 Planning Time: 0.948 ms
 Execution Time: 49.005 ms
(29 rows)
```

</details>

<details><summary>The same step without it (what LoadAsync read before the removals), the lines that differ</summary>

```
 Incremental Sort  (cost=0.47..9150.11 rows=112818 width=88) (actual time=0.031..35.541 rows=113958 loops=1)
   ->  Custom Scan (ChunkAppend) on locationlog l  (cost=0.42..4073.30 rows=112818 width=88) (actual time=0.011..19.663 rows=113958 loops=1)
         ->  Index Scan Backward using _hyper_1_56_chunk_locationlog_time_idx on _hyper_1_56_chunk l_1  (cost=0.42..1139.38 rows=31658 width=88) (actual time=0.010..3.760 rows=32325 loops=1)
         ->  Index Scan Backward using _hyper_1_57_chunk_locationlog_time_idx on _hyper_1_57_chunk l_2  (cost=0.42..2933.92 rows=81160 width=88) (actual time=0.031..9.405 rows=81633 loops=1)
 Planning Time: 0.317 ms
 Execution Time: 38.930 ms
```

</details>

<details><summary>The point after the step (PointStore.LoadAsync, includeNextPoint), with the 69 chunks that are never executed left out</summary>

```
                                                                                              QUERY PLAN
------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
 Limit  (cost=1.03..1.41 rows=1 width=88) (actual time=0.065..0.070 rows=1 loops=1)
   Buffers: shared hit=11
   ->  Incremental Sort  (cost=1.03..2133262.50 rows=5692805 width=88) (actual time=0.064..0.069 rows=1 loops=1)
         Sort Key: l."time", l.device
         Presorted Key: l."time"
         Full-sort Groups: 1  Sort Method: quicksort  Average Memory: 25kB  Peak Memory: 25kB
         Buffers: shared hit=11
         ->  Nested Loop Anti Join  (cost=0.70..1877086.28 rows=5692805 width=88) (actual time=0.045..0.050 rows=2 loops=1)
               Buffers: shared hit=11
               ->  Custom Scan (ChunkAppend) on locationlog l  (cost=0.42..197385.10 rows=5693805 width=88) (actual time=0.022..0.027 rows=3 loops=1)
                     Order: l."time"
                     Chunks excluded during startup: 0
                     Buffers: shared hit=4
                     ->  Index Scan Backward using _hyper_1_57_chunk_locationlog_time_idx on _hyper_1_57_chunk l_1  (cost=0.42..706.46 rows=20945 width=88) (actual time=0.021..0.022 rows=3 loops=1)
                           Index Cond: ("time" > ('2025-06-24 00:00:00+00'::timestamp with time zone + '7 days'::interval))
                           Buffers: shared hit=4
                     ->  Index Scan Backward using _hyper_1_58_chunk_locationlog_time_idx on _hyper_1_58_chunk l_2  (cost=0.42..2810.90 rows=83433 width=88) (never executed)
                           Index Cond: ("time" > ('2025-06-24 00:00:00+00'::timestamp with time zone + '7 days'::interval))
        ... 136 lines: the other chunks, each an Index Scan Backward that is (never executed) ...
               ->  Index Only Scan using excluded_point_pkey on excluded_point e  (cost=0.28..0.30 rows=1 width=24) (actual time=0.007..0.007 rows=0 loops=3)
                     Index Cond: ((device = l.device) AND ("time" = l."time"))
                     Heap Fetches: 1
                     Buffers: shared hit=7
 Planning:
   Buffers: shared hit=4695 dirtied=2
 Planning Time: 19.389 ms
 Execution Time: 1.406 ms
(162 rows)
```

</details>

<details><summary>The nearest point of a night: the latest at or before the instant (PointStore.NearestAsync)</summary>

```
                                                                                                                    QUERY PLAN
--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
 Limit  (cost=1.56..2.46 rows=1 width=88) (actual time=0.044..0.045 rows=1 loops=1)
   Buffers: shared hit=8
   ->  Incremental Sort  (cost=1.56..867.62 rows=964 width=88) (actual time=0.044..0.044 rows=1 loops=1)
         Sort Key: l."time" DESC, l.device
         Presorted Key: l."time"
         Full-sort Groups: 1  Sort Method: quicksort  Average Memory: 25kB  Peak Memory: 25kB
         Buffers: shared hit=8
         ->  Nested Loop Anti Join  (cost=0.70..824.24 rows=964 width=88) (actual time=0.031..0.034 rows=2 loops=1)
               Buffers: shared hit=8
               ->  Custom Scan (ChunkAppend) on locationlog l  (cost=0.42..216.16 rows=1964 width=88) (actual time=0.017..0.018 rows=2 loops=1)
                     Order: l."time" DESC
                     Chunks excluded during startup: 56
                     Buffers: shared hit=4
                     ->  Index Scan using _hyper_1_57_chunk_locationlog_time_idx on _hyper_1_57_chunk l_1  (cost=0.42..70.68 rows=1908 width=88) (actual time=0.016..0.017 rows=2 loops=1)
                           Index Cond: (("time" <= ('2025-06-24 00:00:00+00'::timestamp with time zone + '3 days'::interval)) AND ("time" >= (('2025-06-24 00:00:00+00'::timestamp with time zone + '3 days'::interval) - '12:00:00'::interval)))
                           Buffers: shared hit=4
               ->  Index Only Scan using excluded_point_pkey on excluded_point e  (cost=0.28..0.30 rows=1 width=24) (actual time=0.007..0.007 rows=0 loops=2)
                     Index Cond: ((device = l.device) AND ("time" = l."time"))
                     Heap Fetches: 0
                     Buffers: shared hit=4
 Planning:
   Buffers: shared hit=3969 dirtied=1
 Planning Time: 16.705 ms
 Execution Time: 0.525 ms
(24 rows)
```

</details>

<details><summary>The points of the heaviest day, 36,940 of them, for edit mode (PointStore.LoadPositionsAsync)</summary>

```
                                                                                         QUERY PLAN
---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
 Incremental Sort  (cost=70.31..3131.38 rows=35922 width=40) (actual time=0.245..11.745 rows=36940 loops=1)
   Sort Key: l."time", l.device
   Presorted Key: l."time"
   Full-sort Groups: 1155  Sort Method: quicksort  Average Memory: 27kB  Peak Memory: 27kB
   Buffers: shared hit=758
   ->  Merge Anti Join  (cost=70.26..1514.89 rows=35922 width=40) (actual time=0.225..7.007 rows=36940 loops=1)
         Merge Cond: (l."time" = e."time")
         Join Filter: (e.device = l.device)
         Buffers: shared hit=758
         ->  Index Scan Backward using _hyper_1_57_chunk_locationlog_time_idx on _hyper_1_57_chunk l  (cost=0.42..1335.26 rows=36922 width=40) (actual time=0.012..3.905 rows=36942 loops=1)
               Index Cond: (("time" >= '2025-06-27 22:00:00+00'::timestamp with time zone) AND ("time" < '2025-06-28 22:00:00+00'::timestamp with time zone))
               Buffers: shared hit=748
         ->  Sort  (cost=69.83..72.33 rows=1000 width=24) (actual time=0.175..0.190 rows=455 loops=1)
               Sort Key: e."time"
               Sort Method: quicksort  Memory: 71kB
               Buffers: shared hit=10
               ->  Seq Scan on excluded_point e  (cost=0.00..20.00 rows=1000 width=24) (actual time=0.006..0.079 rows=1000 loops=1)
                     Buffers: shared hit=10
 Planning:
   Buffers: shared hit=25
 Planning Time: 0.378 ms
 Execution Time: 12.971 ms
(22 rows)
```

</details>

<details><summary>The place search with no query (PlaceStore.SearchAsync)</summary>

```
                                                                         QUERY PLAN
-------------------------------------------------------------------------------------------------------------------------------------------------------------
 Limit  (cost=1654.89..1654.90 rows=1 width=57) (actual time=6.437..6.445 rows=20 loops=1)
   Buffers: shared hit=1871
   CTE stays
     ->  HashAggregate  (cost=401.78..402.65 rows=87 width=16) (actual time=3.487..3.495 rows=87 loops=1)
           Group Key: segment.place_id
           Batches: 1  Memory Usage: 24kB
           Buffers: shared hit=1079
           ->  Index Scan using ix_segment_stays on segment  (cost=0.28..392.30 rows=1896 width=8) (actual time=0.028..3.150 rows=3796 loops=1)
                 Filter: (place_id IS NOT NULL)
                 Buffers: shared hit=1079
   CTE chain
     ->  Recursive Union  (cost=2.83..277.56 rows=1347 width=28) (actual time=3.561..3.653 rows=87 loops=1)
           Buffers: shared hit=1085
           ->  Hash Semi Join  (cost=2.83..7.89 rows=87 width=28) (actual time=3.559..3.591 rows=87 loops=1)
                 Hash Cond: (p_1.id = stays_1.place_id)
                 Buffers: shared hit=1082
                 ->  Seq Scan on place p_1  (cost=0.00..3.87 rows=87 width=16) (actual time=0.010..0.022 rows=87 loops=1)
                       Buffers: shared hit=3
                 ->  Hash  (cost=1.74..1.74 rows=87 width=8) (actual time=3.535..3.535 rows=87 loops=1)
                       Buckets: 1024  Batches: 1  Memory Usage: 12kB
                       Buffers: shared hit=1079
                       ->  CTE Scan on stays stays_1  (cost=0.00..1.74 rows=87 width=8) (actual time=3.489..3.510 rows=87 loops=1)
                             Buffers: shared hit=1079
           ->  Hash Join  (cost=4.96..25.62 rows=126 width=28) (actual time=0.050..0.051 rows=0 loops=1)
                 Hash Cond: (chain_1.merged_into_id = next.id)
                 Buffers: shared hit=3
                 ->  WorkTable Scan on chain chain_1  (cost=0.00..19.57 rows=290 width=20) (actual time=0.001..0.006 rows=87 loops=1)
                       Filter: (depth < 32)
                 ->  Hash  (cost=3.87..3.87 rows=87 width=16) (actual time=0.029..0.029 rows=87 loops=1)
                       Buckets: 1024  Batches: 1  Memory Usage: 12kB
                       Buffers: shared hit=3
                       ->  Seq Scan on place next  (cost=0.00..3.87 rows=87 width=16) (actual time=0.005..0.011 rows=87 loops=1)
                             Buffers: shared hit=3
   ->  Sort  (cost=974.68..974.68 rows=1 width=57) (actual time=6.436..6.440 rows=20 loops=1)
         Sort Key: ((sum(stays.visits))::bigint) DESC, p.id
         Sort Method: top-N heapsort  Memory: 26kB
         Buffers: shared hit=1871
         ->  GroupAggregate  (cost=974.64..974.67 rows=1 width=57) (actual time=6.360..6.401 rows=87 loops=1)
               Group Key: p.id
               Buffers: shared hit=1868
               ->  Sort  (cost=974.64..974.65 rows=1 width=65) (actual time=6.351..6.357 rows=87 loops=1)
                     Sort Key: p.id
                     Sort Method: quicksort  Memory: 30kB
                     Buffers: shared hit=1868
                     ->  Nested Loop Semi Join  (cost=941.77..974.63 rows=1 width=65) (actual time=5.730..6.335 rows=87 loops=1)
                           Join Filter: (p.id = up.id)
                           Rows Removed by Join Filter: 3741
                           Buffers: shared hit=1868
                           ->  Nested Loop  (cost=2.97..32.68 rows=1 width=73) (actual time=3.618..3.825 rows=87 loops=1)
                                 Buffers: shared hit=1259
                                 ->  Hash Join  (cost=2.83..29.82 rows=3 width=16) (actual time=3.599..3.727 rows=87 loops=1)
                                       Hash Cond: (chain.origin = stays.place_id)
                                       Buffers: shared hit=1085
                                       ->  CTE Scan on chain  (cost=0.00..26.94 rows=7 width=16) (actual time=3.563..3.675 rows=87 loops=1)
                                             Filter: (merged_into_id IS NULL)
                                             Buffers: shared hit=1085
                                       ->  Hash  (cost=1.74..1.74 rows=87 width=16) (actual time=0.020..0.021 rows=87 loops=1)
                                             Buckets: 1024  Batches: 1  Memory Usage: 13kB
                                             ->  CTE Scan on stays  (cost=0.00..1.74 rows=87 width=16) (actual time=0.001..0.007 rows=87 loops=1)
                                 ->  Index Scan using place_pkey on place p  (cost=0.14..0.95 rows=1 width=57) (actual time=0.001..0.001 rows=1 loops=87)
                                       Index Cond: (id = chain.id)
                                       Filter: (merged_into_id IS NULL)
                                       Buffers: shared hit=174
                           ->  CTE Scan on up  (cost=938.80..940.74 rows=97 width=8) (actual time=0.024..0.027 rows=44 loops=87)
                                 Buffers: shared hit=609
                                 CTE up
                                   ->  Recursive Union  (cost=694.64..938.80 rows=97 width=12) (actual time=2.076..2.090 rows=87 loops=1)
                                         Buffers: shared hit=609
                                         ->  HashAggregate  (cost=694.64..695.51 rows=87 width=12) (actual time=2.075..2.081 rows=87 loops=1)
                                               Group Key: s.place_id
                                               Batches: 1  Memory Usage: 24kB
                                               Buffers: shared hit=609
                                               ->  Seq Scan on segment s  (cost=0.00..685.14 rows=3799 width=8) (actual time=0.005..1.780 rows=3796 loops=1)
                                                     Filter: (place_id IS NOT NULL)
                                                     Rows Removed by Filter: 3811
                                                     Buffers: shared hit=609
                                         ->  Hash Join  (cost=3.88..24.23 rows=1 width=12) (never executed)
                                               Hash Cond: (up_1.id = link.id)
                                               ->  WorkTable Scan on up up_1  (cost=0.00..19.57 rows=290 width=12) (never executed)
                                                     Filter: (depth < 32)
                                               ->  Hash  (cost=3.87..3.87 rows=1 width=16) (never executed)
                                                     ->  Seq Scan on place link  (cost=0.00..3.87 rows=1 width=16) (never executed)
                                                           Filter: (merged_into_id IS NOT NULL)
 Planning:
   Buffers: shared hit=154
 Planning Time: 1.181 ms
 Execution Time: 6.665 ms
(87 rows)
```

</details>

<details><summary>The place search with a query of three letters, the lines that differ</summary>

```
 Limit  (cost=1654.95..1654.96 rows=1 width=57) (actual time=3.887..3.895 rows=20 loops=1)
                                       Filter: ((merged_into_id IS NULL) AND ((strpos(lower(COALESCE(user_name, osm_name, ''::text)), 'pla'::text) > 0) OR (strpos(lower(COALESCE(address, ''::text)), 'pla'::text) > 0)))
 Planning Time: 0.539 ms
 Execution Time: 4.093 ms
```

</details>
