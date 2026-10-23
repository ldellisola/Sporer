#!/usr/bin/env bash
# Times GET /api/day/{date} for random dates of a history: some requests to warm up, then the measured ones.
#
#   tools/perf/day-latency.sh <base-url> <first-date> <last-date> [warmup=50] [samples=200] [seed=1]
#
# Dates are picked with awk's seeded generator, so a run can be repeated. The time is curl's time_total, in
# ms; it includes connecting to the server (a local one, so a fraction of a millisecond).
set -euo pipefail

base=${1:?base url, e.g. http://127.0.0.1:5100}
first=${2:?first date, yyyy-mm-dd}
last=${3:?last date, yyyy-mm-dd}
warmup=${4:-50}
samples=${5:-200}
seed=${6:-1}

days=$(( ( $(date -u -d "$last" +%s) - $(date -u -d "$first" +%s) ) / 86400 + 1 ))
here=$(cd "$(dirname "$0")" && pwd)

random_dates() { # count seed
  awk -v n="$1" -v days="$days" -v seed="$2" 'BEGIN { srand(seed); for (i = 0; i < n; i++) print int(rand() * days) }' |
    while read -r offset; do date -u -d "$first + $offset days" +%F; done
}

request() { curl -s -o /dev/null -w '%{http_code} %{time_total}\n' "$base/api/day/$1"; }

for d in $(random_dates "$warmup" "$seed"); do request "$d" > /dev/null; done

results=$(for d in $(random_dates "$samples" "$((seed + 1))"); do request "$d"; done)
failed=$(echo "$results" | awk '$1 != 200' | wc -l)
echo "GET /api/day: $(echo "$results" | awk '{print $2}' | sort -g | awk -f "$here/percentiles.awk")  non-200=$failed"
