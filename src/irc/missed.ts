/**
 * Lines you missed while the connection was down.
 *
 * When a registered connection is lost, honk notes when it last heard from the server,
 * your nick, and the buffers you had open. After the reconnect, the server's chat
 * history (CHATHISTORY) fills those buffers again. A history line newer than that time
 * was never shown live, so it counts as unread, and as a mention if it names you or is
 * a DM.
 *
 * The nick matters because after a reconnect the server often gives you "goose_": the
 * dead connection still holds "goose". A line sent while you were away says "goose:".
 */

import type { BufferKind, ChatMessage } from "../types.ts";

/** What honk knew when the connection was lost. */
export interface MissedWindow {
  /** When honk last heard from the server (local clock, ms). */
  since: number;
  /** Your nick at that time. */
  nick: string;
  /** The buffers open at that time. A channel joined later has no "missed" lines. */
  buffers: ReadonlySet<string>;
}

/**
 * History timestamps come from the server's clock and `since` from ours. Start the
 * window a little early, so a small clock difference doesn't hide a line. A line that
 * honk did show live is dropped as a duplicate before this check.
 */
export const MISSED_MARGIN_MS = 5_000;

/**
 * Ergo replays joins, parts and quits in its history as ordinary messages from this
 * service ("goose_ joined the channel") when the client doesn't ask for
 * draft/event-playback. They are not chat, and one that names you is not a mention.
 */
const HISTORY_SERVICE = "histserv";

/** True if `message`, going into `bufferName`, arrived while the connection was down. */
export function isMissedLine(
  window: MissedWindow | undefined,
  bufferName: string,
  message: ChatMessage,
): boolean {
  return (
    window !== undefined &&
    Boolean(message.isHistory) &&
    !message.isSelf &&
    (message.kind === "message" || message.kind === "action") &&
    message.from?.toLowerCase() !== HISTORY_SERVICE &&
    window.buffers.has(bufferName) &&
    message.timestamp.getTime() >= window.since - MISSED_MARGIN_MS
  );
}

/** True if a missed line is for you: any line in a DM, or one that names you in a channel. */
export function isMissedMention(
  window: MissedWindow,
  bufferKind: BufferKind,
  message: ChatMessage,
  currentNick: string,
  mentionsNick: (text: string, nick: string) => boolean,
): boolean {
  if (bufferKind === "dm") return true;
  return mentionsNick(message.text, window.nick) || mentionsNick(message.text, currentNick);
}
