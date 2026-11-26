// 24-bit TrueColor palette (Tokyo Night inspired, layered surfaces)
export const theme = {
  // Layered dark surfaces (borderless separation)
  bgBase: "#1a1b26",       // Main chat canvas
  bgSidebar: "#13141c",    // Left server/channel rail
  bgNicklist: "#15161f",   // Right user list
  bgHeader: "#16161e",     // Top topic bar
  bgFooter: "#12131a",     // Bottom status bar
  bgInput: "#222436",      // Prompt input bar
  bgActiveRow: "#24283b",  // Selected channel row
  bgMention: "#2b2135",    // Highlighted mention message row
  bgOverlay: "#1f2335",    // Floating omnibox surface
  bgOverlaySel: "#292e42", // Selected omnibox item
  borderOverlay: "#3b4261", // Omnibox subtle border

  // Hairlines & separators
  gutter: "#3b4261",

  // Text hierarchy
  fgPrimary: "#c0caf5",    // Main chat text
  fgBright: "#e2e8ff",     // Headings / active channel
  fgSecondary: "#a9b1d6",  // Inactive channel / nicklist
  fgMuted: "#565f89",      // Timestamps, separators, hints
  fgDim: "#414868",        // Subtle join/part/system noise

  // Semantic accents
  accent: "#7aa2f7",       // Active indicator, channel names, prompt
  accentAlt: "#bb9af7",    // Actions (/me), notices, DMs
  green: "#9ece6a",        // Connected dot, +voice
  yellow: "#e0af68",       // Connecting dot, @op
  red: "#f7768e",          // Disconnected, errors, mention badge
  cyan: "#7dcfff",         // Links, TLS badge, info
  orange: "#ff9e64",       // Mode changes, highlights
} as const;

// Vibrant, readable 24-bit colors for deterministic nick hashing
const NICK_PALETTE = [
  "#7aa2f7", // blue
  "#bb9af7", // purple
  "#7dcfff", // cyan
  "#9ece6a", // green
  "#e0af68", // gold
  "#f7768e", // coral
  "#ff9e64", // orange
  "#2ac3de", // teal
  "#73daca", // mint
  "#b4f9f8", // ice
  "#c099ff", // lavender
  "#ff757f", // rose
  "#ffc777", // peach
  "#4fd6be", // seafoam
] as const;

export function nickColor(nick: string): string {
  let hash = 2166136261;
  const lower = nick.toLowerCase();
  for (let i = 0; i < lower.length; i++) {
    hash ^= lower.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return NICK_PALETTE[Math.abs(hash) % NICK_PALETTE.length]!;
}

export function prefixColor(prefix: string): string {
  switch (prefix) {
    case "~":
    case "&":
      return theme.red;
    case "@":
      return theme.yellow;
    case "%":
      return theme.orange;
    case "+":
      return theme.green;
    default:
      return theme.fgMuted;
  }
}
