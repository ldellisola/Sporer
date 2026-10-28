# Sporer

Sporer is a (very) simple alternative to Google Timelines. It receives GPS points from the
[Overland](https://overland.p3k.app/) iOS app, stores them in TimescaleDB, and turns them into a timeline of
**stays** (matched to named places), **moves** (walk, cycle, drive or flight) and **gaps**, each with its IANA time zone
and local date. The raw points are the source of truth and are never modified; the timeline is derived from them and can
be rebuilt at any time.

The server is a .NET 10 API, and it also serves the web app that shows the timeline (see "The web app" below). It exposes:

| Endpoint | What it does |
| --- | --- |
| `POST /api/overland` | Receives Overland batches. Answers `{"result":"ok"}` once the points are stored. |
| `GET /api/day/{yyyy-MM-dd}` | One local day of the timeline. A stay at the home in effect on that day, or at a place within `Detection__HomeRadiusMeters` of it (see "Trips and home"), has `"home": true`. `state` is `pending` while work that affects that day is still waiting. |
| `GET /api/range?from=yyyy-MM-dd&to=yyyy-MM-dd` | A stretch of local days (at most 400, both ends counted) in one answer: every move with its line (simplified further if there would be more than 50 000 vertices), the places with the time spent there inside the range, and a list of the days. `state` is `pending` while work that affects the range is still waiting. |
| `GET /api/heat?from=yyyy-MM-dd&to=yyyy-MM-dd` | Where the time of a range (the same dates, the same limit as `/api/range`) was spent, for a heat layer: `cells` are `[lon, lat, seconds]`, the most seconds first, one per cell of a grid of 0.001 degrees (about 111 m of latitude; a degree of longitude is shorter the further you are from the equator, so a cell is narrower than it is tall), weighted by the time of the stays in it, not by points; `maxSeconds` is the first one's weight (0 when there are none). |
| `GET /api/places/{id}` | A place and the time spent at it: name, address, centre, total seconds, number of visits, first and last visit, and the latest 50 stays (`start`, `end`, local `date`, `timeZone`), newest first. A place merged into another is served as the one it was merged into, with the time of both. `404` for an id that is no place of the timeline (unknown, or no stay names the place it leads to or any place merged into it), `400` for one that is not a positive whole number. |
| `GET /api/trips` | The trips, newest first, as `{"trips": [...]}` (an empty list when there are none). Each has its `id` (the date of its first away night, `yyyy-MM-dd`), a `name` (`"Lisbon"`, `"Lisbon & Porto"`; `"Trip"` until its places are named), `firstNight`, `lastNight` and `nights` (every night from the first to the last, those with no known position too), `start` and `end` (when you left and came back, UTC; `end` is `null` while the trip is `ongoing`), `startTimeZone`, `endTimeZone`, `localStartDate` and `localEndDate`, its `cities` (name, country, nights and mean position of each city slept in), and a `thumbnail`: the line `[[lon, lat], ...]` of home, the places it slept at and home again (it stops at the last place while the trip is ongoing). There is no `state`: the trips are worked out after the timeline, once per pass of the background worker, so a trip can follow new points by a moment. |
| `GET /api/trips/{id}` | One trip, `id` being the date of its first away night. The fields of the list (without the thumbnail), its `stats` (`flights`, `cities`, `places`, and `groundDistanceMeters`, the distance of the moves that are not flights), its `moves` (`id`, `mode`, `distanceMeters` and the `geometry` of each, simplified further if all of them together would have more than 50 000 vertices) and its `days`: for each local day of the trip a `description` (`"Oslo → Lisbon"`), up to three `highlights` (the named places with the most time that day, not counting the place slept at the night before or the place slept at that night), `groundDistanceMeters` and `flights`. `404` for an id that is no stored trip (unknown, or not a date). There is no `state`, as for the list. |
| `GET /api/status` | Processing health: algorithm version, backfill progress, pending and failed work, place naming progress, warnings. |
| `GET /api/config` | What the web app needs to know before it can draw: the map styles for the light and the dark colour scheme (`Map__StyleLight`, `Map__StyleDark`, see below). |

## The web app

The web app is at `https://sporer.lud.ar` (that is, at `/` of wherever you publish the container). It shows one day, week,
month, year or range of the timeline on a map with a panel beside it (a sidebar on a wide window, a bottom sheet you pull up
on a phone), and a place with the time you have spent at it. The address says what is shown, so a view can be bookmarked
and the Back button works: `/day/2026-10-22`, `/week/2026-10-19`, `/month/2026-10`, `/year/2026`,
`/range/2026-10-01..2026-10-22`, `/place/7`, `/trips` (the list of your trips, opened by the Trips button of the card at the top of the
map) and `/trip/2026-09-12` (one trip, named by the date of its first night; see "Trips and home"). Anything else opens today. The map
follows the light or dark setting of the device, and the ◐ button of the map draws where the time of a period was spent as a heat layer.

**On an iPhone**, open `https://sporer.lud.ar` in Safari, tap Share, then **Add to Home Screen**. It opens from the home
screen in a window of its own, without Safari's bars. On a desktop browser it is just a page. It does not work offline yet.

The web app is built into the image: nothing else needs to be installed or run next to it. It is served by the same process
as the API, from `wwwroot` next to `Sporer.Api.dll`.

## Trips and home

Sporer works out where you live and when you were away from it, from the places you slept at. All of it is derived from the timeline and is
worked out again with it, so nothing here has to be entered or kept up to date by hand.

- **A night** is named by the evening it begins: the night of 22 October is where you were at **03:00 local time on 23 October**, by the
  clock of the zone you were in then. Its place is the stay that covers that moment; if none does, the nearest raw point within 12 hours;
  if there is none, the night is unknown.
- **Home** is a place that was where you slept on **at least 60 of 90 nights in a row** (a night that is unknown counts against it). A place
  that reaches that bar is home from the first of those nights, and the first home of the history from the first night there is. A long stay
  that stays below the bar, a month abroad or a winter with someone, never becomes home: it is a trip.
- **Places near each other count as one home.** GPS drift can split one house into several places a hundred metres or so apart, so the
  nights at every place within **250 m** of a place count for it (`Detection__HomeRadiusMeters`). A place within that distance of your
  current home never starts a new home, so the home does not flip between the fragments of one house. Two homes closer than that are one
  home, and so can two homes up to about twice that apart (about 500 m), when a place of the new one lies within 250 m of the old one: a
  move that small may not be noticed as a move. That is harmless for trips, as it is far below the 50 km of a trip. On the Day view the
  stays at the new home's places more than 250 m from the old home then show numbers, not a house, until a home override (planned for
  Plan 4) covers it.
- **Away** means sleeping at least **50 km** from the home you had that night. While there is no home, no night is away.
- **A trip** is a run of away nights in a row. Unknown nights between two of them belong to it, and an unknown night never starts or ends
  one. It starts when you left (the end of the last stay within 50 km of home) and ends when you came back (the start of the first one).
  A trip whose last away night is the last night that is stored is **ongoing**, and has no end yet. Its id is the date of its first away
  night.
- **Names** are made when they are asked for, from the cities and countries of the places you slept at, in English: `Lisbon`,
  `Lisbon & Porto`, or the countries when it was three cities or more, and `Trip` until the places have been named (see "Place naming").
  The list says how long it was as `Lisbon · 4 nights` (`1 night`).

On the Day view a stay is at home, and is drawn with a house instead of a number on the map and in the list, when its place is the home of
that day, or when it lies within 250 m of it and was where you slept on at least one night of that home period: the other places of the
same house. A café, a shop or a gym next door is never where you slept, however close it is, so it keeps its number. The numbers count the
other stays that have a place. (A day with stays at two places of the same home shows two houses near each other.) The thresholds are the
`Detection__*` settings below: `Detection__TripMinDistanceKm`, `Detection__HomeMinNights`, `Detection__HomeWindowNights`,
`Detection__HomeRadiusMeters`, `Detection__NightHour` and `Detection__NightPointWindow`. Changing one rebuilds the whole timeline, as
changing any of them does.

## Running it

Sporer needs a TimescaleDB (PostgreSQL) database. The image is published to `ghcr.io/ldellisola/sporer` and listens on
port 80 inside the container.

**In production the container's port is not published.** The app is meant to be reached through Traefik, over the VPN, and
it trusts the forwarded headers of whatever connects to it. Once something like Authentik's forward auth sits in front of
Traefik, a port published on the host is a way round it. Put the container on the Docker network that Traefik reaches its
services by (and on one that reaches the database), and let Traefik be the only one that connects to it:

```sh
docker run -d --name sporer --restart unless-stopped --network <the network Traefik is on> \
  --label 'traefik.enable=true' \
  --label 'traefik.http.routers.sporer.rule=Host(`sporer.example.com`)' \
  --label 'traefik.http.services.sporer.loadbalancer.server.port=80' \
  -e TSDB_CONNECTION_STRING="Host=db;Port=5432;Username=postgres;Password=<password>;Database=postgres" \
  -e OVERLAND_TOKEN="<a long random string>" \
  -e Nominatim__UserAgent="Sporer/1.0 (you@example.com)" \
  ghcr.io/ldellisola/sporer:latest
```

(Add the entry point, TLS and authentication labels that your own Traefik uses for its other services.)

**To try it on your own machine only**, publish the port on the loopback address, so that nothing but that machine can
reach it, and open `http://localhost:8080`. Do not do this on a server:

```sh
docker run -d --name sporer-try -p 127.0.0.1:8080:80 --add-host=host.docker.internal:host-gateway \
  -e TSDB_CONNECTION_STRING="Host=host.docker.internal;Port=5432;Username=postgres;Password=<password>;Database=postgres" \
  -e Nominatim__UserAgent="Sporer/1.0 (you@example.com)" \
  ghcr.io/ldellisola/sporer:latest
```

The database schema is created and upgraded by the app on start-up. If a migration fails, or the database cannot be
reached when the app starts, the app exits; Overland keeps the points it could not send and retries, so nothing is lost
while you fix it. **Run the container with a restart policy** (`--restart unless-stopped` as above, or
`restart: unless-stopped` in Docker Compose, or the equivalent in your orchestrator), so that it starts again by itself
once the database is back, for example after the host reboots and the app comes up before the database does.

The image is based on `mcr.microsoft.com/dotnet/aspnet:10.0` (Ubuntu), which ships the time zone database
(`/usr/share/zoneinfo`) that Sporer needs to convert UTC to local time. If you change the base image, keep tzdata in it.

## Configuration

Everything is set through environment variables. A `:` in a configuration key is written `__` in an environment variable.

### Required and common

| Variable | Default | Meaning |
| --- | --- | --- |
| `TSDB_CONNECTION_STRING` | none | Npgsql connection string of the TimescaleDB database. Set it: without it the app falls back to `ConnectionStrings__TSDB`, and that falls back to a `localhost` connection string meant for development. |
| `OVERLAND_TOKEN` | empty | Shared secret that Overland must send, as `?token=<OVERLAND_TOKEN>` or as an `Authorization: Bearer` header. It can also be set as `Overland__Token` (the `Overland:Token` configuration key); `OVERLAND_TOKEN` is used when both are set. When neither is set the ingest endpoint is **open** and the app logs a warning (also shown in `/api/status`). Set it. |
| `Nominatim__UserAgent` | empty | Identifies your installation to OpenStreetMap's Nominatim, as its usage policy requires: the app name and a way to reach you, for example `Sporer/1.0 (you@example.com)`. **Places are only named when this is set**; without it Sporer makes no Nominatim requests and warns at start-up. |

### Map (`Map__*`)

The map is drawn in the browser from a MapLibre style, which names its own tile server. The browser asks for the style and the
tiles itself, so the device that shows Sporer must be able to reach the host of the style (the server does not).

| Variable | Default | Meaning |
| --- | --- | --- |
| `Map__StyleLight` | `https://tiles.openfreemap.org/styles/liberty` | URL of the MapLibre style the map uses while the device prefers a light colour scheme. |
| `Map__StyleDark` | `https://tiles.openfreemap.org/styles/dark` | The same for a dark colour scheme. |

The defaults are [OpenFreeMap](https://openfreemap.org/)'s, which need no key. A blank value keeps the default. Any style
that uses OpenMapTiles-style layers will do (street names are shown in English where the tiles have an English name). The
OpenStreetMap credit stays on the map whatever the style says. The web app reads the two values from `GET /api/config`.

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
| `Processing__Enabled` | `true` | Whether the background processing runs at all. `false` stops everything that runs in the background: the timeline is no longer built or updated, **and places are no longer named** (place naming is part of it, whatever `Nominatim__*` says). Ingest is not affected. |
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
| `Detection__NightHour` | `3` | The hour of local time (24-hour clock) a night is located at: the night of an evening is placed at this hour on the next day, in the zone you were in then. |
| `Detection__NightPointWindow` | `12:00:00` | When no stay covers a night's moment, the nearest raw point within this long of it locates the night; if there is none, the night is unknown. |
| `Detection__HomeWindowNights` | `90` | A new home is judged over this many consecutive calendar nights. |
| `Detection__HomeMinNights` | `60` | A place becomes home once it is where you slept on at least this many of the last `Detection__HomeWindowNights` nights; unknown nights count against it. Keep it above half the window, so that only one home can qualify at a time. |
| `Detection__HomeRadiusMeters` | `250` | Places within this distance of each other count as one home, because GPS drift can split a home into several places a hundred metres or so apart: the nights at all of them count for the home, and a stay at any of them is shown at home on the Day view. Two homes closer than this are one home, and so can two homes up to about twice this apart, when a place of the new one lies within this distance of the old one: a move next door is not detected (harmless for trips: far below the trip threshold). |
| `Detection__TripMinDistanceKm` | `50` | A night is away, and part of a trip, when its place is at least this far from the home you had that night. |

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
that endpoint is protected by `OVERLAND_TOKEN` instead. Everything else (the read API and the web app) belongs behind
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
times in a row, or that the process dies in the middle of three times (it ran out of memory), is set aside as a failed
range (retried later with a growing delay) and the backfill goes on after it; a live range that fails three times is
set aside the same way. Later processing does not reach back into a set-aside range, so one bad stretch of history does not
hold up the rest, live data included. The failed range of a backfill step also covers the step after it, which is rebuilt
together with it when the retry goes through (until then those days show as `pending`). The same backfill runs again
whenever the detection thresholds or the detection code change, and starts without any failed ranges. The first start of
the version that added trips and home is one of those (the algorithm version changed): it rebuilds the whole timeline
once, and the home periods and trips appear when it has finished.

## Owner's checklist: trips and home

After the first backfill of your real history has finished (`backfill.percent` is 100 at `https://sporer.lud.ar/api/status`), open the app on
the phone, over the VPN, and check:

- [ ] **The home periods look right, including any move.** There is no screen for the periods yet: open a day well before and a day well
  after a move you remember, and look for the house on the stays at home (it is where the number would be). It should be at the old place
  before the move and the new one after it. A move is noticed once the new home has 60 nights of the last 90, but it is dated from the
  first of them. Places within 250 m of each other count as one home (`Detection__HomeRadiusMeters`), so a home that GPS drift split
  over several places is still one, and a day at two of them shows two houses close together; the synthetic history's move, split over
  four places, is found that way. A home that is still not found would show as **no trips at all** (with no home, no night is away), or,
  after a move that was not noticed, as **one long trip** that does not end. If you see either, say so, and with where
  the home is. (The periods are in the `home_period` table: `select * from home_period order by from_date`.)
- [ ] **A short move may not show as a move.** A move of less than about twice the home radius (about 500 m) may not show as a new home.
  When it does not, the stays at the new home's places that are more than 250 m from the old home show numbers, not a house. Trips are
  unaffected. Plan 4's home override will cover it; say if you moved that little and it bothers you.
- [ ] **Each trip you remember is listed**, at `/trips`, with sensible dates, a name and a number of nights. Look for a trip that is missing
  (it was nearer than 50 km) and for one that is not a trip.
- [ ] **A long stay is not mistaken for a move.** A month or two away from home is one trip, and when you are back the house is still at
  your own place. (A stay of 60 nights or more out of 90 at one place is a move, by design.)
- [ ] **Home stops show a house** on the Day view, on the map and in the list, and no stop that is not home does: a café, shop or gym
  next door, which you never slept at, keeps its number, and the places of your own house, where GPS drift put a night, show a house.
- [ ] **The day lines of a trip read well**: open a trip and read each day's line (`Oslo → Lisbon`, its highlights, its distance and its
  flights). Say if a line reads wrong for a day you remember.
- [ ] **Time the trips list and a trip on the phone**, opened from the home screen, over the VPN. On the synthetic history the cards and
  the days show in about 0.8 seconds on a phone-sized page with the processor held back four times (the target is 2 seconds), without
  the network. Say how long they take on the real device; the first load of the app also fetches half a megabyte of JavaScript. The
  measurements and how to repeat them are in `docs/superpowers/plans/2026-10-26-sporer-plan-3-perf.md`.

If a trip is missing or wrongly there, or a home is wrong, the settings are `Detection__TripMinDistanceKm`, `Detection__HomeMinNights`,
`Detection__HomeWindowNights` and `Detection__HomeRadiusMeters` (see "Detection thresholds"); changing one rebuilds the timeline, which
takes a few minutes for years of history.

## Releases

Releases are Docker images on GHCR, built by GitHub Actions. To release, push a version tag:

```sh
git tag v1.2.3
git push origin v1.2.3
```

The workflow runs the .NET tests and the web app's checks (type check, unit tests and the browser tests), then builds the
image (the web app is built inside it) and publishes it as `ghcr.io/ldellisola/sporer` with the tags `1.2.3`, `1.2`, `1` and
`latest` (among others). Only a `v*.*.*` tag publishes `latest`. The server pulls `:latest` daily. Pushes to `main` that touch
`src/`, `tests/`, `web/`, `docker/dockerfile`, `.dockerignore` or the workflow file build and publish a branch-tagged image;
pull requests run the tests and a build without publishing.

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
in the image. The web app is built in a Node stage of its own (`node:22-alpine`) and copied into the image's `wwwroot`;
whatever `web/node_modules`, `web/dist` or `src/Sporer.Api/wwwroot` hold locally is left out of the build.

### Front-end development

The web app is in `web/`: React, TypeScript, Vite and MapLibre, with CSS Modules and no other UI libraries. You need
Node.js 22 (22.22.2 or later), 24 (24.15 or later) or 26 and up.

```sh
cd web
npm ci
npm run dev
```

Start the API first (`dotnet run --project src/Sporer.Api`, on `http://localhost:5097` as above): the Vite dev server, at
`http://localhost:5173`, passes `/api` on to it. The map needs the tile server of its style, so a machine without internet
access gets a plain background instead of a map; the rest of the page works.

| Command | What it does |
| --- | --- |
| `npm run typecheck` | `tsc --noEmit`, with `strict` on, for the app and, as a project of its own (`web/perf/tsconfig.json`), for the performance run. |
| `npm test` | The unit and component tests (Vitest, jsdom). |
| `npm run e2e` | The browser tests (Playwright, Chromium), against the production build with the API mocked: no API, database or internet is needed. Run `npx playwright install chromium` once first. The map is drawn with software WebGL, so no GPU is needed either, but it takes a couple of minutes. |
| `npm run perf` | The web performance run (spec §8): times the panel's rows and the map's idle for a day, a month and a year, for the list of trips and for each trip, on a phone-sized page with the processor held back 4 times, against API answers recorded by `npm run perf:record` from a server over the synthetic history. Not part of `npm run e2e` or CI; takes about six minutes (65 tests for the synthetic history's three trips). How to run it, and its results, are in `docs/superpowers/plans/2026-10-24-sporer-plan-2-perf.md` and, for the trips, `docs/superpowers/plans/2026-10-26-sporer-plan-3-perf.md`. |
| `npm run perf:record` | Records those API answers, the trips' among them (`node scripts/perf/record.mjs <api-url> <first-date> <last-date>`), into `web/perf/recorded/`, which git ignores. |
| `npm run perf:bundle` | After a build: the size of each JavaScript file of the production bundle, gzipped and Brotli-compressed. |
| `npm run build` | Type checks and builds the web app into `src/Sporer.Api/wwwroot`, which the API serves (and git ignores). |
| `npm run icons` | Draws the PNG icons in `public/icons/` again from `icon.svg`. Only when the icon changes. |

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
time the day view and ingest, `tools/perf/api-latency.sh` the range, heat, place and trips endpoints too, and `tools/perf/explain.sql` and
`tools/perf/explain-trips.sql` show the plans of their queries. `tools/perf/backfill-time.sh` times the first backfill,
`tools/perf/refresh-latency.sh` the refresh of the homes and trips after new points, and `tools/perf/name-places.sql` names the generated
places the way Nominatim would. The measurements at 10 million rows, and how to repeat them, are in
`docs/superpowers/plans/2026-10-23-sporer-plan-1-perf.md` (server), `docs/superpowers/plans/2026-10-24-sporer-plan-2-perf.md` (range, heat,
place, the web app) and `docs/superpowers/plans/2026-10-26-sporer-plan-3-perf.md` (the nights, homes and trips: the backfill, the refresh,
the trips endpoints and views).
