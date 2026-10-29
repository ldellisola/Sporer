#!/usr/bin/env bash
# Times the edits that run the recompute of the homes and trips inside their request: renaming a trip, merging two places and setting the trip
# distance. Each is one request that writes the edit and then works the homes and trips out from the stored nights before it answers.
#
#   tools/perf/edit-latency.sh <base-url> [rounds=20] [warmup=3] [trip-id] [place] [other-place]
#
# The API must be running over a finished backfill (no ranges pending, so that the worker is idle and holds nothing), as the other scripts need it.
# The writes change what is stored, so they go in pairs that put it back, and a round is the three pairs:
#   PUT /api/trips/{id}          renames the trip, and then takes the name back (null: the automatic one)
#   POST /api/places/{p}/merge   merges `other-place` into `place`, and then DELETE /api/places/{p}/merged/{o} separates it again
#   PUT /api/settings            sets the trip distance to 60 km, and then back to null (the configured one)
# `warmup` rounds come first and are not measured (the first requests of a process cost more, as the Plan 2 document found). The first round's
# own times are printed, since that is what the owner's first edit after a start is; with `warmup` 0 that round is one of the measured. Then
# `rounds` measured rounds. The time is curl's time_total in ms, over loopback, with a JSON body and `Content-Type: application/json` (a write
# without it is a 415). Every write must answer 2xx; a count of those that did not is printed, and what was stored is looked at again at the end.
#
# The trip is the one of the most nights (a rename does not move it); the place is the home, and the other place is the most visited one that
# is not (merging into the home is the merge that changes what home detection sees). Give them as arguments to use others. The forward write
# of each pair is the one measured for the target (the p95 of `rounds`); the write that puts it back is timed too and printed as well, since it
# runs the same recompute.
set -euo pipefail

base=${1:?base url, e.g. http://127.0.0.1:5100}
rounds=${2:-20}
warmup=${3:-3}
trip=${4:-}
place=${5:-}
other=${6:-}

command -v jq > /dev/null || { echo "edit-latency.sh needs jq: install it" >&2; exit 2; }
curl -fsS -o /dev/null --max-time 10 "$base/api/status" ||
  { echo "edit-latency.sh: no answer from $base/api/status: start the API over the finished backfill first" >&2; exit 2; }

here=$(cd "$(dirname "$0")" && pwd)
workdir=$(mktemp -d)
trap 'rm -rf "$workdir"' EXIT

get() { curl -fsS -H 'Accept: application/json' "$base$1"; }

if [ -z "$trip" ]; then
  trip=$(get /api/trips | jq -r '.trips | max_by(.nights) | .id // empty')
fi
[ -n "$trip" ] || { echo "edit-latency.sh: the history has no trip to rename" >&2; exit 2; }
if [ -z "$place" ]; then
  place=$(get /api/homes | jq -r '[.periods[] | select(.source == "detected")] | last | .placeId // empty')
  [ -n "$place" ] || place=$(get /api/places/search | jq -r '.[0].id')
fi
if [ -z "$other" ]; then
  other=$(get /api/places/search | jq -r --argjson p "$place" '[.[] | select(.id != $p)][0].id // empty')
fi
[ -n "$place" ] && [ -n "$other" ] || { echo "edit-latency.sh: the history has no two places to merge" >&2; exit 2; }
echo "trip $trip, merging place $other into place $place (the home when it has one)"

# method path [json-body]: runs one write and appends "status seconds" to the file named by $label
write() {
  local label=$1 method=$2 path=$3 body=${4:-}
  local args=(-s -o "$workdir/body" -X "$method" -H 'Content-Type: application/json' -H 'Accept-Encoding: br' -w '%{http_code} %{time_total}\n')
  [ -n "$body" ] && args+=(--data "$body")
  curl "${args[@]}" "$base$path" >> "$workdir/$label"
}

round() { # measured? : the three pairs
  local pre=$1
  write "${pre}rename" PUT "/api/trips/$trip" '{"name":"Perf check","startDate":null,"endDate":null}'
  write "${pre}rename-back" PUT "/api/trips/$trip" '{"name":null,"startDate":null,"endDate":null}'
  write "${pre}merge" POST "/api/places/$place/merge" "{\"place\":$other,\"name\":null}"
  write "${pre}separate" DELETE "/api/places/$place/merged/$other"
  write "${pre}distance" PUT /api/settings '{"tripMinDistanceKm":60}'
  write "${pre}distance-back" PUT /api/settings '{"tripMinDistanceKm":null}'
}

for ((i = 0; i < warmup; i++)); do round warm-; done
for ((i = 0; i < rounds; i++)); do round ""; done

report() { # label file
  local failed
  failed=$(awk '$1 !~ /^2/' "$2" | wc -l)
  printf '%-34s %s  non-2xx=%d\n' "$1" "$(awk '{print $2}' "$2" | sort -g | awk -f "$here/percentiles.awk")" "$failed"
}

first() { local file="$workdir/warm-$1"; [ -s "$file" ] || file="$workdir/$1"; awk 'NR == 1 {printf "%.1f", $2 * 1000}' "$file"; }
echo "the first round, ms: rename $(first rename), merge $(first merge), distance $(first distance)"
report "PUT /api/trips/{id} (rename)" "$workdir/rename"
report "  and the name taken back" "$workdir/rename-back"
report "POST /api/places/{id}/merge" "$workdir/merge"
report "  DELETE .../merged/{other}" "$workdir/separate"
report "PUT /api/settings (60 km)" "$workdir/distance"
report "  and back to null" "$workdir/distance-back"

# What was stored is what it was: the trip is named as detected, the place is not merged, the distance is the configured one.
echo "after: trip name $(get "/api/trips/$trip" | jq -r '.ownName // "automatic"'), merged into place $place: $(get "/api/places/$place" | jq '.merged | length'), settings $(get /api/settings | jq -c .)"
