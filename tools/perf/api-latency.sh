#!/usr/bin/env bash
# Times the read endpoints the web app uses, on random dates and windows of a history, and measures what they send.
#
#   tools/perf/api-latency.sh <base-url> <first-date> <last-date> [warmup=20] [days=200] [months=100] [years=20] [places=200] [seed=1] [trips=50]
#
# For each endpoint some requests warm it up, then the measured ones follow, once each:
#   GET /api/day/{date}                      `days` random dates
#   GET /api/range?from&to, and /api/heat    `months` random windows of 31 days, `years` random windows of 365 days
#   GET /api/places/{id}                     `places` requests for the places the busiest year has
#   GET /api/trips                           `trips` requests, and GET /api/trips/{id} `trips` requests for each trip the list has
# The windows start on a random date, so they are not the calendar months and years the web app asks for; a window of 31 or
# 365 days is the longest of them. Everything is picked with a generator of the script's own (see RNG below), so that a seed gives the
# same dates and windows every time and on every awk, and two runs can be compared on the same requests.
#
# Requests carry `Accept-Encoding: br`, as a browser's do, so the time is that of the compressed answer: curl's time_total,
# in ms, which includes connecting to the server (a local one, so a fraction of a millisecond). A second pass asks for the same
# windows without compression to measure the raw JSON and counts the vertices of the lines (needs jq); that pass is not timed.
set -euo pipefail

base=${1:?base url, e.g. http://127.0.0.1:5100}
first=${2:?first date, yyyy-mm-dd}
last=${3:?last date, yyyy-mm-dd}
warmup=${4:-20}
day_count=${5:-200}
month_count=${6:-100}
year_count=${7:-20}
place_count=${8:-200}
seed=${9:-1}
trip_count=${10:-50}

# Fail with a reason, up front, rather than half way through a run: the vertex counts and the places need jq, and nothing is measured
# without an API that answers (a refused connection would count as a request of 0 ms).
command -v jq > /dev/null || { echo "api-latency.sh needs jq (for the vertex counts and for the places): install it" >&2; exit 2; }
curl -fsS -o /dev/null --max-time 10 "$base/api/status" ||
  { echo "api-latency.sh: no answer from $base/api/status: start the API over the history first" >&2; exit 2; }

here=$(cd "$(dirname "$0")" && pwd)
days=$(( ( $(date -u -d "$last" +%s) - $(date -u -d "$first" +%s) ) / 86400 + 1 ))
workdir=$(mktemp -d)
trap 'rm -rf "$workdir"' EXIT

date_at() { date -u -d "$first + $1 days" +%F; } # offset

# A random number generator of our own for awk: the Park-Miller "minimal standard", in doubles (16807 * 2^31 is far below 2^53, so it
# is exact), so that a seed gives the same numbers on every awk. awk's own srand(seed) does not: mawk, which is what Debian and
# Ubuntu have, takes its numbers from arc4random and ignores the seed, so every run of the first pass drew other dates and windows.
RNG='function seed_rnd(s) { x = ((s + 1234567) * 48271) % 2147483647; if (x == 0) x = 1; for (k = 0; k < 8; k++) rnd() }
     function rnd() { x = (x * 16807) % 2147483647; return x / 2147483647 }'


# count length seed: "from to" per line, the window `length` days long and inside the history
random_windows() {
  awk -v n="$1" -v len="$2" -v days="$days" -v seed="$3" \
    "$RNG"' BEGIN { seed_rnd(seed); for (i = 0; i < n; i++) { s = int(rnd() * (days - len + 1)); print s, s + len - 1 } }' |
    while read -r from to; do echo "$(date_at "$from") $(date_at "$to")"; done
}

random_dates() { # count seed
  awk -v n="$1" -v days="$days" -v seed="$2" "$RNG"' BEGIN { seed_rnd(seed); for (i = 0; i < n; i++) print int(rnd() * days) }' |
    while read -r offset; do date_at "$offset"; done
}

# Reads paths on stdin; the first `warmup` are not measured. Prints "status seconds bytes" per measured request.
get() { # accept-encoding
  local skip=$warmup path
  while read -r path; do
    if [ "$skip" -gt 0 ]; then
      skip=$((skip - 1))
      curl -s -o /dev/null -H "Accept-Encoding: $1" "$base$path"
    else
      curl -s -o /dev/null -H "Accept-Encoding: $1" -w '%{http_code} %{time_total} %{size_download}\n' "$base$path"
    fi
  done
}

# label file-of-results: percentiles of the times and the sizes of the bodies
report() {
  local failed
  failed=$(awk '$1 != 200' "$2" | wc -l)
  printf '%-34s %s  non-200=%d  br: median %d B, max %d B\n' "$1" \
    "$(awk '{print $2}' "$2" | sort -g | awk -f "$here/percentiles.awk")" "$failed" \
    "$(awk '{print $3}' "$2" | sort -n | awk '{v[NR] = $1} END {print v[int((NR + 1) / 2)]}')" \
    "$(awk '{print $3}' "$2" | sort -n | tail -1)"
}

# label paths-file: the raw size of each answer (and the vertices of its lines, for a range), as median and maximum
raw_sizes() {
  local path size vertices
  : > "$workdir/raw"
  while read -r path; do
    curl -s -H 'Accept-Encoding: identity' "$base$path" -o "$workdir/body" -w '%{size_download}' > "$workdir/size"
    size=$(cat "$workdir/size")
    vertices=$(jq '[.moves[]?.geometry | length] | add // 0' "$workdir/body" 2> /dev/null || echo 0)
    echo "$size $vertices" >> "$workdir/raw"
  done < "$2"
  printf '%-34s raw: median %d B, max %d B; vertices: median %d, max %d\n' "$1" \
    "$(awk '{print $1}' "$workdir/raw" | sort -n | awk '{v[NR] = $1} END {print v[int((NR + 1) / 2)]}')" \
    "$(awk '{print $1}' "$workdir/raw" | sort -n | tail -1)" \
    "$(awk '{print $2}' "$workdir/raw" | sort -n | awk '{v[NR] = $1} END {print v[int((NR + 1) / 2)]}')" \
    "$(awk '{print $2}' "$workdir/raw" | sort -n | tail -1)"
}

paths() { # kind
  case $1 in
    day) random_dates $((warmup + day_count)) "$seed" | sed 's|^|/api/day/|' ;;
    range) random_windows $((warmup + month_count)) 31 "$seed" | awk '{print "/api/range?from=" $1 "&to=" $2}' ;;
    range-year) random_windows $((warmup + year_count)) 365 "$seed" | awk '{print "/api/range?from=" $1 "&to=" $2}' ;;
    heat) random_windows $((warmup + month_count)) 31 "$seed" | awk '{print "/api/heat?from=" $1 "&to=" $2}' ;;
    heat-year) random_windows $((warmup + year_count)) 365 "$seed" | awk '{print "/api/heat?from=" $1 "&to=" $2}' ;;
  esac
}

run() { # label kind
  paths "$2" > "$workdir/paths"
  get br < "$workdir/paths" > "$workdir/times"
  report "$1" "$workdir/times"
  tail -n +$((warmup + 1)) "$workdir/paths" > "$workdir/measured"
  raw_sizes "  (same requests, raw)" "$workdir/measured"
}

run "GET /api/day ($day_count dates)" day
run "GET /api/range ($month_count x 31 days)" range
run "GET /api/range ($year_count x 365 days)" range-year
run "GET /api/heat ($month_count x 31 days)" heat
run "GET /api/heat ($year_count x 365 days)" heat-year

# The places of the busiest year (the 365-day window with most places in it) are the ones to ask for.
best=$(random_windows "$year_count" 365 "$seed" | while read -r from to; do
  echo "$(curl -s "$base/api/range?from=$from&to=$to" | jq '.places | length') $from $to"
done | sort -rn | head -1)
read -r _ pfrom pto <<< "$best"
ids=$(curl -s "$base/api/range?from=$pfrom&to=$pto" | jq -r '.places[].id')
count=$(echo "$ids" | wc -l)
echo "$ids" | awk -v n=$((warmup + place_count)) -v seed="$seed" \
  "$RNG"' { id[NR] = $1 } END { seed_rnd(seed); for (i = 0; i < n; i++) print "/api/places/" id[int(rnd() * NR) + 1] }' > "$workdir/paths"
get br < "$workdir/paths" > "$workdir/times"
report "GET /api/places/{id} ($place_count, $count ids)" "$workdir/times"
tail -n +$((warmup + 1)) "$workdir/paths" > "$workdir/measured"
raw_sizes "  (same requests, raw)" "$workdir/measured"

# The trips: the list, then every trip of it by its id (the ids and the nights are the list's). Nothing is drawn at random: the same
# path is asked for `trip_count` times, after `warmup` more that are not measured. The raw size and the vertices (of the trip's moves)
# are of the same path, uncompressed.
trip_run() { # label path
  : > "$workdir/paths"
  for ((i = 0; i < warmup + trip_count; i++)); do echo "$2" >> "$workdir/paths"; done
  get br < "$workdir/paths" > "$workdir/times"
  report "$1" "$workdir/times"
  tail -n +$((warmup + 1)) "$workdir/paths" > "$workdir/measured"
  raw_sizes "  (same requests, raw)" "$workdir/measured"
}

trip_run "GET /api/trips ($trip_count)" /api/trips
curl -s "$base/api/trips" | jq -r '.trips[] | "\(.id) \(.nights)"' > "$workdir/trips"
if [ ! -s "$workdir/trips" ]; then
  echo "GET /api/trips/{id}: the list is empty: no trip to ask for"
else
  echo "  (the list has $(wc -l < "$workdir/trips") trips)"
  while read -r id nights; do
    trip_run "GET /api/trips/$id ($trip_count, $nights nights)" "/api/trips/$id"
  done < "$workdir/trips"
fi
