// The unit tests run on the clock of Tokyo, which no day in them is in (the days of the fixtures are Oslo's and New York's, and a
// machine in either would otherwise read its own clock as the segment's). Set here, in the process that starts the workers, so that
// they have it from the start: a zone set once a worker is running is not always taken up by the dates it has already made.
declare const process: { env: Record<string, string | undefined> }; // this file runs in Node, whose types the app does not take

export default function setup(): void {
  process.env["TZ"] = "Asia/Tokyo";
}
