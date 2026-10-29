# Sporer Plan 5: the final performance pass (every §8 target, a network like the VPN)

Measured on 2026-10-29 against the same generated history as Plans 1 to 4 (the same rows and checksum), with the server and the web app as
built at the end of Plan 5's tasks (`aa2f4fb`: the service worker, ReadyToRun and the start-up warm-up, the edit bar's follow-ups). The
commit of this check adds the measuring (a server for the web run, the installed-app, open-the-app and pan scenarios, a deeper recording), the README's
installing and sign-off sections and this document, and no server or app code. The owner's real data was not available: these numbers say how
what v1 is behaves at the volume the spec assumes (spec §6.6, §8, §9), on a throttled desktop browser behind an emulated network, not on the
owner's phone. **The real check is the owner's, on the iPhone over the VPN, and the README's "Owner's sign-off: the §8 targets" asks for it, line by
line.** The earlier checks are in `2026-10-23-sporer-plan-1-perf.md` (ingest, the day, the backfill), `2026-10-24-sporer-plan-2-perf.md` (range, heat,
the web method), `2026-10-26-sporer-plan-3-perf.md` (the nights, homes and trips) and `2026-10-28-sporer-plan-4-perf.md` (editing); this one
repeats none of their history, only what a final pass over §8 needs, and compares with them where something could have changed.

**One pass, and no miss.** Every target was met on this machine, so nothing in the server or the web app was changed for performance and no
migration or index was added. What the check adds is the measuring, and two of the things it measured are findings and not verdicts: the installed app
is no faster than the first visit to its rows here, only to its map (the page is limited by the processor, not by the network, see "Web"), and the
pan and zoom takes a median frame of 117 ms in software drawing, which says nothing about the phone.

## §8 and the targets of this pass

Medians and worst of 7 runs, phone project, processor held back 4 times, network 60 ms round trip, 20 Mbit/s down, 5 up (CDP), times from the start
of the navigation unless a step is said, in ms. Targets are verbatim from the spec's §8 (and Plan 4's edit mode, which was timed before the halo became a
layer of its own and is timed again here). Server times are on loopback and are not in the web numbers; add them (the day's p95 is 7 ms, the month's 11 ms,
the year's 37 ms).

| §8 target (verbatim) | This pass | Verdict |
| --- | --- | --- |
| **open the app (cold, installed) to the map visible ≤ 2 s** | **Installed** (the worker active and its cache full, a new page, the worker not running): the map's first `idle` with its style and the panel's rows **1,358 / 1,612 ms** (the style loaded 730 / 825, the rows 599 / 671, the routes drawn 1,026 / 1,194). **First visit** (no worker, nothing kept): idle **1,542 / 1,685**, style 928 / 952, rows 564 / 589. The app's six files under `/assets/` were all answered by the worker (none fetched) in the installed case, and all fetched in the first | **Met here, 1.2 times under at the worst, the narrowest margin of the table.** The installed app is 184 ms faster to the map and 35 ms *slower* to the rows than the first visit: see "Web". With a connection set-up (two round trips, 0.12 s) and the server's few milliseconds the worst installed run is 1.74 s. What only the phone settles: the real basemap tiles (the style here has none), iOS starting the app and its worker, the real VPN |
| **a past day after ‹ › ≤ 1 s** (the spec: near-instant when prefetched) | Tap › with the next day prefetched: the panel's rows **24 / 29 ms** (the heaviest day 21 / 27), the routes drawn 80 / 98. A second tap at once, with nothing prefetched: rows **103 / 136 ms** (the heaviest day 137 / 168). The day opened cold by its address: rows 585 / 611 (the heaviest 605 / 643). *Information:* the map's idle after a step is 1,134 / 1,367 ms: it is the camera moving, in software | **Met**, 6 times under at the worst of the cold step. The idle is over 1 s as in Plan 2 and is not a verdict (the rows and the routes are there in 0.1 s) |
| **a month ≤ 2 s** | Cold, by its address: rows **599 / 678 ms** (the heaviest month 600 / 614), routes drawn 1,349 / 1,549, map idle 1,652 / 1,769. Tap ›: rows 31 / 35, then a second tap at once: rows 140 / 165 | **Met**, 2.9 times under on the rows at the worst, 1.1 times on the map's idle |
| **a year ≤ 3 s** | Cold, by its address: rows **861 / 898 ms**, routes drawn 1,735 / 1,971, map idle 1,799 / 2,087 (the answer is 554 kB raw, 150 kB on the wire). Tap ›: rows 72 / 87, routes drawn 310 / 347 | **Met**, 3.3 times under on the rows and 1.4 times on the idle, at the worst |
| **pan and zoom smooth on the iPhone** (the spec: the Year with routes included) | A scripted pan and zoom on the Year with its routes (six moves, 6 s): 56 frames, **p95 frame time 150 / 183 ms**, median frame 117 ms, longest 167 / 217 ms, **50 of 56 frames over 50 ms** (44 to 53 in the 7 runs) | **No verdict from here, and the owner's to give.** Software drawing (SwiftShader) is the processor drawing a 1170 × 2532 map, far slower than the iPhone's graphics chip; these are information |
| **ingest p95 < 200 ms while processing runs** (`POST /api/overland`) | During a whole backfill (0 to 100 %, 130 s): 280 batches of 1,000 points, one every 0.4 s (2,500 points a second): **p95 34.2 ms**, p99 65.6, max 85.2; 300 batches of 100 points: **p95 12.3 ms**. Back to back at the start of a backfill: 100 / 500 / 1,000 points p95 10.4 / 21.4 / 30.6 ms. Every answer 200; 280,000 points all processed 55 s after the backfill ended | **Met**, 5.8 times under at the worst |
| **no unhandled error reaching a blank screen** | The tests: 1,361 unit and component tests and 240 browser tests (every view has its loading, empty and error state, with Retry; the app opened with no network, signed out and on a failed chunk have tests of their own); the 94 runs of the web check asserted no console error, no request outside the recording and no external request | **Met by the tests; the owner confirms it in use** (README: Airplane mode, Settings) |
| *Plan 4's:* **edit mode on the heaviest day**, 36,942 points, ≤ 2 s | The tap to the points drawn: **1,067 / 1,150 ms** (the answer, 321 kB on the wire, at 246 / 289; the map has the tiles at 1,042 / 1,130). With no network, to compare with Plan 4: 1,033 / 1,250 against its 1,023 / 1,269 | **Met**, 1.7 times under at the worst. The point halo, which became a layer of its own after Plan 4 timed it (P4-R45), costs nothing that shows: the same to 1 % |

Also on the final build:

| What | Target | This pass | Verdict |
| --- | --- | --- | --- |
| The web app's start: main-thread JavaScript, gzip | ≤ 450 kB (P2-R63) | **398.6 kB** (Plan 4: 397.8): the page's own chunk 117.2 kB, MapLibre's chunk 281.4 kB; MapLibre's worker, apart, 147.9 kB | Met, 51 kB under |
| What the worker keeps at install | (none) | 11 files and `index.html`: **2,074.2 kB raw, 490.8 kB Brotli** (quality 11; the API sends them at its Optimal level, about 525 kB) | Information |
| The first refresh after a start | Plan 3's: ≤ 200 ms | **75 ms** (max 87) after the warm-up, 5 starts, each the first request of its own process | Met; Plan 3 found 174 to 225 ms |
| The first edit after a start (`PUT /api/settings`) | Plan 4's: ≤ 300 ms | **89 ms** (max 93) | Met, 3.4 times under |
| The day's data, `GET /api/day`, 200 dates | Plan 1's: p95 ≤ 200 ms | p50 5.7, **p95 7.1 ms** (`day-latency.sh`: 5.3 / 5.7) | Met, 28 times under |
| The range, 31 and 365 days | Plan 2's: ≤ 400 / 800 ms | p95 **11.0** / **36.8 ms** | Met, 36 and 22 times under |
| Trips list and a trip | Plan 3's: ≤ 200 / 400 ms | p95 **6.5 ms** and 9.3 ms for the longest trip | Met, 31 and 43 times under |
| The edits that recompute the homes and trips | Plan 4's: p95 ≤ 300 ms | rename 21.5, merge 32.0, distance 16.1 ms | Met, 9 to 19 times under |
| The day's points, every day once; the heaviest day | Plan 4's: p95 ≤ 400 ms | 32.1 ms; **80.0 ms** (max 95.6) for the 36,942 points of 2025-06-28 | Met, 12 and 5 times under |
| The place search | Plan 4's: p95 ≤ 200 ms | no `q` 5.5, a `q` of 2 to 3 letters 5.2 ms | Met, 36 times under |

Everything in the tables is a number from the runs below.

## Decisions

- **The build is the one the Dockerfile makes.** `dotnet publish -c Release -r linux-x64 --self-contained false -p:PublishReadyToRun=true`, run as
  `dotnet Sporer.Api.dll`, every setting at its default, `Nominatim__Enabled=false`. Not `dotnet build`, which the earlier plans measured: ReadyToRun
  is what ships, and it is what the first requests after a start are about (Task 4).
- **The network is the browser's, through CDP, and every answer goes through it.** The first design, the one of Plans 2 to 4, mocked the API's answers with
  `page.route`; a fulfilled request never reaches the browser's network stack, where the emulation is, so it is not slowed by it. Checked: a 500 kB answer
  took 13 ms mocked and 270 ms from a server under `Network.emulateNetworkConditions` (60 ms and 20 Mbit/s: 60 + 200). So the run has a server of its own now
  (`web/perf/serve.mjs`): it serves the production build and the recorded answers over HTTP, the way the API does (a strong ETag and a 304, `immutable`
  under `/assets/` and `no-cache` for the rest, Brotli at the quality that `CompressionLevel.Optimal` is, gzip otherwise, and every path that is no file and no
  `/api/` call answered with `index.html`), and notes any `/api/` request it has no recording for, which the run then fails on. It replaces `vite preview`,
  which has gzip only and no API. A run with `PERF_NETWORK=off` is the earlier plans' (below: it gives the same times as Plan 4's to within the spread).
- **The profile is the owner's VPN: 60 ms, 20 Mbit/s down, 5 up.** The processor is held back 4 times as before, on the page's thread (the throttle does
  not reach the map's worker: probe in every run, main thread 4.3 times slower, worker 0.96).
- **What the emulation does not reach is slowed by hand.** The service worker is a target of its own: the navigation it fetches from the network is not slowed
  by the page's emulation (checked: a 300 kB page through a worker took 5 ms under it). The only request of that kind that the installed app waits for is the page of
  the navigation, a kilobyte or two, so it is held 60 ms by a route on the context (`slowWorker`), the round trip of the profile; its transfer is a
  fraction of a millisecond. The worker's install fetches, which the profile does not reach either, are not timed.
- **The first visit has no worker; the installed app has one with its cache full.** The e2e `use` blocks workers, which is the first visit as the brief says
  (a first visit that registers one does so after the page's load and fetches the shell again, in parallel: not modelled, since that traffic is not slowed by
  the emulation, and it is once). The installed case: a page in a browser of its own, the app opened with nothing held back until the worker is `activated`,
  in control of the page and has one cache of files (asserted), then the worker is stopped (CDP `ServiceWorker.stopAllWorkers`: an app left for a while is
  not running on a phone), a new page is opened and the old one closed, and the new one is timed from its navigation start. Both are checked from the
  page's own resource timing, in every run: installed, six resources were answered by the worker with a transfer size of 0 (the six files under `/assets/`), and none
  in the first visit. Playwright keeps the browser's HTTP cache off while a page has a route, and this run's pages have one, so no run read a file from the HTTP cache:
  "the HTTP memory cache gone" of the brief is how every page here starts.
- **"Today" is a recorded day.** The app opens on today (`/`), which is no day that was recorded: the page's clock is put on the typical weekday, 2026-01-12
  (`fixTime`, as the e2e tests do), so that what the app asks for, that day and its neighbours and the list of trips, has recorded answers. The map has the
  e2e suite's local style (`/test-style.json`, no tiles), as in every web check of Plans 2 to 4.
- **The step is timed twice.** The step of the earlier plans is a tap on › with the page at rest, when the day after has been prefetched: it is the "near-instant
  when prefetched". The second, new here, is a tap at the moment the first step's rows are in the DOM, before the page has had the answer for the period after
  that: the same rows have no prefetch to find (the request is made a moment before, by the prefetch of the new period, and the tap waits for it), which is what
  the target's "after navigating" is when the owner is quicker than the prefetch. For a year it is not made: no year after the next has data in the history.
  The recording has three days or months either side for it, a year two.
- **Pan and zoom are scripted on the map**: `panBy` and `zoomTo` with durations (700 and 900 ms), left, up, zoomed in 1.5 levels, right, down, zoomed out, a diagonal,
  on the Year of 2025 once its routes are drawn; the frames are the page's `requestAnimationFrame` calls, and a frame time is the time between two. Real touch
  input would add the handling of the gesture and nothing to the drawing, which is what the software renderer cannot do fast.
- **The ingest runs are each on a database of their own,** a copy of the raw history (a template database), so that the backfill starts from nothing as it does
  after a rebuild, and the points posted, which are stamped now, do not change the history that the reads and the recording use.
- **The recording is of the clean history, made before anything else wrote to it** (`first-after-start.sh` leaves five points a start in `locationlog`).
- **No fix for performance.** Nothing missed, so nothing was changed in the server or the app for it.

## Machine and setup

The same machine and tools as Plan 4's.

- 4 vCPU Intel Xeon @ 2.30 GHz, 15 GB RAM, Linux 6.18 in a container with Docker. Client and server share the machine and its four CPUs (during the web runs the
  API was stopped and the database idle; during the server runs nothing else ran).
- Server: TimescaleDB `timescale/timescaledb:2.17.2-pg16` in Docker on port 55432 with the image's own tuning; the API published ReadyToRun as above (.NET SDK
  10.0.113), over HTTP on 127.0.0.1:5100. Latency is curl's `time_total` with `Accept-Encoding: br` (identity where it says so).
- Web: Node 22.22, Playwright 1.56.1 with its Chromium 141 (headless), software WebGL (SwiftShader), the e2e suite's `phone` project (390 × 844 CSS pixels at a
  device scale of 3, touch), the processor held back 4 times with `Emulation.setCPUThrottlingRate`, the network with `Network.emulateNetworkConditions`, the
  production build served by `web/perf/serve.mjs`.

## The data

The same generator, options and seed as Plans 1 to 4 (`tools/Sporer.SyntheticData --from 2024-06-01 --to 2026-10-22 --moving-interval 500ms --seed 42`).

| | |
| --- | --- |
| Rows written | 10,726,341 (checksum `0690878d1283b1fd`, the same as Plan 1's), in 49 s |
| Backfill | 128.2 s from the start of the API to 100 % and the last refresh done, `failedRanges` 0, `pendingRanges` 0 (Plan 4: 113 to 121 s; the same work: 7,607 segments) |
| Timeline | 7,607 segments, 87 places, 874 nights, 2 home periods, 3 trips: as in Plans 3 and 4 |
| Removed points | none (Plan 4's runs had 1,000 removed, which is why its day of 11,585 points has 11,586 here and its heaviest day's 36,940 has 36,942) |
| Places | named with `tools/perf/name-places.sql` for the reads, as in Plans 3 and 4 |

What a real history will look like is not known; see the caveats.

## Server

All on the ReadyToRun build, over the finished backfill with the places named, the API warm unless it says it is a first request.

### The reads and the edits

`tools/perf/api-latency.sh` (seed 1, 20 warm-up, 200 dates, 100 + 20 windows, 200 places, 50 trips), `day-latency.sh`, `points-latency.sh` and `edit-latency.sh 20 3`.
Times in ms; compressed sizes are Brotli as sent, raw as JSON.

| | n | p50 | p95 | p99 | max | Brotli, median | Raw, median |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `GET /api/day/{date}` | 200 | 5.7 | **7.1** | 8.4 | 13.2 | 2,183 B | 7,796 B |
| ... `day-latency.sh` | 200 | 5.3 | 5.7 | 5.9 | 7.0 | | |
| `GET /api/range`, 31 days | 100 | 9.6 | **11.0** | 15.5 | 18.9 | 13,000 B | 46,153 B |
| `GET /api/range`, 365 days | 20 | 32.0 | **36.8** | 37.1 | 37.1 | 149,070 B | 532,273 B |
| `GET /api/heat`, 31 and 365 days | 100, 20 | 2.1, 6.5 | 2.9, 6.7 | | | 277 B, 853 B | |
| `GET /api/places/{id}` | 200 | 6.4 | 7.2 | 8.5 | 8.6 | 400 B | 1,082 B |
| `GET /api/trips` | 50 | 4.5 | **6.5** | 8.5 | 8.5 | 611 B | 1,851 B |
| `GET /api/trips/{id}`, 25 / 6 / 2 nights | 50 each | 6.7 / 5.3 / 5.1 | **9.3** / 5.7 / 5.4 | | | 8,779 / 3,975 / 3,024 B | 30,753 / 11,785 / 8,008 B |
| `GET /api/places/search`, no `q` | 200 | 4.8 | **5.5** | 7.4 | 8.1 | 246 B | 1,195 B |
| ... a `q` of 2 to 3 letters | 200 | 4.9 | **5.2** | 6.6 | 10.5 | 246 B | 1,195 B |
| `GET /api/day/{date}/points`, every day once | 874 | 14.7 | **32.1** | 41.8 | 58.1 | | median 472,593 B, p95 1,037,166 |
| ... a typical day, 2024-09-18 (11,586 points) | 50 | 18.1 | **22.1** | 31.6 | 31.6 | 96,791 B | 472,593 B |
| ... the heaviest day, 2025-06-28 (36,942 points) | 50 | 62.6 | **80.0** | 95.6 | 95.6 | 321,044 B | 1,506,390 B |
| `PUT /api/trips/{id}`, a rename | 20 | 17.6 | **21.5** | 22.2 | 22.2 | | |
| ... and the name taken back | 20 | 17.7 | 20.6 | 21.9 | 21.9 | | |
| `POST /api/places/{id}/merge` | 20 | 24.4 | **32.0** | 32.1 | 32.1 | | |
| ... `DELETE .../merged/{other}` | 20 | 15.2 | 17.4 | 19.3 | 19.3 | | |
| `PUT /api/settings` (60 km) | 20 | 14.7 | **16.1** | 19.4 | 19.4 | | |
| ... and back to `null` | 20 | 15.1 | 17.1 | 17.1 | 17.1 | | |

Every request answered 200 (2xx for the writes), 847 of the 874 days have points, and what the edits changed was put back (the trip named as detected, nothing merged, the
setting as configured). Against Plan 4's tables the reads and edits are the same to within the spread of a run (day 5.7 / 7.1 against its 6.0-7.4 / 6.6-9.6; range 9.6 / 11.0
against 10.0-10.5 / 12.1-12.7; trips 4.5 / 6.5 against 4.8-5.0 / 5.2-7.1; the heaviest day's points 62.6 / 80.0 against 66.8-71.0 / 80.3-86.0; the rename 17.6 / 21.5 against
18.2-31.1 / 23.0-33.7). No query changed since Plan 4 (the only changes to `src/` since it are the warm-up and the refresher's extraction of the part that only reads: no SQL), so the plans were not run again.

### The first requests after a start

`tools/perf/first-after-start.sh <dll> sporer-perf-db perf 5 isolated` (every kind is the first request of its own new process: the worst case of each) and `... 5 sequence`
(one start for all of them, in the owner's order: the phone's batch and the worker's refresh, a day, a month, the trips, an edit). Medians of 5 starts, ms, the largest in
brackets; the first answer of `/api/status` comes at 736 ms (max 822) after the start.

| First after a start | isolated | sequence | the second, same process |
| --- | --- | --- | --- |
| the worker's refresh after a batch | **75** (87) | 76 (78) | |
| `GET /api/day/2025-08-11` | 74 (80) | 64.5 (70.4) | 9.8 |
| `GET /api/range`, a month | 76.5 (81.5) | 51 (61) | 30.6 / 18.1 |
| `GET /api/trips` | 65 (72) | 39 (48) | 10.5 / 8.2 |
| `PUT /api/settings`, 60 km (the recompute) | **89** (93) | 48 (53) | 48.5 / 36.6 |

These are Task 4's last column again, on a day of their own: its medians for ReadyToRun with the warm-up were refresh 72, edit 87, day 65, month 76 and trips 65 ms isolated, and
74, 47, 58, 46 and 34 in sequence. Its three-way comparison stands and is not repeated here: from the JIT to ReadyToRun to ReadyToRun with the warm-up the first refresh went 159 → 131 → 72 ms,
the first edit 232 → 172 → 87, the day 88 → 73 → 65, the month 91 → 79 → 76, the trips 77 → 69 → 65; and **in sequence the warm-up made each first request 3 to 4 ms slower** than
ReadyToRun alone (the day 54 → 58, the month 43 → 46, the trips 31 → 34); its report says that the warm-up's background work and the first requests compete for the processor in the first seconds. What it
is for is the two that come first after a start, the refresh and the edit, which it takes from 131 and 172 ms (ReadyToRun alone) to 72 and 87. The post-script state was put back: the distance stored none, 3 trips, 2 home periods.

### Ingest while processing runs

`tools/perf/ingest-latency.sh <url> <requests> <points> "" <pause>`, the API started over a copy of the raw history so that its backfill starts at 0 (a fresh start of an API
over a history with no timeline does it). `percent` is `/api/status`'s `backfill.percent`, polled around each run.

| Batch, pacing | What the backfill was doing | n | p50 | p95 | p99 | max | non-200 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 100 points, back to back | 0 to 2.3 % (3 s) | 200 | 5.4 | **10.4** | 32.4 | 66.5 | 0 |
| 500 points, back to back | 2.3 to 7.1 % (8 s) | 200 | 8.6 | **21.4** | 49.6 | 78.7 | 0 |
| 1,000 points, back to back | 7.1 to 16.6 % (11 s) | 200 | 14.0 | **30.6** | 38.8 | 74.4 | 0 |
| 1,000 points, one every 0.4 s (2,500 points a second) | the whole backfill, 0 to 100 % in 130 s | 280 | 14.9 | **34.2** | 65.6 | 85.2 | 0 |
| 100 points, one every 0.4 s | the whole backfill, 0 to 100 % in 126 s | 300 | 5.3 | **12.3** | 41.7 | 71.0 | 0 |

The points are stamped now, so their dirty ranges wait until the backfill is done (by design) and are then processed: 55 to 61 s after the backfill ended there were 0 pending
ranges, with 280,000 points of the long run among them and `failedRanges` empty. Ingest costs what the points cost (a p50 of 14 ms for 1,000 points, against Plan 1's 20 ms after its one-statement insert, and a p95 of 30.6 ms against its 40.9) and the backfill adds a few milliseconds
at the tail: nothing near 200 ms.

## Web

### Method

`npm run perf:record` once, with the API running over the finished backfill (it now records three days or three months either side of a day or a month, a year two: the new step
taps once more), then `npm run perf` with the API stopped, which builds the app, starts `perf/serve.mjs` and runs 94 tests: a warm-up that is discarded, the ten scenarios of Plans 2 to 4
(the day, the heaviest day, the month, the heaviest month, the year, edit mode, the trips and the three trips) and three new ones, 7 runs of each, in series, and the probe of the throttle:

- `open-first` and `open-installed`: the app opened on today (`/`), as above. Timed from the navigation start to the map's first `idle` after the panel's rows, which are the day's 15 rows,
  with the map's style loaded and the routes of the day drawn on it.
- the step of the views: tap › at rest, and tap › again at once (see "Decisions");
- `pan-year`: the Year with its routes, then the scripted pan and zoom.

The warm-up of the installed scenario runs once too and is discarded. A run asserts that it measured what it meant to: the panel has its rows, the recording had an answer for every request,
the page logged no error and asked for nothing outside, and the open scenarios say, from the page's own resource timing, which files the worker answered.

### Results

Network of the §8 profile, 4× CPU, 7 runs, ms from the start of the navigation; median / worst. (Each run writes its numbers, every run of every scenario, to `web/perf/results/web-timing.json`, which git ignores, and a screenshot of the first run of each scenario beside it.)

| | Typical day | Heaviest day | Typical month | Heaviest month | Year |
| --- | --- | --- | --- | --- | --- |
| API answer received | 532 / 560 | 552 / 595 | 544 / 595 | 562 / 576 | 742 / 771 |
| **Panel rows in the DOM** | **585 / 611** | **605 / 643** | **599 / 678** | **600 / 614** | **861 / 898** |
| Rows painted | 615 / 639 | 638 / 667 | 631 / 727 | 637 / 646 | 932 / 965 |
| Routes drawn | 1,147 / 1,258 | 1,255 / 1,324 | 1,349 / 1,549 | 1,306 / 1,665 | 1,735 / 1,971 |
| Map idle (*information*) | 1,580 / 1,753 | 1,449 / 1,600 | 1,652 / 1,769 | 1,650 / 1,784 | 1,799 / 2,087 |
| Tap ›, the next prefetched: **rows** | **24 / 29** | **21 / 27** | **31 / 35** | **34 / 45** | **72 / 87** |
| ... routes drawn | 80 / 98 | 79 / 103 | 91 / 115 | 111 / 138 | 310 / 347 |
| ... map idle (*information*) | 1,134 / 1,367 | 1,116 / 1,226 | 1,291 / 1,623 | 881 / 1,099 | 1,187 / 1,308 |
| Tap › again at once, nothing prefetched: **rows** | **103 / 136** | **137 / 168** | **140 / 165** | **135 / 157** | |
| ... rows painted | 242 / 351 | 243 / 381 | 535 / 673 | 181 / 319 | |
| ... map idle (*information*) | 1,128 / 1,350 | 1,089 / 1,201 | 1,252 / 1,607 | 844 / 1,067 | |

| The app opened on today | First visit | Installed |
| --- | --- | --- |
| First contentful paint | 480 / 508 | 408 / 480 |
| API answer received (the day) | 515 / 527 | 429 / 488 |
| Map style loaded | 928 / 952 | 730 / 825 |
| Panel rows in the DOM (15) | 564 / 589 | 599 / 671 |
| Routes of the day drawn | 1,172 / 1,199 | 1,026 / 1,194 |
| **Map idle after the rows: the map visible** | **1,542 / 1,685** | **1,358 / 1,612** |
| Main thread blocked before the rows | 240 / 265 | 311 / 363 |
| Files under `/assets/` not fetched from the network (of 6) | 0 | 6 |

The trips and the three trips, with the network: rows 562 / 604 (the list), 571 / 598, 561 / 579 and 562 / 624 (the trips of 25, 6 and 2 nights); map idle 1,447 / 1,472, 1,379 / 1,500, 1,396 / 1,482 and 1,506 / 1,636.

**What the network does.** The same scenarios with no network (`PERF_NETWORK=off`, the earlier plans' conditions, with the recording now served over HTTP instead of mocked) have the rows in the DOM at
410 / 456 ms for the typical day, 415 / 434 for the heaviest, 445 / 490 for the month, 408 / 417 for the heaviest month, 544 / 613 for the year, 371 / 393 for the trips and 382 / 401 for the trip of
25 nights. Plan 4's, on the same machine and the mocked answers, were 453 / 462, 387 / 448, 427 / 439, 437 / 500, 528 / 637, 371 / 402 and 389 / 406: **the same to within the spread of a run (−10 % to
+7 %, the trips' 0 %)**, which is the check that the new server did not change what is measured. The network adds 175 ms to the rows of a day (410 → 585: the round trips for the page's files and its first answers), 317 ms to those of the year (544 → 861: its answer is 150 kB, 60 ms of line, and the years
either side are prefetched at the same time and share it) and 205 ms to the answer for the points of edit mode (41 → 246).

**The installed app and the first visit.** The installed app is not faster to the rows here (599 against 564 ms; with no network, 541 against 493), and faster to the map (idle 1,358 against 1,542, the style loaded
at 730 against 928, the first contentful paint 72 ms sooner, the answer 86 ms sooner). The page is limited by the processor, not the network, at this profile: the main thread is blocked for 311 ms before the rows when the files are at hand and 240 when it is still waiting for them, which fits the code of the map
(1 MB unpacked, parsed and compiled at a quarter of the speed) being there earlier in the installed case and taking the processor before the rows are made (not examined further). What the worker is for is what a phone has and this machine
did not emulate: a slow network, a failing one, and no network at all (the e2e spec of the worker has those cases). A bad network is not a profile of this run, and none was measured.

**Edit mode, again.** With the points of the heaviest day (36,942, 1,506 kB, 321 kB on the wire) the tap on Edit points to the first frame that draws them is 1,067 / 1,150 ms with the network (the answer at
246 / 289, the map having the tiles at 1,042 / 1,130, the frame that draws them 25 ms later, the map idle in the same frame) and 1,033 / 1,250 with none, against Plan 4's 1,023 / 1,269 (its answer was 84 / 89 ms, mocked
over loopback). Plan 4 measured it before the point halo became a circle layer of its own, drawn under the dots (P4-R45), and said it would be timed again: the layer adds nothing to the time to the points drawn that this
scenario shows (the median is 1 % higher, the worst 1.5 % lower). The tiles of the points are made in the map's worker, which the throttle does not reach (Plan 4's caveat stands).

**Pan and zoom.** Seven runs of the scripted pan and zoom on the Year: 52 to 58 frames in 6 s (9 a second), median frame time 100 to 117 ms, **p95 133 to 183 ms (150 at the median of the runs)**, longest 150 to 217 ms,
**44 to 53 frames over 50 ms** (50 at the median). 6 or 7 vertical syncs for a frame is the software renderer drawing a 1170 × 2532 pixel map with the year's 14,900 vertices of routes on the processor. It is information, and not a
verdict: the iPhone's graphics chip draws a map of this size and this many lines at its refresh rate, and whether it stutters is what the owner's check asks.

**Bundle and the worker's cache.** `npm run build`, then `npm run perf:bundle`: main-thread JavaScript **398.6 kB gzip** (the page's own chunk 117.2, MapLibre's chunk 281.4), 51 kB under the 450 kB of P2-R63 and 0.8 kB above Plan 4's
397.8 (the worker's registration, the signed-out reload and the edit bar's follow-ups); MapLibre's worker, apart, 147.9 kB; every JavaScript file 546.5 kB; the CSS 15.6 kB; Brotli at quality 11 for the main-thread JavaScript 331.4 kB.
`node scripts/check-sw.mjs` (`npm run check:sw`): "ok. version 7a7e44c9aefb11f3, 11 files and index.html, 2074.2 kB raw, 490.8 kB Brotli (quality 11)": that is what the worker fetches at install, once per release.

## What this does not show (caveats)

Plans 2 to 4's caveats hold for everything on the web side: software WebGL; a run-to-run spread of ±10 % on a shared machine; one phone-sized viewport and the light scheme; server timings on loopback that exclude Traefik and Authentik.
And, new in this pass:

- **The map has no real style and no tiles.** The style is the e2e suite's own, a file of a few lines, so "the map visible" is the map with its style and routes and not its basemap: on the phone the real style and the vector tiles come
  from another server, over the VPN or not, and are asked for after the style. That is the largest part of the first-open number that only the phone can settle, and it is why the verdict on the first row stays with the owner.
- **The emulated network is a latency and a speed per request, and no more.** It does not make a TCP and a TLS connection (about two round trips, 0.12 s, on a cold connection, which the installed app pays for its navigation and for the API's
  first request, and the first visit for each), does not lose a packet, does not change over time, and serves over HTTP/1.1 from `serve.mjs` where Traefik gives HTTP/2. Adding the connection set-up to the worst installed run
  (1.61 s) gives 1.74 s.
- **The server's own time is not in the web numbers**, since the recorded answers are served at once: the day's p95 is 7 ms, the month's 11 and the year's 37, so the year in the table is 0.04 s longer on the phone. And its compression is
  done once and kept, where the API does it on every request (12 to 26 ms for each script at its Optimal level, Plan 2): that is on the first visit, once per release, and not in the installed app.
- **The service worker's own requests are not slowed by the emulation** (see "Decisions"): its install, which a first visit also does, after the load and in parallel, is not in the first visit's numbers, and it is once per release.
- **The installed case is a new page of the same browser, with its worker stopped,** and not a new process: iOS may take longer to start the app and the worker, and the real start of a home-screen app has the phone's own work in it. The HTTP cache
  is off in every run (Playwright's, while a page has a route), so a repeat visit with no worker, which would have the files of `/assets/` in the browser's cache, is not measured: the first visit is the worst case of it.
- **The throttle does not reach the map's worker** (probe: the page 4.3 times slower, the worker 0.96): the tiles of edit mode's 37,000 points, and of the year's routes, are made faster here than on the phone.
- **Seven runs** are a sample of the tail, not a bound; the narrowest margin (the first row, 1.2 times) is the one to read with that in mind.
- **The history has 874 nights and one device** and a real one will differ (Plans 3 and 4's caveats on trips, homes and the edits' recompute stand). The ingest runs have 1,000-point batches at 2,500 points a second, which is far above
  what Overland sends, to put the answer's time where it can be seen.
- **The warm-up and ReadyToRun were measured in their last form only** on the first requests; their three-way comparison is Task 4's.

## Repeat it

```sh
# --- The history: one raw copy, and a database from it for each run that changes it (as Plans 1-4; about 4 minutes) ---
docker run -d --name sporer-perf-db -e POSTGRES_PASSWORD=password -p 55432:5432 timescale/timescaledb:2.17.2-pg16
docker exec sporer-perf-db psql -U postgres -c "create database perf_raw"
# the API as the Dockerfile publishes it
dotnet publish src/Sporer.Api -c Release -r linux-x64 --self-contained false -p:PublishReadyToRun=true -o /tmp/sporer-api
api=/tmp/sporer-api/Sporer.Api.dll
export TSDB_CONNECTION_STRING="Host=localhost;Port=55432;Username=postgres;Password=password;Database=perf_raw"
export Nominatim__Enabled=false ASPNETCORE_URLS=http://127.0.0.1:5100
Processing__Enabled=false dotnet $api & pid=$!; sleep 8; kill $pid          # creates the schema
dotnet run --project tools/Sporer.SyntheticData -c Release -- --connection "$TSDB_CONNECTION_STRING" \
  --from 2024-06-01 --to 2026-10-22 --moving-interval 500ms --seed 42       # 10.7 million rows, about a minute
# a copy needs the template to have no other session: the TimescaleDB scheduler is one, so end it in the same run that copies
copy() { printf "select pg_terminate_backend(pid) from pg_stat_activity where datname = 'perf_raw' and pid <> pg_backend_pid();\ncreate database $1 template perf_raw strategy file_copy;\n" |
  docker exec -i sporer-perf-db psql -U postgres; }
copy perf

# --- The backfill, then the reads, the edits and the points (the API is left running by KEEP=1; stop it by its pid) ---
export TSDB_CONNECTION_STRING="${TSDB_CONNECTION_STRING/perf_raw/perf}"
KEEP=1 tools/perf/backfill-time.sh $api sporer-perf-db perf               # 128 s; its last lines: "nights 874, home periods 2, trips 3"
docker exec -i sporer-perf-db psql -U postgres -d perf -X < tools/perf/name-places.sql
tools/perf/api-latency.sh http://127.0.0.1:5100 2024-06-01 2026-10-22     # about 40 seconds; the place search is its last two lines
tools/perf/day-latency.sh http://127.0.0.1:5100 2024-06-01 2026-10-22
tools/perf/points-latency.sh http://127.0.0.1:5100 2024-06-01 2026-10-22  # about 30 seconds
tools/perf/edit-latency.sh http://127.0.0.1:5100 20 3                     # under 20 seconds
# the web run's recording is made now, before anything else writes to the history (the next script does):
(cd web && npm run perf:record -- http://127.0.0.1:5100 2024-06-01 2026-10-22 2025)   # web/perf/recorded/, not committed; 39 responses, half a minute
kill <the API's pid>

# --- The first requests after a start: the script starts the API itself (nothing may answer on the port), five starts of each kind ---
tools/perf/first-after-start.sh $api sporer-perf-db perf 5 isolated       # about 6 minutes
tools/perf/first-after-start.sh $api sporer-perf-db perf 5 sequence       # about 1 minute

# --- Ingest while the timeline is rebuilt: each run on a copy of the raw history, so that the API starts a backfill from nothing ---
copy perf_ing
export TSDB_CONNECTION_STRING="${TSDB_CONNECTION_STRING/perf/perf_ing}"
dotnet $api & pid=$!                                                      # then, while `curl .../api/status` says backfill.percent is under 100:
tools/perf/ingest-latency.sh http://127.0.0.1:5100 200 100                # and 200 500, 200 1000 straight after
tools/perf/ingest-latency.sh http://127.0.0.1:5100 280 1000 "" 0.4        # for a run over the whole backfill, start it as the API starts
# when pendingRanges is 0 again: kill $pid; drop database perf_ing; copy it again for the next run

# --- The web: the API stopped; the build, the server and 94 tests, about six minutes each ---
cd web
npm run perf                      # the §8 profile: 60 ms, 20 Mbit/s down, 5 up, 4x CPU, PERF_RUNS=7
PERF_NETWORK=off npm run perf     # none, the earlier plans' conditions (rows in the DOM against Plan 4's)
npm run perf -- --grep "open-|pan-year|warm-up"   # the opened app, installed and first, and the pan, alone
npm run perf:bundle               # after `npm run build`
npm run check:sw

docker rm -fv sporer-perf-db
```

`npm run perf` and its parts are described in Plan 2's, 3's and 4's "Repeat it"; what is new is that the API's answers come over HTTP from `web/perf/serve.mjs`, that the network is emulated (`PERF_NETWORK=off` for none), that the
recording holds three days and months either side, and that the run plays the opened app (first and installed) and the pan and zoom besides the views.
