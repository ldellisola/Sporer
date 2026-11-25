#!/usr/bin/env bash
# Builds the Mac app (Mac Catalyst) and opens it. usage: ios/scripts/run-mac.sh [<app options>]
#
# The Mac app has no 7-day limit. To keep it, copy ios/build/mac/Build/Products/Debug-maccatalyst/Sporer.app to Applications.
source "$(dirname "$0")/common.sh"

app="$("$(dirname "$0")/build.sh" mac)"
say "Opening it…"
open -n "$app" --args "$@"
