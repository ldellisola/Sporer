#!/usr/bin/env bash
# Times the first of each thing after a fresh start of the API: what the owner waits for while the JIT compiles the code that runs for the first time
# (a published build with ReadyToRun has less to compile, and this is the script that shows it).
#
#   tools/perf/first-after-start.sh <api-dll> <db-container> [database=perf] [starts=5] [mode=isolated] [kinds="refresh day range trips edit"]
#
# Starts `dotnet <api-dll>` itself (the environment says which database and where it listens: TSDB_CONNECTION_STRING, ASPNETCORE_URLS and so on,
# as in the "Repeat it" section of the perf documents; Processing__Debounce is set here to zero, so that a refresh follows its batch at once),
# over a finished backfill with the worker idle, and waits until the API answers `GET /api/status` (the time to that is printed too), and then for
# a second more, so that the worker's first pass over the queue is done. Then, for each of the `kinds`, the first of them:
#   refresh  the worker's refresh of the nights, homes and trips after a batch of points, timed as refresh-latency.sh does: from the database's log
#            (every statement logged for the length of the refresh, and put back), between the worker's read of the window that waits and its emptying
#   day      GET /api/day/{date}                  the middle date of the history
#   range    GET /api/range?from&to               the calendar month of that date, as the web app asks for a month
#   trips    GET /api/trips
#   edit     PUT /api/settings                    the trip distance set to 60 km, which works the homes and trips out again inside the request
# and the second of it where there is one (the same request again, for a read; the distance put back, for the edit, which runs the same recompute).
# The time of a request is curl's time_total in ms, over loopback, with `Accept-Encoding: br` as a browser asks, and a JSON body for the write.
#
# `mode` says how the starts go. `isolated` starts the API again for every kind, so that each is the first request after the start that asks for it:
# the worst case of each, which does not depend on the order. `sequence` takes the kinds in the order given after one start (the default order is what
# happens to the owner: the phone's batch and the worker's refresh, then a day, a month and the trips, then an edit), so that what a kind compiles
# is no longer to compile for the next, and the later ones are faster for it. The API is stopped after each start. `starts` starts are made (in
# `isolated` mode, that many of every kind), and the first times of each kind are printed as a line, in the order of the starts, with the median and the largest.
#
# What it changes it puts back: the trip distance goes back to what was stored before (none, or the number), through the API, so that the homes and
# trips are those of before too, and the log settings of the database are reset. What it cannot put back is the batch of the refresh: five points a
# start, of a device of its own (`perf-first`), a second apart in the evening of the second last day of the history, at the place the person was at
# then (as refresh-latency.sh sends them), later in that evening each start, so that the points are new each time. A history that is to stay as it
# is has to be made again.
set -euo pipefail
export TZ=UTC

dll=${1:?path to Sporer.Api.dll}
container=${2:?the docker container that holds the database}
database=${3:-perf}
starts=${4:-5}
mode=${5:-isolated}
kinds=${6:-refresh day range trips edit}
base=${ASPNETCORE_URLS:-http://127.0.0.1:5100}
base=${base%%;*}

command -v jq > /dev/null || { echo "first-after-start.sh needs jq: install it" >&2; exit 2; }
case $mode in sequence | isolated) ;; *) echo "first-after-start.sh: the mode is sequence or isolated, not $mode" >&2; exit 2 ;; esac
for kind in $kinds; do
  case $kind in day | range | trips | edit | refresh) ;; *) echo "first-after-start.sh: no kind $kind (day, range, trips, edit, refresh)" >&2; exit 2 ;; esac
done
! curl -s -o /dev/null --max-time 2 "$base/api/status" ||
  { echo "first-after-start.sh: something answers at $base already: stop it, the API is to be started here" >&2; exit 2; }

here=$(cd "$(dirname "$0")" && pwd)
psql_run() { docker exec "$container" psql -U postgres -d "$database" -X -tA "$@"; }
psql_one() { psql_run -c "$1"; }
workdir=$(mktemp -d)
pid=
logging=0
changed=0

for file in {day,range,trips,edit,refresh}.{first,second} refresh.db ready; do : > "$workdir/$file"; done

# What the owner set of the distance, to be put back: nothing, or the number stored.
stored=$(psql_one "select value from app_setting where key = 'tripMinDistanceKm'")
original_body='{"tripMinDistanceKm":null}'
[ -z "$stored" ] || original_body="{\"tripMinDistanceKm\":$stored}"

put_settings() { # json-body: prints "code seconds"
  curl -s -o "$workdir/body" -X PUT -H 'Content-Type: application/json' -H 'Accept-Encoding: br' -w '%{http_code} %{time_total}\n' --data "$1" "$base/api/settings"
}

# Always: the distance back through the running API (so that the homes and trips follow), the API stopped, the log settings of the database reset.
cleanup() {
  trap - EXIT INT TERM
  if [ -n "$pid" ] && kill -0 "$pid" 2> /dev/null; then
    [ "$changed" = 0 ] || put_settings "$original_body" > /dev/null || true
    stop_api
  fi
  [ "$logging" = 0 ] || logging_off || true
  rm -rf "$workdir"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

logging_on() {
  docker exec "$container" psql -U postgres -X -q -c "alter system set log_min_duration_statement = 0" -c "alter system set log_line_prefix = '%m [%p] '" \
    -c "select pg_reload_conf()" > /dev/null
  logging=1
}
logging_off() {
  docker exec "$container" psql -U postgres -X -q -c "alter system reset log_min_duration_statement" -c "alter system reset log_line_prefix" \
    -c "select pg_reload_conf()" > /dev/null
  logging=0
}

# Starts the API and waits until it answers: sets $ready_ms, the milliseconds from the start of the process to the first answer of /api/status
# (polled every 50 ms), and refuses a history whose backfill is not finished.
start_api() {
  local began now status
  began=$(date +%s%N)
  Processing__Debounce=00:00:00 dotnet "$dll" > "$workdir/api.log" 2>&1 &
  pid=$!
  while :; do
    kill -0 "$pid" 2> /dev/null || { echo "first-after-start.sh: the API stopped:" >&2; tail -20 "$workdir/api.log" >&2; pid=; exit 1; }
    if status=$(curl -fsS --max-time 2 "$base/api/status" 2> /dev/null); then
      now=$(date +%s%N)
      break
    fi
    sleep 0.05
  done
  ready_ms=$(( (now - began) / 1000000 ))
  echo "$ready_ms" >> "$workdir/ready"
  [ "$(jq -r '.backfill.percent' <<< "$status")" = 100 ] && [ "$(jq -r '.pendingRanges' <<< "$status")" = 0 ] ||
    { echo "first-after-start.sh: the backfill is not finished (or ranges are pending): run it first, over $database" >&2; exit 2; }
  sleep 1
}
stop_api() {
  kill "$pid" 2> /dev/null || true
  wait "$pid" 2> /dev/null || true
  pid=
}

# The history: its middle date and that date's calendar month, and where the person was on the second last evening.
first_date=$(psql_one "select min(local_start_date) from segment")
last_date=$(psql_one "select max(local_end_date) from segment")
[ -n "$first_date" ] && [ -n "$last_date" ] || { echo "first-after-start.sh: $database has no timeline: run the backfill first" >&2; exit 2; }
span=$(( ( $(date -d "$last_date" +%s) - $(date -d "$first_date" +%s) ) / 86400 ))
day=$(date -d "$first_date + $((span / 2)) days" +%F)
month_from=$(date -d "$day" +%Y-%m-01)
month_to=$(date -d "$month_from + 1 month - 1 day" +%F)
evening=$(date -d "$last_date - 1 day" +%F)
read -r lat lon <<< "$(psql_one "select p.latitude || ' ' || p.longitude from segment s join place p on p.id = s.place_id
                                  where s.kind = 'stay' and s.start_utc <= '$evening 21:00:00+00' and s.end_utc > '$evening 21:00:00+00' limit 1" | tr '|' ' ')"
[ -n "${lat:-}" ] || { echo "first-after-start.sh: the person was at no place at $evening 21:00 UTC: pick another history" >&2; exit 2; }

overland="$base/api/overland"
[ -z "${OVERLAND_TOKEN:-}" ] || overland="$overland?token=$OVERLAND_TOKEN"

# The five points of the batch, a second apart from `first` (epoch seconds)
batch() {
  local i stamp
  printf '{"locations":['
  for i in 0 1 2 3 4; do
    printf -v stamp '%(%Y-%m-%dT%H:%M:%SZ)T' $(($1 + i))
    [ "$i" -gt 0 ] && printf ','
    printf '{"type":"Feature","geometry":{"type":"Point","coordinates":[%s,%s]},"properties":{"timestamp":"%s","altitude":20,"speed":0,"horizontal_accuracy":8,"motion":["stationary"],"device_id":"perf-first"}}' "$lon" "$lat" "$stamp"
  done
  printf ']}'
}

ms() { awk '{printf "%.1f", $1 * 1000}'; } # seconds on stdin

# A request's first time (and its second, if asked) of a read: "code seconds" lines appended to $workdir/<kind>.first and .second
read_kind() { # kind path
  local kind=$1 path=$2 part out
  for part in first second; do
    out=$(curl -s -o /dev/null -H 'Accept-Encoding: br' -w '%{http_code} %{time_total}' "$base$path")
    echo "$out" >> "$workdir/$kind.$part"
  done
}

edit_kind() {
  local out
  changed=1
  out=$(put_settings '{"tripMinDistanceKm":60}')
  echo "$out" >> "$workdir/edit.first"
  out=$(put_settings "$original_body")
  echo "$out" >> "$workdir/edit.second"
  case $out in 2*) changed=0 ;; *) echo "first-after-start.sh: putting the distance back answered ${out%% *}" >&2; exit 1 ;; esac
}

# The first refresh of the process: one batch, and the time of the refresh it makes the worker do, from the database's log.
refresh_kind() {
  local n minute since code left wait spans lines
  n=$(( $(psql_one "select count(*) from locationlog where device = 'perf-first'") / 5 ))
  minute=$((30 + n))
  batch $(( $(date -d "$evening 21:00:17" +%s) + minute * 60 )) > "$workdir/batch"
  logging_on
  sleep 1
  since=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  code=$(curl -s -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' --data-binary "@$workdir/batch" "$overland")
  [ "$code" = 200 ] || { echo "first-after-start.sh: the batch was refused with $code" >&2; exit 1; }
  for ((wait = 0; wait < 240; wait++)); do # at most a minute
    left=$(psql_one "select (select count(*) from dirty_range) + (select count(*) from night_refresh where from_utc is not null)")
    [ "$left" = 0 ] && break
    sleep 0.25
  done
  [ "$left" = 0 ] || { echo "first-after-start.sh: still waiting for the refresh after a minute: is the worker running?" >&2; exit 1; }
  sleep 1
  spans=$(docker logs "$container" --since "$since" 2>&1 | awk -f "$here/refresh-spans.awk")
  logging_off
  lines=$(wc -l <<< "$spans")
  [ -n "$spans" ] || { echo "first-after-start.sh: no refresh in the database's log (did the statements get logged?)" >&2; exit 1; }
  [ "$lines" = 1 ] || echo "first-after-start.sh: $lines refreshes in the log after the batch, the first is taken" >&2
  head -1 <<< "$spans" | awk '{print 200, $1}' >> "$workdir/refresh.first"
  head -1 <<< "$spans" | awk '{print 200, $2}' >> "$workdir/refresh.db"
}

run_kind() {
  case $1 in
    day) read_kind day "/api/day/$day" ;;
    range) read_kind range "/api/range?from=$month_from&to=$month_to" ;;
    trips) read_kind trips /api/trips ;;
    edit) edit_kind ;;
    refresh) refresh_kind ;;
  esac
}

echo "$database: history $first_date to $last_date; day $day, month $month_from to $month_to; mode $mode, $starts starts; the distance stored: ${stored:-none}"
for ((s = 1; s <= starts; s++)); do
  if [ "$mode" = sequence ]; then
    start_api
    echo "start $s: ready after $ready_ms ms"
    for kind in $kinds; do run_kind "$kind"; done
    stop_api
  else
    for kind in $kinds; do
      start_api
      echo "start $s, $kind: ready after $ready_ms ms"
      run_kind "$kind"
      stop_api
    done
  fi
done

# One line a kind: the first times in the order of the starts, their median and the largest, the second times the same way, and how many were not 2xx.
report() { # label kind
  local label=$1 file="$workdir/$2.first" failed
  [ -s "$file" ] || return 0
  failed=$(awk '$1 !~ /^2/' "$file" "$workdir/$2.second" 2> /dev/null | wc -l)
  printf '%-30s first, ms: %s | median %s, max %s' "$label" "$(awk '{printf "%.0f ", $2 * 1000}' "$file")" \
    "$(awk '{print $2 * 1000}' "$file" | sort -g | awk '{v[NR] = $1} END {printf "%.1f", v[int((NR + 1) / 2)]}')" \
    "$(awk '{print $2 * 1000}' "$file" | sort -g | tail -1 | awk '{printf "%.1f", $1}')"
  if [ -s "$workdir/$2.second" ]; then
    printf ' | second, ms: %s | median %s' "$(awk '{printf "%.0f ", $2 * 1000}' "$workdir/$2.second")" \
      "$(awk '{print $2 * 1000}' "$workdir/$2.second" | sort -g | awk '{v[NR] = $1} END {printf "%.1f", v[int((NR + 1) / 2)]}')"
  fi
  printf ' | non-2xx=%d\n' "$failed"
}
echo "the first time of each, in the order of the starts ($mode mode):"
echo "start to the first answer of /api/status, ms: $(tr '\n' ' ' < "$workdir/ready")| median $(sort -n "$workdir/ready" | awk '{v[NR] = $1} END {print v[int((NR + 1) / 2)]}'), max $(sort -n "$workdir/ready" | tail -1)"
report "worker refresh" refresh
if [ -s "$workdir/refresh.db" ]; then
  echo "  of the refresh the database's statements, ms: $(awk '{printf "%.0f ", $2 * 1000}' "$workdir/refresh.db")"
fi
report "GET /api/day/$day" day
report "GET /api/range ($month_from)" range
report "GET /api/trips" trips
report "PUT /api/settings (60 km)" edit

# What was changed is as it was: the distance stored, and the trips that follow it.
echo "after: the distance stored: $(psql_one "select coalesce((select value::text from app_setting where key = 'tripMinDistanceKm'), 'none')"); $(psql_one "select count(*) from trip") trips, $(psql_one "select count(*) from home_period") home periods"
