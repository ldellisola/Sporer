# Sporer Plan 6 — rulings, parked findings and checks before release

These are the decisions made on the owner's behalf while building Plan 6:
- edit mode draws the points the timeline ignores as hollow rings;
- a tap on a point opens a card with everything known about it;
- a Settings switch draws the routes of weeks, months and years at full strength.

The plan was built task by task, with a separate review of each task, then a whole-branch review and one fix wave. Each decision states what it costs if it turns out wrong.

## Check before the `v1.3.0` tag

The acceptance test is the editing checklist in the README. In short:

- **Hollow points on a day with no GPS.** Open a day with cell-tower fixes, for example a stretch indoors or underground, and tap Edit points. The fixes worse than the accuracy limit (100 m by default) are hollow rings, and the solid dots are the ones the timeline uses. Pull the sheet up to read the hint that explains the rings.
- **A point's card on the phone.** Tap a point. The card opens above or below it, inside the map and clear of the map's buttons, also for a point near an edge. It shows:
  - the time;
  - the place;
  - the accuracy, speed and altitude;
  - whether the timeline uses the point, and why not if it doesn't;
  - the points before and after it;
  - the stay or move it is part of.

  It closes with ×, with a tap on the empty map, on another day, or with Done.
- **Select area.** With Select area on, a tap selects a point without opening a card, and turning Select area on closes an open card.
- **The routes switch.** In Settings, Map, turn off "Fade routes in weeks, months and years". A month's routes draw as strongly as a day's, and under the heat layer they stay faint. The setting is kept per browser: the app on the Home Screen keeps its own, separate from Safari's.

These cannot be verified in the build container:
- the card and the rings on the iPhone itself (no iPhone);
- WebKit drawing the map's pixels (the smoke set leaves those to Chromium, P5-R13).

**Upgrading from v1.2.0.** There are no migrations and nothing to configure. The app on the Home Screen picks the release up the next time it is started.

## Rulings

- **P6-R1.** The detail endpoint classifies a point among the 20 nearest not-removed points on each side, on any device, so its status agrees with the day's list. For a (device, time) stored twice it describes the first row, the one the timeline uses. *If wrong:* the card and the dots can still disagree across a run of more than 20 unusable points.
- **P6-R2.** The day's list classifies with the same margin: the 20 nearest not-removed points before and after the day, ordered by time and then device. One shared helper (`PointSpan`) builds the window for both endpoints. This amends the plan's "the nearest point before and after the day". *If wrong:* two extra bounded queries per day's list.
- **P6-R3.** No query names `ctid`. TimescaleDB refuses it on compressed chunks, and a fix brief's suggestion of it had broken both point endpoints on compressed history. A test now compresses a chunk and asks both endpoints. Every window query looks within one day of the point first, and goes unbounded only when fewer than 20 rows come back. *If wrong:* a second query on sparse history, measured at 155 to 460 ms.
- **P6-R4.** The ring of an ignored point uses the app's muted ink, light #6C6C70 and dark #8E8E93. That gives 3:1 contrast on the light map, and the ring is distinct from the routes of an unknown mode. *If wrong:* one scheme-dependent paint branch.
- **P6-R5.** The detail answer carries `maxAccuracyM`, the server's `Detection__MaxAccuracyMeters`. The card's "more than N m" uses it, and no accuracy limit is written into the web app. *If wrong:* one field.
- **P6-R6.** The card writes distances with the app's own format, so there is no decimal from 100 km up. *If wrong:* "123 km" for "123.4 km" on a long gap.
- **P6-R7.** When the card closes while the keyboard focus is inside it, the focus goes to the map. Retry moves the focus to the card's ×. *If wrong:* one focus call.
- **P6-R8.** The commits keep the session's `Co-Authored-By` attribution trailer, as on Plans 1 to 5. The rule against model names covers code, docs and message bodies. *If wrong:* nothing beyond the trailer.
- **P6-R9.** The card keeps clear of the map buttons' real rectangle, measured when the card is placed, not of a full-height strip. A point anywhere outside the buttons gets a card with a pointer. *If wrong:* one layout read per placement.
- **P6-R10.** With Select area on, a tap selects a point without opening a card, and turning Select area on closes an open card. Area mode is for selecting many points, and an open card swallowed the next box drag. *If wrong:* to inspect a point in area mode, turn area mode off first.
- **P6-R11.** CI's web job runs on Ubuntu 24.04. GitHub's `ubuntu-latest` has been Ubuntu 26.04 since late October 2026, and there Playwright 1.56 installs none of WebKit's system packages yet exits 0, so every WebKit test failed at launch. The .NET and image jobs stay on `ubuntu-latest`. *If wrong:* a manual move back once Playwright supports 26.04.

Every finding set aside by the whole-branch review was accepted as set aside:
- the timeline's own rebuild window, which is part of the algorithm and outside this plan;
- the accepted costs of P6-R1 and P6-R3;
- the WebKit, dark-scheme and iPhone items, which belong to the owner's checklist;
- the tap that both selects and opens, which the plan mandates;
- the card's "1 min 1 s" for gaps, also mandated;
- the trips map, which draws no routes;
- the release tag.

## Notes for later

- **Unpin CI's web job** (P6-R11) once Playwright supports Ubuntu 26.04. The upgrade is a version bump in `web/package.json`, then `runs-on: ubuntu-latest` again.
- **The timeline's rebuild and the day's list judge a rebuild's first point differently.** The processor cleans from the anchor stay with no margin before it, while the list uses 20 points. They can only differ for an out-and-back spike that falls exactly at a rebuild's first point.
- **Twin rows** (a re-sent batch) are one point to every edit: tapping either twin selects the same (device, time), and Remove removes both. The card of the twin drawn as a repeat says so, and says the timeline uses the first row only when it does (the whole-branch re-review's last finding, fixed before the merge).
