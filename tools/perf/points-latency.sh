#!/usr/bin/env bash
# Times GET /api/day/{date}/points, the raw points of a day that edit mode draws, over a whole history, and measures what it sends.
#
#   tools/perf/points-latency.sh <base-url> <first-date> <last-date> [warmup=20] [repeat=50]
#
# Three passes, each on the API warm (the dates are the history's own, taken in the order they come):
#   every day   one request for every date from the first to the last, with `Accept-Encoding: identity` (the sizes it records are the raw
#               JSON the app parses, and are what picks the next two); the time is of the answer uncompressed. A request each, so each is
#               the first read of its day since the start of the API: what a real first visit costs.
#   typical     the day of the median raw size among the days that have points, `repeat` times after `warmup` that are not measured,
#               with `Accept-Encoding: br` as a browser asks, with its sizes and its number of points.
#   heaviest    the same for the day with the most bytes.
# Times are curl's time_total in ms, which includes connecting to a local server. The points are counted with jq.
set -euo pipefail

base=${1:?base url, e.g. http://127.0.0.1:5100}
first=${2:?first date, yyyy-mm-dd}
last=${3:?last date, yyyy-mm-dd}
warmup=${4:-20}
repeat=${5:-50}

command -v jq > /dev/null || { echo "points-latency.sh needs jq (to count the points): install it" >&2; exit 2; }
curl -fsS -o /dev/null --max-time 10 "$base/api/status" ||
  { echo "points-latency.sh: no answer from $base/api/status: start the API over the history first" >&2; exit 2; }

here=$(cd "$(dirname "$0")" && pwd)
days=$(( ( $(date -u -d "$last" +%s) - $(date -u -d "$first" +%s) ) / 86400 + 1 ))
workdir=$(mktemp -d)
trap 'rm -rf "$workdir"' EXIT

# --- Every day, once ---
: > "$workdir/sweep"
for ((k = 0; k < days; k++)); do
  date=$(date -u -d "$first + $k days" +%F)
  curl -s -o /dev/null -H 'Accept-Encoding: identity' -w "$date %{http_code} %{time_total} %{size_download}\n" "$base/api/day/$date/points" >> "$workdir/sweep"
done
failed=$(awk '$2 != 200' "$workdir/sweep" | wc -l)
# An empty day is {"date":"...","devices":[],"points":[]}, 46 bytes: those that have points are the days worth looking at.
awk '$4 > 100' "$workdir/sweep" | sort -k4,4n > "$workdir/withpoints"
with=$(wc -l < "$workdir/withpoints")
printf '%-34s %s  non-200=%d  raw: median %d B, p95 %d B, max %d B  (%d of %d days have points)\n' \
  "GET /api/day/{date}/points (every)" "$(awk '{print $3}' "$workdir/sweep" | sort -g | awk -f "$here/percentiles.awk")" "$failed" \
  "$(awk '{v[NR] = $4} END {print v[int((NR + 1) / 2)]}' "$workdir/withpoints")" \
  "$(awk '{v[NR] = $4} END {print v[int((NR * 95 + 99) / 100)]}' "$workdir/withpoints")" \
  "$(awk '{v[NR] = $4} END {print v[NR]}' "$workdir/withpoints")" "$with" "$days"
[ "$with" -gt 0 ] || { echo "no day has points" >&2; exit 1; }

# --- One day, repeated ---
one() { # label date
  local path="/api/day/$2/points" i
  for ((i = 0; i < warmup; i++)); do curl -s -o /dev/null -H 'Accept-Encoding: br' "$base$path"; done
  : > "$workdir/times"
  for ((i = 0; i < repeat; i++)); do
    curl -s -o /dev/null -H 'Accept-Encoding: br' -w '%{http_code} %{time_total} %{size_download}\n' "$base$path" >> "$workdir/times"
  done
  curl -s -H 'Accept-Encoding: identity' "$base$path" -o "$workdir/body" -w '%{size_download}' > "$workdir/size"
  printf '%-34s %s  non-200=%d  br %d B, raw %d B, %d points, %d devices\n' "$1 $2" \
    "$(awk '{print $2}' "$workdir/times" | sort -g | awk -f "$here/percentiles.awk")" "$(awk '$1 != 200' "$workdir/times" | wc -l)" \
    "$(awk 'NR == 1 {print $3}' "$workdir/times")" "$(cat "$workdir/size")" "$(jq '.points | length' "$workdir/body")" "$(jq '.devices | length' "$workdir/body")"
}

one "  typical day" "$(awk -v n="$with" 'NR == int((n + 1) / 2) {print $1}' "$workdir/withpoints")"
one "  heaviest day" "$(awk 'END {print $1}' "$workdir/withpoints")"
