# Sporer v1.5.0

## New

- **Every place on the map.** The web app has a Places view (the Places button of the top bar, `/places`), and the native app's Places tab
  draws the same: every place as a dot, named where the name fits, with the list to search beside it. A dot or a row opens the place.
  - A place's map shows the places round it, so the places that GPS drift split one stay over are seen next to each other.
- **Merge several places at once, on the map.** Merge with… (Merge in the native app) brings the map to the place and the places within 250 m
  of it.
  - A tap on a place picks it (blue, with a tick in the native app) instead of opening it, and a second tap takes it off.
  - The nearest places are listed under it too, to pick by name or search.
  - Choose the name to keep, and Merge merges every place picked at once, or none of them. Separate still gives each back on its own.

## API

- `GET /api/places` lists every place in use with where it is, the most time first: `{"places": [{"id", "name", "lat", "lon", "seconds", "visits"}]}`.
- `POST /api/places/{id}/merge` also takes `{"places": [7, 9, 12]}` (1 to 100): all of them are merged in one transaction, or none, and the
  homes and trips are worked out once. `{"place": 7}` works as before.

## Upgrading

- No migration, and nothing is rebuilt.
- **Reinstall the native app** on the iPhone and the Mac (`ios/scripts/install-iphone.sh`, `ios/scripts/build.sh mac`) for the Places map
  and the new merge. Older builds go on working with this server.
- The app on the Home Screen picks the release up when it is next started.

Also since v1.4.0: the native app's version is the release it was built from (Settings, About).
