# Sporer v1.3.0

## What's new

- **Hollow points.** In edit mode, the points the timeline already ignores (no GPS fix, a glitch, a repeat) are drawn hollow, with a hint under the row saying why.
- **The point's card.** Tap a point in edit mode to see everything known about it: its time and zone, accuracy, speed, altitude, the stay or move it is in and how far it is from the points either side. It closes with the ×, Escape or a tap on the empty map.
- **Routes at full strength.** Settings, Map, "Fade routes in weeks, months and years" (on, as before): turn it off to draw the routes of weeks, months and years as strongly as a day's. It is kept per device.

## API

- `GET /api/day/{date}/points` now gives each point a fifth element, its status: `0` used, `1` poor accuracy, `2` glitch, `3` repeat.
- New `GET /api/points/detail?device=…&t=…` returns one point in full, including a removed one.

## Upgrading

No migrations and nothing to configure: pull the new image.
