# Sporer for iPhone, iPad and Mac

The native app: SwiftUI for iOS 27, which also runs on the Mac (Mac Catalyst). What it does and how it keeps up with the server is in the
[main README](../README.md#the-native-app-iphone-ipad-and-mac); how it looks and why is in the
[design](../docs/superpowers/specs/2026-11-25-sporer-ios-app-design.md). This page is about building it.

## What you need

- A Mac with **macOS 27** and **Xcode 27** (the iOS 27 SDK and at least one iPhone simulator). The scripts also use `jq`, which macOS has.
- For the iPhone and the Mac app, an **Apple account** signed in to Xcode (Xcode, Settings, Accounts). A free one is enough; the app then
  opens on the iPhone for 7 days after each install.
- For the iPhone, **Developer Mode** on (Settings, Privacy & Security, Developer Mode).

## The scripts

Everything is built and checked on this Mac with the scripts in `ios/scripts/`, never on GitHub Actions. They print only warnings and
errors, and put what they build in `ios/build/` (ignored by git).

| Script | What it does |
| --- | --- |
| `ios/scripts/build.sh [simulator\|iphone\|mac\|all]` | Builds the app and prints where it is: Debug for the simulator, Release for an iPhone, Debug for the Mac. `all` (the default) builds the three. |
| `ios/scripts/test.sh` | The unit tests, on an iPhone simulator. No server needed. |
| `ios/scripts/test.sh --live http://127.0.0.1:5097` | The live tests: every write of the app sent to a real server, and put back. Only against a local server with the synthetic history. |
| `ios/scripts/run-simulator.sh [options]` | Builds the app and opens it in a simulator, with the app's options (below), such as `-mock`. |
| `ios/scripts/install-iphone.sh [--no-launch] [-- options]` | Builds the app for an iPhone, installs it, says until when its profile lasts and opens it. |
| `ios/scripts/run-mac.sh [options]` | Builds the Mac app and opens it. |

They read these settings from the environment:

| Variable | Default | |
| --- | --- | --- |
| `SPORER_TEAM` | the project's team | The Team ID to sign with (Xcode, Settings, Accounts, your Personal Team). |
| `SPORER_BUNDLE_ID` | `ldellisola.Sporer` | The app's id. With a free account it must be one no one else has used. |
| `SPORER_SIMULATOR` | a booted iPhone simulator, or the first iPhone of the newest iOS | A simulator's name or UDID. |
| `SPORER_DEVICE` | the only iPhone or iPad this Mac knows | A device's name or UDID, when the Mac knows more than one. |

Someone else building the app sets their own team and id, as in `SPORER_TEAM=ABCDE12345 SPORER_BUNDLE_ID=com.example.Sporer
ios/scripts/install-iphone.sh`, or changes them under the Sporer target's Signing & Capabilities in Xcode.

The scripts stamp the app with the release it was built from, which Settings, About shows as **Version**. It is the newest version tag behind the
commit (`v1.4.0` gives `1.4.0`), and the build number in brackets is the count of commits, so every later build has a higher one. A build of
commits after a release keeps that release's number with a higher build number. A build started in Xcode shows the project's own `1.0 (1)`.

## The iPhone

```sh
ios/scripts/install-iphone.sh
```

The first time on an iPhone:

1. Connect it with a cable and unlock it. If `devicectl` says the device must be paired, run `xcrun devicectl manage pair --device <its name>`
   and tap Trust on the phone. From then on it is found over Wi-Fi as well (an iOS update can undo the pairing; do it again then).
2. Run the script. The app installs but does not open until you trust the developer on the phone: Settings, General, VPN & Device
   Management, your Apple account, Trust. Run the script again, or open the app.

After that, over Wi-Fi, the phone has to be **unlocked**, on the **same network** as the Mac and **with its own VPN off** while it installs:
a VPN that takes all traffic hides the phone from the Mac. With a free account, **run the script again within 7 days**; it says when the
profile ends. Options for the app go after `--`, as in `ios/scripts/install-iphone.sh -- -section trips`.

## The simulator and the Mac

```sh
ios/scripts/run-simulator.sh -mock
ios/scripts/run-simulator.sh -serverURL http://127.0.0.1:5097
ios/scripts/run-mac.sh
```

`-mock` runs on the made-up data of the design, with no server. `-serverURL` points the app at another server for that launch only; for a
local server with the synthetic history, see "Local development" in the main README. The Mac app has no 7-day limit: to keep it, copy
`ios/build/mac/Build/Products/Debug-maccatalyst/Sporer.app` to Applications.

**After a server update that adds a mode of travel, install again.** Builds from before buses and trains cannot read a day, a period or a
trip with a bus or a train in it. Run `ios/scripts/install-iphone.sh` again, and copy a new `ios/scripts/build.sh mac` build over the Mac app
in Applications. Builds from then on read a mode they do not know as no mode, so this is needed only once.

In Xcode, open `ios/Sporer.xcodeproj` and run the Sporer scheme on a simulator, your iPhone or My Mac; options for the app go in the
scheme's Arguments (Product, Scheme, Edit Scheme, Run).

## The app's options

For screenshots and checks, the app can open on a given screen:

| Option | |
| --- | --- |
| `-mock` | The made-up data of the design, with no server. |
| `-serverURL <address>` | Another server, for this launch only. |
| `-section day\|explore\|trips\|places` | The tab to open on. |
| `-day yyyy-MM-dd` | The day (Day) and the period (Explore) to show. |
| `-scale week\|month\|year\|range` | Explore's scale. |
| `-push place:<id>\|trip:<id>\|day:<date>` | A screen pushed on the tab. |
| `-detent peek\|medium\|large` | How high the iPhone's sheet stands. |
| `-settings`, `-edit`, `-heat` | Open Settings, edit mode for the day, or the heat layer. |

## The tests

`ios/scripts/test.sh` runs the unit tests in `ios/SporerTests` (Swift Testing): the decoding of every answer of the API (from the
fixtures in `SporerTests/Fixtures`), the HTTP client against a stub server (statuses, `ETag`s, the saved answers, what each write
sends), the refresh rules, the map's drawings and the formats.

`ios/scripts/test.sh --live <address>` runs `LiveServerTests`, which send every write of the app to a real server, check what changed
and put it back. They are skipped unless they are asked for, and the script refuses an address that is not on this Mac (add
`--not-my-data` for a test server elsewhere). **Never point them at the server with your real history.** The server they run against
is the one of "Local development" in the main README, with the synthetic history of "Synthetic data and performance checks".

## The code

| Folder | |
| --- | --- |
| `Sporer/App` | The app, and `AppModel`: the tab, the day, the navigation, the refresh rules and which screen draws the map. |
| `Sporer/Shell` | The map with a sheet over it (iPhone) or a sidebar beside it (iPad and Mac), and the buttons on the map. |
| `Sporer/Map` | The map (MapKit): routes, stops and their names, the heat layer, and what each screen asks it to draw. |
| `Sporer/Features` | The panels: Day, Explore, Trips, Places, Settings and edit mode. |
| `Sporer/Data` | The HTTP client (`HTTPService`), the saved answers (`ResponseStore`) and the protocol both it and the mock serve. |
| `Sporer/Model` | The API's types, local dates and geometry. |
| `Sporer/Design` | Shared views (loading, errors, the offline note) and formats. |
| `Sporer/Mock` | The made-up data of `-mock`. |

Two things that are easy to break:

- **On the Mac, a panel's toolbar must have one item.** On macOS 27, Mac Catalyst crashes at launch when a toolbar has buttons side by
  side (`ToolbarItemGroup`, or separate `ToolbarItem`s). On Catalyst the Day and Explore panels put their buttons in one `ToolbarItem`
  holding an `HStack`; the iPhone and iPad keep separate items.
- **The project is Swift 6 with the main actor as the default.** Types the HTTP client and the tests use off the main actor are
  `nonisolated`.
