// Records the API responses that the web performance run (`npm run perf`) serves in place of the API.
//
//   node scripts/perf/record.mjs <api-base-url> <first-date> <last-date> [year]
//
// Run it against the API over the synthetic history (tools/Sporer.SyntheticData, see docs/superpowers/plans/2026-10-24-sporer-plan-2-perf.md),
// after its backfill: nothing of an owner's history belongs here. It looks at every day and every whole calendar month between the
// two dates and records
//   - a typical day (the median weekday by the size of its answer) and the heaviest day,
//   - a typical month and the heaviest month (the same, over whole calendar months),
//   - one year (the calendar year given, else the one whose answer is the largest),
// and, for each, what the app asks for on top of it: the status, and the two days or periods either side (it prefetches the one before and
// the one after whatever is on show, so a step to the next one asks for the one after that).
// Everything goes to perf/recorded/, as the server wrote it, with an index of the requests it answers. The directory is not
// committed (a year of routes is half a megabyte): record again on the machine that measures. It is written to perf/recorded.partial/
// first and takes the place of the old recording only when it is complete, so that a server that fails half-way (or a run that is
// stopped) leaves the old recording as it was, and never a half of a new one.
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const [base, first, last, yearArg] = process.argv.slice(2);
if (!base || !first || !last) {
  console.error("usage: node scripts/perf/record.mjs <api-base-url> <first-date> <last-date> [year]");
  process.exit(2);
}

const perf = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "perf");
const out = join(perf, "recorded");
const partial = join(perf, "recorded.partial");

// --- Dates, all in UTC and as yyyy-mm-dd, which is how the app writes them ---
const DAY = 86_400_000;
const parse = (date) => Date.parse(`${date}T00:00:00Z`);
const text = (ms) => new Date(ms).toISOString().slice(0, 10);
const addDays = (date, days) => text(parse(date) + days * DAY);
const monthOf = (date) => date.slice(0, 7);
const monthRange = (month) => {
  const [y, m] = month.split("-").map(Number);
  return { from: `${month}-01`, to: text(Date.UTC(y, m, 0)) }; // day 0 of the next month is the last of this one
};
const addMonths = (month, delta) => {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
};

// --- Fetching ---
const index = {}; // request path and query -> file
const files = {}; // file -> { bytes }
async function record(path, name) {
  if (index[path]) return;
  const response = await fetch(base + path, { headers: { Accept: "application/json", "Accept-Encoding": "identity" } });
  if (!response.ok) throw new Error(`GET ${path} answered ${response.status}`);
  const body = await response.text();
  const file = `${name}.json`;
  writeFileSync(join(partial, file), body);
  index[path] = file;
  files[file] = { bytes: Buffer.byteLength(body) };
  return body;
}
async function peek(path) {
  const response = await fetch(base + path, { headers: { Accept: "application/json", "Accept-Encoding": "identity" } });
  if (!response.ok) throw new Error(`GET ${path} answered ${response.status}`);
  const body = await response.text();
  return { body, bytes: Buffer.byteLength(body), json: JSON.parse(body) };
}
const median = (sorted) => sorted[Math.floor((sorted.length - 1) / 2)];

// --- Choosing what to record ---
const dayCount = (parse(last) - parse(first)) / DAY + 1;
const days = [];
for (let k = 0; k < dayCount; k++) {
  const date = addDays(first, k);
  const { bytes, json } = await peek(`/api/day/${date}`);
  if (json.segments.length === 0) continue;
  days.push({ date, bytes, segments: json.segments.length, weekday: new Date(parse(date)).getUTCDay() });
}
const weekdays = days.filter((d) => d.weekday >= 1 && d.weekday <= 5 && d.segments >= 5).sort((a, b) => a.bytes - b.bytes);
const typicalDay = median(weekdays);
const heavyDay = [...days].sort((a, b) => b.bytes - a.bytes)[0];

const months = [];
for (let month = monthOf(first); month <= monthOf(last); month = addMonths(month, 1)) {
  const { from, to } = monthRange(month);
  if (from < first || to > last) continue; // a month the history does not cover whole is not typical of anything
  const { bytes, json } = await peek(`/api/range?from=${from}&to=${to}`);
  months.push({ month, bytes, moves: json.moves.length, days: json.days.length });
}
months.sort((a, b) => a.bytes - b.bytes);
const typicalMonth = median(months);
const heavyMonth = months[months.length - 1];

const years = [];
for (let year = Number(first.slice(0, 4)); year <= Number(last.slice(0, 4)); year++) {
  const { bytes } = await peek(`/api/range?from=${year}-01-01&to=${year}-12-31`);
  years.push({ year, bytes });
}
const year = yearArg ? Number(yearArg) : [...years].sort((a, b) => b.bytes - a.bytes)[0].year;

// --- Recording them, and what the app asks for around each ---
// Into a directory of its own: the old recording goes only once this one is complete (a server that was not there, that failed while
// the days were looked at or that fails now, leaves it as it was), and what a failed run began is taken away again.
rmSync(partial, { recursive: true, force: true }); // what an earlier run that was killed left
mkdirSync(partial, { recursive: true });
let complete = false;
process.on("exit", () => {
  if (!complete) rmSync(partial, { recursive: true, force: true }); // a failure on the way (the server went away, say) takes its half with it
});
const scenarios = [];
const rangePath = ({ from, to }) => `/api/range?from=${from}&to=${to}`;

for (const [id, label, day] of [
  ["day", "a typical weekday", typicalDay],
  ["day-heavy", "the heaviest day", heavyDay],
]) {
  for (const date of [-2, -1, 0, 1, 2].map((k) => addDays(day.date, k))) await record(`/api/day/${date}`, `day-${date}`);
  scenarios.push({ id, label, url: `/day/${day.date}`, request: `/api/day/${day.date}` });
}
for (const [id, label, one] of [
  ["month", "a typical month", typicalMonth],
  ["month-heavy", "the heaviest month", heavyMonth],
]) {
  for (const month of [-2, -1, 0, 1, 2].map((k) => addMonths(one.month, k))) await record(rangePath(monthRange(month)), `range-${month}`);
  scenarios.push({ id, label, url: `/month/${one.month}`, request: rangePath(monthRange(one.month)) });
}
for (const y of [-2, -1, 0, 1, 2].map((k) => year + k)) await record(rangePath({ from: `${y}-01-01`, to: `${y}-12-31` }), `range-${y}`);
scenarios.push({ id: "year", label: `the calendar year ${year}`, url: `/year/${year}`, request: rangePath({ from: `${year}-01-01`, to: `${year}-12-31` }) });

await record("/api/status", "status");

for (const scenario of scenarios) {
  const file = index[scenario.request];
  scenario.file = file;
  scenario.bytes = files[file].bytes;
}
writeFileSync(
  join(partial, "index.json"),
  JSON.stringify({ recordedFrom: base, first, last, scenarios, requests: index, files }, null, 2),
);
// Complete: it takes the place of the old recording, which goes only now.
rmSync(out, { recursive: true, force: true });
renameSync(partial, out);
complete = true;

console.log(`Recorded ${Object.keys(index).length} responses to ${out}`);
for (const s of scenarios) console.log(`  ${s.id.padEnd(12)} ${s.url.padEnd(20)} ${s.label}: ${(s.bytes / 1000).toFixed(1)} kB`);
