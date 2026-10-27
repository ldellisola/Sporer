#!/usr/bin/env bash
# Times the first backfill: from starting the API over a history that has no timeline yet to the timeline being complete.
#
#   tools/perf/backfill-time.sh <api-dll> [db-container] [database=perf] [poll-seconds=1]
#
# Starts `dotnet <api-dll>` itself (the environment says which database and where it listens: TSDB_CONNECTION_STRING and
# ASPNETCORE_URLS, as in the "Repeat it" section of the perf documents), polls /api/status until the backfill is at 100 % with no range
# pending, and prints the seconds from the start of the process to then. With a docker container that holds the database it also waits
# for the window of `night_refresh` to be empty, because the refresh of the nights, homes and trips of the last step runs after the
# state that says 100 % was saved; a database with no such table (the code before Plan 3) is done at 100 % alone. The API is stopped
# at the end, unless KEEP=1 (then it is left running, and its pid and its log are printed). The same pass of the same script times the code of
# any commit: build it, and give its dll.
set -euo pipefail

dll=${1:?path to Sporer.Api.dll}
container=${2:-}
database=${3:-perf}
poll=${4:-1}
base=${ASPNETCORE_URLS:-http://127.0.0.1:5100}

command -v jq > /dev/null || { echo "backfill-time.sh needs jq: install it" >&2; exit 2; }
command -v bc > /dev/null || { echo "backfill-time.sh needs bc: install it" >&2; exit 2; }

psql_one() { docker exec "$container" psql -U postgres -d "$database" -X -tA -c "$1"; }

log=$(mktemp)
start=$(date +%s.%N)
dotnet "$dll" > "$log" 2>&1 &
pid=$!
trap '[ "${KEEP:-0}" = 1 ] || { kill "$pid" 2> /dev/null; rm -f "$log"; }' EXIT

while :; do
  kill -0 "$pid" 2> /dev/null || { echo "the API stopped:" >&2; tail -20 "$log" >&2; exit 1; }
  status=$(curl -s --max-time 5 "$base/api/status" || true)
  if [ -n "$status" ] && [ "$(echo "$status" | jq -r '.backfill.percent')" = 100 ] && [ "$(echo "$status" | jq -r '.pendingRanges')" = 0 ]; then
    waiting=0
    if [ -n "$container" ]; then
      waiting=$(psql_one "select count(*) from night_refresh where from_utc is not null" 2> /dev/null || echo 0)
    fi
    [ "$waiting" = 0 ] && break
  fi
  sleep "$poll"
done
end=$(date +%s.%N)

printf 'backfill: %.1f s from the start of the process to 100 %% (polled every %s s)\n' "$(echo "$end - $start" | bc -l)" "$poll"
echo "$status" | jq -c '{backfill, pendingRanges, failedRanges: (.failedRanges | length), lastError, warnings}'
if [ -n "$container" ]; then
  psql_one "select 'segments ' || (select count(*) from segment)" 2> /dev/null || true
  psql_one "select 'nights ' || (select count(*) from night) || ', home periods ' || (select count(*) from home_period) || ', trips ' || (select count(*) from trip)" 2> /dev/null || true
fi
[ "${KEEP:-0}" = 1 ] && echo "left running: pid $pid, its output in $log"
exit 0
