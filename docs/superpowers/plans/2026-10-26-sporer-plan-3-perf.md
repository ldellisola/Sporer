# Sporer Plan 3: trips and home performance check (synthetic history, about 10 million rows)

Measured on 2026-10-27 against the same generated history as Plan 1's and Plan 2's checks (the same rows and checksum), with the server
and the web app as built at the end of Plan 3. The owner's real data was not available: these numbers say how the new work behaves at the
volume the spec assumes (spec §6.6, §8, §9), on a throttled desktop browser, not on the owner's phone. The real check is the owner's, on
the iPhone over the VPN, after the first backfill: the README's "Owner's checklist" asks for it. Plan 1's server check is in
`2026-10-23-sporer-plan-1-perf.md` and Plan 2's in `2026-10-24-sporer-plan-2-perf.md`, whose method this one follows; this one adds what
Plan 3 built (the nights, the homes and the trips: their share of the backfill, the live refresh, the two trips endpoints and their query
plans, and the web timings of the trips list and of a trip) and says what it did to what was there before.

**One pass, and one finding.** Every target was met, so nothing in the server or the web app was changed for performance. What the check
adds is the measuring: the scripts for the backfill, the refresh and the trips (`tools/perf/`), the trips in the web run's recording and
scenarios, and this document. Where nothing changed, this document says so and refers to Plan 2's. The check did find one thing that was
not a speed: the history's house move was not detected (see "The house move"). Task 13 fixed home detection, and "After the home fix"
gives the backfill, the refresh, the day and the trips endpoints measured again at that head, with every target still met. The tables
below are the measurements of Plan 3's head before the fix, which stay the record of the rest (the web, the plans), none of which the fix
touched.

## Result

The trips endpoints and the trips web scenarios are given with the places named (see "Decisions"), and with no place named, as in Plans 1
and 2, where it says so. The backfill, the refresh and the plans were measured before the places were named; none of them depends on it.

| What (spec §9, Plan 3 brief) | Target | Measured | Verdict |
| --- | --- | --- | --- |
| **Backfill**, the whole history, from the start of the API to 100 % with nothing pending | the night and trip work adds ≤ 20 % to `main`'s (Plan 2's head) on this machine | `main` 181.2 / 179.0 / 174.6 s (mean 178.3), Plan 3 189.8 / 180.8 s (mean 185.3): **+3.9 %** on the means; the two back-to-back pairs +4.7 % and +1.0 %. (Plan 2 measured 167 s: `main` takes about 7 % longer on this machine) | Met, 16 points under |
| **Refresh**, one live refresh of the nights, homes and trips after a dirty range, 30 in a running process | ≤ 200 ms | p50 **33.0 ms**, p95 **66.0 ms**, max 94 ms (30 more, in a process started 10 s before: p50 35.0, p95 78.0, max 217, which is the first refresh after the start) | Met, 2.6 to 3 times under at p95. **The first refresh after a start is 174 to 225 ms** (six starts, four over 200 ms by 3 to 12 %): the JIT, see "Refresh" |
| **`/api/trips`**, 50 requests | ≤ 200 ms server time | p50 **8.0 ms**, p95 **13.4 ms**, max 15.3 ms (right after the start: 8.5 / 17.8 / 21.0); no place named: p50 7.8-10.0, p95 10.7-16.4 over three runs. 557 B Brotli, 1,648 B raw | Met, 11 to 15 times under at p95 |
| **`/api/trips/{id}`**, 50 requests for each of the three trips, with sizes | ≤ 400 ms | 25 nights: p50 13.5, p95 **21.0** ms, 9,555 B Brotli, 33,076 B raw; 6 nights: 11.3 / **21.0** ms, 3,940 / 11,717 B; 2 nights: 9.9 / **15.0** ms, 2,996 / 7,940 B. The worst p95 over every run of both kinds, 27.7 ms | Met, 14 to 27 times under |
| **Plans** (`EXPLAIN (ANALYZE, BUFFERS)`) of the trips list and detail queries | no query scans a large table | every one of the 7 queries runs in **0.02 to 2.0 ms** (the 25-night trip's stays and moves, 199 segments, 1.97 ms, the slowest); the segments are read from `ix_segment_start`, the nights from their primary key, the `Seq Scan`s are on `trip`, `place`, `home_period`: three rows, 87 rows, one row | Met |
| **Web, cold navigation to the trips list's cards** (4× CPU, 7 runs) | ≤ 2 s (the month's) | median **826 ms**, worst 957 ms (no place named: 754 / 888) | Met, 2.1 times under at the worst |
| **Web, cold navigation to a trip's day rows**, the three synthetic trips | ≤ 2 s | 25 nights, 26 days: median **811 ms**, worst 885; 6 nights, 7 days: **742** / 842; 2 nights, 3 days: **756** / 832 (no place named: 854 / 1,026, 838 / 865, 760 / 939) | Met, 2.3 to 2.4 times under at the worst |
| *Information:* panel rows **painted**, trips list / three trips | read against the same | median 1,019 / 1,015 / 975 / 1,001 ms, worst 1,214 / 1,181 / 1,063 / 1,065 | Inside 2 s |
| *Information:* **map `idle`** from cold navigation, trips list / three trips | read against the same, with Plan 2's caveats | median 2,168 / 1,910 / 1,796 / 1,924 ms, worst 2,487 / 2,097 / 1,933 / 2,057 | The list's is over 2 s, by 8 % at the median, and unnamed it is 1,479 / 1,584 ms: **the names add 47 %** (the city dots and labels the list draws only when its places are named), see "Web". Not a verdict, as the idle is read with the caveats (software WebGL: the month's on this machine, 2,283 / 2,514 ms, is over 2 s too) |
| *Information, what Plan 3 did to what was there:* the **day** endpoint | Plan 2's: ≤ 200 ms | p50 8.6-11.5 ms, p95 12.9-19.7 ms over five runs, against `main`'s 5.9-7.2 and 10.4-12.2 on the same machine and history: **about 2.5 ms more**, the home lookup. Range, heat and place: the same | Met |
| *Information:* the **web app's start** | Plan 2's: main-thread JavaScript ≤ 450 kB gzip | 383.9 kB (Plan 2: 379.0): the page's own chunk 102.6 kB (97.6), MapLibre's chunk 281.4 kB (281.4) | Met, 66 kB under |
| *Information:* the cold **day, month and year** views, against `main` on this machine | Plan 2's: ≤ 1 s / 2 s / 3 s | the day, the heaviest day, the month and the heaviest month **−8 % to +14 %** of `main`'s rows in the DOM (the spread of runs of the same code is as large: `main`'s day 760-868 ms); the year **+12 % on average**: 1,171-1,277 ms against 1,064-1,211 | Met: every median is inside its target (day 0.80-0.91 s, month 0.85-0.92 s, year 1.17-1.28 s). The year is the one that is slower, by about 140 ms; see "Web" |

Everything in the table is a number from the runs below.

## Decisions

Decisions that shaped how it was measured, so that the numbers are read with them:

- **The backfill's baseline is measured here, back to back.** Plan 2's 167 s is on another day and perhaps another machine, so the
  target ("the night and trip work adds no more than 20 %") is judged against the code of `main` (`ba52d52`, Plan 2's head: a `git
  worktree` of it, built in Release) run on this machine, one raw history copied (as a template database, `create database ... template`)
  for each run, so that each backfill starts from the same rows and no timeline. Three runs of `main` and two of Plan 3, in the order
  `main`, Plan 3, `main`, Plan 3, `main`; runs of the same code differ by 4 % (`main`) and 5 % (Plan 3), less than the 10 % at which
  a pair would be run again.
- **The refresh is timed from the database's log, and the debounce is 0 for it.** "One live refresh after a dirty range" is: with the
  backfill complete, a small Overland batch through `POST /api/overland`, as the phone does, into a recent day, so that a range is dirty;
  the worker rebuilds it and refreshes. The refresh is what lies between two statements the worker already runs (it reads the window that
  waits, and empties it), so it is read from the database's log of statements with their timestamps and nothing in the app was changed
  to measure it (see "Refresh"). The one setting changed is `Processing__Debounce=00:00:00` (the default is a minute after a batch, which
  would make 30 rounds half an hour): the debounce decides when a range is processed, not what a refresh does.
- **The trips endpoints** are in `tools/perf/api-latency.sh` (the list 50 times, then each trip of the list 50 times, with the ids taken
  from the list) and their queries in `tools/perf/explain-trips.sql`, a sibling of `explain.sql` (which is not touched: the queries of
  the day, range, heat and place endpoints are the ones it holds).
- **The web scenarios** are the cold navigation to `/trips` and to `/trip/{id}` for each trip, with the same throttle, number of runs,
  recording and probe as the others (`record.mjs` records `/api/trips` and every `/api/trips/{id}`). "Visible" is read as "in the DOM",
  as Plan 2 reads the day's rows: the cards and the days are rendered, and on the phone the sheet starts at its peek, so they are below
  its edge until the owner pulls it up. They are timed on the cold navigation only (the day, month and year scenarios also tap ›).
- **The places are named in the run that is reported.** The generator makes places with coordinates and nothing else, and the API ran with
  `Nominatim__Enabled=false` (as in Plans 1 and 2), so every trip is "Trip", has no cities, and its days say "Travelling" with no
  highlights: smaller answers and less on the screen than the owner's will have. `tools/perf/name-places.sql` gives the 87 places a city,
  a country (Oslo, Tromsø, Lisbon, Tokyo, by where they are) and, to three in four, an OSM name, as Nominatim would have. The server and
  the web runs were made without the names first and again with them; the tables give the named run and, where it says so, the
  other. (The backfill, the refresh and the plans are of the first, which they do not depend on.) Nothing else was different. (The
  typical day and month are chosen by the size of their answers, which the names change, so they are other days and months in the two
  runs: 2025-12-05 and 2025-05 without the names, 2026-01-12 and 2024-10 with them.)
- **No fix for performance.** Nothing missed, so nothing was changed in the server or the app for it and no migration was added. (The
  house move that the history showed was not detected was a different matter, and was fixed in Task 13: see "The house move".)

## Machine and setup

The same kind of machine and the same tools as Plan 2's, and a few percent slower: `main` itself took 175 to 181 s here, against 167 s in
Plan 2 (about 7 % more).

- 4 vCPU Intel Xeon @ 2.80 GHz, 15 GB RAM, Linux 6.18 in a container with Docker. Client and server share the machine and its four CPUs
  (during the web runs the API was stopped and the database idle).
- Server: TimescaleDB `timescale/timescaledb:2.17.2-pg16` in Docker on port 55432 with the image's own tuning; the API as in Plan 1
  (.NET SDK 10.0.113, `dotnet build -c Release`, `dotnet Sporer.Api.dll`, `Nominatim__Enabled=false`, every other setting at its default
  but the debounce of the refresh runs), over HTTP on 127.0.0.1:5100. Latency is curl's `time_total` with `Accept-Encoding: br`.
- Web: Node 22.22.0, Playwright 1.56.1 with its Chromium 141.0.7390.37 (headless), software WebGL (SwiftShader), the e2e suite's `phone`
  project (390 × 844 CSS pixels at a device scale of 3, touch), the processor held back 4 times with `Emulation.setCPUThrottlingRate`,
  the production build served by `vite preview`: as in Plan 2.

## The data

The same generator, options and seed as Plan 1 and 2 (`tools/Sporer.SyntheticData`, `--from 2024-06-01 --to 2026-10-22 --moving-interval
500ms --seed 42`).

| | |
| --- | --- |
| Rows written | 10,726,341 (checksum `0690878d1283b1fd`, the same as Plan 1's), in 79 s here |
| `locationlog` | 126 chunks, 1,371 MB the database (the raw history, before the timeline) |
| Backfill | 189.8 s and 180.8 s from the start of the API to 100 % and the last refresh done, `failedRanges` empty, `pendingRanges` 0 (`main`: 174.6-181.2 s) |
| Timeline | 7,607 segments on 816 days, 87 places: the same as Plan 1's and Plan 2's |
| Nights, homes, trips | 874 nights, **1 home period**, **3 trips** (before Task 13; **2 home periods** after it, see "The house move") |

The three trips are the generator's: 2024-12-12 (2 nights, "north", Tromsø), 2025-05-16 (6 nights, Lisbon) and 2026-02-20 (25 nights,
Tokyo: 24 nights at the hotel, and a flight that lands the next day makes the night of the flight an away night too).

**The house move was not found, at first** (see "The house move"): the history holds a move (the generator's, on 2025-10-18, about
17 km) and, until Task 13, the detector found one home only.

What a real history will look like is not known; see the caveats.

## The house move

**What the check found.** The history holds a move (the generator's, on 2025-10-18, about 17 km), and the detector of Plan 3's head found
one home only: place 1, from the first night (2024-05-31) to now. The new house's nights are spread over four places (162, 81, 61 and 39
nights at places 53, 52, 61 and 58, 77 to 151 m apart pairwise: a stay is matched to a place within 75 m or makes its own, and the
generator's wander drifts as an iPhone's does), and no single place has 60 of any 90 nights (the best window has 50, place 53's), so
none became home. The old house does not split the same way: its first place has 425 of the 505 nights before the move. No false trip
came of it (the new house is within 50 km of the old home), but the house of the Day view was on the old place only, for the whole
history. The same split can happen to the owner's real home, and then it is worse than a house on the wrong place: with no home found
there is no trip at all, because a night with no home in effect is never away.

**What changed (Task 13).** Home detection counts a place's nights by place and by the places near it: the nights of every place within
`Detection__HomeRadiusMeters` (250 m, new) of a candidate count for the candidate. The best candidate has the most counted nights, then
the most nights of its own, then the lower id. A new period starts only if that count reaches 60 of 90, the candidate is not the
current home, and it is farther than the radius from it: a place near the home never starts a period, so the home does not flip between
the fragments of one house. A period is backdated as before, from the earliest counted night. The day view marks a stay as home when
its place is the home or within the same radius of it (two fragments in one day show two house pins; Plan 4's place merge tidies
that). The refresh reads the positions of the places of the nights once, for both the homes and the trips. The places near each other
are worked out once per refresh (a sweep by latitude over the places of the nights), not for each of the 874 dates. The stays, places
and nights are as they were, and the algorithm version is the same.

**What it gives on this history** (the same rows and checksum, backfilled at that head; the numbers of "After the home fix" are of the
same runs):

- **Two home periods**: place 1 from 2024-05-31 to 2025-10-17, and place 53 from 2025-10-18 (the move day, backdated from the night on
  which the four places together first had 60 of the last 90 nights, 2025-12-16), still open. Together the four places have up to 90
  of 90 nights in a window; place 53 alone, at most 50.
- **Three trips, the same first nights and nights** as before: 2024-12-12 (2 nights), 2025-05-16 (6) and 2026-02-20 (25). The two before
  the move are the same in every field. The 25-night trip leaves at 11:06 UTC on 2026-02-20 (it was 07:29) and returns at 14:35 UTC on
  2026-03-17 (it was 16:40): the stays near home that it leaves from and returns to are now those near the new house, which is the
  home it had. Its detail answer is smaller for that (30,166 B raw and 852 vertices, against 32,533 B and 953).
- **The day**: on 2025-10-22 the stays at places 53, 52 and 58 are all `home: true`; on the days before the move the old place is.

## After the home fix

The same machine, history (10,726,341 rows, checksum `0690878d1283b1fd`), scripts and settings as above, at the head of Task 13, and the
steps of "Repeat it" in their order (the server with no place named, then the refresh, then the places named). The backfill is one run
on a copy of the raw history, with the code before the fix (`7c5bccc`, a `git worktree` built in Release) timed just before on a copy of
its own. The web was not measured again: no web code changed, and the Day view draws a house on whatever stays the day says are home.

| What | Target | Measured | Verdict |
| --- | --- | --- | --- |
| **Backfill**, to 100 % with nothing pending | ≤ +20 % over `main`'s mean (178.3 s) | **175.2 s**: **−1.7 %** against `main`'s mean (the code before the fix, on a copy of the same history just before: 182.2 s; 189.8 and 180.8 s in the table above). 7,607 segments, 874 nights, **2 home periods**, 3 trips, `failedRanges` empty | Met, 21.7 points under |
| **Refresh**, 30 in a running process | ≤ 200 ms | p50 **33.0 ms**, p95 **42.0 ms**, p99 55.0, max 55 (the database's statements, p50 18.8 ms). 30 in a process started 10 s before: p50 32.0, p95 50.0, max 189 (the first refresh after the start; a start of five rounds had 204 ms for its first) | Met, 4.8 times under at p95. The first refresh after a start is 189 to 204 ms: the JIT again, see "Refresh" |
| **`/api/day`**, 200 dates | ≤ 200 ms | p50 **8.3 ms**, p95 12.7, max 24.7 (no place named); named: 9.2 / 14.7 / 27.4. Before the fix 8.6-9.5 / 12.9-16.6 and, named, 8.6-11.5 / 13.4-19.7 | Met; the radius check on each stay is not to be seen in the spread |
| **`/api/trips`**, 50 requests | ≤ 200 ms | p50 7.7 ms, p95 **13.7** ms, max 28.6 (no place named) | Met |
| **`/api/trips/{id}`**, 50 requests each | ≤ 400 ms | 25 nights: p50 11.6, p95 **18.7** ms; 6 nights: 10.0 / **15.7**; 2 nights: 8.9 / **13.7** | Met |
| *Information:* a **list of 98 trips** (the what-if) | read against the same | p50 18.0 and 18.6 ms, p95 24.3 and 28.6 ms, max 30.0 and 33.4 ms in two runs of 50, 5,534 B Brotli and 51,576 B raw; one added trip p50 10.5 ms, p95 15.6 ms (before: 18.4 and 19.6, 26.6 and 25.3, 5,595 B and 51,504 B) | The same |

The refresh script is as it was: it always sent its batches from the place of the night of the day it uses, as the person was there.
That place is now the new house (place 53, the home), and after each refresh the stored result is the same: 874 nights, 2 home
periods, 3 trips. The other endpoints' queries and
plans are those of the sections below: nothing in the fix touches a query but the day's (the home it reads now carries the place's
position, which `LoadHomesAsync` already read).

## Server

### Backfill

`tools/perf/backfill-time.sh <api-dll> [db-container] [database] [poll-seconds]` (new) starts the API itself over a database that has the
raw history and no timeline, polls `/api/status` every second, and prints the seconds from the start of the process until the backfill is
at 100 % with no range pending and the window of `night_refresh` empty (the refresh of the last step runs after the state that says 100 %
is saved). It does not care which commit the dll is of: that is how `main` was timed.

| Run | `main` (`ba52d52`) | Plan 3 (HEAD) |
| --- | --- | --- |
| 1 | 181.2 s | 189.8 s |
| 2 | 179.0 s | 180.8 s |
| 3 | 174.6 s | |
| **Mean** | **178.3 s** | **185.3 s** (+3.9 %) |

Each run was a new copy of the same raw history (7,607 segments every time, so the work is the same). The extra time is the refresh,
which the worker runs once at the end of each pass, and a pass rebuilds one chunk of 7 days: about 126 of them to the present, so 7 s
more is about 55 ms a pass: the refresh of the live path (below) with the nights of seven days to build instead of one. The nights, the
homes and the trips are recomputed from every night each time, and there are 874 of them at the end, so the cost of a pass grows as the
history does and stays at tens of milliseconds.

### Refresh

`tools/perf/refresh-latency.sh <base-url> <db-container> [database] [rounds] [token]` (new). It needs the API running over the finished
backfill with `Processing__Debounce=00:00:00`. Each round it sends one batch of five points, a second apart, in the evening of the
second last day of the history (2026-10-21), at the place the person was at then, so that the batch changes nothing that is detected.
It marks a range dirty; the worker rebuilds it, extends the window of `night_refresh`, and refreshes: it builds the nights of the
window, reads every night and the positions of every stay, works the homes and the trips out in memory, and writes the nights, the homes
and the trips in one transaction (`TripRefresher`). The script waits until nothing is dirty or pending before it sends the next.

*How it is timed.* The database logs every statement with a timestamp (`log_min_duration_statement = 0` and `log_line_prefix = '%m [%p] '`,
set with `ALTER SYSTEM` for the length of the run and reset at the end). The refresh is what lies between two statements the worker runs
anyway: its read of the window that waits (`select ... from night_refresh where id = 1`, the first thing it does) and its emptying
(`update night_refresh set from_utc = null ...`, the last). Everything of `RefreshAsync` is between them: the reads, the C#, the round
trips and the transaction; the time of the update is in it and the time of the read is not. The time of the statements the database ran
in between is added up as well, to say how much of it is the database's. A refresh was also read statement by statement once (below),
to see that the two ends are the right ones.

| | n | p50 | p95 | p99 | max | of it the database's statements, p50 |
| --- | --- | --- | --- | --- | --- | --- |
| A running process (after 5 rounds of its own) | 30 | **33.0 ms** | **66.0 ms** | 94.0 | 94.0 | 19.0 ms |
| A process started 10 s before | 30 | 35.0 ms | 78.0 ms | 217.0 | 217.0 | 19.4 ms |

In the order they ran, the second set: 217, 56, 54, 36, 51, 38, 53, 33, 43, 41, 42, 34, 32, 32, 78, 35, 29, ... ms. **The first refresh
after a start is the slow one**: 174 ms (a start of five rounds, no place named), 217, 225, 206, 216 and 188 ms in six starts (the
second refresh of each: 50 to 62 ms). It is the JIT compiling the refresh's code (and Dapper building its readers) the first time, as Plan 2
found for the first requests of a fresh process; it happens once per start, in the worker and not in a request, a minute or more after
the batch that started it, and ingest does not wait on it. It is over 200 ms by 3 to 12 % in four of the six (217, 225, 206 and 216),
which is why it is said here and is not in the percentiles (two more starts, at the head of Task 13, had 204 and 189 ms): nothing was
done about it (a warm-up at the start, or ReadyToRun compilation of the image, is a change to the product for a job that runs behind a
debounce of a minute).

One refresh, statement by statement (the database's log: 65 ms from the read of the window to the update that empties it, a window of two
nights, 17 statements): the read of every night 2.5 ms, the read of every stay's position 7.8 ms, each of the others 0.02 to 0.4 ms, 12 ms
of execution in all (19 ms with the parse and bind messages, which is what the table adds up). The rest is the app: the nights built,
`HomeDetector` and `TripDetector` over the 874 nights, and the round trips.

### The trips endpoints

`tools/perf/api-latency.sh` now also asks for `/api/trips` and for each trip of it by its id (the ids and the nights are the list's),
`trips` requests each (50 by default, its tenth argument), after the same 20 warm-up requests, with `Accept-Encoding: br`; a second pass
asks for the same paths raw and counts the vertices of the moves. Times in ms, sizes in bytes as curl counts the body; the API warm; in
brackets the same requests right after the API was started.

**Places named** (the table of the Result section):

| Endpoint | n | p50 | p95 | p99 | max | Brotli body | Raw body | Vertices of the moves |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `/api/trips` (3 trips) | 50 | 8.0 (8.5) | 13.4 (17.8) | 15.3 (21.0) | 15.3 (21.0) | 557 | 1,648 | |
| `/api/trips/2026-02-20` (25 nights, 26 days, 100 moves) | 50 | 13.5 (16.3) | 21.0 (24.7) | 30.5 (34.1) | 30.5 (34.1) | 9,555 | 33,076 | 953 |
| `/api/trips/2025-05-16` (6 nights, 7 days) | 50 | 11.3 (12.1) | 21.0 (19.7) | 27.9 (24.8) | 27.9 (24.8) | 3,940 | 11,717 | 375 |
| `/api/trips/2024-12-12` (2 nights, 3 days) | 50 | 9.9 (11.8) | 15.0 (18.4) | 28.7 (21.2) | 28.7 (21.2) | 2,996 | 7,940 | 280 |

**No place named** (as Plans 1 and 2 ran), three runs, the first right after the start of the API:

| Endpoint | p50 | p95 | max | Brotli body | Raw body |
| --- | --- | --- | --- | --- | --- |
| `/api/trips` | 7.9, 7.8, 10.0 | 11.3, 10.7, 16.4 | 15.4, 15.1, 32.3 | 410 | 1,353 |
| `/api/trips/2026-02-20` | 12.0, 11.6, 18.3 | 21.4, 17.0, 27.7 | 25.5, 32.5, 34.6 | 9,345 | 32,533 |
| `/api/trips/2025-05-16` | 10.3, 9.5, 11.1 | 18.8, 14.2, 15.5 | 28.4, 18.3, 21.5 | 3,823 | 11,447 |
| `/api/trips/2024-12-12` | 10.6, 9.5, 9.6 | 15.9, 14.8, 12.3 | 16.9, 23.9, 13.3 | 2,894 | 7,769 |

A trip answer is mostly its moves (100 moves for the 25-night trip, 953 vertices after the budget: nowhere near the 50,000 of
`VertexBudget`, which fits every move of the trip together) and the days. The names add 2 to 3 % to a trip's answer (the highlights of its
days) and 22 % to the list's raw size (its cities), and nothing that can be seen in the times. The list is three queries and the detail
three (four for an ongoing trip), whatever the number of trips or days (see the plans); the first requests of a process cost more, as
in Plan 2 (the list's p95 right after the start 17.8 ms, 13.4 later).

**Plan 3's effect on the other endpoints**, on the same machine and history (`main` served from a copy that its own backfill made; p50 /
p95 in ms; the ranges are the runs):

| Endpoint | `main` (2 runs) | Plan 3 (3 runs, no place named; 2 more named) |
| --- | --- | --- |
| `/api/day/{date}` | 5.9-7.2 / 10.4-12.2 | 8.6-9.5 / 12.9-16.6 (named 8.6-11.5 / 13.4-19.7) |
| `/api/range`, 31 days | 21.0-24.7 / 29.6-38.8 | 18.6-22.3 / 25.9-32.9 |
| `/api/range`, 365 days | 64.0-67.4 / 77.1-92.0 | 62.6-73.5 / 73.1-96.2 |
| `/api/heat`, 31 days and 365 days | 5.4-5.8 / 9.7-13.2 and 15.2-16.2 / 21.8-23.3 | 4.5-5.1 / 8.2-11.8 and 12.1-13.8 / 16.5-20.5 |
| `/api/places/{id}` | 15.4-16.4 / 22.8-26.1 | 12.5-14.1 / 19.4-23.4 |

Only the day moved: **about 2.5 ms at the median**. A day now looks up the home of its date (`TripStore.FindHomeOnAsync`: the home periods,
one row, with the survivors of their places: 0.3 ms in the database and a round trip) so that the stays at home can be marked. The
sizes of the day's and the range's answers are the same but for the `home` field of the day's stays (the day's Brotli median 2,141 B
against 2,127 B, the raw 7,768 B against 7,729 B).

### Query plans

`tools/perf/explain-trips.sql` (new) holds the queries of the trips endpoints, copied from `TripStore` with the parameters as psql
variables, under `EXPLAIN (ANALYZE, BUFFERS)`, and works the span of a trip out as `FindAsync` does (the one variable is `trip`):

```sh
docker exec -i sporer-perf-db psql -U postgres -d perf -X -v trip=2026-02-20 < tools/perf/explain-trips.sql
```

Run after the backfill (no place named), for the trip of 25 nights, the longest; the full plans are in the appendix.

| Query | Plan | Execution | Buffers |
| --- | --- | --- | --- |
| List: the trips | Seq Scan on `trip` (3 rows), sort | 0.15 ms | 4 |
| List: the nights of every trip | the trips joined to `night_pkey` (11 nights each), the survivors of the 6 places through a recursive chain over `place` (87 rows, 1 page) | 0.63 ms | 15 |
| List and day: the home periods | Seq Scan on `home_period` (1 row), the chain over `place` | 0.29 ms | 13 |
| Detail: the trip | Seq Scan on `trip` (3 rows) | 0.02 ms | 1 |
| Detail: the latest segment, for an ongoing trip | Index Scan Backward on `ix_segment_start`, limit 1 | 0.08 ms | 3 |
| Detail: its nights and those around it | Index Scan on `night_pkey` (27 nights), the chain over `place` | 0.42 ms | 15 |
| Detail: its stays and moves | Index Scan on `ix_segment_start` from the last segment that starts at or before the span (an Index Only Scan Backward, 1 row) to its end: 199 segments of 7,607, the chain over `place` | 1.97 ms | 44 |

(The 6-night trip's detail: 0.96 ms for the stays and moves, 0.31 ms for the nights; the 2-night trip's, 0.35 ms for the nights; the lists
and the trip's own row the same.) **No query scans a large table**: the `Seq Scan`s are on `trip`, `place` and `home_period`, the `night`
table is read through its primary key and `segment` through `ix_segment_start`, and the stays and moves of a trip are read from the one
that starts at or before it (the query's lower bound, "the latest segment that starts at or before the span start", so that a trip that
began after years of history does not read them; here it reads 199 rows, not 7,607).
Every query is far inside its endpoint's target, so **no index and no migration was added**. The planner chooses a `Seq Scan` of `trip`
because it has three rows; it would use its primary key when it has hundreds.

### A long list of trips (what-if)

The history has three trips and a real one has more. `tools/perf/scale-trips.sql` (new) adds 95 to a copy of it, a trip of 4 nights every
8 days from 2024-07-01 on nights the history has, 98 in all, and an API with the worker off (it would work the trips out again from the
nights and put the three back) answers over the copy. `/api/trips`: p50 18.4 and 19.6 ms, p95 26.6 and 25.3 ms, max 32.0 and 28.7 ms in two
runs of 50, 5,595 B Brotli and 51,504 B raw (the three: 557 and 1,648 B); one of the added trips, p50 11.0 ms and p95 16.4 ms. The list
costs about 0.12 ms and 0.5 kB a trip; extrapolated in a straight line, 1,000 trips (a trip a week for 19 years) would be about 130 ms and
0.5 MB raw. That is far inside the list's 200 ms, but it is the one number here that grows with the history, and it is not paged. (The
nights of the added trips are at home, one city and one dot each: a trip of several cities costs a little more.)

## Web

### Method

The same as Plan 2's (`npm run perf:record`, then `npm run perf`), with the trips added.

1. **Record** (`web/scripts/perf/record.mjs`, extended): it also records `/api/trips` (what `/trips` asks for, and what the bar of a trip
   asks for to name the trips either side of it) and every trip of it, `/api/trips/{id}` (there are few, and the app prefetches the
   neighbours of the trip on show, so all are needed whichever is opened), and adds the scenarios `trips` and `trip-{id}`: 9 scenarios in
   all, 26 responses recorded (30 with the names: they are other days).
2. **Play back** (`web/perf/web-timing.spec.ts`, extended): each run is a test of its own with a new browser context, the CPU held back 4
   times, the API mocked from the recording (a request it has no answer for fails the run), one warm-up run thrown away, then 7 runs of
   each scenario, now 9 of them: the 65 tests take about 6 minutes (Plan 2's 37 took 4). For `/trips` and `/trip/{id}` the run waits for
   the panel's rows (the cards of the list, the days of the trip), the map's `idle` after them and 400 ms, and is over: no tap › follows
   (the step of the day, month and year scenarios). The measures are the same, "API answer received" being the scenario's own request (for
   a trip, `/api/trips/{id}`, not the list that the bar asks for too).

### Results

4× CPU throttling, 7 runs of each, ms from the start of the navigation; median / worst, the places named. The rows are the panel's
(3 cards; 26, 7 and 3 days), in the DOM and painted two frames later.

| | Trips list (3 cards) | Trip of 25 nights (26 days) | Trip of 6 nights (7 days) | Trip of 2 nights (3 days) |
| --- | --- | --- | --- | --- |
| API answer received | 695 / 837 | 656 / 743 | 646 / 701 | 639 / 687 |
| first contentful paint | 720 / 856 | 680 / 788 | 660 / 724 | 660 / 720 |
| **panel rows in the DOM** | **826 / 957** (721-957) | **811 / 885** (716-885) | **742 / 842** (710-842) | **756 / 832** (621-832) |
| panel rows painted | 1,019 / 1,214 | 1,015 / 1,181 | 975 / 1,063 | 1,001 / 1,065 |
| map style loaded | 1,339 / 1,592 | 1,387 / 1,507 | 1,286 / 1,387 | 1,332 / 1,384 |
| routes drawn on the map | 1,533 / 1,836 | 1,732 / 1,914 | 1,716 / 1,817 | 1,734 / 1,870 |
| **map idle** | **2,168 / 2,487** | **1,910 / 2,097** | **1,796 / 1,933** | **1,924 / 2,057** |
| main thread blocked before the rows | 554 / 678 | 564 / 636 | 510 / 602 | 501 / 600 |
| *target* (rows) | ≤ 2,000 | ≤ 2,000 | ≤ 2,000 | ≤ 2,000 |

With no place named (the first run of the web suite, a recording of its own):

| | Trips list | 25 nights | 6 nights | 2 nights |
| --- | --- | --- | --- | --- |
| **panel rows in the DOM** | 754 / 888 | 854 / 1,026 | 838 / 865 | 760 / 939 |
| panel rows painted | 946 / 1,053 | 1,010 / 1,353 | 912 / 1,127 | 902 / 1,095 |
| map idle | 1,479 / 1,584 | 1,867 / 2,410 | 1,836 / 1,870 | 1,737 / 2,073 |

How to read it:

- **The rows are in the DOM at 0.74 to 0.83 s at the median and 0.83 to 0.96 s at the worst**, 2.1 to 2.4 times under the target. The API
  answer is there at 0.64 to 0.70 s and the rows follow it by 100 to 160 ms: the cards and the days are few and light. The trips list is
  not slower than a month (its rows were 0.92 s on this machine, 41 rows), and a trip of 26 days is not slower than the list of 3.
- **The rows are painted at about 1.0 s**, 0.2 to 0.25 s after they are in the DOM: the same wait as Plan 2's, MapLibre's parse arriving in the
  same stretch as the rows on a mocked API over loopback (see "Where the time goes" there).
- **The map's `idle` is 1.8 to 2.2 s**, the trips list the slowest (2,168 ms at the median, 2,487 at the worst: over 2 s, as the month's is
  on this machine: 2,283 / 2,514). It is the camera move (600 ms by design) and the frames drawn in software on top of the start; read
  it with Plan 2's caveats, not as a verdict. The routes of a trip are on the map 1.7 to 1.9 s after the start.
- **The names make the trips list's map slower, and nothing else here.** Without names the list's map idles at 1,479 / 1,584 ms against
  2,168 / 2,487 with them: **+47 %** at the median (+57 % at the worst), about five times the spread of the runs. It is not the
  software WebGL, which is the same in both runs: it is what the names add to the drawing. With no place named the trips have no cities,
  so the list's map draws no dot and no label; named, it draws a dot for each city slept in and names the five with the most nights
  ("Lisbon · 9 nights"), and the labels are what the map has to lay out (its glyphs and their placing) before it idles. (The trips'
  maps draw their routes either way, and their idle is the same with and without names, within the spread.) Everything else is within
  the run-to-run spread, about ±10 % (the list's rows in the DOM +10 % and painted +8 %; the three trips' rows and idle −11 % to +11 %):
  the answers are smaller by a few hundred bytes and the days have no second line.

**Plan 3's effect on the views that were there** (the control): the day, month and year scenarios were run on this machine with `main`'s
web app too (a `git worktree` of `ba52d52`, the same Chromium, the same recorded answers: the `home` of a day's stays that `main` does
not read is in them), once for all five and then, alternating, for the day and the year only. Rows in the DOM, median / worst of 7, ms:

| | Typical day | Heaviest day | Typical month | Heaviest month | Year |
| --- | --- | --- | --- | --- | --- |
| `main` | 797 / 859 | 804 / 952 | 879 / 985 | 924 / 1,104 | 1,064 / 1,444 |
| Plan 3, the same recording and hour | 876 / 1,072 | 913 / 1,057 | 914 / 1,119 | 858 / 949 | 1,277 / 1,355 |
| Plan 3, the same recording, with the places named (the table above's) | 819 / 992 | 861 / 905 | 923 / 978 | 852 / 1,024 | 1,265 / 1,493 |

| Alternating runs, the day 2026-01-12 and the year 2025 (the named recording) | Day, `main` | Day, Plan 3 | Year, `main` | Year, Plan 3 |
| --- | --- | --- | --- | --- |
| first pair | 868 / 1,003 | 804 / 1,423 | 1,211 / 1,551 | 1,171 / 1,620 |
| second pair | 760 / 826 | 797 / 876 | 1,076 / 1,215 | 1,255 / 1,553 |

The day, the heaviest day, the month and the heaviest month are the same as `main`'s within the spread of the machine (one day of `main`'s
is 760 ms in one run and 868 in the next). **The year is slower, by about 140 ms on average** (12 %: +213, +201 and +179 ms in three
comparisons and −40 ms in the fourth; 1,171-1,277 ms against 1,064-1,211). Why was not looked into: it is 2.3 times inside its 3 s, and
Plan 2's own year ran from 1.0 to 1.3 s. The worst of seven for the day is over 1 s in some runs of both (`main` 1,003; Plan 3 1,072 and
1,423, the latter one slow run of seven whose median is 804), as the heaviest day's worst of seven was in Plan 2.

**Bundle** (`npm run build`, `npm run perf:bundle`): the main-thread JavaScript is **383.9 kB** gzip (Plan 2: 379.0 kB), 66 kB under the
450 kB of P2-R63: the page starts with 102.6 kB (97.6) and the map fetches MapLibre's chunk, 281.4 kB (the same), when it mounts;
MapLibre's worker, apart, 147.9 kB (the same); every JavaScript file 531.8 kB (526.9), over 450 kB as Plan 2 stated plainly. What Plan 3
added (the trips list, a trip, the house and the rest) is 5.0 kB gzip of the page's own chunk.

## What this does not show (caveats)

Plan 2's caveats hold for everything on the web side: software WebGL, so the map's `idle` is a record and not a verdict; no real map
style, tiles or network; a mocked API on loopback that puts MapLibre's parse in the same stretch as the rows; a 4× throttle that is not
an iPhone and a worker the throttle hardly reaches (probe in this run: the page's thread 5.1 times slower, the worker 1.5 times); one
phone-sized viewport and the light scheme; run-to-run spread of ±10 % on this shared machine; server timings on loopback that exclude the
VPN, Traefik and Authentik. Also:

- **The history has three trips and two homes.** A real history has more of both: dozens of trips in a few years, and the owner's own
  move or two. The list's cost is a few queries and a loop over the trips; the detail's is its span and does not depend on how many
  trips there are. What is measured is the endpoint at three trips and a trip of up to 25 nights (see the what-if for a long list);
  a trip of months, or a year of long drives, would carry more moves, and `VertexBudget` is what caps their lines.
- **The tables above were measured before the home fix** (see "The house move"), on a history with one home: the backfill, the refresh
  and the endpoints were measured again with two homes ("After the home fix"), the web and the plans were not. The recorded day answers
  of the web runs mark the stays at the old house only; the Day view draws a house for each stay an answer marks, as it did.
- **The places are named by a script**, not by Nominatim: a real trip's cities, highlights and day lines are what Nominatim says of the
  places, in English, and may be longer or fewer than "Place 12".
- **The refresh was timed with a debounce of 0** and with batches that add five points inside a stay: the rebuilt window is the day's,
  the window of nights two, and the homes and the trips were the same after every one. A range that rebuilds a week (a backfill step,
  a retry of a set-aside range) builds seven nights and costs about 55 ms a pass (the backfill's share, above); a client that sends a
  year of points at once refreshes once at the end of its pieces, and builds the nights of the year.
- **The first refresh after a start is 0.17 to 0.23 s**, above the target for that one request (see "Refresh").
- **Seven runs of the web scenarios** are a sample of the tail, not a bound; the worst of seven for the trips' rows is 957 ms at the most
  with the places named, and 1,026 ms with none (the 25-night trip).
- The Plan 2 documents' numbers are not repeated here: this machine is a few percent slower than theirs, and where Plan 3 could have
  changed a Plan 2 figure it is compared with `main` on this machine (above) and not with Plan 2's.

## Repeat it

```sh
# --- The history: one raw copy, and a database from it for each timing of a backfill (as Plan 1 and 2; about 4 minutes) ---
docker run -d --name sporer-perf-db -e POSTGRES_PASSWORD=password -p 55432:5432 timescale/timescaledb:2.17.2-pg16
docker exec sporer-perf-db psql -U postgres -c "create database perf_raw"
dotnet build src/Sporer.Api -c Release
api=src/Sporer.Api/bin/Release/net10.0/Sporer.Api.dll
export TSDB_CONNECTION_STRING="Host=localhost;Port=55432;Username=postgres;Password=password;Database=perf_raw"
export Nominatim__Enabled=false ASPNETCORE_URLS=http://127.0.0.1:5100
Processing__Enabled=false dotnet $api & pid=$!; sleep 8; kill $pid          # creates the schema
dotnet run --project tools/Sporer.SyntheticData -c Release -- --connection "$TSDB_CONNECTION_STRING" \
  --from 2024-06-01 --to 2026-10-22 --moving-interval 500ms --seed 42       # 10.7 million rows, about 80 s
# a copy needs the template to have no other session: the TimescaleDB scheduler is one, so retry (or terminate it) until it is made
docker exec sporer-perf-db psql -U postgres -c "create database perf template perf_raw strategy file_copy"

# --- The backfill, Plan 3 against `main` (Plan 2's head), each on a database of its own made from perf_raw ---
git worktree add ../sporer-main ba52d52 && dotnet build ../sporer-main/src/Sporer.Api -c Release
docker exec sporer-perf-db psql -U postgres -c "create database perf_main template perf_raw strategy file_copy"
TSDB_CONNECTION_STRING="${TSDB_CONNECTION_STRING/perf_raw/perf_main}" \
  tools/perf/backfill-time.sh ../sporer-main/src/Sporer.Api/bin/Release/net10.0/Sporer.Api.dll sporer-perf-db perf_main   # about 3 minutes
export TSDB_CONNECTION_STRING="${TSDB_CONNECTION_STRING/perf_raw/perf}"
KEEP=1 tools/perf/backfill-time.sh $api sporer-perf-db perf                   # leaves the API running (stop it with pkill -f Sporer.Api.dll); drop and make the database again to repeat
# Its last lines give "nights 874, home periods 2, trips 3" on this history
# (the code before Task 13 found one home period: the move was lost).

# --- The server, no place named: latencies and sizes (the trips are the last of its output), and the plans ---
tools/perf/api-latency.sh http://127.0.0.1:5100 2024-06-01 2026-10-22         # about 2 minutes; the 10th argument is the trips' requests
docker exec -i sporer-perf-db psql -U postgres -d perf -X -v trip=2026-02-20 < tools/perf/explain-trips.sql

# --- The refresh, no place named: the API with no debounce, then the script (about 3 minutes for 30 rounds) ---
pkill -f Sporer.Api.dll; sleep 2; Processing__Debounce=00:00:00 dotnet $api & sleep 8
tools/perf/refresh-latency.sh http://127.0.0.1:5100 sporer-perf-db perf 30    # the first of a fresh start is the slow one: start the API again to see it

# --- Then the places named, and the server again ---
docker exec -i sporer-perf-db psql -U postgres -d perf -X < tools/perf/name-places.sql    # what the owner's places will look like
tools/perf/api-latency.sh http://127.0.0.1:5100 2024-06-01 2026-10-22

# --- The long list of trips, on a copy. A template database must have no other session ("source database is being accessed by
#     other users"): stop the API first, and end the TimescaleDB scheduler's session in the same session that copies (it comes back
#     at once, so the two statements go in one psql run; run it again if it still loses the race). The API over the copy has the
#     worker off, so that it does not work the trips out again ---
pkill -f Sporer.Api.dll; sleep 2
printf "select pg_terminate_backend(pid) from pg_stat_activity where datname = 'perf' and pid <> pg_backend_pid();\ncreate database perf_scale template perf strategy file_copy;\n" |
  docker exec -i sporer-perf-db psql -U postgres
docker exec -i sporer-perf-db psql -U postgres -d perf_scale -X < tools/perf/scale-trips.sql
TSDB_CONNECTION_STRING="${TSDB_CONNECTION_STRING%perf}perf_scale" Processing__Enabled=false dotnet $api & sleep 8
for path in /api/trips /api/trips /api/trips/2024-07-01; do     # the list twice, then the first of the added trips: 20 to warm up, 50 measured
  for i in $(seq 70); do curl -s -o /dev/null -H 'Accept-Encoding: br' -w '%{time_total}\n' http://127.0.0.1:5100$path; done |
    tail -n 50 | sort -g | awk -f tools/perf/percentiles.awk
done
curl -s -o /dev/null -H 'Accept-Encoding: br' -w '%{size_download} B Brotli\n' http://127.0.0.1:5100/api/trips
curl -s -o /dev/null -H 'Accept-Encoding: identity' -w '%{size_download} B raw\n' http://127.0.0.1:5100/api/trips
pkill -f Sporer.Api.dll; sleep 2
dotnet $api & sleep 8                                             # over `perf` again, for the web's recording

# --- The web: record once (the API running over the history), then measure (the API may be stopped) ---
cd web
npm run perf:record -- http://127.0.0.1:5100 2024-06-01 2026-10-22 2025       # web/perf/recorded/, not committed; 26 responses
npm run perf                      # builds, serves the build, 65 tests, about 6 minutes; PERF_RUNS=7 PERF_CPU=4 by default
npm run perf:bundle               # after `npm run build`

pkill -f Sporer.Api.dll; docker rm -f sporer-perf-db; git worktree remove ../sporer-main
```

`npm run perf` and the rest are described in Plan 2's "Repeat it"; what is new is that the recording holds the trips and that it plays
back the nine scenarios (`PERF_RUNS` and `PERF_CPU` change the runs and the throttle as before).

## Appendix: the query plans

Run with `tools/perf/explain-trips.sql` as above, for the trip of 25 nights (2026-02-20), on the history of this document with no place
named, with literal parameters (the custom plans a statement gets on its first executions). `Buffers` lines are all `shared hit`: the
database was warm and in memory.

<details><summary>Trips list: the trips (TripStore.ListAsync)</summary>

```
                                              QUERY PLAN                                              
------------------------------------------------------------------------------------------------------
 Sort  (cost=1.11..1.12 rows=3 width=176) (actual time=0.105..0.106 rows=3 loops=1)
   Sort Key: id DESC
   Sort Method: quicksort  Memory: 25kB
   Buffers: shared hit=4
   ->  Seq Scan on trip  (cost=0.00..1.09 rows=3 width=176) (actual time=0.060..0.065 rows=3 loops=1)
         Buffers: shared hit=1
 Planning:
   Buffers: shared hit=16
 Planning Time: 0.213 ms
 Execution Time: 0.145 ms
```

</details>

<details><summary>Trips list: the nights of every trip (TripStore.ListAsync)</summary>

```
                                                             QUERY PLAN                                                              
-------------------------------------------------------------------------------------------------------------------------------------
 Sort  (cost=213.27..214.00 rows=291 width=152) (actual time=0.388..0.394 rows=33 loops=1)
   Sort Key: named.trip_id, named.date
   Sort Method: quicksort  Memory: 27kB
   Buffers: shared hit=15
   CTE named
     ->  Nested Loop  (cost=0.28..21.74 rows=291 width=32) (actual time=0.058..0.141 rows=33 loops=1)
           Buffers: shared hit=12
           ->  Seq Scan on trip t  (cost=0.00..1.03 rows=3 width=8) (actual time=0.005..0.005 rows=3 loops=1)
                 Buffers: shared hit=1
           ->  Index Scan using night_pkey on night n  (cost=0.28..5.93 rows=97 width=28) (actual time=0.035..0.042 rows=11 loops=3)
                 Index Cond: ((date >= t.id) AND (date <= t.last_night))
                 Filter: ((latitude IS NOT NULL) AND (longitude IS NOT NULL))
                 Buffers: shared hit=11
   CTE chain
     ->  Recursive Union  (cost=9.46..153.80 rows=684 width=28) (actual time=0.135..0.190 rows=6 loops=1)
           Buffers: shared hit=10
           ->  Hash Semi Join  (cost=9.46..12.82 rows=44 width=28) (actual time=0.135..0.142 rows=6 loops=1)
                 Hash Cond: (p_1.id = named_1.place_id)
                 Buffers: shared hit=9
                 ->  Seq Scan on place p_1  (cost=0.00..1.87 rows=87 width=16) (actual time=0.008..0.012 rows=87 loops=1)
                       Buffers: shared hit=1
                 ->  Hash  (cost=5.82..5.82 rows=291 width=8) (actual time=0.104..0.105 rows=32 loops=1)
                       Buckets: 1024  Batches: 1  Memory Usage: 10kB
                       Buffers: shared hit=8
                       ->  CTE Scan on named named_1  (cost=0.00..5.82 rows=291 width=8) (actual time=0.001..0.093 rows=33 loops=1)
                             Buffers: shared hit=8
           ->  Hash Join  (cost=2.96..13.41 rows=64 width=28) (actual time=0.044..0.046 rows=0 loops=1)
                 Hash Cond: (chain_1.merged_into_id = next.id)
                 Buffers: shared hit=1
                 ->  WorkTable Scan on chain chain_1  (cost=0.00..9.90 rows=147 width=20) (actual time=0.001..0.002 rows=6 loops=1)
                       Filter: (depth < 32)
                 ->  Hash  (cost=1.87..1.87 rows=87 width=16) (actual time=0.025..0.027 rows=87 loops=1)
                       Buckets: 1024  Batches: 1  Memory Usage: 12kB
                       Buffers: shared hit=1
                       ->  Seq Scan on place next  (cost=0.00..1.87 rows=87 width=16) (actual time=0.002..0.009 rows=87 loops=1)
                             Buffers: shared hit=1
   ->  Hash Left Join  (cost=15.96..25.82 rows=291 width=152) (actual time=0.320..0.358 rows=33 loops=1)
         Hash Cond: (named.place_id = chain.origin)
         Buffers: shared hit=15
         ->  CTE Scan on named  (cost=0.00..5.82 rows=291 width=32) (actual time=0.061..0.064 rows=33 loops=1)
               Buffers: shared hit=4
         ->  Hash  (cost=15.92..15.92 rows=3 width=72) (actual time=0.231..0.231 rows=6 loops=1)
               Buckets: 1024  Batches: 1  Memory Usage: 9kB
               Buffers: shared hit=11
               ->  Hash Right Join  (cost=13.72..15.92 rows=3 width=72) (actual time=0.216..0.225 rows=6 loops=1)
                     Hash Cond: (p.id = chain.id)
                     Buffers: shared hit=11
                     ->  Seq Scan on place p  (cost=0.00..1.87 rows=87 width=72) (actual time=0.001..0.005 rows=87 loops=1)
                           Buffers: shared hit=1
                     ->  Hash  (cost=13.68..13.68 rows=3 width=16) (actual time=0.196..0.196 rows=6 loops=1)
                           Buckets: 1024  Batches: 1  Memory Usage: 9kB
                           Buffers: shared hit=10
                           ->  CTE Scan on chain  (cost=0.00..13.68 rows=3 width=16) (actual time=0.137..0.190 rows=6 loops=1)
                                 Filter: (merged_into_id IS NULL)
                                 Buffers: shared hit=10
 Planning:
   Buffers: shared hit=160
 Planning Time: 1.602 ms
 Execution Time: 0.629 ms
```

</details>

<details><summary>Trips list and day view: the home periods (TripStore.LoadHomesAsync)</summary>

```
                                                               QUERY PLAN                                                               
----------------------------------------------------------------------------------------------------------------------------------------
 Sort  (cost=32.29..32.29 rows=1 width=101) (actual time=0.177..0.181 rows=1 loops=1)
   Sort Key: ((h.source = 'user'::text)) DESC, h.from_date DESC, h.id DESC
   Sort Method: quicksort  Memory: 25kB
   Buffers: shared hit=13
   CTE chain
     ->  Recursive Union  (cost=1.02..28.40 rows=31 width=28) (actual time=0.042..0.066 rows=1 loops=1)
           Buffers: shared hit=3
           ->  Hash Semi Join  (cost=1.02..3.13 rows=1 width=28) (actual time=0.041..0.053 rows=1 loops=1)
                 Hash Cond: (p_1.id = home_period.place_id)
                 Buffers: shared hit=2
                 ->  Seq Scan on place p_1  (cost=0.00..1.87 rows=87 width=16) (actual time=0.005..0.009 rows=87 loops=1)
                       Buffers: shared hit=1
                 ->  Hash  (cost=1.01..1.01 rows=1 width=8) (actual time=0.025..0.028 rows=1 loops=1)
                       Buckets: 1024  Batches: 1  Memory Usage: 9kB
                       Buffers: shared hit=1
                       ->  Seq Scan on home_period  (cost=0.00..1.01 rows=1 width=8) (actual time=0.018..0.018 rows=1 loops=1)
                             Buffers: shared hit=1
           ->  Hash Join  (cost=0.26..2.50 rows=3 width=28) (actual time=0.011..0.011 rows=0 loops=1)
                 Hash Cond: (next.id = chain_1.merged_into_id)
                 Buffers: shared hit=1
                 ->  Seq Scan on place next  (cost=0.00..1.87 rows=87 width=16) (actual time=0.001..0.001 rows=1 loops=1)
                       Buffers: shared hit=1
                 ->  Hash  (cost=0.22..0.22 rows=3 width=20) (actual time=0.002..0.002 rows=0 loops=1)
                       Buckets: 1024  Batches: 1  Memory Usage: 8kB
                       ->  WorkTable Scan on chain chain_1  (cost=0.00..0.22 rows=3 width=20) (actual time=0.002..0.002 rows=1 loops=1)
                             Filter: (depth < 32)
   ->  Nested Loop  (cost=0.63..3.87 rows=1 width=101) (actual time=0.101..0.111 rows=1 loops=1)
         Join Filter: (h.place_id = chain.origin)
         Buffers: shared hit=5
         ->  Hash Join  (cost=0.63..2.84 rows=1 width=32) (actual time=0.088..0.097 rows=1 loops=1)
               Hash Cond: (p.id = chain.id)
               Buffers: shared hit=4
               ->  Seq Scan on place p  (cost=0.00..1.87 rows=87 width=24) (actual time=0.005..0.009 rows=87 loops=1)
                     Buffers: shared hit=1
               ->  Hash  (cost=0.62..0.62 rows=1 width=16) (actual time=0.071..0.071 rows=1 loops=1)
                     Buckets: 1024  Batches: 1  Memory Usage: 9kB
                     Buffers: shared hit=3
                     ->  CTE Scan on chain  (cost=0.00..0.62 rows=1 width=16) (actual time=0.046..0.067 rows=1 loops=1)
                           Filter: (merged_into_id IS NULL)
                           Buffers: shared hit=3
         ->  Seq Scan on home_period h  (cost=0.00..1.01 rows=1 width=33) (actual time=0.001..0.001 rows=1 loops=1)
               Buffers: shared hit=1
 Planning:
   Buffers: shared hit=74
 Planning Time: 0.868 ms
 Execution Time: 0.292 ms
```

</details>

<details><summary>Trip: the trip (TripStore.FindAsync)</summary>

```
                                           QUERY PLAN                                           
------------------------------------------------------------------------------------------------
 Seq Scan on trip  (cost=0.00..1.06 rows=1 width=172) (actual time=0.013..0.013 rows=1 loops=1)
   Filter: (id = '2026-02-20'::date)
   Rows Removed by Filter: 2
   Buffers: shared hit=1
 Planning:
   Buffers: shared hit=2
 Planning Time: 0.094 ms
 Execution Time: 0.022 ms
```

</details>

<details><summary>Trip: the latest segment, for an ongoing trip (TripStore.FindAsync)</summary>

```
                                                                  QUERY PLAN                                                                   
-----------------------------------------------------------------------------------------------------------------------------------------------
 Limit  (cost=0.28..0.38 rows=1 width=16) (actual time=0.062..0.063 rows=1 loops=1)
   Buffers: shared hit=3
   ->  Index Scan Backward using ix_segment_start on segment  (cost=0.28..752.04 rows=7607 width=16) (actual time=0.061..0.061 rows=1 loops=1)
         Buffers: shared hit=3
 Planning:
   Buffers: shared hit=2
 Planning Time: 0.095 ms
 Execution Time: 0.076 ms
```

</details>

<details><summary>Trip: its nights and the ones around them (TripStore.FindAsync)</summary>

```
                                                                     QUERY PLAN                                                                     
----------------------------------------------------------------------------------------------------------------------------------------------------
 Nested Loop Left Join  (cost=86.35..95.77 rows=27 width=124) (actual time=0.208..0.253 rows=27 loops=1)
   Join Filter: (chain.origin = n.place_id)
   Rows Removed by Join Filter: 109
   Buffers: shared hit=15
   CTE chain
     ->  Recursive Union  (cost=6.90..79.93 rows=306 width=28) (actual time=0.050..0.146 rows=5 loops=1)
           Buffers: shared hit=8
           ->  Hash Join  (cost=6.90..9.18 rows=16 width=28) (actual time=0.050..0.056 rows=5 loops=1)
                 Hash Cond: (p_1.id = night.place_id)
                 Buffers: shared hit=7
                 ->  Seq Scan on place p_1  (cost=0.00..1.87 rows=87 width=16) (actual time=0.004..0.008 rows=87 loops=1)
                       Buffers: shared hit=1
                 ->  Hash  (cost=6.74..6.74 rows=13 width=8) (actual time=0.031..0.032 rows=5 loops=1)
                       Buckets: 1024  Batches: 1  Memory Usage: 9kB
                       Buffers: shared hit=6
                       ->  HashAggregate  (cost=6.61..6.74 rows=13 width=8) (actual time=0.024..0.026 rows=5 loops=1)
                             Group Key: night.place_id
                             Batches: 1  Memory Usage: 24kB
                             Buffers: shared hit=6
                             ->  Index Scan using night_pkey on night  (cost=0.28..6.54 rows=27 width=8) (actual time=0.010..0.017 rows=26 loops=1)
                                   Index Cond: ((date >= '2026-02-19'::date) AND (date <= '2026-03-17'::date))
                                   Filter: (place_id IS NOT NULL)
                                   Rows Removed by Filter: 1
                                   Buffers: shared hit=6
           ->  Hash Join  (cost=2.96..6.77 rows=29 width=28) (actual time=0.089..0.089 rows=0 loops=1)
                 Hash Cond: (chain_1.merged_into_id = next.id)
                 Buffers: shared hit=1
                 ->  WorkTable Scan on chain chain_1  (cost=0.00..3.60 rows=53 width=20) (actual time=0.001..0.002 rows=5 loops=1)
                       Filter: (depth < 32)
                 ->  Hash  (cost=1.87..1.87 rows=87 width=16) (actual time=0.075..0.075 rows=87 loops=1)
                       Buckets: 1024  Batches: 1  Memory Usage: 12kB
                       Buffers: shared hit=1
                       ->  Seq Scan on place next  (cost=0.00..1.87 rows=87 width=16) (actual time=0.002..0.018 rows=87 loops=1)
                             Buffers: shared hit=1
   ->  Index Scan using night_pkey on night n  (cost=0.28..6.54 rows=27 width=28) (actual time=0.018..0.022 rows=27 loops=1)
         Index Cond: ((date >= '2026-02-19'::date) AND (date <= '2026-03-17'::date))
         Buffers: shared hit=6
   ->  Materialize  (cost=6.15..8.36 rows=2 width=80) (actual time=0.007..0.007 rows=5 loops=27)
         Buffers: shared hit=9
         ->  Hash Right Join  (cost=6.15..8.35 rows=2 width=80) (actual time=0.177..0.184 rows=5 loops=1)
               Hash Cond: (p.id = chain.id)
               Buffers: shared hit=9
               ->  Seq Scan on place p  (cost=0.00..1.87 rows=87 width=72) (actual time=0.004..0.009 rows=87 loops=1)
                     Buffers: shared hit=1
               ->  Hash  (cost=6.12..6.12 rows=2 width=16) (actual time=0.152..0.152 rows=5 loops=1)
                     Buckets: 1024  Batches: 1  Memory Usage: 9kB
                     Buffers: shared hit=8
                     ->  CTE Scan on chain  (cost=0.00..6.12 rows=2 width=16) (actual time=0.051..0.147 rows=5 loops=1)
                           Filter: (merged_into_id IS NULL)
                           Buffers: shared hit=8
 Planning:
   Buffers: shared hit=7
 Planning Time: 0.691 ms
 Execution Time: 0.419 ms
```

</details>

<details><summary>Trip: its stays and moves (TripStore.FindAsync)</summary>

```
                                                                                       QUERY PLAN                                                                                        
-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
 Sort  (cost=74.79..74.82 rows=10 width=296) (actual time=1.607..1.619 rows=199 loops=1)
   Sort Key: s.start_utc, s.id
   Sort Method: quicksort  Memory: 67kB
   Buffers: shared hit=44
   CTE spanned
     ->  Index Scan using ix_segment_start on segment segment_1  (cost=0.63..8.21 rows=10 width=89) (actual time=0.201..0.858 rows=199 loops=1)
           Index Cond: ((start_utc < '2026-03-17 16:40:53.475+00'::timestamp with time zone) AND (start_utc >= COALESCE($1, '2026-02-20 07:29:51.453929+00'::timestamp with time zone)))
           Filter: ((kind = ANY ('{stay,move}'::text[])) AND (end_utc > '2026-02-20 07:29:51.453929+00'::timestamp with time zone))
           Rows Removed by Filter: 1
           Buffers: shared hit=38
           InitPlan 2 (returns $1)
             ->  Result  (cost=0.34..0.35 rows=1 width=8) (actual time=0.133..0.134 rows=1 loops=1)
                   Buffers: shared hit=4
                   InitPlan 1 (returns $0)
                     ->  Limit  (cost=0.28..0.34 rows=1 width=8) (actual time=0.131..0.132 rows=1 loops=1)
                           Buffers: shared hit=4
                           ->  Index Only Scan Backward using ix_segment_start on segment  (cost=0.28..293.53 rows=5519 width=8) (actual time=0.130..0.130 rows=1 loops=1)
                                 Index Cond: ((start_utc IS NOT NULL) AND (start_utc <= '2026-02-20 07:29:51.453929+00'::timestamp with time zone))
                                 Heap Fetches: 1
                                 Buffers: shared hit=4
   CTE chain
     ->  Recursive Union  (cost=0.33..57.75 rows=300 width=28) (actual time=0.068..0.095 rows=17 loops=1)
           Buffers: shared hit=2
           ->  Hash Semi Join  (cost=0.33..2.53 rows=10 width=28) (actual time=0.067..0.076 rows=17 loops=1)
                 Hash Cond: (p_1.id = spanned.place_id)
                 Buffers: shared hit=1
                 ->  Seq Scan on place p_1  (cost=0.00..1.87 rows=87 width=16) (actual time=0.007..0.011 rows=87 loops=1)
                       Buffers: shared hit=1
                 ->  Hash  (cost=0.20..0.20 rows=10 width=8) (actual time=0.043..0.044 rows=99 loops=1)
                       Buckets: 1024  Batches: 1  Memory Usage: 12kB
                       ->  CTE Scan on spanned  (cost=0.00..0.20 rows=10 width=8) (actual time=0.002..0.025 rows=99 loops=1)
                             Filter: (place_id IS NOT NULL)
                             Rows Removed by Filter: 100
           ->  Hash Join  (cost=2.66..5.22 rows=29 width=28) (actual time=0.015..0.016 rows=0 loops=1)
                 Hash Cond: (next.id = chain_1.merged_into_id)
                 Buffers: shared hit=1
                 ->  Seq Scan on place next  (cost=0.00..1.87 rows=87 width=16) (actual time=0.001..0.001 rows=1 loops=1)
                       Buffers: shared hit=1
                 ->  Hash  (cost=2.25..2.25 rows=33 width=20) (actual time=0.005..0.006 rows=0 loops=1)
                       Buckets: 1024  Batches: 1  Memory Usage: 8kB
                       ->  WorkTable Scan on chain chain_1  (cost=0.00..2.25 rows=33 width=20) (actual time=0.003..0.005 rows=17 loops=1)
                             Filter: (depth < 32)
   ->  Hash Right Join  (cost=6.35..8.67 rows=10 width=296) (actual time=1.233..1.453 rows=199 loops=1)
         Hash Cond: (chain.origin = s.place_id)
         Buffers: shared hit=41
         ->  Hash Right Join  (cost=6.03..8.23 rows=2 width=144) (actual time=0.135..0.147 rows=17 loops=1)
               Hash Cond: (p.id = chain.id)
               Buffers: shared hit=3
               ->  Seq Scan on place p  (cost=0.00..1.87 rows=87 width=136) (actual time=0.001..0.006 rows=87 loops=1)
                     Buffers: shared hit=1
               ->  Hash  (cost=6.00..6.00 rows=2 width=16) (actual time=0.112..0.112 rows=17 loops=1)
                     Buckets: 1024  Batches: 1  Memory Usage: 9kB
                     Buffers: shared hit=2
                     ->  CTE Scan on chain  (cost=0.00..6.00 rows=2 width=16) (actual time=0.071..0.102 rows=17 loops=1)
                           Filter: (merged_into_id IS NULL)
                           Buffers: shared hit=2
         ->  Hash  (cost=0.20..0.20 rows=10 width=144) (actual time=1.071..1.071 rows=199 loops=1)
               Buckets: 1024  Batches: 1  Memory Usage: 50kB
               Buffers: shared hit=38
               ->  CTE Scan on spanned s  (cost=0.00..0.20 rows=10 width=144) (actual time=0.209..0.955 rows=199 loops=1)
                     Buffers: shared hit=38
 Planning:
   Buffers: shared hit=161
 Planning Time: 4.270 ms
 Execution Time: 1.972 ms
```

</details>

