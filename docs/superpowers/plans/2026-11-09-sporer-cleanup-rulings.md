# Sporer clean-up after v1.3.0: rulings and checks before release

These are the decisions made on the owner's behalf during the clean-up. It closed the loose ends that Plans 5 and 6 had parked:
- the browser tests run again on GitHub's current Ubuntu;
- edit mode gets four small fixes.

Each task was reviewed on its own. A whole-branch review and one fix wave followed. Each decision says what it costs if it turns out wrong.

## Check before the `v1.3.1` tag

These are the items in the README's editing checklist that this release touches:

- **Signed out in edit mode.** When the login in front of the app has expired and you open Edit points, the edit bar says to close and reopen the app to sign in, not "status 0".
- **The edit bar at large text.** With edit mode on and the sheet at its peek, Done is fully in view:
  - at Safari's text size 100 %, 115 % and 125 %;
  - with Display Zoom set to Larger Text.

  The peek now grows with the bar.
- **Undo from a keyboard** (on a desktop): remove some points, then press Undo on the toast with the keyboard. The focus goes to Done, or to Edit points once edit mode is closed.

The iPhone itself cannot be checked here. The browser tests check the peek in Chromium's phone emulation.

**Upgrading from v1.3.0.** There are no migrations and nothing to configure. The app on the Home Screen picks it up the next time it is started.

## Rulings

- **CU-R1.** The two tests that type a date part by part into the range fields run on desktop only.
  - Typing a date's parts with a keyboard is a desktop interaction. On the iPhone, Safari sets a date with its wheel picker.
  - Chromium 156, which comes with Playwright 1.64, no longer takes typed parts in a date field under phone emulation.
  - The phone keeps the test that sets the range with the fields.
  - *If wrong:* a regression in typing dates on a phone with a keyboard goes unseen. iOS has no such input.
- **CU-R2.** The plan's "125 % root font" test of the peek was replaced.
  - The app sizes in px, so changing the root font size changes nothing, and that test passed without the fix.
  - Instead, the edit bar's text is set to 17.5 px. That test fails without the fix.
  - A second test makes the bar's row taller after edit mode has started, so the real resize observer must move the peek.
  - *If wrong:* nothing.
- **CU-R3.** The taller-row test is not added to the WebKit smoke set. Edit mode stays with Chromium (P5-R13). *If wrong:* one less WebKit check of the peek.
- **CU-R4.** The plan's wording of that test was amended to match CU-R2, and these rulings are kept in the repository. *If wrong:* nothing.

Other choices made during the clean-up:
- **Playwright version.** It is 1.64.1, a patch release from mid-October. 1.61 is the first version that supports Ubuntu 26.04, and 1.65.0 was days old.
- **System packages.** A failed install of the browsers' system packages now fails the job. So does an Ubuntu that Playwright does not know.
- **Browser cache key.** The key carries the Ubuntu release, so a new release never reuses another release's browsers.
- **Local Chromium.** Local runs can point Playwright at an installed Chromium with `PW_CHROMIUM_PATH`. CI never sets it.

## Notes for later

- **Two phone tests each failed once under load in local runs:**
  - `edit-place.spec.ts:347`, once in four full runs;
  - `edit-trip.spec.ts:333`, once under CI's font.

  Both passed on every rerun and in CI. Watch for them in CI. If either fails there, read its trace before calling it flaky.
- **The other parked notes stay parked.** From Plan 4: applied versus stored trip dates, and the place search reading `segment` twice. From Plan 5 (P5-R19): the 502–504 test's timing.
