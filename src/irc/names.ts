import type { BufferKind } from "../types.ts";

export const STATUS_BUFFER = "*status";

export function isChannelName(name: string): boolean {
  return /^[#&+!]/.test(name);
}

export function bufferKindFor(name: string): BufferKind {
  if (name === STATUS_BUFFER) return "status";
  return isChannelName(name) ? "channel" : "dm";
}

/** Case-insensitive nick comparison. The one place to add IRC casemapping later. */
export function sameNick(a: string | undefined, b: string | undefined): boolean {
  return a !== undefined && b !== undefined && a.toLowerCase() === b.toLowerCase();
}

/** Strips `!user` if a bouncer/server omits `@host` (e.g. `goose!goose` -> `goose`). */
export function normalizeNick(name?: string): string {
  if (!name) return "";
  const bang = name.indexOf("!");
  return bang === -1 ? name : name.slice(0, bang);
}
