/**
 * Picks the escape sequence honk uses for desktop notifications when OpenTUI can't.
 *
 * OpenTUI finds the terminal by asking it (XTVERSION). Inside tmux or screen, the
 * multiplexer answers instead, so OpenTUI turns notifications off, even when tmux
 * would pass them through to a terminal that shows them. Inside tmux, honk asks tmux
 * for the outer terminal (`#{client_termtype}`) and whether passthrough is on, and
 * then tells OpenTUI which sequence to send, through OPENTUI_NOTIFICATION_PROTOCOL in
 * the renderer's `environment`.
 * OpenTUI wraps the sequence for tmux.
 *
 * Inside zellij, OpenTUI also turns notifications off. zellij shows OSC 99 (and turns it
 * into OSC 9 for the outer terminal, also from a hidden tab), so honk picks that.
 *
 * Where honk can't ask (screen, or honk on an SSH host while tmux runs on your own
 * computer), the config can name the sequence: `"notifications": "osc777"`.
 */

const NOTIFICATION_PROTOCOLS = ["osc9", "osc777", "osc99"] as const;
type NotificationProtocol = (typeof NOTIFICATION_PROTOCOLS)[number];

/** What `tmux display -p` reports about the terminal tmux runs in. */
export interface TmuxInfo {
  /** The outer terminal's XTVERSION answer, such as "ghostty 1.2.3". Empty if it did not answer. */
  termtype: string;
  /**
   * The pane's allow-passthrough option: "off", "on" (only while the pane is on
   * screen) or "all" (also from hidden panes).
   */
  passthrough: string;
}

/** The config's `notifications` value, checked. */
export interface NotificationSetting {
  enabled: boolean;
  /** A protocol the config names, which beats detection. */
  protocol?: NotificationProtocol;
  /** A problem with the value, to show in *status. */
  warning?: string;
}

interface ProtocolChoice {
  /** Give OpenTUI this as OPENTUI_NOTIFICATION_PROTOCOL. Undefined leaves OpenTUI to decide. */
  protocol?: NotificationProtocol;
  /** A problem to show in *status. */
  warning?: string;
}

/**
 * The sequence each terminal shows, by the start of its XTVERSION answer. These are
 * the ones OpenTUI picks when it talks to the terminal directly.
 */
const TERMINAL_PROTOCOLS: [prefix: string, protocol: NotificationProtocol][] = [
  ["ghostty", "osc777"],
  ["wezterm", "osc777"],
  ["vte", "osc777"],
  ["iterm2", "osc9"],
  ["kitty", "osc99"],
  ["foot", "osc99"],
  // zellij inside tmux: tmux reports zellij as its outer terminal.
  ["zellij", "osc99"],
];

export function protocolForTerminal(termtype: string): NotificationProtocol | undefined {
  const name = termtype.trim().toLowerCase();
  return TERMINAL_PROTOCOLS.find(([prefix]) => name.startsWith(prefix))?.[1];
}

function isNotificationProtocol(value: unknown): value is NotificationProtocol {
  return (NOTIFICATION_PROTOCOLS as readonly unknown[]).includes(value);
}

/** Checks the config's `notifications` value: true, false, or a protocol name. Missing means on. */
export function parseNotificationSetting(raw: unknown): NotificationSetting {
  if (raw === false) return { enabled: false };
  if (raw === undefined || raw === true) return { enabled: true };
  if (isNotificationProtocol(raw)) return { enabled: true, protocol: raw };
  return {
    enabled: true,
    warning: `"notifications" should be true, false, or one of ${NOTIFICATION_PROTOCOLS.join(", ")}, not ${JSON.stringify(raw)}`,
  };
}

const PASSTHROUGH_HELP =
  "tmux blocks notifications. Add `set -g allow-passthrough all` to ~/.tmux.conf, then run `tmux source-file ~/.tmux.conf`";

/** With "on", tmux drops passthrough from a pane that is not on screen, which is when a mention matters most. */
const HIDDEN_PANE_HELP =
  "tmux passes notifications only while honk's window is on screen. To get them from a hidden window too, use `set -g allow-passthrough all`";

function unknownTerminalHelp(termtype: string): string {
  const which = termtype ? `your terminal (${termtype})` : "your terminal";
  return `honk can't tell which notifications ${which} shows inside tmux. To choose one, set "notifications" in the config to one of ${NOTIFICATION_PROTOCOLS.join(", ")}`;
}

/**
 * Decides the notification sequence before the renderer starts.
 *
 * - `forced` is a protocol the config names. It beats detection.
 * - `readTmux` runs only inside tmux. It returns null when tmux can't be asked.
 */
export function chooseNotificationProtocol(
  env: Record<string, string | undefined>,
  forced: NotificationProtocol | undefined,
  readTmux: () => TmuxInfo | null,
): ProtocolChoice {
  // The user's own setting for OpenTUI wins.
  if (env.OPENTUI_NOTIFICATION_PROTOCOL) return {};
  if (!env.TMUX) {
    // Remove the zellij case once OpenTUI picks OSC 99 inside zellij by itself.
    return { protocol: forced ?? (env.ZELLIJ !== undefined ? "osc99" : undefined) };
  }

  const tmux = readTmux();
  if (!tmux) return { protocol: forced };
  if (tmux.passthrough !== "on" && tmux.passthrough !== "all") return { warning: PASSTHROUGH_HELP };
  const protocol = forced ?? protocolForTerminal(tmux.termtype);
  if (!protocol) return { warning: unknownTerminalHelp(tmux.termtype) };
  return { protocol, warning: tmux.passthrough === "on" ? HIDDEN_PANE_HELP : undefined };
}

/** Asks the tmux server about the client that shows honk's pane. */
export function readTmuxInfo(): TmuxInfo | null {
  try {
    // Ask about honk's own pane, not whichever pane is active.
    const pane = process.env.TMUX_PANE;
    const target = pane ? ["-t", pane] : [];
    const format = "#{client_termtype}\t#{allow-passthrough}";
    const result = Bun.spawnSync(["tmux", "display-message", "-p", ...target, format], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    if (result.exitCode !== 0) return null;
    const [termtype = "", passthrough = ""] = result.stdout.toString().replace(/\n$/, "").split("\t");
    return { termtype, passthrough };
  } catch {
    return null;
  }
}
