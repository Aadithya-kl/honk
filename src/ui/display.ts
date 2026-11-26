import { theme } from "../theme.ts";
import type { BufferState, ConnectionStatus } from "../types.ts";

/**
 * Rows of the three top headers (sidebar, chat, user list). They must match so the
 * headers line up as one bar: a row of padding, the text, a row of padding.
 */
export const HEADER_HEIGHT = 3;

export function truncate(str: string, max: number): string {
  return str.length > max ? `${str.slice(0, max - 1)}…` : str;
}

export function statusIndicator(status: ConnectionStatus): { glyph: string; color: string } {
  switch (status) {
    case "connected":
      return { glyph: "●", color: theme.green };
    case "connecting":
    case "reconnecting":
      return { glyph: "◐", color: theme.yellow };
    case "error":
      return { glyph: "●", color: theme.red };
    default:
      return { glyph: "○", color: theme.fgMuted };
  }
}

export function bufferDisplayName(buf: BufferState): string {
  return buf.kind === "dm" ? `@${buf.name}` : buf.name;
}

export function unreadBadge(unread: number): string {
  return unread > 99 ? "99+" : String(unread);
}

export function scrollboxStyle(bg: string) {
  return {
    rootOptions: { backgroundColor: bg },
    viewportOptions: { backgroundColor: bg },
    contentOptions: { backgroundColor: bg },
    scrollbarOptions: {
      showArrows: false,
      trackOptions: { foregroundColor: theme.gutter, backgroundColor: bg },
    },
  };
}
