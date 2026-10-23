#!/usr/bin/env bash
# Times POST /api/overland with single-batch payloads of a few points each (the points are stamped now, near a made-up spot).
#
#   tools/perf/ingest-latency.sh <base-url> [requests=200] [points-per-batch=20] [token]
#
# The points are real rows in locationlog and mark time ranges as dirty, like a phone's. The time is curl's
# time_total, in ms.
set -euo pipefail

base=${1:?base url, e.g. http://127.0.0.1:5100}
requests=${2:-200}
points=${3:-20}
token=${4:-}

here=$(cd "$(dirname "$0")" && pwd)
url="$base/api/overland"
[ -n "$token" ] && url="$url?token=$token"

payload() {
  local now stamp i
  now=$(date -u +%s)
  printf '{"locations":['
  for ((i = 0; i < points; i++)); do
    stamp=$(date -u -d "@$((now - points + i))" +%FT%TZ)
    [ "$i" -gt 0 ] && printf ','
    printf '{"type":"Feature","geometry":{"type":"Point","coordinates":[%s,%s]},"properties":{"timestamp":"%s","altitude":20,"speed":1.2,"horizontal_accuracy":8,"motion":["walking"],"device_id":"perf-test"}}' \
      "10.7$((RANDOM % 100))" "59.9$((RANDOM % 100))" "$stamp"
  done
  printf ']}'
}

results=$(for ((r = 0; r < requests; r++)); do
  curl -s -o /dev/null -w '%{http_code} %{time_total}\n' -H 'Content-Type: application/json' -d "$(payload)" "$url"
done)
failed=$(echo "$results" | awk '$1 != 200' | wc -l)
echo "POST /api/overland ($points points): $(echo "$results" | awk '{print $2}' | sort -g | awk -f "$here/percentiles.awk")  non-200=$failed"
