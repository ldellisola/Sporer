#!/usr/bin/env bash
# Runs the native app's tests on a simulator, on this Mac (never on GitHub Actions).
#
#   ios/scripts/test.sh                              the unit tests (no server needed)
#   ios/scripts/test.sh --live http://127.0.0.1:5097  the tests that send every write of the app to a real server and put back
#                                                     what they changed
#
# The live tests change the server's data while they run: point them only at a local server with the synthetic history (see the
# README, "Local development"), never at the one with your real data. An address that is not on this Mac is refused unless
# --not-my-data follows it. The simulator is SPORER_SIMULATOR, or an iPhone simulator (ios/scripts/common.sh).
source "$(dirname "$0")/common.sh"

live=""
case "${1:-}" in
    "") ;;
    --live)
        live="${2:-}"
        [[ -n "$live" ]] || fail "usage: $0 --live <the local server's address> [--not-my-data]"
        host="$(sed -E 's#^[a-z]+://(\[[^]]*\]|[^/:]*).*#\1#' <<<"$live")"
        case "$host" in
            127.0.0.1|localhost|"[::1]"|*.localhost|*.test) ;;
            *) [[ "${3:-}" == "--not-my-data" ]] || fail "$host is not on this Mac. The live tests write to it; add --not-my-data if it holds no real history." ;;
        esac
        ;;
    *) fail "usage: $0 [--live <the local server's address> [--not-my-data]]" ;;
esac

# Prints the failures and how many tests passed and were skipped, not a line for each.
quiet_passes() {
    awk "/' passed on '/ { passed++; next }
         /' skipped on '/ { skipped++; next }
         /' started on '|IDETestOperationsObserverDebug|^Testing started$/ { next }
         { print }
         END { printf \"%d tests passed, %d skipped.\\n\", passed, skipped }"
}

udid="$(simulator_udid)"
[[ -n "$udid" ]] || fail "No iPhone simulator found: add one in Xcode (Window, Devices and Simulators), or set SPORER_SIMULATOR."
name="$(xcrun simctl list devices -j | jq -r --arg u "$udid" '.devices[][] | select(.udid == $u) | .name')"

if [[ -z "$live" ]]; then
    say "Running the unit tests on $name…"
    xcb -destination "id=$udid" -derivedDataPath "$BUILD_DIR/test" test 2>&1 | quiet_passes
else
    say "Running the live tests against $live on $name…"
    TEST_RUNNER_SPORER_LIVE_SERVER="$live" xcb -destination "id=$udid" -derivedDataPath "$BUILD_DIR/test" \
        -only-testing:SporerTests/LiveServerTests test 2>&1 | quiet_passes
fi
say "Passed."
