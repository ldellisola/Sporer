# Sporer v1.4.0

## New

- **Trains and buses.** A move can now be a bus or a train, besides a walk, a ride, a drive or a flight.
  - A drive that follows an OpenStreetMap railway for most of its way is a train: mainline trains, the T-bane, trams and the rest.
  - So is a metro ride underground that the phone logged as a walk, and a high-speed train that used to look like a flight.
  - A drive that is not a train is a bus when it is shorter than 20 km, or when it follows a bus route.
  - Trains are purple and buses brown, on the map and in the lists, on the web and in the native app.
- **Set a move's mode yourself.** In the day view, the mode of a move's row opens a menu of the six modes. In the native app it is in the
  row's context menu. Your choice is kept through every rebuild, and "As detected" takes it back.
- **Railway and bus lines from OpenStreetMap.** They are fetched in the background from the public Overpass API, only for the moves they
  could change, and kept in the database. `GET /api/status` counts them under `transit`.

## API

- A move's `mode` can be `bus` or `train`. In the day, every move has `modeEdited`.
- `PUT /api/moves/{id}/mode` sets a move's mode, and `DELETE /api/moves/{id}/mode` takes it back.
- Buses and trains count as ground travel in a trip's figures.

## Upgrading

- **One migration** (`0007_transit.sql`) runs on start.
- **The first start rebuilds the whole timeline once**, a few minutes for years of history. Short drives become buses at once. Trains
  appear over the following hours, as the railway tiles arrive, about one every 10 seconds.
- **Overpass needs a user agent.** Sporer sends `Transit__UserAgent`, or `Nominatim__UserAgent` when that is not set. With neither, no
  lines are fetched. `Transit__Enabled=false` turns fetching off; the README's "Transit lines" has the settings and the privacy note.
- **Reinstall the native app** on the iPhone and the Mac (`ios/scripts/install-iphone.sh`, `ios/scripts/build.sh mac`). Builds from
  before this release cannot read a bus or a train.
- The app on the Home Screen picks the release up when it is next started.

Also since v1.3.2: the native app for iPhone, iPad and Mac (`ios/README.md`).
