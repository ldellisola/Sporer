# Sporer v1.5.1

## New

- **A new icon.** The pink pin of the map over the faint contour lines of a map, with a trail of dots leading to it in the colours of
  walking, cycling and driving. It is the icon of the web app on the Home Screen and of the native app on the iPhone, the iPad and the Mac.
  - `npm run icons` (in `web/`) now draws the native app's icon too, from the same `web/public/icons/icon.svg`.

## Upgrading

- No migration, and nothing is rebuilt.
- **Reinstall the native app** on the iPhone and the Mac (`ios/scripts/install-iphone.sh`, `ios/scripts/build.sh mac`) for the new icon.
- The app on the Home Screen picks the new icon up when it is next started; iOS may keep the old one until it is removed from the Home
  Screen and added again.
