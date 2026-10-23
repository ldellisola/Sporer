#!/usr/bin/env bash
# Times POST /api/overland with single-batch payloads (made-up points near a made-up spot, stamped now and just before).
#
#   tools/perf/ingest-latency.sh <base-url> [requests=200] [points-per-batch=20] [token] [pause-seconds=0]
#
# Each request carries its own stretch of time (one point a second, the last request ending now), so no two points share a
# time. The points are real rows in locationlog and mark time ranges as dirty, like a phone's. The time is curl's
# time_total, in ms; the payloads are built before it starts, so building them does not count.
set -euo pipefail
export TZ=UTC

base=${1:?base url, e.g. http://127.0.0.1:5100}
requests=${2:-200}
points=${3:-20}
token=${4:-}
pause=${5:-0}

here=$(cd "$(dirname "$0")" && pwd)
url="$base/api/overland"
[ -n "$token" ] && url="$url?token=$token"
now=$(date +%s)

payload() { # request number
  local first=$((now - (requests - $1) * points)) i stamp
  printf '{"locations":['
  for ((i = 0; i < points; i++)); do
    printf -v stamp '%(%Y-%m-%dT%H:%M:%SZ)T' $((first + i))
    [ "$i" -gt 0 ] && printf ','
    printf '{"type":"Feature","geometry":{"type":"Point","coordinates":[10.7%s,59.9%s]},"properties":{"timestamp":"%s","altitude":20,"speed":1.2,"horizontal_accuracy":8,"motion":["walking"],"device_id":"perf-test"}}' \
      "$((RANDOM % 100))" "$((RANDOM % 100))" "$stamp"
  done
  printf ']}'
}

body=$(mktemp)
trap 'rm -f "$body"' EXIT
results=$(for ((r = 0; r < requests; r++)); do
  payload "$r" > "$body" # a file: a thousand points do not fit on a command line
  curl -s -o /dev/null -w '%{http_code} %{time_total}\n' -H 'Content-Type: application/json' --data-binary "@$body" "$url"
  [ "$pause" = 0 ] || sleep "$pause"
done)
failed=$(echo "$results" | awk '$1 != 200' | wc -l)
echo "POST /api/overland ($points points): $(echo "$results" | awk '{print $2}' | sort -g | awk -f "$here/percentiles.awk")  non-200=$failed"
