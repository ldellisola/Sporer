# Sporer v1.3.1

## Fixes

- **Sign-out in edit mode.** If you are signed out while editing points, the edit bar now says what every other error says: close and reopen the app to sign in.
- **A larger peek at large text.** In edit mode the sheet's peek grows to fit the edit bar's row, so Done stays in view when the text is large.
- **Focus after Undo.** After an Undo from the keyboard, the focus goes to Done in edit mode, or to Edit points on the day.
- **A repeated failure is announced again.** When loading the points fails a second time, screen readers hear it again.

## Behind the scenes

- The browser tests now run on Playwright 1.64 and Ubuntu 26.04.

## Upgrading

No migrations and nothing to configure: pull the new image. The app on the Home Screen picks the release up when it is next started.
