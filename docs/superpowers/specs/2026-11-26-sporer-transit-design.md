# Sporer: trains and buses

- **Date:** 2026-11-26
- **Status:** decisions marked (owner) were made by the owner on 2026-11-26; the rest are calls they can overturn
- **Replaces:** web app spec §2 "Train / public-transport detection", §4.2's list of route colours (for bus and train), §6.5 "Train is
  shown as drive in v1" and the train line of §11
- **As built:** where the build differs from this design (the web's bus colour, batched rebuilds as tiles arrive, short dips inside a
  train ride, and smaller points), see `docs/superpowers/plans/2026-11-26-sporer-transit-rulings.md`

Throughout, **(owner)** marks a decision the owner made; **(call)** marks a decision made on their behalf.

---

## 1. Intent

Today a move is walked, cycled, driven or flown. A train is called *drive*, because speed alone cannot tell a train from a car, and a bus is
*drive* too. The owner lives in Oslo and travels by train, metro, tram and bus far more than by car, so most "drive" moves are wrong.

Two new modes come in, and the owner can correct any move by hand:

| Mode | What it covers |
| --- | --- |
| `train` | Every kind of rail: mainline and local trains, the metro (T-bane), trams, light rail, funiculars **(owner: one mode for all rail)** |
| `bus` | Buses and coaches |

Ferries stay as they are (owner). The full list of modes becomes **walk, cycle, drive, bus, train, flight**.

## 2. How a move gets its mode

Segmenting (stays, moves, gaps, flights) does not change. Each move's mode is then decided in this order. The first rule that applies wins.

1. **The owner's choice.** If the owner set a mode on a move (§5), and that edit covers more than half of the move's time, the move has that mode.
2. **Detected as before.** The existing classifier gives the *base* mode: flight, or else Overland's motion, or else the median speed
   (`Detection__WalkMaxKmh`, `Detection__CycleMaxKmh`). The rules below only ever change a base mode.
3. **Train: the move follows a railway.** Railway lines come from OpenStreetMap (§3). Only a move whose whole path has railway data
   cached can become a train; until then it keeps the mode the next rules give it, and becomes a train later, when the data arrives.
   - A *drive* move is a train when at least `TransitMinShare` (80 %) of its path is near a railway and at least `TrainMinDistanceKm` (1 km) is.
   - A *flight* is a train when it looks like ground travel and follows a railway: at least one point per 2 km of its path, the 90th
     percentile of its hop speeds at most `TrainMaxKmh` (350 km/h), and 80 % of its path near a railway. Its line is then the points it
     went through and its distance their sum, not the great-circle arc (a high-speed train across Europe or Japan is no longer a flight).
   - A *walk* or *cycle* move is a train only through a tunnel: the tunnel hops (below) make at least half of its path, and 80 % of the
     whole path is near a railway. This is a metro ride underground with a short walk at each end, which the phone reports as walking.
4. **Bus.** A *drive* move that is not a train:
   - is a bus when it is shorter than `BusMaxKm` (20 km) **(owner)**;
   - is a bus when it is longer and at least 80 % of its path is near a bus route (§3) **(owner: "try bus-route matching")**;
   - stays *drive* otherwise.
5. Otherwise the base mode stands.

Adjacent moves that both end up as *train*, with nothing between them, are merged into one move **(call)**: a fast train is split by the
flight rule wherever it slows down, and the pieces are one ride.

### 2.1 What "near" means

- The path is the move's cleaned points in time order. Each hop between two points is sampled every 25 m, both ends included.
- A sample is **near** a line when its distance to the line is at most `max(TransitNearMeters, min(accuracy, 75 m))`, where
  `TransitNearMeters` is 30 m and `accuracy` is the worse reported accuracy of the hop's two points (none reported counts as 0).
- A hop's matched length is its length times the share of its samples that are near. A **tunnel hop** is a hop of at least
  `TunnelMinMeters` (500 m) whose two ends are both within `TunnelEndMeters` (150 m) of a railway and whose implied speed is between
  15 and 350 km/h: all of it counts as near a railway, wherever its straight line runs.
- The share is the matched length over the path's length. Hops of no length are left out.
- Bus routes use the same rule without tunnels.

### 2.2 What is known not to work (call)

- **A car on a road beside a railway**, closer than about 30 m for most of the way, is called a train. A **bus on a street with tram
  tracks** for most of its ride is called a train too. The owner corrects these by hand (§5).
- **A ride split by a stop of 5 minutes or more** (a long wait in a station) is two moves, as today.
- **A move that is walk, then train, then walk** with no stop between is one move with one mode. It is a train when the rail part is
  at least 80 % of it. Splitting moves where the mode changes is left for later.
- **Speed-only history** (before Overland sent motion) calls slow trams and buses *cycle*. They stay *cycle* (the owner cycles too).
- **A ferry** shorter than 20 km has a base mode of *drive* when Overland says automotive or the speed is above 25 km/h, so it becomes a *bus*.

## 3. Where the railway and bus lines come from (call)

The lines come from OpenStreetMap through the public **Overpass API**, are fetched in the background, and are kept in the database. This
follows the owner's rule for place names: "Public OpenStreetMap services are fine, with results cached".

- **Tiles.** The world is cut into tiles of 0.1° by 0.1° (about 11 km by 6 km in Oslo). A tile is fetched once per kind and kept for good.
  Railways change slowly; an owner who wants fresh lines deletes the cached tiles (README).
- **Two kinds of tile.**
  - `rail`: ways tagged `railway` = `rail`, `light_rail`, `subway`, `tram`, `narrow_gauge`, `monorail` or `funicular`, without
    `service` = `yard`, `siding`, `spur` or `crossover` and without `usage` = `industrial`, `military` or `test`.
  - `bus`: the ways that are members of relations tagged `route` = `bus`, `trolleybus` or `coach`.
- **Queries** (S, W, N, E are the tile's edges):

  ```
  [out:json][timeout:90];
  way["railway"~"^(rail|light_rail|subway|tram|narrow_gauge|monorail|funicular)$"]
     ["service"!~"^(yard|siding|spur|crossover)$"]["usage"!~"^(industrial|military|test)$"](S,W,N,E);
  out tags geom(S,W,N,E) qt;
  ```

  ```
  [out:json][timeout:90];
  rel["route"~"^(bus|trolleybus|coach)$"](S,W,N,E);
  way(r)(S,W,N,E);
  out skel geom(S,W,N,E) qt;
  ```
- **Only what is needed is fetched.** A move asks for the tiles within 150 m of its samples, and only when the answer could change its
  mode: rail tiles for a drive move of 1 km or more, for a flight that looks like ground travel, and for a walk or cycle move with a
  tunnel-length hop; bus tiles only for a drive move of 20 km or more that is not a train. When a tile arrives, the stretch of time of
  the moves that asked for it is rebuilt, so their modes follow without a full rebuild.
- **Politeness.** One request at a time, at least `Transit__MinInterval` (10 s) apart, with a `User-Agent` that names the operator
  (`Transit__UserAgent`, else `Nominatim__UserAgent`). A refusal (406, 429) or a failure (5xx, a timeout) backs the tile off (2ⁿ minutes,
  up to 24 h) and pauses all requests (1 minute, doubling up to an hour). A tile that failed 5 times is set aside and tried again once a day.
- **Privacy.** The Overpass server learns which tiles were asked for, that is where the owner travelled, to about 10 km. Nominatim
  already learns the places themselves. `Transit__Enabled=false` stops all requests; lines already cached are still used.
- **Order.** Tiles of the most recent travels are fetched first.
- **Determinism.** Processing reads only the cache, never the network. The same points and the same cache give the same timeline,
  whatever the order in which stretches are rebuilt.
- **First start after the update.** The detection rules change, so the whole timeline is rebuilt once (a few minutes). Short drives become
  buses at once. Trains appear over the following hours, as tiles arrive: a few hundred tiles for years of history in and around Oslo,
  at one every 10 s or so.

## 4. API

Mode values on the wire: `walk`, `cycle`, `drive`, `bus`, `train`, `flight` (and `null` for a move stored without one, as today).

- **Day** (`GET /api/day/{date}`): a move gains `modeEdited` (boolean, always present): true when the owner set its mode.
- **Range, trip, point detail:** unchanged apart from the new values.
- **Trip stats:** buses and trains are ground travel: `groundDistanceMeters` counts them and `flights` does not.
- **`PUT /api/moves/{id}/mode`** with `{"mode": "train"}` sets the mode of the stored move `id` (an id from the day, range or trip
  answer). It stores the edit over the move's time, replacing any edit that overlapped it, changes the stored move at once, and asks for
  the move's stretch to be rebuilt (so its line and distance follow a change to or from *flight*). Answers 200 with
  `{"id", "mode", "modeEdited": true}`. 404 when no stored move has that id (ids change on every rebuild: the client reloads the day),
  400 for a mode that is not one of the six.
- **`DELETE /api/moves/{id}/mode`** removes every edit that overlaps the move's time and asks for the stretch to be rebuilt, which brings
  back the detected mode. Answers 204; 404 as above.
- **Status** (`GET /api/status`) gains `transit`: `{"enabled", "tiles": {"cached", "waiting", "failed"}}`.

## 5. Changing a move's mode by hand (owner)

- **Web.** In the day view, every move row has a mode menu next to it, whose visible text is the move's mode. It lists the six modes
  with the current one checked and, when the owner set it, "As detected" to undo the choice. The row says "set by you" when the owner set
  the mode. The choice is saved at once, the day reloads, and a failure is said in the row with Retry.
- **Native app.** The move row in the day's rail has a context menu (a long press on the iPhone, a right click on the Mac) with a *Mode*
  menu listing the six modes, the current one checked, and *Use Detected Mode* when the owner set it. VoiceOver offers the same as actions.
- **Kept across rebuilds.** Edits are kept by time span, like removed points and trip edits, and survive every rebuild and a full
  rebuild after a change of settings.

## 6. How the modes look (call)

| Mode | Word | Colour (web, light and dark) | Colour (app) | Symbol (app) |
| --- | --- | --- | --- | --- |
| train | Train | `#AF52DE` (the mockup's train colour) | system purple | `train.side.front.car` |
| bus | Bus | `#A2845E` | system brown | `bus.fill` |

The other modes keep their colours. Routes of both draw solid, like drive. A colour that fails the web map's 3:1 contrast rule (P6-R4) is
darkened for the web only.

Both apps must survive a mode they do not know (a server newer than the app): the web shows "Move" in grey, and the native app treats
it as no mode. The native app already installed on the iPhone fails today on an unknown mode, so it is reinstalled with this release.

## 7. Settings

New `Detection__*` settings (changing any of them rebuilds the whole timeline, as for the others):

| Variable | Default | Meaning |
| --- | --- | --- |
| `Detection__TransitNearMeters` | `30` | A point this close to a railway or bus route is on it (widened to the point's accuracy, up to 75 m). |
| `Detection__TransitMinShare` | `0.8` | The share of a move's path that must be on a railway (or bus route) for it to be a train (or bus). |
| `Detection__TrainMinDistanceKm` | `1` | A train ride covers at least this much railway. |
| `Detection__TrainMaxKmh` | `350` | A "flight" whose hops are mostly slower than this, and that follows a railway, is a train. |
| `Detection__TunnelMinMeters` | `500` | A hop at least this long between two points near a railway counts as a ride through a tunnel. |
| `Detection__TunnelEndMeters` | `150` | How close to a railway both ends of a tunnel hop must be. |
| `Detection__BusMaxKm` | `20` | A motorised move shorter than this that is not a train is a bus. |

New `Transit__*` settings (changing them rebuilds nothing):

| Variable | Default | Meaning |
| --- | --- | --- |
| `Transit__Enabled` | `true` | Fetch railway and bus lines from Overpass. Off, the lines already cached are still used. |
| `Transit__OverpassUrl` | `https://overpass-api.de/api/interpreter` | The Overpass API to ask. |
| `Transit__UserAgent` | (`Nominatim__UserAgent`) | Required by Overpass; without it nothing is fetched. |
| `Transit__MinInterval` | `00:00:10` | The least time between two requests. |

## 8. Later

- Splitting a move where the mode changes (walk, train, walk).
- Ferries, and boats in general.
- Per-mode figures in trips and periods ("3 h by train").
- Refreshing cached tiles.
