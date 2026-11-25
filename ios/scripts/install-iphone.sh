#!/usr/bin/env bash
# Builds the app for an iPhone, installs it and opens it. usage: ios/scripts/install-iphone.sh [--no-launch] [-- <app options>]
#
#   ios/scripts/install-iphone.sh                       build, install and open
#   ios/scripts/install-iphone.sh -- -section trips     open on Trips (options for the app go after --)
#
# The iPhone is SPORER_DEVICE, or the only one this Mac knows (ios/scripts/common.sh). Over Wi-Fi it must be unlocked, on the same
# network as the Mac and with its own VPN off. With a free Apple account the app opens for 7 days: run this again before then.
source "$(dirname "$0")/common.sh"

launch=1
app_options=()
while [[ $# -gt 0 ]]; do
    case "$1" in
        --no-launch) launch=0; shift ;;
        --) shift; app_options=("$@"); break ;;
        *) fail "usage: $0 [--no-launch] [-- <app options>]" ;;
    esac
done

device="$(device_id)"
app="$("$(dirname "$0")/build.sh" iphone)"

say "Installing on $device…"
if ! xcrun devicectl device install app --device "$device" "$app"; then
    fail "Could not install. Is the iPhone unlocked, on the Mac's Wi-Fi and with its VPN off? If it says the device must be paired,
connect the cable and run: xcrun devicectl manage pair --device $device"
fi

profile="$app/embedded.mobileprovision"
if [[ -f "$profile" ]]; then
    expires="$(security cms -D -i "$profile" 2>/dev/null | plutil -extract ExpirationDate raw -o - - 2>/dev/null || true)"
    [[ -n "$expires" ]] && say "Its profile lasts until $expires: install it again before then."
fi

if [[ $launch == 1 ]]; then
    say "Opening it…"
    # Without --, devicectl would take the app's options for its own.
    if ! xcrun devicectl device process launch --device "$device" --terminate-existing "$BUNDLE_ID" -- ${app_options[@]+"${app_options[@]}"}; then
        fail "Installed, but it did not open. The first time, trust the developer on the iPhone: Settings, General, VPN & Device Management."
    fi
fi
