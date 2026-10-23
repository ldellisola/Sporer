# Sporer web app: design

- **Date:** 2026-10-23
- **Status:** draft, awaiting owner approval
- **Mockups:** [`assets/2026-10-23-map-views-mockup.html`](assets/2026-10-23-map-views-mockup.html) (hand-drawn maps, made-up data; layout reference only)

Throughout, **(owner)** marks a decision the owner made; **(call)** marks a decision made on the owner's behalf that they can overturn.

---

## 1. Intent

The owner paid for *Replay: Life & Travel Map* on iOS. It logs location in the background, turns it into visits and routes, and shows where you've been on a map. The owner loves the idea, but the app is unstable and effectively abandoned.

Meanwhile, Sporer (this repo) has been collecting the owner's GPS for over two years. Overland on the iPhone posts to `POST /api/overland`, and the API stores the raw points in TimescaleDB. Nothing reads that data back yet.

The goal is a self-hosted web app that does what the owner valued in Replay, on top of data they already own:

- **Looking back on a map** at where they've been over a day, a week, a month, a year, or a trip.

It is used from the iPhone 17 Pro home screen (full-screen, app-like) and from a desktop browser.

## 2. Goals, non-goals, anti-goals

### Goals

1. **The map is the product (owner).** Each time scale has a map view: Day, Week, Month, Year, and a custom Range.
2. **Automatic stops and routes.** Visits (stops), routes, and how you travelled are worked out automatically from raw points, including all historical data.
3. **Trips (owner).** Trips are detected automatically and listed. Each opens as its own map.
4. **Corrections (owner).**
   - Rename places.
   - Merge two places into one.
   - Remove bad GPS points from the map.
5. **Fast and stable (owner).** See §8 for the targets.
6. **Phone and desktop.** It works installed on the iPhone home screen and in a desktop browser.

### Non-goals (for v1)

- **Photos and notes on moments.** Replay has these. A web page can't read the iPhone photo library, and the owner didn't ask for them.
- **Logins and user accounts in the app itself (owner).**
  - Access is VPN-only today.
  - Later, the owner will put Authentik forward-auth in front of it at the Traefik level.
  - The app is single-user.
- **Native iOS app or background tracking.** Overland keeps doing the tracking.
- **Self-hosted map tiles or geocoding (owner).** Public OpenStreetMap services are fine, with results cached.
- **Charts and analytics beyond the map views.** The only stats are the "where your time went" ranking and the per-view summary chips.
- **Train / public-transport detection (call).** Speed alone can't tell a train from a car, so v1 labels both as *drive*. It's a candidate for later (see §11).

### Anti-goals: failure even if it technically works

- **Slow (owner).** Waiting for a day or month to appear, janky map panning on the phone.
- **Unstable (owner).** Crashes, blank screens, views that sometimes don't load, or the processing job interfering with ingest.
- **Losing or corrupting raw GPS data.** The raw points are the irreplaceable asset. Nothing in this app deletes or rewrites them.

## 3. Current state (what exists)

- **Stack:** .NET 8, FastEndpoints 5.28, Dapper, Npgsql. FastEndpoints uses source-generated discovery.
- **Ingest:** `src/Sporer.Api/Features/Overland/ConsumeEndpoint.cs`, at `POST /api/overland`.
  - It is anonymous.
  - It inserts `time, longitude, latitude, device, speed, altitude` into `locationLog`, setting speed to null when it is negative.
  - It returns `{"result":"ok"}`.
  - It drops everything else Overland sends, notably `horizontal_accuracy` and `motion`.
- **Schema:** `src/Sporer.Api/DB/01-Create-table.sql`.
  - It creates the `locationLog` hypertable.
  - It is run manually; there is no migration runner.
  - There is no primary key or unique constraint.
- **Static files:** `Program.cs` already calls `UseStaticFiles()` and `MapFallbackToFile("index.html")`. The design always intended a SPA served from the same app.
- **Docker:** `docker/dockerfile` is a two-stage .NET build. The GitHub workflow builds and pushes `ghcr.io/ldellisola/sporer` on pushes to `main` that touch `src/**` or `docker/Dockerfile`.
  - Note: the real file is `docker/dockerfile`, lowercase, so that path filter never matches.
- **Data:**
  - More than two years of points.
  - Historical rows have no accuracy or motion data, and speed only.
  - The volume is unknown. Assume up to roughly 10 million rows and design so it doesn't matter.
- **Deployment:** the owner self-hosts behind Traefik, reachable only over their VPN. Assume HTTPS via Traefik (call). A home-screen web app needs HTTPS for its offline cache.

## 4. What the owner sees

The mockup file shows views 1–4 below.

### 4.1 Shell and navigation

- **Full-screen map, always.**
  - Floating at the top: a segmented control `Day | Week | Month | Year | Range`, and a date line with ‹ › arrows. Swipe left/right on the date line also steps through time.
  - Map buttons on the right edge: recenter/fit, and a layer toggle for the heat map.
  - At the bottom, a **draggable sheet** (Apple-Maps style) with three snap points: peek, half, full.
- **Desktop (≥ 900 px wide).** The sheet becomes a fixed left sidebar of about 320 px; the map fills the rest. Keyboard ← → steps through time.
- **URL reflects state** (call), so refresh, back button, and bookmarks work. For example:
  - `/day/2026-10-22`
  - `/month/2026-10`
  - `/range/2026-09-12..2026-09-19`
  - `/trips`, `/trip/{id}`
  - `/place/{id}`
- **Entry points** for Trips and Settings sit in the sheet's header or a small menu (builder's choice). There is no tab bar; the map stays primary.
- **Theme.** Light and dark follow the system setting (call). The map style switches with the theme.
- **Conventions (call):**
  - Metric units.
  - 24-hour clock.
  - Weeks start on Monday.
  - English UI.
  - Times shown in the local time zone of where you were (see §6.7).

### 4.2 Day view (mockup 1)

- **Routes** are drawn as lines coloured by mode:
  - walk: green
  - cycle: teal
  - drive: blue
  - flight: orange dashed great-circle arc
- **Stops** are numbered pins. Home has a house icon.
- **Sheet:**
  - Summary chips: number of places, distance, time moving.
  - A vertical timeline alternating stops (name, arrival–departure, duration) and moves (mode, distance, duration).
  - Tapping a row flies the map to that stop or route.
  - Tapping a stop's name opens the place detail (§4.6).
- **Today** shows the day so far. It refreshes when the app regains focus and as new data is processed.
- **Gaps** in data (phone off, no points for hours) appear as an explicit "No data" row. They are never silently bridged with a straight line, except flights (see §6.4).

### 4.3 Week, Month, Year, Range views (mockup 2, option A, owner)

- **Every route** in the period is drawn faint (about 35 % opacity), so frequently travelled corridors darken naturally.
- **Places** are dots sized by total time spent in the period. The top few are labelled.
- **Sheet:**
  - Summary chips: number of places, distance, number of trips/moves.
  - "Where your time went": places ranked by hours, with bars.
  - Tapping a place opens its detail.
  - A compact list of the days in the period (call), so you can jump into a day.
- **Range** uses a date-range picker and otherwise behaves like Month.
- **Year** behaves like Month. At this scale, routes must be simplified (§7.3).

### 4.4 Heat layer (owner: "a heat map option looks cool")

- A toggle on the map's layer button, available at every time scale. It is off by default and the choice is remembered.
- It shows a glow weighted by **time spent**, not by point count, so a phone that logs more often while moving doesn't skew it.
- It can be shown alongside or instead of the routes (builder's choice).
- Mockup 2B shows the look, on a dark map. Its calendar sheet was **not** chosen.

### 4.5 Trips (mockup 3)

- **Trips list:**
  - Newest first.
  - Each card shows a small static map or route thumbnail, the name, dates, and the cities visited.
- **Trip view:**
  - **Map:** the whole trip, with flights as arcs, ground routes coloured by mode, and cities as dots sized by nights spent, labelled "Lisbon · 4 nights".
  - **Sheet:**
    - Stats: flights, cities, places, ground distance.
    - A day-by-day summary: date, one-line description, a few highlights.
    - Tapping a day opens that Day view.
- **Trip edits (call):**
  - Rename.
  - Adjust start and end dates.
  - Delete. A deleted trip stays deleted when data is reprocessed.

### 4.6 Place detail

Reached by tapping a place anywhere. It shows:

- Name: the user's name if set, otherwise the OpenStreetMap name.
- Address.
- A small map.
- Total time.
- Number of visits.
- First and last visit.
- A list of visits; tapping one jumps to that day.

Actions:

- **Rename.**
- **Merge with…** Pick another place from a nearby list or a search. All visits move to the surviving place, and the name you choose is kept.

### 4.7 Edit mode: removing points (owner)

- Available in Day view. It shows that day's raw GPS points as small dots over the routes.
- Select by tapping a point or dragging a box. Then use "Remove *n* points".
- Removed points are **hidden, never deleted** (call), with Undo straight after and a "Removed points" list in Settings to restore them.
- After removal, the day (and any trip containing it) is reprocessed and the view updates.

### 4.8 Settings (minimal)

- **Home:** shows detected home(s) over time, with an override.
- **Trip distance threshold:** default 50 km (call).
- **Processing status:** backfill progress, last processed time, and any failed days with a retry button.
- **Removed points.**
- About / attribution.

## 5. Decisions the owner made

| Topic | Decision |
|---|---|
| Core focus | The map view: seeing a day, week, month; seeing where they've been on trips |
| Week/month style | Option A (routes + places sized by time), plus a heat-map toggle |
| Map provider | Not Apple MapKit JS. The owner only has a free Apple developer account, and MapKit JS keys require the paid program. Use MapLibre with free OSM-based tiles. |
| Access control | VPN only today; Authentik forward-auth at Traefik later. No login in the app. |
| Front-end stack | Left to the builder's judgement. See §7, which records the call made. |
| Third-party services | Public OpenStreetMap services are acceptable; cache results. |
| Corrections | Rename and merge places; remove coordinate points from the map |
| What a trip is | Being away from home overnight |
| What failure looks like | Slow or unstable |

## 6. How the data becomes visits, routes and trips

All derived data is computed on the **server**, in a background worker inside the API process, and stored in tables. Read endpoints only read the stored results. The browser never processes raw history.

### 6.1 Pipeline overview

```
raw points ─► clean ─► segment into stays & moves ─► assign stays to places ─► classify move mode
                                                          │                        │
                                                          ▼                        ▼
                                                   reverse-geocode new     simplify geometry
                                                   places (Nominatim)
                                                          │
                                                          ▼
                                          detect home(s) ─► detect trips ─► heat cells
```

### 6.2 Units of work and incremental processing

- **The unit of work is a local day.** Each point maps to a local date using the time zone at its coordinates (§6.7).
- **Ingest marks days dirty.** Ingest inserts points, then upserts the affected local day(s) into a `dirty_days` queue. That's a cheap insert in the same request, and it never waits on processing.
- **The worker reprocesses dirty days.**
  - It is debounced, so today is reprocessed at most about once a minute while points stream in.
  - A day's stays and moves are recomputed together with a small overlap into the neighbouring days, so stays that cross midnight are handled.
  - Home and trip detection are then re-run for the affected date window.
- **Backfill.** On first start, every day in the history is marked dirty and processed oldest-first. Progress is visible in Settings. The UI works for already-processed days while the backfill runs.
- **Failure handling.** A day that throws is marked failed with the error and retried with backoff. It never blocks other days or ingest.
- **Algorithm versioning.** Each processed day records an algorithm version. Bumping the version re-queues all days, so tuning thresholds later is a supported operation.

### 6.3 Cleaning

- **Duplicates.** Drop exact duplicates, meaning the same device and timestamp. Overland can resend a batch.
- **Accuracy.** When `horizontal_accuracy` is known, drop points worse than about 100 m.
- **Glitches.** Drop a point when it implies an impossible jump out-and-back: speed to it and away from it both exceed about 300 km/h while its neighbours are close together. Sustained high speed is a flight, not a glitch (§6.4).
- **User exclusions.** Drop points the owner removed (§4.7).
- **Tuning.** All thresholds are configuration with sensible defaults. Expect to tune them against real data.

### 6.4 Stays and moves

- **Stays.** A stay is a period of at least about 5 minutes within about 100 m of a centre. This is a standard stay-point detection approach.
- **Sparse logging when still.** Overland logs sparsely while you're stationary. A long gap between two points that are close together therefore counts as being stationary for the whole gap.
- **Moves.** A move is everything between consecutive stays. Each one gets:
  - distance
  - duration
  - mode (§6.5)
  - a simplified geometry (§7.3)
- **Flights.** Consecutive points that imply more than about 200 km/h, or a gap where the jump is more than about 100 km with an implied speed above 200 km/h, form a flight. It is drawn as a great-circle arc between take-off and landing.
- **Gaps.** A gap with a large jump that is *not* flight-like (for example, the phone was off) is stored as an explicit gap and shown as "No data".

### 6.5 Mode (walk / cycle / drive / flight)

- **When Overland's `motion` is present** (new data only, once ingest stores it), it is the primary signal. Overland reports walking, running, cycling, automotive or stationary.
- **Otherwise, use speed.** Take the median speed of the move. Starting thresholds:
  - below about 7 km/h: walk
  - about 7–25 km/h: cycle
  - above about 25 km/h: drive
  - flight per §6.4
- **Historical data has speed only,** so old days will be rougher. That's accepted.
- **Train is shown as drive in v1** (call, see §11).

### 6.6 Places, home, trips

- **Places** are stable entities.
  - A new stay whose centre is within about 75 m of an existing place is assigned to it. Otherwise a new place is created at the stay's centre.
  - Places are **never re-created from scratch** on reprocessing, so names and merges survive.
- **Reverse geocoding.**
  - New places are named via the public Nominatim reverse API, using the POI name if there is one, otherwise a short address.
  - The worker respects Nominatim's usage policy: at most 1 request/second, a descriptive `User-Agent` with contact details (from configuration), and results cached in the database.
  - The whole history should need on the order of hundreds to a few thousand lookups, so a one-off backfill of well under an hour at 1/s is acceptable.
  - A failed lookup leaves the place unnamed (show coordinates or "Unnamed place") and is retried later.
  - The place's city and country are also stored, for trip names and trip summaries.
- **User overrides.**
  - A user-set name always wins.
  - A merge marks the absorbed place as merged into the survivor. Its visits are reassigned, and future stays near either place go to the survivor.
- **Home.**
  - The home for each night is the place where you were at 03:00 local time: the stay covering 03:00, or the nearest point if none does.
  - Home over time is the most frequent 03:00 place in a rolling window of about 30 days. This produces home periods, which handle moving house.
  - The owner can override the home, with a date range, in Settings.
- **Trips (owner: "away from home overnight").**
  - A night counts as *away* when the 03:00 location is at least the threshold distance (default 50 km, call) from the home in effect.
  - A trip is a maximal run of consecutive away nights. It starts when you leave home before the first away night and ends when you're back home after the last.
  - **Auto-name:** the city with the most nights, or "City A & City B" for two, or the country name when more than two cities. The user can rename.
  - **User trip edits** (name, dates, deleted) are stored separately and re-applied after every reprocessing. A deleted trip is suppressed by matching its date span.

### 6.7 Time zones

- Each point's local time zone comes from its coordinates, using an offline lookup. For example, the `GeoTimeZone` NuGet package plus `TimeZoneConverter`; the builder picks.
- Day boundaries, the 03:00 home rule, and all displayed times use that local zone. A day in Lisbon is a Lisbon day.
- The API returns UTC timestamps plus the IANA zone, and the UI formats them.

## 7. Architecture

### 7.1 Back end (call: stay on .NET, upgrade)

- **Upgrade to .NET 10 (LTS).** .NET 8 reaches end of support on 10 November 2026.
- **Keep** FastEndpoints (upgrade to a .NET 10-compatible version), Dapper and Npgsql.
- **No PostGIS dependency** (call). Geometry runs in C#: haversine, stay detection, Douglas–Peucker simplification. Use NetTopologySuite if helpful; the builder decides.
- **Migrations.**
  - Add a migration runner (for example DbUp) that runs on startup.
  - The existing `01-Create-table.sql` has already been applied by hand on the owner's DB. The runner must treat it as the baseline and not fail on an existing `locationLog`.
  - All new migrations are additive.
- **Ingest changes (call):**
  - Store `horizontal_accuracy` and `motion` (as `text[]`) in new nullable columns. Old rows stay null.
  - The builder should check the payload field names against Overland's README.
  - **Ingest token.** When `OVERLAND_TOKEN` is set, require it as a `?token=` query parameter (the pattern other Overland receivers use), and also accept `Authorization: Bearer`. If it isn't set, accept anonymously and log a warning once at startup, so the owner's current setup doesn't break before they update Overland's URL.
  - The response must stay exactly `{"result":"ok"}` on success. Overland deletes its local batch only on that response.
  - Ingest must stay fast and independent of processing. It inserts points and marks dirty days, nothing else.
- **Background worker.** A hosted service in the same process. One worker processing days sequentially is fine. Processing must not hold locks that block ingest inserts.
- **Read API** (shape is the builder's call; this is what the UI needs):
  - `GET /api/day/{date}`: stops (with place), moves (mode, distance, duration, geometry), gaps, summary, time zone.
  - `GET /api/range?from&to`: simplified moves, places with time spent, summary, and the per-day list. Week, Month, Year and Range all use this.
  - `GET /api/heat?from&to`: weighted cells for the heat layer.
  - `GET /api/day/{date}/points`: raw points, including hidden ones flagged, for edit mode.
  - `POST /api/points/exclude`, `POST /api/points/restore`.
  - `GET /api/trips`, `GET /api/trips/{id}`, `PATCH /api/trips/{id}`, `DELETE /api/trips/{id}`.
  - `GET /api/places/{id}`, `PATCH /api/places/{id}` (rename), `POST /api/places/{id}/merge`, `GET /api/places/nearby?lat&lon`.
  - `GET /api/status` (processing / backfill), plus settings endpoints.
- **Routes for Traefik.** The owner's future Traefik/Authentik config must exempt `/api/overland` from forward-auth. Everything else, including the UI and read API, sits behind it. Document this in the README.

### 7.2 Storage (indicative; the builder finalises)

New regular tables (not hypertables) alongside `locationLog`:

- **`place`**
  - id, centre lat/lon, osm_name, user_name, address, city, country
  - merged_into_id
  - geocode status and timestamps
- **`stay`**
  - id, place_id, start, end, centre, local_date(s), tz
- **`move`**
  - id, start, end, mode, distance_m, local_date(s)
  - geometry at two detail levels: day detail, and coarse for long ranges
  - flag for flight or gap
- **`home_period`**
  - place_id, from, to, source (detected | user)
- **`trip`**
  - id, start, end, auto_name
  - user_name, user_start, user_end, deleted
- **`excluded_point`**
  - device, time, excluded_at
  - Raw rows are never updated or deleted.
- **`heat_cell_day`**
  - local_date, cell key (for example lat/lon rounded to about 100 m), seconds spent
  - Summed over a range for the heat layer.
- **`dirty_day`, `day_status`**
  - local_date, state, algorithm version, error, attempts
- **`geocode_cache`**
  - rounded lat/lon key and response

### 7.3 Performance design

- **Precompute.** Everything shown on the map is precomputed at processing time.
- **Two geometry levels per move.**
  - Day view uses a lightly simplified line, roughly 5–10 m tolerance.
  - Week, Month, Year and Range use a coarse line, roughly 30–100 m tolerance.
  - A year of moves must stay small enough to draw smoothly on the phone; aim for under about 50k vertices.
- **Heat** comes from pre-aggregated `heat_cell_day` rows, never from raw points at request time.
- **Caching.**
  - Responses carry `ETag` / `Cache-Control`.
  - A fully processed past day is effectively immutable until edited or reprocessed. Key the ETag on the day's processing version.
  - The front end caches queries (TanStack Query) and prefetches the previous and next day or period, so ‹ › feels instant.
- **Front-end weight.**
  - Code-split so first paint loads only the shell and map.
  - MapLibre is the largest dependency; avoid adding other heavy ones.
- **Map rendering.** Use MapLibre's native layers (line, circle, heatmap, symbol) fed GeoJSON sources. Avoid one DOM marker per point.

### 7.4 Front end (call)

- **Build.** React + TypeScript + Vite, in a new `web/` folder at the repo root. The production build outputs into the API's `wwwroot`, served by the existing static-file and fallback setup. It is still one Docker image.
- **Map.** MapLibre GL JS (v5, for globe projection on trips and long ranges) via `react-map-gl`'s MapLibre binding, or used directly.
- **Map styles.** OpenFreeMap: `liberty` for light. The `dark` style is unfinished upstream, so the builder may need to restyle it or pick another free dark OSM style.
  - No API key needed.
  - Keep OSM attribution visible.
  - The owner accepted the third-party dependency (§5). If OpenFreeMap disappears, the style URL is the only thing to change.
- **Data fetching.** TanStack Query.
- **Libraries left to the builder:** the bottom-sheet library (for example vaul) or a custom one, the styling approach, and the date library.
- **Installable web app (PWA).**
  - Web manifest with `display: standalone`, iOS `apple-touch-icon`, and theme colours.
  - `viewport-fit=cover`, with safe-area insets respected around the Dynamic Island and home indicator.
  - A service worker caches the app shell for fast, reliable start-up. It doesn't cache API data offline in v1.
- **Error handling.** Every view handles loading, empty ("No data for this day") and error states, with a retry. A failing request must never leave a blank screen.

### 7.5 Deployment

- **Dockerfile.** Add a Node build stage for `web/` and copy its output into the published app's `wwwroot`. Move the base images to .NET 10.
- **Workflow.** Fix the path filter (`docker/dockerfile`, lowercase) and add `web/**`.
- **New configuration:**
  - `OVERLAND_TOKEN`
  - Nominatim contact/User-Agent
  - Map style URLs
  - Detection thresholds, including the trip distance
- **README.** Document setup, Overland configuration (receiver URL with token), and the Traefik/Authentik exemption for `/api/overland`.

## 8. Quality bar

Measured on the owner's iPhone over their VPN, against the real history, after backfill:

| What | Target |
|---|---|
| Open app (cold, installed) to map visible | ≤ 2 s |
| Day view data shown after navigating (‹ ›), past day | ≤ 1 s (near-instant when prefetched) |
| Month view shown | ≤ 2 s |
| Year view shown | ≤ 3 s |
| Map pan/zoom on iPhone | Smooth (no visible stutter), including Year with routes |
| Ingest `POST /api/overland` | Unaffected by processing; p95 < 200 ms |
| Stability | No unhandled errors reaching a blank screen; worker failures isolated per day and visible in Settings |

## 9. Testing

- **Detection logic (highest value).** Unit tests with synthetic tracks covering:
  - a stay with sparse points across a gap
  - a stay crossing midnight
  - a GPS spike
  - a flight
  - a phone-off gap
  - walk, cycle and drive speeds
  - a time-zone change mid-trip
  - home moving
  - a trip of one night and of many nights
  - merges and renames surviving reprocessing
  - excluded points
- **Integration tests** against a real TimescaleDB, for example with Testcontainers if Docker is available to the builder:
  - migrations on an existing baseline DB
  - ingest with and without the token
  - the dirty-day flow
- **Front end.** A few Playwright end-to-end tests against seeded data:
  - day navigation
  - month view
  - opening a trip
  - renaming and merging a place
  - removing and restoring points
  - phone and desktop viewports
- **Real-data tuning.** Before calling detection done, run it on the owner's history and review several representative days and trips with the owner.

## 10. Suggested build order

Each phase leaves the app deployable.

1. **Foundation.**
   - .NET 10 upgrade and migration runner.
   - Ingest token and new columns.
   - `web/` shell with the map rendering, served from the API.
   - Dockerfile and workflow updated.
2. **Processing.**
   - Cleaning, stays and moves, places, geocoding, modes.
   - Dirty-day queue, backfill, status endpoint.
3. **Day view** (phone and desktop).
4. **Week / Month / Year / Range,** plus the heat layer and place detail.
5. **Home and trip detection,** the trips list, and the trip view.
6. **Editing:**
   - rename and merge places
   - remove and restore points
   - trip edits
   - Settings
7. **PWA polish** and a performance pass against §8.

## 11. Later (explicitly out of v1)

- **Train / transit detection,** for example by matching moves to OSM railway lines.
- **Offline viewing** of previously loaded data.
- **Photos and notes.**
- **An all-time "everywhere I've been" view** (countries and cities counts).

## 12. Left to the builder

- Exact table shapes, endpoint shapes and JSON formats, within the needs in §6–7.
- Detection thresholds beyond the stated starting points, tuned against real data.
- Front-end libraries for the bottom sheet, styling and dates; component structure.
- Whether the heat layer replaces or overlays routes when on.
- Where the Trips and Settings entry points live in the UI.
- Exact visual design within the mockups' direction: Apple-Maps-like, clean, light and dark.

## 13. Risks

- **Detection quality on historical data** (speed only, no accuracy). Mitigations: conservative defaults, an algorithm-version reprocess, and manual point removal.
- **OpenFreeMap or public Nominatim availability or policy changes.** Mitigations: geocoding results are cached, and both are configurable URLs.
- **Authentik forward-auth with an iOS home-screen app** (future). Login redirects in standalone mode can be awkward on iOS. Not in scope now, but keep the app's assumptions simple: same-origin API, no custom auth.
