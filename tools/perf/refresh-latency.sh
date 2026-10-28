#!/usr/bin/env bash
# Times the live refresh of the nights, homes and trips: what the worker does after a range of the timeline was rebuilt.
#
#   tools/perf/refresh-latency.sh <base-url> <db-container> [database=perf] [rounds=25] [token]
#
# Needs the API running over a finished backfill, started with Processing__Debounce=00:00:00 (the debounce only decides when a
# range is processed, one minute after the last batch by default, so that 25 rounds would take half an hour; it does not change
# what a refresh does). Each round sends one small Overland batch, as the phone does, through POST /api/overland: five points, a
# second apart, in the evening of a recent day (the second last day of the history), at the place the person was at then, so the
# batch adds nothing to what is detected. It marks a range dirty; the worker rebuilds it, then refreshes (TripRefresher): the
# nights of what was rebuilt, and the homes and trips from every night. The script waits until the dirty range and the refresh's
# window are both gone, which is before it asks for the next batch.
#
# How it is timed, with no change to the app: the database logs every statement with a millisecond timestamp (log_min_duration_statement
# = 0, set here with ALTER SYSTEM for the length of the run and put back at the end), and the refresh is what lies between two of
# them: the worker's read of the window that waits (`select ... from night_refresh where id = 1`, the first thing it does in a
# refresh) and its emptying (`update night_refresh set from_utc = null ...`, the last). Between them is the whole of
# TripRefresher.RefreshAsync: reading the stays and nights, building the nights, working out the homes and trips in memory, and the
# transaction that writes them. The time of the update itself is inside it; the time of the read is not. The statements the
# database ran in between are added up too, to say how much of it was the database's and how much the app's (C# and the round trips).
# Prints n, p50, p95, p99 and max of both, in ms.
set -euo pipefail
export TZ=UTC

base=${1:?base url, e.g. http://127.0.0.1:5100}
container=${2:?the docker container that holds the database}
database=${3:-perf}
rounds=${4:-25}
token=${5:-}

here=$(cd "$(dirname "$0")" && pwd)
command -v jq > /dev/null || { echo "refresh-latency.sh needs jq: install it" >&2; exit 2; }
curl -fsS -o /dev/null --max-time 10 "$base/api/status" ||
  { echo "refresh-latency.sh: no answer from $base/api/status: start the API over the finished backfill first" >&2; exit 2; }

psql_one() { docker exec "$container" psql -U postgres -d "$database" -X -tA -c "$1"; }
workdir=$(mktemp -d)
restore() {
  docker exec "$container" psql -U postgres -X -q -c "alter system reset log_min_duration_statement" -c "alter system reset log_line_prefix" \
    -c "select pg_reload_conf()" > /dev/null
  rm -rf "$workdir"
}
trap restore EXIT

# The evening of the second last day of the history, and where the person was then.
last=$(psql_one "select max(local_end_date) from segment")
day=$(date -d "$last - 1 day" +%F)
read -r lat lon <<< "$(psql_one "select p.latitude || ' ' || p.longitude from segment s join place p on p.id = s.place_id
                                  where s.kind = 'stay' and s.start_utc <= '$day 21:00:00+00' and s.end_utc > '$day 21:00:00+00' limit 1" | tr '|' ' ')"
[ -n "${lat:-}" ] || { echo "refresh-latency.sh: the person was at no place at $day 21:00 UTC: pick another history" >&2; exit 2; }

url="$base/api/overland"
[ -n "$token" ] && url="$url?token=$token"
batch() { # round: five points a second apart, a minute and a bit after the round before
  local first=$(($(date -d "$day 21:00:17" +%s) + $1 * 60)) i stamp
  printf '{"locations":['
  for i in 0 1 2 3 4; do
    printf -v stamp '%(%Y-%m-%dT%H:%M:%SZ)T' $((first + i))
    [ "$i" -gt 0 ] && printf ','
    printf '{"type":"Feature","geometry":{"type":"Point","coordinates":[%s,%s]},"properties":{"timestamp":"%s","altitude":20,"speed":0,"horizontal_accuracy":8,"motion":["stationary"],"device_id":"perf-test"}}' "$lon" "$lat" "$stamp"
  done
  printf ']}'
}

docker exec "$container" psql -U postgres -X -q -c "alter system set log_min_duration_statement = 0" -c "alter system set log_line_prefix = '%m [%p] '" \
  -c "select pg_reload_conf()" > /dev/null
sleep 1
since=$(date -u +%Y-%m-%dT%H:%M:%SZ)

for ((r = 0; r < rounds; r++)); do
  batch "$r" > "$workdir/body"
  code=$(curl -s -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' --data-binary "@$workdir/body" "$url")
  [ "$code" = 200 ] || { echo "round $r: the batch was refused with $code" >&2; exit 1; }
  for ((wait = 0; wait < 60; wait++)); do # at most a minute
    left=$(psql_one "select (select count(*) from dirty_range) + (select count(*) from night_refresh where from_utc is not null)")
    [ "$left" = 0 ] && break
    sleep 1
  done
  [ "$left" = 0 ] || { echo "round $r: still waiting after a minute: is the worker running, and is the debounce 0?" >&2; exit 1; }
done
sleep 1

# One line per refresh: its time and the time of the statements the database ran in it (ms). The database logs a statement in three
# messages (parse, bind, execute): the refresh begins after the execute of the read and ends after the execute of the update, and
# the script's own queries (the polling above) are left out.
docker logs "$container" --since "$since" 2>&1 | awk '
  function seconds(line,   t) { split(substr(line, 12, 12), t, /[:.]/); return t[1] * 3600 + t[2] * 60 + t[3] + t[4] / 1000 }
  /from_utc is not null/ { next }
  /execute [^:]*: select from_utc as FromUtc.*night_refresh where id = 1/ { take = seconds($0); db = 0; next }
  take != "" && /duration: / { match($0, /duration: [0-9.]+ ms/); db += substr($0, RSTART + 10, RLENGTH - 13) }
  take != "" && /execute [^:]*: update night_refresh set from_utc = null/ {
    total = seconds($0) - take; if (total < 0) total += 86400
    printf "%.4f %.4f\n", total, db / 1000; take = ""
  }' > "$workdir/refreshes"

n=$(wc -l < "$workdir/refreshes")
[ "$n" -gt 0 ] || { echo "refresh-latency.sh: no refresh in the database's log (did the statements get logged?)" >&2; exit 1; }
echo "$n refreshes from $rounds batches at $day (the person at $lat, $lon)"
echo "refresh (nights, homes, trips): $(awk '{print $1}' "$workdir/refreshes" | sort -g | awk -f "$here/percentiles.awk")"
echo "  in the order they ran (ms): $(awk '{printf "%d ", $1 * 1000}' "$workdir/refreshes")"
echo "  of it the database's statements: $(awk '{print $2}' "$workdir/refreshes" | sort -g | awk -f "$here/percentiles.awk")"
echo "  nights, home periods and trips stored now: $(psql_one "select (select count(*) from night) || ', ' || (select count(*) from home_period) || ', ' || (select count(*) from trip)")"
