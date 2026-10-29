# One line per refresh of the nights, homes and trips (TripRefresher.RefreshAsync) in the log of a database that logs every statement
# (log_min_duration_statement = 0, with log_line_prefix = '%m [%p] '): "<seconds> <seconds>", the refresh's time and the time of the
# statements the database ran in it. Shared by refresh-latency.sh and first-after-start.sh; the log comes on stdin.
#
# The refresh is what lies between two statements of the worker: its read of the window that waits (`select ... from night_refresh where
# id = 1`, the first thing it does in a refresh) and its emptying (`update night_refresh set from_utc = null ...`, the last). The database logs a
# statement in three messages (parse, bind, execute): the refresh begins after the execute of the read and ends after the execute of the update,
# and the script's own queries (the polling of the window) are left out. The worker reads the window on every pass, so a read that found
# nothing is simply taken again by the next one.
function seconds(line,   t) { split(substr(line, 12, 12), t, /[:.]/); return t[1] * 3600 + t[2] * 60 + t[3] + t[4] / 1000 }
/from_utc is not null/ { next }
/execute [^:]*: select from_utc as FromUtc.*night_refresh where id = 1/ { take = seconds($0); db = 0; next }
take != "" && /duration: / { match($0, /duration: [0-9.]+ ms/); db += substr($0, RSTART + 10, RLENGTH - 13) }
take != "" && /execute [^:]*: update night_refresh set from_utc = null/ {
  total = seconds($0) - take; if (total < 0) total += 86400
  printf "%.4f %.4f\n", total, db / 1000; take = ""
}
