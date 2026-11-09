# Sporer clean-up after v1.3.0

**Goal:** close the loose ends parked by Plans 5 and 6. Owner's request: "do the cleanup", meaning the clean-up items offered after v1.3.0.

**Context:**
- Rulings P5-R16, P5-R19 and P6-R11.
- The "Notes for later" in `2026-10-29-sporer-plan-5-rulings.md` and `2026-11-05-sporer-plan-6-rulings.md`.

## Global Constraints

- **Raw data:** no change to the server's behaviour and no migrations; `locationLog` rows are never updated or deleted.
- **Test output:** typecheck, vitest and the full Playwright suite pass with clean output. They must also pass under CI's font (`FONTCONFIG_FILE=…/fonts-dejavu.conf`).
- **Writing:** comments and docs are plain, owner-facing where the owner reads them, wrapped to the width of the surrounding text, and name no model.
- **Commits:** one commit per task, on `claude/sporer-cleanup`. The branch is squashed into `main` at the end, and the owner tags.

## Task 1: Playwright 1.64.1, and CI's web job back on `ubuntu-latest`

`ubuntu-latest` has been Ubuntu 26.04 since late October 2026. Playwright 1.56.1 cannot install WebKit's system packages there, so P6-R11 pinned the web job to `ubuntu-24.04`. Playwright 1.61 and later carry dependency lists and WebKit builds for Ubuntu 26.04. Use 1.64.1, a patch release from mid-October; 1.65.0 is days old.

**Files:**
- `web/package.json` and `web/package-lock.json`: lock the new version with npm itself.
- `.github/workflows/docker-publish.yml`
- `README.md`, if it names the Playwright version or the runner.
- Any spec or config that 1.64 needs changed.

- [ ] **Step 1:** Change `@playwright/test` to exactly `1.64.1` and update the lockfile with npm. Read Playwright's release notes for 1.57 to 1.64, and record in the report any breaking change that touches this repo, such as config options, `toHaveScreenshot`, locators, the WebKit or Chromium launch flags, or the clock.
- [ ] **Step 2:** Run the full suite locally. The container only has the Chromium of Playwright 1.56, in `/opt/pw-browsers`, and `playwright install` must not be run. If 1.64 cannot find a matching Chromium there, start it with `executablePath` pointing at the existing Chromium through an environment variable that only local runs set. CI must not set it. Document the variable in the README's "Front-end development" section.
- [ ] **Step 3:** In the workflow, set `runs-on: ubuntu-latest` for the web job and remove P6-R11's comment. The cache key already includes the Playwright version, so the first run is a miss and installs with `--with-deps`. Make the cache-hit step fail when Playwright cannot install system packages for the runner's OS, rather than passing silently. One way: check its output for "Cannot install dependencies" and exit 1.
- [ ] **Step 4:** Commit with the message `CI: Playwright 1.64.1, and the web job back on ubuntu-latest`.

The proof is a CI run on the branch on `ubuntu-latest`, with the WebKit smoke set passing. The controller starts that run.

## Task 2: Three loose ends of the web app

**Files:**
- `web/src/views/EditBar.tsx`
- `web/src/views/States.tsx`
- `web/src/views/RemovedToast.tsx`
- `web/src/sheet/BottomSheet.tsx`
- the files that wire the sheet's peek and the edit bar
- their tests

- [ ] **Step 1: The edit bar's sign-out text.** A points load held back by a sign-out (the redirect P5 detects) currently shows `GET …/points failed with status 0` in the edit bar's note. The bar must show the same words as every other error state: what `describe` in `States.tsx` gives, for example "close and reopen the app to sign in". Share `describe`, do not copy it. Test it with the same signed-out error the other views' tests use.
- [ ] **Step 2: A repeated failure is announced again.** When a later load of the points fails again with the same text, the alert stays mounted and screen readers say nothing. Make each new failure announce itself, for example by re-keying the alert on each failed attempt. Do it without moving the focus. Unit-test it.
- [ ] **Step 3: The focus after the toast's Undo.** When Undo is pressed from the keyboard and the toast then shows "Restored N points", the Undo button goes and the focus falls to the page. Move it to a place that is still there, in this order:
  - the edit bar's Done, if edit mode is still on;
  - otherwise the day view's Edit points button;
  - otherwise leave it.
  Only do this when the focus was lost, using the existing `focusLost` helper. Unit-test it.
- [ ] **Step 4: The sheet's peek follows the edit bar.** With edit mode on, the sheet's lowest point is the fixed 96 px (`SHEET_PEEK`), and at large text sizes the bar's row can need more. Make the peek, in edit mode only, as tall as the edit bar's row really is: measure it with a `ResizeObserver`. Never go below 96 px, and never above the half snap point. Outside edit mode nothing changes. Unit-test it with a measured height of 140 px. Add an e2e check that at 125 % text size, emulated by setting the root font size, the bar's Done is fully in view at the peek on the phone project.
- [ ] **Step 5:** Commit with the message `Edit mode: the sign-out words, a failure said again, the focus after Undo, a peek that fits the bar`.

## Task 3: Docs

- [ ] **Step 1:** In the README, remove the checklist's caveat that the edit bar's row "can need a third line and push Done below the peek". Say instead that the sheet's peek grows with the bar.
- [ ] **Step 2:** Write release notes for v1.3.1 in `2026-11-09-sporer-cleanup-release.md`. Keep them short and owner-facing: no migrations, nothing to configure.
- [ ] **Step 3:** Commit with the message `Docs: the clean-up and the v1.3.1 notes`.

## Out of scope

- The Plan 4 notes, which stay parked: applied versus stored trip dates, and the place search reading `segment` twice.
- The 502–504 e2e timing assertion (P5-R19).
- Deleting old branches on GitHub: the git proxy refuses it, so the owner does it.
