# Shared by the scripts of the native app: where things are, how to sign, and which simulator or iPhone to use.
# Sourced, not run. Every setting below can be changed with the environment variable named next to it.

set -euo pipefail

IOS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT="$IOS_DIR/Sporer.xcodeproj"
SCHEME=Sporer
BUILD_DIR="$IOS_DIR/build"

# The app's id. A free Apple account needs an id no one else has used, so someone else building the app sets their own
# (SPORER_BUNDLE_ID=com.example.Sporer) along with their team.
BUNDLE_ID="${SPORER_BUNDLE_ID:-ldellisola.Sporer}"

# The settings passed to every xcodebuild that signs: the team of the project, unless SPORER_TEAM names another (the
# Team ID of your Personal Team, in Xcode's Settings, Accounts).
SIGNING=()
[[ -n "${SPORER_TEAM:-}" ]] && SIGNING+=("DEVELOPMENT_TEAM=$SPORER_TEAM")
[[ -n "${SPORER_BUNDLE_ID:-}" ]] && SIGNING+=("PRODUCT_BUNDLE_IDENTIFIER=$SPORER_BUNDLE_ID")

say() { printf '\033[1m%s\033[0m\n' "$*" >&2; }
fail() { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

# xcodebuild with the project and scheme, printing only warnings and errors.
xcb() {
    xcodebuild -project "$PROJECT" -scheme "$SCHEME" -quiet "$@"
}

# The simulator to build for and test on: SPORER_SIMULATOR (a name or a UDID), else a booted iPhone, else the first iPhone of the
# newest iOS. Prints its UDID.
simulator_udid() {
    local list
    list="$(xcrun simctl list devices available -j)"
    if [[ -n "${SPORER_SIMULATOR:-}" ]]; then
        jq -r --arg want "$SPORER_SIMULATOR" \
            '[.devices | to_entries[] | select(.key | test("iOS")) | .value[] | select(.udid == $want or .name == $want)][-1].udid // empty' \
            <<<"$list"
    else
        jq -r '[.devices | to_entries[] | select(.key | test("iOS")) | .key as $runtime | .value[]
                 | select(.name | startswith("iPhone")) | . + {runtime: $runtime}] as $all
               | ($all | map(select(.state == "Booted")))
                 + ($all | map(select(.state != "Booted")) | group_by(.runtime) | reverse | flatten(1))
               | .[0].udid // empty' <<<"$list"
    fi
}

# The iPhone to install on: SPORER_DEVICE (its name or UDID), else the only iPhone or iPad this Mac knows. Prints its identifier.
device_id() {
    local json
    json="$(mktemp -t sporer-devices)"
    xcrun devicectl list devices --json-output "$json" >/dev/null 2>&1 || true
    local found
    if [[ -n "${SPORER_DEVICE:-}" ]]; then
        found="$(jq -r --arg want "$SPORER_DEVICE" '.result.devices[]
            | select(.deviceProperties.name == $want or .hardwareProperties.udid == $want or .identifier == $want)
            | .hardwareProperties.udid' "$json" | head -1)"
    else
        found="$(jq -r '.result.devices[] | select(.hardwareProperties.reality == "physical" and .hardwareProperties.platform == "iOS")
            | .hardwareProperties.udid' "$json")"
        if [[ "$(printf '%s' "$found" | grep -c . || true)" -gt 1 ]]; then
            jq -r '.result.devices[] | select(.hardwareProperties.reality == "physical") | "  \(.deviceProperties.name)  \(.hardwareProperties.udid)"' "$json" >&2
            rm -f "$json"
            fail "This Mac knows more than one device: say which with SPORER_DEVICE=<name or UDID>."
        fi
    fi
    rm -f "$json"
    [[ -n "$found" ]] || fail "No iPhone found. Pair it once with a cable (see the README, \"The native app\"), or set SPORER_DEVICE."
    printf '%s\n' "$found"
}
