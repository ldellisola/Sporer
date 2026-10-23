# Sporer Plan 1 — Server performance check (synthetic history, about 10 million rows)

Measured on 2026-10-23, against a generated history, with the server as built at the end of plan 1. The owner's real data
was not available, so these numbers say how the server behaves at the volume the spec assumes (spec §8, §9), not what the
real history will look like; the real check is the owner's, on their phone, after the first backfill.

## Result

| Target (spec §8) | Measured | Verdict |
| --- | --- | --- |
| Day view data, past day: p95 ≤ 200 ms (supports ≤ 1 s on the phone) | p50 5.0 ms, p95 7.0 ms (200 random dates, after 50 warm-up requests); p95 7.5-12.9 ms while a backfill runs | Met, 29 times under |
| Ingest `POST /api/overland` with a backfill running: p95 < 200 ms | After the one-statement insert (R31): 100-point batches p95 15 ms, 500 points 24 ms, 1000 points 41 ms. Before it: 107 ms, 407 ms, 707 ms | Met for every batch size; the per-point insert met it only up to about 100 points |
| Backfill completes, nothing fails | 10.7 million points in about 2 min 20 s (140-145 s, before and after the follow-up changes), `failedRanges` empty, no error logged, API memory flat at 220-265 MB | Met (the spec sets no time) |

The first pass of this check (day view, backfill, ingest with batches of up to 100 points) missed nothing, and the server was left
alone. Two things it found were then fixed on the controller's ruling, each re-measured below: ingest inserted a batch one
point at a time, which misses the target for the batches of 500 to 1000 points Overland can send (R31, "Ingest, one
statement per batch"), and `Segmenter` summed a merged stay's points again on every merge (R30, "Suspects"). Neither changed
what the server stores: the stored timeline and the stored points are the same.

## Machine and setup

- 4 vCPU Intel Xeon @ 2.10 GHz, 15 GB RAM, Linux 6.18 in a container with Docker.
- TimescaleDB `timescale/timescaledb:2.17.2-pg16` in Docker on the same machine, port 55432, with the image's own tuning
  (`shared_buffers` 4 GB, `work_mem` 10 MB).
- The API: .NET SDK 10.0.113, `dotnet build -c Release`, run as `dotnet Sporer.Api.dll` (Server GC, the Web SDK's default),
  over HTTP on 127.0.0.1, `Nominatim__Enabled=false`, every `Processing__` and `Detection__` setting at its default (backfill
  steps of 7 days, 0.2 s pause between steps, 60 s debounce). Client and server share the machine, so the network costs nothing
  and the four CPUs are shared.
- Latency is curl's `time_total`, which includes connecting to localhost.

## The data

`tools/Sporer.SyntheticData` writes a fictional person's history straight into `locationlog` with binary `COPY` (one
transaction). Everything about the person and the city is made up; the same options give the same rows (the checksum below
is the same with and without a database, and a unit test checks it).

```sh
dotnet run --project tools/Sporer.SyntheticData -c Release -- \
  --connection "Host=localhost;Port=55432;Username=postgres;Password=password;Database=perf" \
  --from 2024-06-01 --to 2026-10-22 --moving-interval 500ms --seed 42
```

| | |
| --- | --- |
| Rows written | 10,726,341 (checksum `0690878d1283b1fd`), in 56 s |
| `locationlog` | 126 chunks, 1.37 GB with its index |
| Rows with accuracy and motion | 1,091,780, the last 90 days only |
| Timeline it produces | 7,607 segments (3,797 stays, 2,060 walks, 849 cycle rides, 886 drives, 6 flights, 9 gaps) on 816 days, 87 places |

What the person does: weekday commutes (cycling or driving, sometimes after a morning run; some days at a hub nearby, on foot or
by bike; some at home), lunch at a cafe, the gym or a walk in the evening, a monthly evening out; on weekends a long hike or
ride, errands, family visits; three trips by air (two nights in the same time zone, six nights in Lisbon, 24 nights in
Tokyo), one house move, nine spells with the phone off (six on weekend outings, two on commutes, one in Tokyo), sparse
logging while still (a point on arrival, silence until they leave, an occasional stray one), GPS error that drifts, and an
occasional spike of 1.5 to 15 km.

**The interval is finer than a phone logs.** The brief says to tune `--moving-interval` until there are 10 million rows. This
person is on the move about 1.7 hours a day, so 1 s gives 5.4 million rows and 10 million needs 500 ms (a phone reports about
once a second at best). Stationary rows are only about 12,000 of the 10.7 million. What is realistic here is the number of
rows and the structure of the timeline (8.7 segments a day); the time resolution is not. Rows are what the backfill and the
database pay for, so the numbers hold; but the segment count, which the day view and the status page read, is that of a normal life
and not that of a person who is on the move 3 hours a day at 1 Hz.

## Step 2: backfill

Start the API against the filled database. It sees no algorithm version, starts a backfill from the oldest point to now and
works through it in 125 steps of 7 days. Poll `/api/status` until `backfill.percent` is 100.

| Run | Wall-clock from API start to 100 % | Notes |
| --- | --- | --- |
| 1, no other load | 144.6 s (5 s polling) | `failedRanges` empty, `pendingRanges` 0 |
| 2, with the ingest load of step 4 | 140.4 s (1 s polling) | 100-point batches posted all the while (260 of them, one every half second) |

Progress was linear (0.8 % a second), with no slowdown as the history accumulated. The API's resident memory stayed at 220-265 MB.

Where the time goes (20 steps from 2025-03-03 replayed outside the server, 1.77 million rows, nothing written; `load` is the
query and the mapping into points, `split` is stay, move and gap detection):

| Per step of 7 days (about 88,000 rows) | |
| --- | --- |
| Load points | 0.22 s |
| Clean | 0.07 s |
| Split into segments | 0.62 s |
| Simplify and classify moves | 0.03 s |
| Pause between steps (a setting) | 0.20 s |
| Total, times 125 steps | about 142 s, against 140-145 s measured: writing the segments costs nothing measurable |

Two thirds of the work is the stay search in `Segmenter` (a haversine distance from each point to every point within 100 m of
it; walking, logged at 2 Hz, is about 140 points each).

## Step 3: day API

`tools/perf/day-latency.sh http://127.0.0.1:5100 2024-06-01 2026-10-22` requests 50 random dates once each, then 200 others,
all through `GET /api/day/{date}`.

| Condition | p50 | p95 | p99 | max |
| --- | --- | --- | --- | --- |
| Backfill finished | 5.0 ms | 7.0 ms | 7.9 ms | 12.4 ms |
| Backfill at 29-35 % (three runs of 200) | 4.3-5.1 ms | 7.5-12.9 ms | 18-32 ms | 35-48 ms |

The heaviest day of the history (a hike, with its 5 m geometry) answers in 6 ms with 18.7 kB; the median day carries 5.1 kB of
geometry. `/api/status` answers in p50 7.5 ms, p95 9.4 ms.

## Step 4: ingest while a backfill runs

The backfill was restarted by changing `Detection__StayRadiusMeters` (each change alters the algorithm version, which deletes every
segment and starts over). The payloads are Overland batches of fresh points near a made-up spot
(`tools/perf/ingest-latency.sh <url> <requests> <points>`), 200 requests each unless said.

### First pass: one insert per point

| Points per batch | Backfill idle | Backfill running |
| --- | --- | --- |
| 1 | p50 5.9, p95 8.4 ms | p50 5.7, p95 10.7 ms (p99 28.7) |
| 20 | p50 22.1, p95 31.0 ms | p50 20.1, p95 34.1 ms (p99 60.4) |
| 100 | p50 77.2, p95 100.2 ms | p50 75.4, p95 106.4 ms; another run: p50 74.3, p95 124.1 ms (p99 150.0, max 152.9) |

A longer run, 260 batches of 100 points spread over a whole backfill: p50 74.9, p95 117.8, p99 152.5, max 199.5 ms, every
answer 200. The 1,056 ms maximum of the first 100-point run is the first requests after the API had restarted (JIT); it did
not move the p95.

The backfill costs ingest little (2 to 24 ms at p95). What ingest costs is the number of points, about 0.75 ms each, because
the insert ran once per point. At 100 points that left a margin of about 1.6, and Overland can send batches of 500 to 1000.

### R31: one statement per batch

`ConsumeEndpoint` now inserts a whole batch with one statement, in the same transaction as before (committed before the dirty
range is written, only an `INSERT` on `locationlog`):

```sql
insert into locationlog (time, longitude, latitude, device, speed, altitude, horizontal_accuracy, motion)
select p.time, p.longitude, p.latitude, p.device, p.speed, p.altitude, p.horizontal_accuracy,
       case when p.motion_length is null then null
            else @motion_values[p.motion_start + 1 : p.motion_start + p.motion_length] end
from unnest(@times, @longitudes, @latitudes, @devices, @speeds, @altitudes, @accuracies, @motion_starts, @motion_lengths)
     as p(time, longitude, latitude, device, speed, altitude, horizontal_accuracy, motion_start, motion_length)
```

Each field of the batch is a typed array parameter (`timestamptz[]`, `float8[]`, `text[]`), so the values are converted by the
database exactly as the per-point parameters were (altitude `float8` to `numeric` included). A point's motion array has a
different length from the next one's and `unnest` cannot take jagged arrays, so all the motion values go in one flat `text[]`
and each point says where its slice starts and how long it is; a point without motion has no length, which keeps `NULL`
(and an empty array stays empty, and a `null` among the values stays `null`). A negative speed is still stored as `NULL`.

A new test posts 1000 points in every shape (speed missing, negative, zero or set; altitude and accuracy missing or set; motion
missing, empty, one value, several, a `null` among them; two devices; arriving out of order) and checks every column of
every row. It passes unchanged against the old per-point code too, which is the evidence that the stored rows are the same;
the 11 existing ingest tests pass unchanged.

Before and after, with the backfill running (the same machine, the same data; before is the build from the first pass, and
the payloads now carry one point a second with no two sharing a time, so the 100-point row differs a little from the first pass):

| Points per batch | Before (a statement per point) | After (one statement) |
| --- | --- | --- |
| 100 | p50 69.5, p95 107.1, p99 150.6, max 193.8 ms (200 requests) | p50 7.6, p95 15.3, p99 38.6, max 110.8 ms (200 requests) |
| 500 | p50 329.7, p95 **407.3**, p99 475.3, max 516.8 ms (100 requests) | p50 12.1, p95 23.9, p99 43.5, max 75.9 ms (200 requests) |
| 1000 | p50 647.0, p95 **707.2**, p99 712.5, max 712.5 ms (50 requests) | p50 20.3, p95 40.9, p99 51.1, max 74.4 ms (200 requests) |

(The old code's 500- and 1000-point rows have fewer requests so as to fit in one backfill.) A longer run after the change:
280 batches of 1000 points, one every 0.45 s, spread over a whole backfill (about 2,000 points a second): p50 21.6, p95 49.9,
p99 65.2, max 134.4 ms, every answer 200; that backfill took 142.5 s, as before. Commands:

```sh
Detection__StayRadiusMeters=101 dotnet $api &            # a new backfill
tools/perf/ingest-latency.sh http://127.0.0.1:5100 200 100
tools/perf/ingest-latency.sh http://127.0.0.1:5100 200 500
tools/perf/ingest-latency.sh http://127.0.0.1:5100 200 1000
tools/perf/ingest-latency.sh http://127.0.0.1:5100 280 1000 "" 0.4   # one batch every 0.4 s, for a whole backfill
```

The points posted during a backfill are stamped now, so their dirty ranges wait until the backfill is done (by design) and are
then processed; at the end of each run `pendingRanges` drained to 0 with `failedRanges` empty.

## Suspects flagged by earlier reviews

| Suspect | Measured | Action |
| --- | --- | --- |
| `ix_segment_local_dates (local_start_date, local_end_date)` scans all history before the date | The plan for the most recent day: 13 buffers, 0.24 ms (7,607 rows). On a scratch table of 90,140 segments (12 times the history), for a date after all of them (the longest scan), the same query takes 1.3 ms, against 0.05 ms with an index led by `local_end_date` | None: 1 ms of 200 would be saved. No migration 0004 |
| `Segmenter` recomputes a merged stay's centre from all its points on each merge | The synthetic history has no stay with more than a few merges, so it did not show. A stress track did: one place, 1 Hz logging, a GPS blip 150 m away every 400 s. **Before:** 7 days (604,800 points, 1,512 merges) 2.8 s; 30 days (2.6 million points, 6,480 merges) 98 s. **After:** 0.12 s and 0.29 s, from the same harness on a quiet machine | **Fixed (R30).** The centre keeps running sums: the later stay's points are added to them one by one in the same order, so every centre is bit-identical to the one summed from scratch (checked in a throwaway harness: the old and the new `Segmenter` give exactly equal segments, times, points and centres, compared with `==` on the doubles, on the synthetic history at 5 s and at 10 s with another seed (1.08 and 0.54 million points, whole), on 20 jittery one-place tracks at five positions including the antimeridian and near a pole, and on the 7- and 30-day stress tracks; the existing `Segmenter` and `TimelineProcessor` tests pass unchanged, so the algorithm version is not bumped and nothing is rebuilt). A new test pins a merged stay's exact centre, and a coarse guard (600,000 points, 6,047 merges: 0.1 s, 3 s allowed; the old code took 28 s in the test's debug build) bounds the time |
| `SegmentStore.ReplaceAsync` inserts one row at a time | About 60 segments a step; the stages above add up to the measured backfill with nothing left for it | None |
| `PointStore` buffers two copies of the points | The API's resident memory peaked at 265 MB with 88,000-row steps | None |
| `segment.place_id` has no index | 87 places, 7,607 segments: `/api/status` p95 9.4 ms | None |

## What this does not show

- Real data. Dense logging while still, many short stays, places with thousands of visits or several devices could cost more
  than a synthetic life that is mostly a clean commute. The generator is deterministic, so a run can be compared with the
  real one.
- The phone, the VPN, TLS in Traefik and Authentik in front of the day view. Only the server was timed.
- The real server's hardware. This ran on a shared 4-core container; the owner's own first backfill, read from `/api/status`,
  is the real figure.
- Place naming (`Nominatim__Enabled=false`). It runs in the background at one request a second and does not touch the numbers above.

## Repeat it

```sh
docker run -d --name sporer-perf-db -e POSTGRES_PASSWORD=password -p 55432:5432 timescale/timescaledb:2.17.2-pg16
docker exec sporer-perf-db psql -U postgres -c "create database perf"
dotnet build src/Sporer.Api -c Release
api=src/Sporer.Api/bin/Release/net10.0/Sporer.Api.dll
export TSDB_CONNECTION_STRING="Host=localhost;Port=55432;Username=postgres;Password=password;Database=perf"
export Nominatim__Enabled=false ASPNETCORE_URLS=http://127.0.0.1:5100

# 1. The API creates the schema. Processing is off, so it does not record an empty history as backfilled.
Processing__Enabled=false dotnet $api & pid=$!; sleep 8; kill $pid

# 2. The history: about a minute, 10.7 million rows (--dry-run counts and checksums without a database).
dotnet run --project tools/Sporer.SyntheticData -c Release -- --connection "$TSDB_CONNECTION_STRING" \
  --from 2024-06-01 --to 2026-10-22 --moving-interval 500ms --seed 42

# 3. The backfill (about 2.5 minutes), then the day view.
dotnet $api & pid=$!
until [ "$(curl -s localhost:5100/api/status | jq -r .backfill.percent)" = 100 ]; do sleep 2; done
tools/perf/day-latency.sh http://127.0.0.1:5100 2024-06-01 2026-10-22

# 4. Ingest during a new backfill: change a threshold (this deletes the segments and starts again), then post.
kill $pid; Detection__StayRadiusMeters=101 dotnet $api & pid=$!
sleep 10; for points in 100 500 1000; do tools/perf/ingest-latency.sh http://127.0.0.1:5100 200 $points; done

kill $pid; docker rm -f sporer-perf-db
```

The generator writes the points directly, so nothing marks them as new: start the API with processing on only after they are
written, or it finds an empty history and never backfills. The same steps work with `--moving-interval 5s` (1.08 million rows,
a few seconds) for a small local database.
