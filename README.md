# Sporer

Sporer is a (very) simple alternative to Google Timelines. It receives GPS points from the
[Overland](https://overland.p3k.app/) iOS app, stores them in TimescaleDB, and turns them into a timeline of
**stays** (matched to named places), **moves** (walk, cycle, drive or flight) and **gaps**, each with its IANA time zone
and local date. The raw points are the source of truth and are never modified; the timeline is derived from them and can
be rebuilt at any time.

The server is a .NET 10 API. It exposes:

| Endpoint | What it does |
| --- | --- |
| `POST /api/overland` | Receives Overland batches. Answers `{"result":"ok"}` once the points are stored. |
| `GET /api/day/{yyyy-MM-dd}` | One local day of the timeline. `state` is `pending` while work that affects that day is still waiting. |
| `GET /api/status` | Processing health: algorithm version, backfill progress, pending and failed work, place naming progress, warnings. |

## Running it

Sporer needs a TimescaleDB (PostgreSQL) database. The image is published to `ghcr.io/ldellisola/sporer` and listens on
port 80.

```sh
docker run -d --name sporer -p 8080:80 \
  -e TSDB_CONNECTION_STRING="Host=db;Port=5432;Username=postgres;Password=<password>;Database=postgres" \
  -e OVERLAND_TOKEN="<a long random string>" \
  -e Nominatim__UserAgent="Sporer/1.0 (you@example.com)" \
  ghcr.io/ldellisola/sporer:latest
```

The database schema is created and upgraded by the app on start-up. If a migration fails the app does not start;
Overland keeps the points it could not send and retries, so nothing is lost while you fix it.

The image is based on `mcr.microsoft.com/dotnet/aspnet:10.0` (Ubuntu), which ships the time zone database
(`/usr/share/zoneinfo`) that Sporer needs to convert UTC to local time. If you change the base image, keep tzdata in it.

## Configuration

Everything is set through environment variables. A `:` in a configuration key is written `__` in an environment variable.

### Required and common

| Variable | Default | Meaning |
| --- | --- | --- |
| `TSDB_CONNECTION_STRING` | none | Npgsql connection string of the TimescaleDB database. Set it: without it the app falls back to `ConnectionStrings__TSDB`, and that falls back to a `localhost` connection string meant for development. |
| `OVERLAND_TOKEN` | empty | Shared secret that Overland must send, as `?token=<OVERLAND_TOKEN>` or as an `Authorization: Bearer` header. When empty the ingest endpoint is **open** and the app logs a warning (also shown in `/api/status`). Set it. |
| `Nominatim__UserAgent` | empty | Identifies your installation to OpenStreetMap's Nominatim, as its usage policy requires: the app name and a way to reach you, for example `Sporer/1.0 (you@example.com)`. **Places are only named when this is set**; without it Sporer makes no Nominatim requests and warns at start-up. |

### Place naming (`Nominatim__*`)

| Variable | Default | Meaning |
| --- | --- | --- |
| `Nominatim__Enabled` | `true` | Set `false` to never name places. |
| `Nominatim__BaseUrl` | `https://nominatim.openstreetmap.org` | The Nominatim server to ask. |
| `Nominatim__MinInterval` | `00:00:01.1` | The least time between two requests. The public service allows one request per second at most, so do not go below `00:00:01`. |

Results are cached in the database, so a place is looked up once.

### Background processing (`Processing__*`)

Durations are written `hh:mm:ss`. A duration outside its bounds (below) is moved to the nearest bound, so a typo cannot
stop the worker.

| Variable | Default | Meaning |
| --- | --- | --- |
| `Processing__Enabled` | `true` | Whether the background processing runs at all. |
| `Processing__PollInterval` | `00:00:05` | How long the worker sleeps when a pass found nothing to do. 100 ms to 10 minutes. |
| `Processing__Debounce` | `00:01:00` | New points are processed once the oldest batch of a group of nearby ones has waited this long, and the newer ones are processed with it. While Overland streams, today is rebuilt at most once per debounce. 0 to 1 hour. |
| `Processing__BackfillChunkDays` | `7` | How many days of history one backfill step processes. Also the longest stretch one rebuild loads: a longer range of new points is processed in pieces of this length, oldest first. |
| `Processing__BackfillPause` | `00:00:00.2` | The wait after each backfill step, so a backfill leaves the database free for ingest and reads. 0 to 10 minutes. |

### Detection thresholds (`Detection__*`)

The defaults are the ones the timeline is designed around; change them only if you want a different timeline. Durations
are written `hh:mm:ss`. **Changing any of them makes Sporer rebuild the whole timeline** from the raw points on the next
start (see "First start" below).

| Variable | Default | Meaning |
| --- | --- | --- |
| `Detection__MaxAccuracyMeters` | `100` | Points with a reported horizontal accuracy worse than this are dropped. |
| `Detection__GlitchSpeedKmh` | `300` | An out-and-back jump implying more than this speed is treated as a GPS glitch. |
| `Detection__StayRadiusMeters` | `100` | Points within this distance of a stay's first point belong to the stay. |
| `Detection__StayMinDuration` | `00:05:00` | Minimum time within the stay radius to count as a stay. |
| `Detection__StationaryGapMaxSpeedMps` | `1.0` | A silent gap whose implied speed is below this still counts as stationary. |
| `Detection__WalkingSpeedMps` | `1.4` | Speed assumed when working out when someone left after a silent stay. |
| `Detection__GapMinDuration` | `00:30:00` | A pause in logging at least this long, outside a stay, is a gap. |
| `Detection__FlightSpeedKmh` | `200` | A hop at least this fast may be part of a flight. |
| `Detection__FlightMinDistanceKm` | `100` | A run of fast hops must cover at least this distance to be a flight. |
| `Detection__WalkMaxKmh` | `7` | Median speed below this is walking. |
| `Detection__CycleMaxKmh` | `25` | Median speed below this (and at least the walking limit) is cycling; above it is driving. |
| `Detection__PlaceRadiusMeters` | `75` | A stay within this distance of a known place is matched to it. |
| `Detection__DetailToleranceMeters` | `5` | Line simplification tolerance of the detailed track. |
| `Detection__CoarseToleranceMeters` | `50` | Line simplification tolerance of the coarse track. |

## Overland

In Overland, set the receiver endpoint to

```
https://sporer.lud.ar/api/overland?token=<OVERLAND_TOKEN>
```

using the same value as the server's `OVERLAND_TOKEN`. Overland deletes a batch from the phone only when it gets
`{"result":"ok"}` back, which is what Sporer answers once the points are stored.

## Traefik and Authentik

Sporer sits behind a Traefik ingress that terminates TLS, and the service is reachable over the VPN only. When
Authentik forward-auth is added in front of it, **exempt `/api/overland` from forward-auth**: Overland cannot log in, and
that endpoint is protected by `OVERLAND_TOKEN` instead. Everything else (the read API and, later, the UI) belongs behind
forward-auth.

## First release

The first release of the timeline server changes the database, so take a schema-only dump before it starts against your
data:

```sh
pg_dump --schema-only --host <host> --username <user> --dbname <database> --file sporer-schema-before-release.sql
```

It is small. A full data backup is optional: existing `locationLog` rows are never modified or deleted by Sporer, and the
only change to that table is two added nullable columns (`horizontal_accuracy` and `motion`) for the new points Overland
sends. Every other change creates new tables.

## First start

On its first start Sporer **backfills the whole history**: it processes every stored point, oldest first, a few days at a
time, and pauses briefly between steps so ingest and reads stay responsive. For years of history this takes a while.
Until it completes, any day the backfill has not reached yet is shown as `"state": "pending"`, and so is live data:
the backfill works towards the present, and points that arrive in the meantime wait for it. Places are named in the
background, at about one Nominatim request per second, so their names appear gradually.

Follow the progress at `https://sporer.lud.ar/api/status`: `backfill.percent` goes from 0 to 100, `pendingRanges` falls to
0, and `failedRanges`, `lastError` and `warnings` say if something needs your attention. A backfill step that fails three
times in a row is set aside as a failed range (retried later with a growing delay) and the backfill goes on after it,
so one bad stretch of history does not hold up the rest. The same backfill runs again whenever the detection thresholds
or the detection code change.

## Releases

Releases are Docker images on GHCR, built by GitHub Actions. To release, push a version tag:

```sh
git tag v1.2.3
git push origin v1.2.3
```

The workflow runs the test suite, then builds the image and publishes it as `ghcr.io/ldellisola/sporer` with the tags
`1.2.3`, `1.2`, `1` and `latest` (among others). The server pulls `:latest` daily. Pushes to `main` that touch `src/`, `tests/` or
`docker/dockerfile` build and publish a branch-tagged image; pull requests run the tests and a build without publishing.

## Local development

You need the [.NET 10 SDK](https://dotnet.microsoft.com/download) and Docker. The tests start a TimescaleDB container
with Testcontainers, so Docker must be running.

```sh
dotnet test src/Sporer.sln
```

To run the API, start a TimescaleDB that matches the development connection string in `appsettings.json`, then run it:

```sh
docker run -d --name sporer-db -p 5432:5432 -e POSTGRES_PASSWORD=password timescale/timescaledb:2.17.2-pg16
dotnet run --project src/Sporer.Api
```

The development profile listens on `http://localhost:5097`. Use synthetic coordinates for any test data; no real
location data belongs in the repository.

To build the image:

```sh
docker build -f docker/dockerfile -t sporer:dev .
```

The image builds `src/Sporer.Api` only. The solution also references the test projects, so it is not restored or built
in the image.

### Synthetic data and performance checks

`tools/Sporer.SyntheticData` writes a fictional person's history (commutes, trips by air, a house move, phone-off gaps,
GPS spikes) straight into a database's `locationlog`, deterministically for a `--seed`, so that you can develop against
years of data without real points. Start the API once to create the schema (with `Processing__Enabled=false`), write the
history, then start the API with processing on: it backfills the timeline from what is there.

```sh
dotnet run --project tools/Sporer.SyntheticData -c Release -- --connection "<Npgsql connection string>" \
  --from 2024-06-01 --to 2026-10-22 --moving-interval 5s --seed 42
```

`5s` gives about a million rows; `500ms` gives 10.7 million. `tools/perf/day-latency.sh` and `tools/perf/ingest-latency.sh`
time the day view and ingest. The measurements at 10 million rows, and how to repeat them, are in
`docs/superpowers/plans/2026-10-23-sporer-plan-1-perf.md`.
