# Sporer trains and buses: rulings and checks before release

These are the decisions made on the owner's behalf while building trains and buses
(`docs/superpowers/specs/2026-11-26-sporer-transit-design.md`). The owner chose three things on 2026-11-26:
- one `train` mode for all rail, and no ferry;
- buses by length (under 20 km), else by bus-route matching;
- a way to set a move's mode by hand.

The rest are calls. The server, the web app and the native app were each built against the design. A review of the whole change followed,
with a skeptic checking each finding, and one fix wave. All of it was built and tested on the owner's Mac, not on GitHub Actions. Each
decision says what it costs if it turns out wrong.

## Check before the `v1.4.0` tag

Only the owner can check these, on real data and real devices:

- **Trains and buses on your history** (README, "Owner's checklist: trips and home", Trains and buses). Every railway in the automated tests
  is made up. The real Overpass API was asked only in one local end-to-end run (see "End-to-end run" below).
- **The mode menu in Safari on the iPhone** (README, "Owner's checklist: editing", Set a move's mode). The browser test of the menu is in the
  WebKit smoke set, but WebKit is not installed on this Mac, so it was run in Chromium only. CI runs it in WebKit.
- **The native app's context menu on a real iPhone, and with a right click on the Mac.** On an iPhone simulator it opened and worked, with
  the checkmark on the current mode (see "End-to-end run"). The Mac app was only built. Does the menu also open on a move row with no line?
- **Reinstall the native app** once the server is updated. The build on the iPhone cannot read `bus` or `train` (README, "The native app").
- **The user agent.** Overpass gets `Transit__UserAgent`, or else `Nominatim__UserAgent`. Set the first if the second should not be
  sent to Overpass. `Transit__Enabled=false` stops all Overpass requests.

**Upgrading from v1.3.2.** There is one migration, `0007_transit.sql`, and nothing to configure. The first start rebuilds the whole
timeline once, a few minutes for years of history. Trains then appear over the next hours, as railway tiles arrive.

## Where the build differs from the design

- **TR-R1. The web's bus is `#9A7D59`, not `#A2845E`.**
  - `#A2845E` falls below 3:1 on three of the light map's surfaces: the background, parks and housing. The ratios run from 2.77 to 2.99.
  - `#9A7D59` has the same hue and passes all four surfaces. The design allows this (§6, P6-R4). `layers.ts` has the method and the ratios.
  - The native app uses the system brown. The dark map was not measured.
  - *If wrong:* one colour.
- **TR-R2. The rebuilds that follow arriving tiles are batched.**
  - The design (§3) said each tile's arrival rebuilds the stretch of the moves that waited for it. A tile near home is wanted by moves
    from every year, so its stretch is the whole history. With a few hundred tiles arriving 10 s apart, that meant a full rebuild after
    nearly every tile, for an hour or more.
  - Now an arriving tile only widens one held stretch (`processing_state.transit_ready_from`/`_to`). The worker asks for it as one rebuild:
    - not while a backfill is open, paused or not, because the backfill reads the tiles anyway;
    - at once when no other tile is due to be fetched;
    - otherwise at most every 10 minutes (`ProcessingQueue.TransitHold`, a constant).
  - On the first start that is one rebuild after the backfill, then about 6 or 7 over the hour of arrivals.
  - A held stretch does not make the days in it `pending`. Counting it would mark every day pending for that hour.
  - *If wrong:* trains appear up to 10 minutes later than they could.
- **TR-R3. A short slow stretch between two pieces of a train ride is part of the ride.**
  - The design merges touching train moves, because a fast train is cut by the flight rule where it slows down. A dip shorter than
    `TrainMinDistanceKm` never asks for railways, so it became a bus and split the ride.
  - It is now joined into the ride when it touches a train on each side, is not a flight, and its mode was not set by the owner.
  - *If wrong:* a real stop of under 1 km between two high-speed runs is drawn as one ride.
- **TR-R4. A flight that becomes a train needs no `TrainMinDistanceKm`.** The design lists three conditions for it: dense points, p90
  speed, and 80 % near a railway. It is always over 100 km anyway (`Detection__FlightMinDistanceKm`). *If wrong:* nothing in practice.
- **TR-R5. Railway tiles for a walk or a ride are asked for only when its tunnel-like hops make half its path.** The design said "a
  tunnel-length hop". A single long hop can never make such a move a train (§2 rule 3), so fetching its tiles would be wasted.
  *If wrong:* nothing; the rule is the classifier's own.
- **TR-R6. Every failed Overpass request backs off.** The design named 406, 429, 5xx and timeouts. Now any failure counts:
  - a 400, a network error, an answer that cannot be read;
  - a 200 whose `remark` reports an error. Overpass reports a query that ran out of time or memory that way, and keeping that answer
    would store an empty or partial tile forever.

  This is what place naming does. *If wrong:* a tile waits longer than it had to.
- **TR-R7. Tile backoff is 2, 4, 8 and 16 minutes.** From the fifth failure the tile is set aside and tried once a day. A success resets
  the count and the global pause. *If wrong:* constants.
- **TR-R8. `DELETE /api/moves/{id}/mode` always answers 204 and always rebuilds the stretch.**
  - It does so even when there was no edit.
  - Until the rebuild, the stored move keeps the owner's mode and `modeEdited`, and the day is `pending`. The detected mode is not
    known before the rebuild.
  - Both apps keep asking for the day every 3 s for two minutes after a mode change, as after removing points.
  - *If wrong:* a few seconds of the old mode after "As detected".
- **TR-R9. An id that is not a positive whole number is a 400 on both mode endpoints**, as on the place and home endpoints. The id of a
  stay or a gap is a 404. Mode names are exactly the six, in lower case. *If wrong:* a status code.
- **TR-R10. `transit.enabled` in `/api/status` means "switched on, with a user agent".** It ignores `Processing__Enabled`, which stops
  the fetcher too (the README says so). *If wrong:* a flag that reads true on a server that is not fetching.
- **TR-R11. A fetched tile always has its lines.**
  - The database refuses a `done` tile without lines or `fetched_at` (`transit_tile_done_has_lines`).
  - A database from before that constraint, with such a row, has the tile sent back to be fetched again. Before, that row looped the
    worker.
  - *If wrong:* nothing.

## Choices the design left open

- **TR-R12. Choosing the mode a detected move already has keeps it as the owner's.** This is the same on the web and in the native app,
  and the README says so. It is how the owner stops later detection from changing a move, for example when a railway tile arrives.
  Choosing it again is saved again, because after "As detected" the row can still show the old mode. *If wrong:* one PUT too many.
- **TR-R13. A merged train ride counts as set by the owner when any of its pieces was.**
  - Edits are applied before the merge, and only trains are merged.
  - So setting `bus` over a whole merged ride brings back its pieces, each a bus.
  - An owner-set dip (TR-R3) is never absorbed.
  - *If wrong:* the owner sees several bus moves where one ride was.
- **TR-R14. The web's mode menu opens in place under its row**, not as a pop-up, as the other edits do. It follows the menu-button
  pattern.
  - Only one change runs at a time. While one is saving, every row's menu is marked unavailable.
  - A 404 (the day was rebuilt meanwhile) is said once, above the timeline, and the day reloads.
  - Move rows are keyed by start time, because ids change on every rebuild.

  *If wrong:* layout.
- **TR-R15. The native app's menu is a Mode submenu in the move row's context menu.**
  - It lists the six as toggles, so the current mode shows its checkmark, with Use Detected Mode after a divider.
  - The marker reads "Set by You", as in Settings, Home.
  - While one change is saving, every row's submenu is disabled and no VoiceOver action is offered.
  - A 404 shows a toast, "The day had changed. Try again.", and the day reloads.
  - There is no Undo toast: the ids change on the rebuild.

  *If wrong:* menu layout.
- **TR-R16. A mode an app does not know.** The web shows "Move" in grey. The native app treats it as no mode, through one tolerant
  decoder that the day, range and trip decoders all use. *If wrong:* nothing until the server gets a seventh mode.
- **TR-R17. `TravelMode` gains `Bus` and `Train` at the end.** The numbers of the existing modes stay. Nothing stores the number, only the
  name. *If wrong:* nothing.
- **TR-R18. `CodeVersion` is 3.** The new detection settings change the options hash anyway; the bump makes the one full rebuild explicit.
  *If wrong:* nothing.

## End-to-end run

On 2026-11-26, a local server on this Mac ran with its own empty database, fetching from the real Overpass API with a generic user
agent. It was sent one synthetic Overland batch of 374 points (`motion: automotive` throughout):
- a 6.3 km ride along T-bane line 1, from Majorstuen to Holmenkollen, built from the line's OpenStreetMap geometry;
- a 4.2 km ride back by road, on streets west of the railway;
- a stay before, between and after.

- After the one-minute debounce, both rides were buses (under 20 km, no railway cached yet). Each asked for the same two railway
  tiles (59.9–60.0° N, 10.6–10.7° E and 10.7–10.8° E).
- The first tile arrived after 36 s: 245 lines. Its stretch was held, because the second tile was due.
- Overpass answered the second tile with a 504. The tile backed off 2 minutes and all requests paused. With no tile due any more, the
  held stretch was rebuilt a second later. The ride stayed a bus, because its path runs through both tiles.
- The second tile's next try met a 502 and backed off 4 minutes. The try after that brought it: 687 lines. No tile was due, so the held
  stretch was rebuilt 5 seconds later.
- **The T-bane ride became a train (6.3 km). The road ride stayed a bus (4.2 km).** `/api/status` ended with 2 tiles cached, none waiting,
  none failed, and no pending or failed ranges.
- In the web app (served by that server, in Chromium), the train was purple along the line and the bus brown. Setting the road ride
  to Drive showed "set by you". "As detected" kept it until the rebuild, then brought back Bus.
- In the native app on an iPhone simulator against the same server, a long press on the train row opened the context menu. Mode listed
  the six modes with Train checked. Bus showed "Set by You", and Use Detected Mode brought the train back, with no `mode_edit` row left.
  The Mac app was built but not opened.
- The native app's live tests (`ios/scripts/test.sh --live`) ran against a second local server with the synthetic history and fetching
  off: 14 passed, setting and taking back a move's mode among them.

## Notes for later

- **Antimeridian.** A railway that crosses ±180° is not found from the other side. Nothing in Oslo's travels is affected.
- **Fresh tiles** are fetched again only by deleting their rows and rebuilding (README, "Fresh lines"). There is no endpoint for it.
- **The browser tests on macOS.** Four tests failed on this Mac before the change and still do: `range.spec.ts:393` on phone and
  desktop, and `shell.spec.ts:180` and `:204` on desktop. CI runs on Linux; they are not caused by this work.
- **Later work** stays in the design's §8: splitting a move where the mode changes, ferries, per-mode figures and refreshing tiles.
