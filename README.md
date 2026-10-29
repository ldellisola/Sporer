# Sporer

Sporer is a (very) simple alternative to Google Timelines. It receives GPS points from the
[Overland](https://overland.p3k.app/) iOS app, stores them in TimescaleDB, and turns them into a timeline of
**stays** (matched to named places), **moves** (walk, cycle, drive or flight) and **gaps**, each with its IANA time zone
and local date. The raw points are the source of truth and are never modified or deleted; the timeline is derived from them and can
be rebuilt at any time. What you correct by hand in the app (place names and merges, points you remove, trips, homes and the trip distance, see
"Editing") is kept apart from what is derived and survives every rebuild.

The server is a .NET 10 API, and it also serves the web app that shows the timeline (see "The web app" below). It exposes:

| Endpoint | What it does |
| --- | --- |
| `POST /api/overland` | Receives Overland batches. Answers `{"result":"ok"}` once the points are stored. |
| `GET /api/day/{yyyy-MM-dd}` | One local day of the timeline. A stay at the home in effect on that day, or at a place within `Detection__HomeRadiusMeters` of it (see "Trips and home"), has `"home": true`. `state` is `pending` while work that affects that day is still waiting. |
| `GET /api/day/{yyyy-MM-dd}/points` | The raw points of a local day that are not removed, for edit mode to draw: `{"date", "devices": [...], "points": [[t, lon, lat, deviceIndex], ...]}`, in time order. `t` is the time in **microseconds** since the epoch, exact, and with the device it is what a removal names a point by; `deviceIndex` is a place in `devices`. The day is the one the day view shows, in every zone its segments are in (from the earliest local midnight to the latest next one), so on a day of travel the points of the days next to it overlap and no point is on no day. A day with no points has an empty list (a day can have tens of thousands). `400` for a date that is not `yyyy-MM-dd`. |
| `GET /api/range?from=yyyy-MM-dd&to=yyyy-MM-dd` | A stretch of local days (at most 400, both ends counted) in one answer: every move with its line (simplified further if there would be more than 50 000 vertices), the places with the time spent there inside the range, and a list of the days. `state` is `pending` while work that affects the range is still waiting. |
| `GET /api/heat?from=yyyy-MM-dd&to=yyyy-MM-dd` | Where the time of a range (the same dates, the same limit as `/api/range`) was spent, for a heat layer: `cells` are `[lon, lat, seconds]`, the most seconds first, one per cell of a grid of 0.001 degrees (about 111 m of latitude; a degree of longitude is shorter the further you are from the equator, so a cell is narrower than it is tall), weighted by the time of the stays in it, not by points; `maxSeconds` is the first one's weight (0 when there are none). |
| `GET /api/places/{id}` | A place and the time spent at it: name, address, centre, total seconds, number of visits, first and last visit, and the latest 50 stays (`start`, `end`, local `date`, `timeZone`), newest first. A place merged into another is served as the one it was merged into, with the time of both. `404` for an id that is no place of the timeline (unknown, or no stay names the place it leads to or any place merged into it), `400` for one that is not a positive whole number. `merged` lists the places merged directly into it (`id`, `name`). |
| `GET /api/places/search?q=` | The places in use (not merged into another), the most visited first, at most 20, as `[{"id", "name", "address", "visits"}]` (the name is yours, else OpenStreetMap's, else `null`; the visits include those of the places merged into it). With a `q`, those whose name or address contains it, whatever the case and taken as text (`%` and `_` mean themselves); with none, or an empty one, the most visited of all. It serves the home picker in Settings. |
| `GET /api/places/{id}/candidates?q=` | The places the place can be merged with, the nearest first, at most 20, as `[{"id", "name", "address", "distanceM", "visits"}]`: the places in use that survive merges, except the place itself (and so not one merged into it). `q` filters by name or address as for the search. `404` for an id that is no place of the timeline, `400` for one that is not a positive whole number. |
| `PUT /api/places/{id}/name` | Names a place yourself: body `{"name": "Gym"}`. Your name is shown in place of OpenStreetMap's wherever the place is named (the day, the range, the place view and the highlights of a trip's days). It is trimmed, at most 100 characters (`400` otherwise), and `null` or an empty one brings back the automatic name; a body with no `name` in it is a `400`, as is an id that is not a positive whole number; `404` for an id that is no place of the timeline. A place merged into another is the one it was merged into, and that is the one named. Answers `200` with the place, as `GET /api/places/{id}`. Nothing is reprocessed. |
| `POST /api/places/{id}/merge` | Merges the place `{"place": 7}` into the place `id`: the place you are on survives, and everything spent at the other is spent at it from now on, in the day, the range, the place and the trips. An optional `name` becomes the survivor's name (trimmed, at most 100 characters); an empty one clears the survivor's own name, so that OpenStreetMap's shows again, and `null` or none leaves it as it is. The homes and trips are worked out again from the stored nights before the answer. `200` with the survivor, as `GET /api/places/{id}`, merged places and all. `400` for an `id` or a `place` that is missing or not a positive whole number, or a name over 100 characters; `404` for a place that is no place of the timeline; `409` for two that are the same place once their merges are followed (merging a place into itself, or into one it was merged into), or for a merge that would chain more than 32 merges. |
| `DELETE /api/places/{id}/merged/{other}` | Separates `other`, which must have been merged directly into the place `id`, so that it is a place of its own again, with its own stays; what was merged into it goes with it. The name given to the survivor at the merge stays with the survivor. The homes and trips are worked out again before the answer. `204`; `404` for an `id` that is no place of the timeline or an `other` that is not merged directly into it; `400` for an id that is not a positive whole number. |
| `GET /api/trips` | The trips, newest first, as `{"trips": [...]}` (an empty list when there are none). Each has its `id` (the date of its first away night, `yyyy-MM-dd`), a `name` (`"Lisbon"`, `"Lisbon & Porto"`; `"Trip"` until its places are named), `firstNight`, `lastNight` and `nights` (every night from the first to the last, those with no known position too), `start` and `end` (when you left and came back, UTC; `end` is `null` while the trip is `ongoing`), `startTimeZone`, `endTimeZone`, `localStartDate` and `localEndDate`, its `cities` (name, country, nights and mean position of each city slept in), and a `thumbnail`: the line `[[lon, lat], ...]` of home, the places it slept at and home again (it stops at the last place while the trip is ongoing). `edited` says you have changed the trip; `ownName` is the name you gave it (`null` when it is the made-up one), and `startEdited` and `endEdited` say that the start and the end date are yours and not detected. There is no `state`: the trips are worked out after the timeline, once per pass of the background worker, so a trip can follow new points by a moment. |
| `GET /api/trips/{id}` | One trip, `id` being the date of its first away night. The fields of the list (without the thumbnail), its `stats` (`flights`, `cities`, `places`, and `groundDistanceMeters`, the distance of the moves that are not flights), its `moves` (`id`, `mode`, `distanceMeters` and the `geometry` of each, simplified further if all of them together would have more than 50 000 vertices) and its `days`: for each local day of the trip a `description` (`"Oslo → Lisbon"`), up to three `highlights` (the named places with the most time that day, not counting the place slept at the night before or the place slept at that night), `groundDistanceMeters` and `flights`. `404` for an id that is no stored trip (unknown, or not a date). There is no `state`, as for the list. |
| `PUT /api/trips/{id}` | Says what the trip is, which replaces whatever you said before: body `{"name": "Lisbon", "startDate": "2026-09-10", "endDate": "2026-09-18"}`. All three must be in the body, and `null` for each means as detected (`"name": null` is the automatic name). The start date is the day the trip begins and the end date the day you are back, so its nights run from the evening of the first to the one before the second; the trip begins at midnight at the start of the first date and ends at midnight at the end of the last, so the journey home is in the trip. The edit is kept and put on the trip again whenever the trips are worked out. The trips are worked out again before the answer. `200` with `{"id": "2026-09-10"}`, the trip's id now (its first night, which a new start date moves). `400` for a name over 100 characters, a date that is not `yyyy-MM-dd` (from 1970 to 2099) or a start that is not before the end; `404` for an id that is no stored trip; `409` when the nights it would have are another trip's. |
| `DELETE /api/trips/{id}` | Says the trip is none. It stays gone when the trips are worked out again, from new data or a rebuild, until it is brought back. `204`; `404` for an id that is no stored trip, or one that is deleted already. |
| `GET /api/trips/deleted` | The trips you deleted and have not brought back, the one deleted last first, as `[{"key", "label", "deletedAt"}]`: `key` is what restores it (`yyyy-MM-dd`), `label` is what it was shown under (`Lisbon · 12 – 16 Sep 2026`). |
| `POST /api/trips/deleted/{key}/restore` | Brings a deleted trip back, as detection finds it, with the name and dates you had given it. The trips are worked out again before the answer. Takes no body (an empty one, or `{}`). `204`; `404` for a key that is no deleted trip. |
| `POST /api/points/remove` | Removes points from the timeline: body `{"points": [{"device": "iPhone", "t": 1790000000000000}, ...]}`, each by its device and its time in microseconds, as `GET /api/day/{date}/points` gives them, at most 50 000. The raw points are **not deleted**: they are left out of every rebuild of the timeline, and the stretch they are in is rebuilt at once. One request is one removal (a batch), which `DELETE /api/points/removed/{batch}` undoes. A point that does not exist, or that is removed already, is ignored and not counted. `200` with `{"batch": "<id>", "count": 3}`; when none was removed `batch` is `null` and nothing is rebuilt. `400` for no `points`, more than 50 000, or a point without a `device` or a `t` that is a time. |
| `GET /api/points/removed` | The removals you have made and not restored, the newest first: `[{"batch", "removedAt", "count", "from", "to", "localDates"}]`, `from` and `to` being the times of the first and last point and `localDates` the local dates (`yyyy-MM-dd`) the points are on. |
| `DELETE /api/points/removed/{batch}` | Restores the points of one removal and has the stretch rebuilt at once. `204`; `404` for a batch there is none of, which includes one that was restored already; `400` for a batch that is not the id a removal gave. |
| `GET /api/homes` | The home periods as they are stored, those detection found and those you set, in date order: `{"periods": [{"id", "placeId", "placeName", "from", "to", "source"}]}`. `from` and `to` are night dates, both counted, `to` is `null` for a home that goes on, and `source` is `detected` or `user`. Where yours covers a detected one both are listed, and yours wins. |
| `POST /api/homes` | Says a place was home from one night to another, which replaces what detection found for those dates (see "Editing"): body `{"placeId": 53, "from": "2025-10-18", "to": null}`. `from` and `to` are night dates, `yyyy-MM-dd`; `to` must be in the body, and `null` is a home that goes on. A place that was merged into another is the place it was merged into. The trips are worked out again before the answer. `201` with the period, as `GET /api/homes` lists it. `400` for a missing place, a bad date or a `from` after the `to`; `404` for a place that is no place of the timeline; `409` when a night is one of another period you set. |
| `DELETE /api/homes/{id}` | Takes back a home you set; what detection found for those dates is the home again. The trips are worked out again before the answer. `204`; `404` for an id that is no period; `409` for a detected period, which the next refresh would find again (set a home for its dates instead); `400` for an id that is not a positive whole number. |
| `GET /api/settings` | Your settings: `{"tripMinDistanceKm": 50, "tripMinDistanceKmDefault": 50}`, the distance from home that makes a night away, in effect and as configured (`Detection__TripMinDistanceKm`). |
| `PUT /api/settings` | Sets the trip distance: body `{"tripMinDistanceKm": 80}`, from 5 to 1000 (`400` otherwise), or `null` to take your setting back and use `Detection__TripMinDistanceKm`. It must be in the body. The trips are worked out again from the stored nights before the answer: **nothing is rebuilt**. `200` with the settings, as `GET /api/settings`. |
| `GET /api/status` | Processing health: algorithm version, backfill progress, pending and failed work, place naming progress, warnings. |
| `POST /api/status/retry` | Makes every failed range of the processing queue due now, instead of when its backoff is over: the ranges that failed on their own and the backfill steps that were set aside, which are what `GET /api/status` lists as failed. The worker takes them on its next pass. Takes no body (an empty one, or `{}`). `200` with `{"retried": n}`, 0 when none had failed. |
| `GET /api/config` | What the web app needs to know before it can draw: the map styles for the light and the dark colour scheme (`Map__StyleLight`, `Map__StyleDark`, see below). |

**Writes.** Every write (`POST`, `PUT`, `DELETE`) takes and answers JSON. A `POST`, `PUT` or `PATCH` under `/api` whose `Content-Type` is not `application/json`, with a body or without one, is answered `415` and never reaches an endpoint (`POST /api/overland` is the exception, and has its token); a write that takes no body is sent with an empty body or `{}`. Errors: `400` for a value that is not valid, `404` for an id that is unknown, `409` for a conflict (merging a place into itself, trips or home periods that would share a night); a `400` has the usual errors body, `{"statusCode", "message", "errors": {field: [reason]}}`.

## The web app

The web app is at `https://sporer.lud.ar` (that is, at `/` of wherever you publish the container). It shows one day, week,
month, year or range of the timeline on a map with a panel beside it (a sidebar on a wide window, a bottom sheet you pull up
on a phone), and a place with the time you have spent at it. The address says what is shown, so a view can be bookmarked
and the Back button works: `/day/2026-10-22`, `/week/2026-10-19`, `/month/2026-10`, `/year/2026`,
`/range/2026-10-01..2026-10-22`, `/place/7`, `/trips` (the list of your trips, opened by the Trips button of the card at the top of the
map), `/trip/2026-09-12` (one trip, named by the date of its first night; see "Trips and home") and `/settings` (the gear: processing,
your homes, the trip distance, and what you deleted or removed, see "Editing"). Anything else opens today. The map
follows the light or dark setting of the device, and the ◐ button of the map draws where the time of a period was spent as a heat layer.

**On an iPhone**, open `https://sporer.lud.ar` in Safari, tap Share, then **Add to Home Screen** (see "Installing on the iPhone"
below). It opens from the home screen in a window of its own, without Safari's bars. On a desktop browser it is just a page.

The web app is built into the image: nothing else needs to be installed or run next to it. It is served by the same process
as the API, from `wwwroot` next to `Sporer.Api.dll`.

## Installing on the iPhone

Open `https://sporer.lud.ar` in Safari (over the VPN), tap Share, then **Add to Home Screen**. From then on the app opens from the home
screen in a window of its own, without Safari's bars, on today.

- **What the app keeps.** Once the app has loaded, a service worker (`/sw.js`, for the whole site) saves the app's **shell** on the phone: its page,
  its scripts and styles, its icons and its manifest: 2 MB unpacked, about half a megabyte as it travels. That is all. It **never keeps and never answers anything
  from the API** (`/api/…`): every day, month, trip and place you look at is asked of the server each time, so what is on the screen is never
  older than the server's, and none of your data is stored by the worker. Nor does it touch anything from another site (the map's style and
  tiles come from their own server, as before). The shell is what makes the app open at once, without fetching its code again over the VPN, and
  what lets it open at all when the network is slow or gone.
- **A start without a network.** The app opens, and each view says it could not load, with a **Retry**; the map has no basemap
  ("Map unavailable", with its own Retry) because its style and tiles are fetched from the network. Nothing you looked at before is shown: viewing
  data loaded earlier without a network is not part of v1. When the network is back, Retry loads the view. The same happens when the network
  answers but very slowly: after 3 seconds without an answer the app opens from the saved page instead of waiting, and its views load as the
  answers come.
- **How a release reaches the installed app.** The app's page is always asked of the server first (it is saved only for when that fails), so the next time
  the app starts after the server was updated, it starts on the new version of the page; the phone checks `/sw.js` at the same time, and a new build is
  a new worker that fetches the new shell in the background and then takes over and throws the old one away. An app you left open (it is still in the
  app switcher) runs on the version it started with until you close it: if it then needs a file that the release replaced, the view says it is
  unavailable, with a **Retry**, and closing the app and opening it again fixes it.
- **If it ever seems stuck** (an old version that does not go, a view that says unavailable and will not load): close the app from the app
  switcher and open it again. As a last resort, **delete the app from the Home Screen** (touch and hold its icon, then Remove App, Delete App) and add
  it again from Safari: an app on the Home Screen keeps its own website data, its worker and its saved shell included, apart from Safari's, and the
  new one starts with none, so the first start fetches the shell once more. Nothing of yours is lost, for the worker keeps only the shell and your data is on
  the server. Removing the site from Safari's Website Data is the other way, and may not reach the app on the Home Screen: on iOS 18 and later it is
  Settings, Apps, Safari, Advanced, Website Data; on iOS 17 and earlier, Settings, Safari, Advanced, Website Data.

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
  stays at the new home's places more than 250 m from the old home then show numbers, not a house, until a home you set in Settings
  covers it.
- **Away** means sleeping at least **50 km** from the home you had that night (`Detection__TripMinDistanceKm`, or the distance you set in
  Settings, which is used in its place; see "Editing"). While there is no home, no night is away.
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
changing any of them does. (The trip distance you set in the app is not one of them: it changes the trips alone, and rebuilds nothing.)
What you set by hand, the homes and the trips you edited, is put over what is detected whenever it is worked out.

## Editing

The timeline is worked out by the server, and what it gets wrong you put right in the app. Every edit is **yours**: it is kept in tables of
its own, and nothing the server works out again overwrites it. The edits are made in the places they are about; each shows that it is on its
way, and when it fails says why, with a Retry only where asking again can help.

- **Rename a place** (the place view, Rename). Your name is shown in place of OpenStreetMap's wherever the place is named (the day, the range, the
  place view and the highlights of a trip's days). An empty name brings OpenStreetMap's back. Nothing is reprocessed.
- **Merge two places** (the place view, Merge with…). Pick the other place from the nearest ones, or search by name, and choose which of the two
  names to keep. The place you are on survives; everything spent at the other is spent at it from now on, in every view, and the homes and
  trips are worked out again, so a home that GPS drift split over two places becomes one, and a home may be one of the two. **Separate**
  (listed under the place, for each place merged into it) makes a place of its own again, with its own stays; it is the undo of a merge.
- **Remove points** (the day view, Edit points). The raw points of the day are drawn on the map; tap one, or turn on Select area on the map
  and drag a box (or hold Shift on a desktop), then Remove. The day is rebuilt at once, and the toast has **Undo**. A removal is a batch, and
  Settings lists the batches (Removed points) with a **Restore** for each, so a removal is never final: the raw points are **never deleted**,
  only left out of the timeline.
- **Edit a trip** (the trip view, Edit): a name and the dates it begins and ends on (the day you are back is the end date; the journey home is in
  the trip). Use detected dates puts the dates detection found back. **Delete trip** says the trip is none, and Settings lists the deleted
  trips (Deleted trips) with a **Restore** for each.
- **Set a home** (Settings, Home, Set home). Pick a place and the nights it was home, from a date to a date or still; that replaces what was
  detected for those dates, the trips follow it at once, and Remove takes it back. Use it when a move was not noticed, or was noticed late or
  early. Detected periods are listed with yours but cannot be removed: they are found again.
- **The trip distance** (Settings, Trips): how far from home a night has to be to be away, from 5 to 1000 km. It is a setting of the app and
  overrides `Detection__TripMinDistanceKm`; Reset to default goes back to that. It changes the trips and **does not rebuild the timeline**,
  because it is no part of the algorithm's version (the `Detection__*` thresholds are, and changing one rebuilds everything).

**What survives.** Every edit survives new data, reprocessing and a rebuild of the whole timeline, such as the one an algorithm or a
`Detection__*` change makes: the place names and merges (`place.user_name`, `place.merged_into_id`), the removed points (`excluded_point`),
the edits of trips (`trip_edit`), the homes you set (the rows of `home_period` with `source = 'user'`) and the settings (`app_setting`) are
owner data, and a rebuild keeps all of them. The detected homes and trips are derived and are worked out again, with your edits put over them.
A trip you edited keeps its name and dates and one you deleted stays deleted; an edit finds its trip again when new data moves a night of it
(the trip that shares most nights with it), and when there is none it waits and changes nothing until there is.

**Raw points are never deleted.** `locationLog` is never written to by the timeline or by an edit. Remove adds the point's device and exact
time to `excluded_point`, and every read of points that the timeline is made from leaves those out (the segmenter's, and the nearest point to
a night); Restore deletes the row. A removal rebuilds the stretch it is in at once (the worker takes it on its next pass, within about
five seconds).

**Writes accept only JSON.** An edit is a `POST`, `PUT` or `DELETE`, and a `POST`, `PUT` or `PATCH` that is not sent as
`application/json` gets `415` and is never run, whether or not it has a body. A page of another site can make a browser send a form, or
a request with no `Content-Type`, but not JSON without asking first (a `DELETE` is no simple request either), and the API serves no CORS;
so once Authentik's cookies sit in front of Sporer a page of another site cannot edit anything with the owner's login.

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
OpenStreetMap credit stays on the map whatever the style says: it shows when the map opens, folds to an ⓘ button after five seconds or the first touch, and ⓘ shows it again. The web app reads the two values from `GET /api/config`.

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
| `Detection__TripMinDistanceKm` | `50` | A night is away, and part of a trip, when its place is at least this far from the home you had that night. The distance you set in the app (Settings, Trips; 5 to 1000 km) is used in its place while it is set, and changing it does not rebuild the timeline. |

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

**Behind the login.** When the session at the login has ended, the app does not show an error that has nothing to do with it: the first request of
the app that the login answers with a redirect (every request of the app is made so that a redirect is seen and not followed) reloads the page, which
the proxy then sends to its login, and after signing in you are back in the app. The reload happens at most once a minute (the tab remembers when it
last did), so a login that keeps redirecting cannot make the page reload for ever: the view that asked shows its error with a Retry instead, as it does
when the browser will not let the tab remember anything (a private window). A request that gets no answer at all (no network) is not a sign-out and
never reloads the page. The installed app's service worker is no part of this: it never answers a request of the
API, and a page that the login redirects to is shown as the login sends it, never replaced by the saved page.

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

- [ ] **The home periods look right, including any move.** Settings (the gear) lists the periods, detected and yours: open a day well before and a day well
  after a move you remember too, and look for the house on the stays at home (it is where the number would be). It should be at the old place
  before the move and the new one after it. A move is noticed once the new home has 60 nights of the last 90, but it is dated from the
  first of them. Places within 250 m of each other count as one home (`Detection__HomeRadiusMeters`), so a home that GPS drift split
  over several places is still one, and a day at two of them shows two houses close together; the synthetic history's move, split over
  four places, is found that way. A home that is still not found would show as **no trips at all** (with no home, no night is away), or,
  after a move that was not noticed, as **one long trip** that does not end. If you see either, set the home yourself (see the checklist
  of "Editing" below), and say so, with where the home is.
- [ ] **A short move may not show as a move.** A move of less than about twice the home radius (about 500 m) may not show as a new home.
  When it does not, the stays at the new home's places that are more than 250 m from the old home show numbers, not a house. Trips are
  unaffected. A home you set in Settings covers it; do that if you moved that little and it bothers you.
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
takes a few minutes for years of history. The trip distance can also be changed in the app, without a rebuild (see below).

## Owner's checklist: editing

On the phone, over the VPN, with the real history. None of these touches the raw points, each can be undone, and none needs a rebuild of the
timeline (an algorithm change, or any `Detection__*` change, makes one, and your edits survive it):

- [ ] **Rename a place.** Open a place from the Day view, tap Rename, type a name, Save. The new name is on the place and on its stays in the
  day and the other views that name places, and, for a place in a trip, in the highlights of the trip's days on which you were there and did not
  sleep there (a trip is named by its cities, and no place name changes that). A day's highlights are the three named places where you spent
  the most time that day, so a short stop may not appear among them; an empty name brings OpenStreetMap's back.
- [ ] **Merge two places, one of them home.** Open the place that is to stay, tap Merge with…, pick the other from the nearest (or search for it), choose
  the name to keep, Merge. Do it for the two places GPS drift made of your own house, so that one of them is home. The stays of both are at
  the one place in the day, its time and visits add up, **the trips and the house on the Day view follow at once**, and the place lists the
  other under it with a **Separate**. Separate it to see it undone, and merge again if you want it merged.
- [ ] **Remove a GPS spike, and undo it.** Open a day with a point far from where you were, tap Edit points, select the spike by tapping it or
  with Select area, Remove. The day is rebuilt within a few seconds (the day says Updating… meanwhile) and the spike's distance is gone from
  it. Tap **Undo** in the toast: the points are back and the day as it was. Then remove it again and leave it: Settings, Removed points, lists
  it with a Restore, and it stays out of the day after the timeline is rebuilt too. (Edit points on a day with tens of thousands of points
  draws them all; say how long it takes on the phone, the target is two seconds.)
- [ ] **Edit mode on the iPhone itself.** The browser tests that run in WebKit in CI leave edit mode out (headless WebKit shows the last frame of a WebGL
  canvas late, so the test that removes points cannot read it there; see "Continuous integration"), so this is where it is checked on Safari's
  engine. Open a day, tap Edit points: the points are drawn on the map; tap one (it is marked), Remove, and Undo; then turn on Select area and
  drag a box over some.
- [ ] **The edit bar at the peek, at larger text.** With edit mode on and the sheet at its lowest (its peek), the edit bar's row (the note or the count,
  Clear and Done) is fully visible without pulling the sheet up, with Safari's text size (the page menu, aA, in the address bar of a page in Safari: the
  app on the Home Screen has no such menu) at 100 %, and again at 115 % and at 125 %. And again with Settings, Display & Brightness, Display Zoom, Larger
  Text: it narrows the page, and it is the one size setting that also applies to the app on the Home Screen. So does a load error of the points (open a
  day, turn on Airplane mode, then tap Edit points): its alert, with its Retry, is in that same row. At large text the row can need a third line and push
  Done below the peek: say so, with the size, if it does.
- [ ] **Re-date and rename a trip, delete one and restore it.** Open a trip, tap Edit, give it a name and another start or end date (the day you
  are back is the end date), Save. The trip, its days and the trips list show the new name and dates, and the address follows a new start
  date. **Use detected dates** puts the detected ones back. Delete another trip (Delete trip): it leaves the list, and is listed under Settings,
  Deleted trips, where **Restore** brings it back.
- [ ] **Set a home override and see the trips follow.** In Settings, Home, tap Set home, pick a place (search by name), and the dates it was home
  (leave the end empty for a home that goes on), Save. Trips that were away from the detected home are worked out against yours for those
  dates, so a trip appears, goes, or changes its nights; Remove takes your home back.
- [ ] **Change the trip distance.** In Settings, Trips, set 100 km, Save: the trips list shows only the trips that far from home, within a
  moment and with no rebuild (`/api/status` shows no backfill). Reset to default goes back to 50 km (or `Detection__TripMinDistanceKm`).
- [ ] **The edits stay.** After the next release, or any restart of the container (the timeline is only rebuilt when an algorithm or a
  `Detection__*` setting changed), your names, merges, removed points, trips, homes and distance are as you left them.

## Owner's sign-off: the §8 targets

v1 is signed off by you, on your iPhone, over the VPN, against your real history once the first backfill has finished (spec §8 and §9). The
performance check in `docs/superpowers/plans/2026-10-29-sporer-plan-5-perf.md` measured every target on a generated history of ten million
rows, on a computer with its processor held back four times and a network like the VPN (60 ms round trip, 20 Mbit/s down, 5 up), and says
what the code does at that volume. It cannot say what the phone does: the map there is drawn by the phone's graphics chip with the real tiles, over
the real network. So each line below is yours, and the target is the spec's. Open the app from the home screen, as you use it, and look at the
clock, not at the feel.

- [ ] **Open the app, cold and installed: the map is visible in 2 seconds or less.** Close the app from the app switcher, open it from the home screen,
  and time it from the tap to the map showing its basemap and the day's list under it. Three times. (The very first start of a new install is slower:
  it has no shell yet. The target is for the installed app.)
- [ ] **A past day after ‹ or ›: 1 second or less, and near instant when it was prefetched.** Open a past day, wait a second, and tap › and ‹ a few
  times: the day should be there at once. Then tap › twice in a row without waiting: the second day may take longer, but not more than a second.
- [ ] **A month: 2 seconds or less.** Open the month with the most going on (the Month button of the top bar), and time it from the tap to the list and
  the routes.
- [ ] **A year: 3 seconds or less.** The same on the busiest year, with all its routes (the answer for a year is half a megabyte, about 150 kB on the wire).
- [ ] **Pan and zoom are smooth, the Year with its routes included.** On the Year, drag the map about and pinch in and out. Look for a stutter. This is the
  one line that no computer can answer: software drawing on the computer is far slower than your phone, so its frame times in the performance check are
  information and no verdict.
- [ ] **Ingest stays fast while processing runs: p95 under 200 ms.** The performance check measured the p95 (34 ms with 1,000-point batches every 0.4 s
  over a whole rebuild); the API logs no request times at its default level, so what you can check is that nothing is refused. The next time the whole timeline
  is rebuilt (the first backfill, or after changing a `Detection__*` setting), leave Overland sending: every batch is accepted (Overland shows no failed
  uploads, and none is retried; Traefik's access log has the times, if it is on), and once the rebuild has ended `pendingRanges` in `GET /api/status` is back
  to 0 (the new points' ranges wait for the rebuild by design, so they rise while it runs). Do not use `tools/perf/ingest-latency.sh` for this: it posts
  made-up points, and a point that is stored is never deleted. It is for a database of generated data.
- [ ] **No unhandled error reaches a blank screen; a failure of one day's processing shows in Settings, for that day only.** Use the app for a while,
  and try the worst: open it with Airplane mode on (the views say they could not load, with a Retry, and nothing is blank), turn it off and tap Retry;
  look at Settings for failed ranges and warnings after a rebuild.
- [ ] **The installed app behaves** (see "Installing on the iPhone"): a start with no network shows the app and not a browser error; a release reaches the
  app on its next start after the server was updated; if the session at the login ended, the app goes to the login by itself and comes back.
- [ ] **Edit mode on the iPhone** is in the editing checklist above, with the edit bar at larger text: the browser tests in CI cannot check it in WebKit.
- [ ] **Detection quality** is only signed off on real data, so it is yours too: the two checklists above, "Owner's checklist: trips and home" (the home
  periods and any move, each trip you remember and no trip that is not one, a long stay that is not a move, the house on the stops at home, the
  day lines of a trip) and "Owner's checklist: editing" (a spike removed and undone, two places of one house merged, a trip re-dated and one deleted
  and restored, a home you set, the trip distance, and that your edits are still there after the next release). Where something is wrong, the
  `Detection__*` settings are in "Detection thresholds", and an edit puts it right in the app.

If a line misses, say which, with the time and the phone, and what you were doing: the performance document says where the time goes.

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
pull requests run the tests and a build without publishing. So does a run started by hand on any branch or tag but `main` and the
`v*` tags (it publishes on those): see [Continuous integration](#continuous-integration).

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

The API is published ReadyToRun: its code is compiled ahead of time, so that the first requests, the first edit and the first
refresh after a start wait less for the JIT (they still wait for some of it). That code is for one architecture, taken from the
platform being built: BuildKit, which `docker build` uses by default, sets `TARGETARCH` to the architecture of the build (the host's,
unless `--platform` says another), and `amd64` gives `linux-x64` and `arm64` gives `linux-arm64`; only the classic builder leaves it
empty, which gives `linux-x64`. Any other value fails the build. The app stays framework-dependent, on the same `aspnet` image as
before. For the rest, after the migrations the app reads the nights and works the homes and trips out once in the background, and throws
the result away, so that the first refresh and the first edit do not compile that code while you wait: it writes nothing and takes no
lock, and a failure is only logged as a warning; the log says `Warmed up the homes and trips` when it is done.

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
| `npm run typecheck` | `tsc --noEmit`, with `strict` on, for four projects: the app, the service worker (`src/sw`), the build's configuration (`build`) and, with Node's few declarations, the performance run (`web/perf/tsconfig.json`). |
| `npm test` | The unit and component tests (Vitest, jsdom). |
| `npm run e2e` | The browser tests (Playwright, Chromium), against the production build with the API mocked: no API, database or internet is needed. Run `npx playwright install chromium` once first. The map is drawn with software WebGL, so no GPU is needed either, but it takes a couple of minutes. With `PW_WEBKIT=1` it adds a WebKit project that runs only the tests tagged `@smoke` (see below). |
| `npm run perf` | The web performance run (spec §8), on a phone-sized page with the processor held back 4 times and, unless `PERF_NETWORK=off`, a network like the VPN (60 ms round trip, 20 Mbit/s down, 5 up): the panel's rows and the map's idle for a day, a month and a year (and the step to the next, with its answer prefetched and not), the list of trips and each trip, edit mode on the day with the most points, the app opened on today as a first visit and as the installed app (the service worker active, its cache filled), and a scripted pan and zoom on the year with its routes. The API's answers are those recorded by `npm run perf:record` from a server over the synthetic history, served over real HTTP by `web/perf/serve.mjs` as the API serves them (Brotli, cache headers). Not part of `npm run e2e` or CI; takes about six minutes (94 tests). How to run it, and its results, are in `docs/superpowers/plans/2026-10-29-sporer-plan-5-perf.md` and, for the earlier plans, `docs/superpowers/plans/2026-10-24-sporer-plan-2-perf.md`, `docs/superpowers/plans/2026-10-26-sporer-plan-3-perf.md` and `docs/superpowers/plans/2026-10-28-sporer-plan-4-perf.md`. |
| `npm run perf:record` | Records those API answers, the trips' and the points of the day with the most of them among them (`node scripts/perf/record.mjs <api-url> <first-date> <last-date>`; it asks for the points of every day, which takes about half a minute), into `web/perf/recorded/`, which git ignores. |
| `npm run perf:bundle` | After a build: the size of each JavaScript file of the production bundle, gzipped and Brotli-compressed. `npm run check:sw` prints what the service worker keeps. |
| `npm run build` | Type checks and builds the web app into `src/Sporer.Api/wwwroot`, which the API serves (and git ignores). |
| `npm run icons` | Draws the PNG icons in `public/icons/` again from `icon.svg`. Only when the icon changes. |

### Continuous integration

`.github/workflows/docker-publish.yml` (Create Docker Image) has three jobs:

- `test`: the .NET tests (`dotnet test src/Sporer.sln`).
- `web`: `npm ci`, `npm run typecheck`, `npm test` and `npm run e2e` (with `PW_WEBKIT=1`) in `web/`. The browser tests run in Chromium and a smoke
  set of them also in WebKit, the engine of iOS Safari. The Playwright browsers are cached on the version in `web/package-lock.json` (saved even
  when a test fails; a cache is per branch and goes after 7 days unused, so the first run on `main` after a merge installs them again); a run
  that finds them in the cache still installs the system packages they need.
- `build`: always builds the image, so that the Dockerfile is checked on every run, and publishes it (cosign, the login, the push and the
  signature) only for these events:

  | Event | The image |
  | --- | --- |
  | Push to `main` | built and published |
  | Push of a `v*.*.*` tag | built and published |
  | Pull request | built, not published |
  | Run workflow by hand on `main` or on a `v*` tag | built and published |
  | Run workflow by hand on any other branch or tag | built, not published |

The WebKit smoke set is the tests tagged `{ tag: "@smoke" }`: one or two of each flow (the app opens on today, day navigation, the month,
opening a trip, renaming a place, Settings, and the service worker installing from a page that is not the app). Two kinds of test stay with
Chromium. The test of removing points reads the pixels of the points right after edit mode sets them, and headless WebKit puts the last frame of a
WebGL canvas into a screenshot late (the points are in the canvas, and in the screenshot only after another frame is drawn, which an idle map does not
do; the trips test, whose map keeps moving, runs on WebKit too). The two service-worker cases that need the page's requests to reach the test's mocks
are not routed by Playwright on WebKit while a worker controls the page. Edit mode on Safari is in the owner's iPhone checklist. The smoke set is a project called `webkit` that exists only when
`PW_WEBKIT=1`, so only CI runs it by default; a plain `npm run e2e` is Chromium's two projects. The project uses Playwright's iPhone 14
descriptor (WebKit, touch, the phone's pixel density). Where WebKit is installed (`npx playwright install webkit`; on Linux add `--with-deps`),
run it with:

```sh
cd web
PW_WEBKIT=1 npx playwright test --project=webkit
```

To check a branch before it is merged, without publishing anything: Actions, Create Docker Image, Run workflow, and pick the branch. The
`test`, `web` and `build` jobs all run, and `build` pushes nothing, as it does for a pull request: only `main` and a `v*` tag are published when
the run is started by hand.

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
places the way Nominatim would. For editing, `tools/perf/edit-latency.sh` times the edits that recompute the homes and trips,
`tools/perf/points-latency.sh` the points of a day, `tools/perf/exclude-points.sql` removes a thousand points spread over the history (to time a
backfill with removals) and `tools/perf/explain-edits.sql` shows the plans of the removal's anti-join, the day's points and the place search.
`tools/perf/first-after-start.sh` starts the API itself and times the first refresh, edit and reads after each start (what ReadyToRun and the
warm-up are for), and `tools/perf/rng.awk` is the seeded random generator that `api-latency.sh` and `day-latency.sh` share.
The measurements at 10 million rows, and how to repeat them, are in
`docs/superpowers/plans/2026-10-23-sporer-plan-1-perf.md` (server), `docs/superpowers/plans/2026-10-24-sporer-plan-2-perf.md` (range, heat,
place, the web app), `docs/superpowers/plans/2026-10-26-sporer-plan-3-perf.md` (the nights, homes and trips: the backfill, the refresh,
the trips endpoints and views), `docs/superpowers/plans/2026-10-28-sporer-plan-4-perf.md` (editing: the backfill with removed points,
the edits, the day's points, the place search and edit mode on a phone) and `docs/superpowers/plans/2026-10-29-sporer-plan-5-perf.md` (the final pass
over every target of spec §8, on the published ReadyToRun build and with a network like the VPN, the installed app, the first requests after a start,
ingest while the timeline is rebuilt, and the pan and zoom of the year).
