#!/usr/bin/env bash
# Builds the app and opens it in a simulator. usage: ios/scripts/run-simulator.sh [<app options>]
#
#   ios/scripts/run-simulator.sh -mock                              the made-up data of the design, no server needed
#   ios/scripts/run-simulator.sh -serverURL http://127.0.0.1:5097   a local server (see the README, "Local development")
#
# The simulator is SPORER_SIMULATOR, or an iPhone simulator (ios/scripts/common.sh).
source "$(dirname "$0")/common.sh"

udid="$(simulator_udid)"
[[ -n "$udid" ]] || fail "No iPhone simulator found: add one in Xcode (Window, Devices and Simulators), or set SPORER_SIMULATOR."
app="$("$(dirname "$0")/build.sh" simulator)"

say "Opening it in the simulator…"
xcrun simctl boot "$udid" 2>/dev/null || true
# Show it: Simulator up to Xcode 26, DeviceHub from Xcode 27. The app runs either way.
open -a Simulator --args -CurrentDeviceUDID "$udid" 2>/dev/null \
    || open "$(xcode-select -p)/../Applications/DeviceHub.app" 2>/dev/null \
    || say "(No Simulator or DeviceHub app to show it in; it runs anyway.)"
xcrun simctl bootstatus "$udid" -b >/dev/null
xcrun simctl install "$udid" "$app"
xcrun simctl launch --terminate-running-process "$udid" "$BUNDLE_ID" "$@"
