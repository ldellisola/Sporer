# Reads seconds, one per line, sorted ascending (sort -g); prints n, p50, p95, p99 and max in milliseconds (nearest rank).
{ v[NR] = $1 * 1000 }
END {
  n = NR
  if (n == 0) { print "no samples"; exit 1 }
  printf "n=%d  p50=%.1f ms  p95=%.1f ms  p99=%.1f ms  max=%.1f ms\n",
    n, v[int((n * 50 + 99) / 100)], v[int((n * 95 + 99) / 100)], v[int((n * 99 + 99) / 100)], v[n]
}
