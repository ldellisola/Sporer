# Sporer v1.3.2

## Fixes

- **Map colours after a failed light or dark switch.** When the device switched between light and dark and the map could not load the other style, the routes and labels were redrawn in the new scheme's colours on top of the old map. They now keep the colours of the map that stays.
- **A trip's thumbnail after a gap in the data.** A trip that ends at a new home was drawn back to the old home when the night you came back had no data. Its thumbnail now ends at the home of the first night after the trip that has a position.

## Behind the scenes

- The browser tests run in Playwright's own Docker image, split over four jobs, so a CI run takes about 6 minutes instead of 14.
- A version tag on a commit whose CI already passed builds and publishes without running the tests again.

## Upgrading

No migrations and nothing to configure: pull the new image. The app on the Home Screen picks the release up when it is next started.
