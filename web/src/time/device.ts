import { dateLabel, dateOf } from "./dates";
import { formatTime } from "./format";

/** The zone of this device: the processing has no zone of its own, and the owner reads when it ran, or when they did something, on the clock they have. */
export const deviceZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** The date and the time of an instant on the clock of this device: "Sat 24 Oct 2026 17:15". */
export function whenOf(isoUtc: string): string {
  const zone = deviceZone();
  return `${dateLabel(dateOf(isoUtc, zone))} ${formatTime(isoUtc, zone)}`;
}
