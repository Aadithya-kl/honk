import type { ChatMessage } from "../types.ts";

/** The local date as one number, such as 20261127. Equal numbers mean the same day. */
function dayKey(date: Date): number {
  return date.getFullYear() * 10000 + date.getMonth() * 100 + date.getDate();
}

const SAME_YEAR = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" });
const OTHER_YEAR = new Intl.DateTimeFormat(undefined, {
  weekday: "long",
  month: "long",
  day: "numeric",
  year: "numeric",
});

/** "Thursday, November 26", with the year when it is not the year of `now`. */
export function dayLabel(date: Date, now: Date): string {
  const format = date.getFullYear() === now.getFullYear() ? SAME_YEAR : OTHER_YEAR;
  return format.format(date);
}

/**
 * The label of the day divider above `msg`, or null for none. A divider goes
 * where the local date changes from `prev`, and above the first message of the
 * buffer when that message is not from today. Labels are absolute dates, so
 * they stay right when honk runs past midnight.
 */
export function dayLabelBefore(prev: ChatMessage | undefined, msg: ChatMessage, now: Date): string | null {
  const key = dayKey(msg.timestamp);
  const before = prev ? dayKey(prev.timestamp) : dayKey(now);
  return key === before ? null : dayLabel(msg.timestamp, now);
}
