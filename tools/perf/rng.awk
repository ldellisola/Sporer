# A random number generator of our own for awk, shared by the perf scripts that draw dates, windows or terms at random (api-latency.sh and
# day-latency.sh): the Park-Miller "minimal standard", in doubles (16807 * 2^31 is far below 2^53, so it is exact), so that a seed gives the
# same numbers on every awk. awk's own srand(seed) does not: mawk, which is what Debian and Ubuntu have, takes its numbers from arc4random and
# ignores the seed, so every run of the first pass drew other dates and windows, and two runs could not be compared on the same requests.
#
# It is not run on its own: a script reads it into a shell variable and puts that in front of the program of each awk call that draws,
#   RNG=$(cat "$here/rng.awk")
#   awk -v seed="$seed" "$RNG"' BEGIN { seed_rnd(seed); print rnd() }'
# where seed_rnd(s) starts the sequence of the seed `s` and rnd() gives the next number, between 0 and 1 (neither included).
# Keep a function as the last thing in the file: what follows it in the program is joined to it.
function seed_rnd(s) { x = ((s + 1234567) * 48271) % 2147483647; if (x == 0) x = 1; for (k = 0; k < 8; k++) rnd() }
function rnd() { x = (x * 16807) % 2147483647; return x / 2147483647 }
