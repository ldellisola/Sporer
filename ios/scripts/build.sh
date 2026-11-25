#!/usr/bin/env bash
# Builds the native app. usage: ios/scripts/build.sh [simulator|iphone|mac|all]   (default: all)
#
#   simulator  Debug, for the iOS simulator, in ios/build/simulator (no signing needed)
#   iphone     Release, for an iPhone, in ios/build/iphone, signed with your Apple account (see the README, "The native app")
#   mac        Debug, Mac Catalyst, in ios/build/mac, signed with your Apple account
#
# Prints the path of each app it built. Settings: SPORER_TEAM, SPORER_BUNDLE_ID (ios/scripts/common.sh).
source "$(dirname "$0")/common.sh"

build_simulator() {
    say "Building for the simulator…"
    xcb -configuration Debug -destination 'generic/platform=iOS Simulator' -derivedDataPath "$BUILD_DIR/simulator" \
        ${SIGNING[@]+"${SIGNING[@]}"} build >&2
    echo "$BUILD_DIR/simulator/Build/Products/Debug-iphonesimulator/Sporer.app"
}

build_iphone() {
    say "Building for an iPhone (Release)…"
    xcb -configuration Release -destination 'generic/platform=iOS' -derivedDataPath "$BUILD_DIR/iphone" \
        -allowProvisioningUpdates ${SIGNING[@]+"${SIGNING[@]}"} build >&2
    echo "$BUILD_DIR/iphone/Build/Products/Release-iphoneos/Sporer.app"
}

build_mac() {
    say "Building for the Mac (Mac Catalyst)…"
    xcb -configuration Debug -destination 'platform=macOS,variant=Mac Catalyst' -derivedDataPath "$BUILD_DIR/mac" \
        -allowProvisioningUpdates ${SIGNING[@]+"${SIGNING[@]}"} build >&2
    echo "$BUILD_DIR/mac/Build/Products/Debug-maccatalyst/Sporer.app"
}

case "${1:-all}" in
    simulator) build_simulator ;;
    iphone) build_iphone ;;
    mac) build_mac ;;
    all) build_simulator; build_iphone; build_mac ;;
    *) fail "usage: $0 [simulator|iphone|mac|all]" ;;
esac
