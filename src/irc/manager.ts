import { Client } from "irc-client-ts";
import { defaultNick, parsePortArg, sameHost, serverIdFromHost } from "../config.ts";
import type {
  ActiveBuffer,
  BufferKind,
  BufferState,
  ChatMessage,
  MessageKind,
  NickEntry,
  ServerConfig,
  ServerState,
  StoreSnapshot,
  UpdateNotice,
} from "../types.ts";
import {
  bufferKindFor,
  isChannelName,
  normalizeNick,
  sameNick,
  STATUS_BUFFER,
} from "./names.ts";
import { SLASH_COMMANDS } from "./commands.ts";
import {
  DEMO_AMBIENT,
  DEMO_HISTORY,
  DEMO_NETWORKS,
  DEMO_NICK,
  DEMO_REPLIES,
  DEMO_START,
  DEMO_TIMELINE,
  demoWhois,
  type DemoEvent,
} from "./demo.ts";
import { createNodeRuntime } from "./runtime.ts";

/** Messages kept per buffer from live traffic. */
const MAX_MESSAGES = 500;
/** Hard cap once history (/history, CHATHISTORY playback) has grown a buffer past MAX_MESSAGES. */
const MAX_MESSAGES_WITH_HISTORY = 5000;
/** A paste with more lines than this is refused, so a wrong paste can't flood a channel. */
const MAX_PASTE_LINES = 10;

/** In the demo: how long someone takes to answer you, and the gap between ambient lines. */
const DEMO_REPLY_DELAY_MS = 1_200;
const DEMO_AMBIENT_EVERY_MS = 7_000;
/** Mode prefixes, highest first, for sorting the demo's user lists. */
const PREFIX_ORDER = "~&@%+";

// Reconnect & health tuning
const CONNECT_TIMEOUT_MS = 15_000;
const STABLE_RESET_MS = 10_000;
const BACKOFF_BASE_MS = 2_000;
const BACKOFF_MAX_MS = 60_000;
const WAKE_CHECK_INTERVAL_MS = 5_000;
const WAKE_JUMP_THRESHOLD_MS = 15_000;
/**
 * How long a /join waits for the server's JOIN before it no longer takes focus. Some
 * failures (a forward to another channel, 477, or no reply at all) have no reply we can
 * match to the request.
 */
const REQUESTED_JOIN_TTL_MS = 30_000;
/** Join failures. Their first argument after our nick is the channel. */
const JOIN_ERRORS = new Set([
  "err_nosuchchannel",
  "err_toomanychannels",
  "err_channelisfull",
  "err_inviteonlychan",
  "err_bannedfromchan",
  "err_badchannelkey",
  "err_badchanmask",
  "err_badchanname",
]);

interface ServerControl {
  manualDisconnect: boolean;
  fatalError: boolean;
  attempts: number;
  registered: boolean;
  hasEverConnected: boolean;
  nickCollisionTries: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  connectTimer: ReturnType<typeof setTimeout> | null;
  stableTimer: ReturnType<typeof setTimeout> | null;
}

function createControl(): ServerControl {
  return {
    manualDisconnect: false,
    fatalError: false,
    attempts: 0,
    registered: false,
    hasEverConnected: false,
    nickCollisionTries: 0,
    reconnectTimer: null,
    connectTimer: null,
    stableTimer: null,
  };
}

/**
 * The TLS error code if the server's certificate was rejected (self-signed, expired,
 * wrong host...). Retrying can't fix these. Node and Bun put the reason only in `code`;
 * the message is free text such as "self signed certificate".
 */
function tlsCertErrorCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code !== "string") return undefined;
  return /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER/.test(code)
    ? code
    : undefined;
}

function isFatalErrorMessage(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("sasl auth failed") ||
    m.includes("sasl authentication failed") ||
    m.includes("err_saslfail") ||
    m.includes("k-lined") ||
    m.includes("g-lined") ||
    m.includes("z-lined") ||
    m.includes("you are banned")
  );
}

function computeBackoffMs(attempt: number): number {
  const exp = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * Math.pow(2, attempt));
  // ±25% random jitter
  const jitter = 0.75 + Math.random() * 0.5;
  return Math.round(exp * jitter);
}

let nextMsgId = 1;
function makeMessage(
  kind: MessageKind,
  text: string,
  extra?: Partial<Omit<ChatMessage, "id" | "timestamp" | "kind" | "text">> & {
    timestamp?: Date;
  },
): ChatMessage {
  return {
    ...extra,
    id: String(nextMsgId++),
    timestamp: extra?.timestamp ?? new Date(),
    kind,
    text,
  };
}

function tagTime(tags?: { time?: string }): Date {
  return tags?.time ? new Date(tags.time) : new Date();
}

/** Cancels a pending connect for each client, so a dropped attempt can't register late. */
const connectAborts = new WeakMap<Client, AbortController>();

/** Closes the client's socket, or cancels its connect if the socket isn't open yet. */
function safeDisconnect(client: Client): void {
  connectAborts.get(client)?.abort();
  try {
    client.disconnect();
  } catch {
    // ignore
  }
}

function requestHistory(
  client: Client,
  subcommand: "LATEST" | "BEFORE",
  target: string,
  anchor: string,
  limit: number,
): void {
  void client.send(
    "CHATHISTORY" as never,
    subcommand as never,
    target as never,
    anchor as never,
    String(limit) as never,
  );
}

function createBuffer(name: string, kind: BufferKind): BufferState {
  return {
    name,
    kind,
    topic: "",
    messages: [],
    users: [],
    unread: 0,
    hasMention: false,
  };
}

/** Characters allowed in IRC nicks. A mention must not touch one on either side. */
const NICK_CHAR = String.raw`[\w\[\]\\` + "`" + String.raw`^{}|-]`;

/** True if `text` contains `nick` as a whole word. `\b` fails for nicks like `goose[m]`. */
function mentionsNick(text: string, nick: string): boolean {
  if (!nick) return false;
  const escaped = nick.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<!${NICK_CHAR})${escaped}(?!${NICK_CHAR})`, "i").test(text);
}

/** The buffer a chat line belongs to: the channel, or for a DM the other person. */
function routeTarget(rawTarget: string, from: string, isSelf: boolean): string {
  return isChannelName(rawTarget) || isSelf ? rawTarget : from;
}

/**
 * Runs `hook` before each event reaches any listener. The library's own plugins (nicklist)
 * listen before the app does and change state first, so state "before the event" must be
 * read here.
 */
function beforeEmit(
  client: Client,
  hook: (event: string, payload: unknown) => void,
): void {
  (
    client as unknown as {
      hooks: { beforeCall(key: "emit", hook: (event: string, payload: unknown) => void): void };
    }
  ).hooks.beforeCall("emit", hook);
}

/** Buffer order for the sidebar: *status, then channels, then DMs, each sorted by name. */
function sortBufferOrder(server: ServerState, order: string[]): string[] {
  return order.sort((a, b) => {
    if (a === STATUS_BUFFER) return -1;
    if (b === STATUS_BUFFER) return 1;
    const ka = server.buffers[a]?.kind ?? "dm";
    const kb = server.buffers[b]?.kind ?? "dm";
    if (ka !== kb) return ka === "channel" ? -1 : 1;
    return a.localeCompare(b);
  });
}

/** Sorts a user list by mode (ops, then voice, then everyone else), then by nick. */
function sortUsers(users: NickEntry[]): NickEntry[] {
  const rank = (p: string) => (p ? PREFIX_ORDER.indexOf(p[0]!) : PREFIX_ORDER.length);
  return [...users].sort(
    (a, b) => rank(a.prefix) - rank(b.prefix) || a.nick.localeCompare(b.nick),
  );
}

/** A demo channel's users from "@alice"-style entries, with the demo user added. */
function demoUsers(entries: string[]): NickEntry[] {
  const users = entries.map((entry): NickEntry => {
    const prefix = PREFIX_ORDER.includes(entry[0]!) ? entry[0]! : "";
    return { prefix, nick: entry.slice(prefix.length) };
  });
  if (!users.some((u) => sameNick(u.nick, DEMO_NICK))) {
    users.push({ prefix: "", nick: DEMO_NICK });
  }
  return sortUsers(users);
}

function joinKey(serverId: string, channel: string): string {
  return `${serverId}\n${channel.toLowerCase()}`;
}

function channelsWithNick(server: ServerState, nick: string): string[] {
  const lower = nick.toLowerCase();
  return server.bufferOrder.filter((name) => {
    const buf = server.buffers[name];
    return buf?.kind === "channel" && buf.users.some((u) => u.nick.toLowerCase() === lower);
  });
}

export class IrcManager {
  private clients = new Map<string, Client>();
  private servers = new Map<string, ServerState>();
  private controls = new Map<string, ServerControl>();
  private serverOrder: string[] = [];
  private active: ActiveBuffer | null = null;
  private listeners = new Set<() => void>();
  private snapshot: StoreSnapshot = { servers: [], active: null, update: null };
  private update: UpdateNotice | null = null;
  private wakeInterval: ReturnType<typeof setInterval> | null = null;
  /** Channels the user asked to /join, with when the request expires. The join switches to them. See joinKey. */
  private requestedJoins = new Map<string, number>();
  private lastWakeTick = Date.now();

  constructor() {
    this.startWakeWatcher();
  }

  private startWakeWatcher(): void {
    if (this.wakeInterval) return;
    this.lastWakeTick = Date.now();
    this.wakeInterval = setInterval(() => {
      const now = Date.now();
      const elapsed = now - this.lastWakeTick;
      this.lastWakeTick = now;
      if (elapsed > WAKE_JUMP_THRESHOLD_MS) {
        this.handleSystemWake();
      }
    }, WAKE_CHECK_INTERVAL_MS);
  }

  private handleSystemWake(): void {
    for (const id of this.serverOrder) {
      const server = this.servers.get(id);
      const ctrl = this.controls.get(id);
      if (!server || !ctrl || !server.config.host) continue;
      if (ctrl.manualDisconnect || ctrl.fatalError) continue;
      if (
        server.status === "connected" ||
        server.status === "connecting" ||
        server.status === "reconnecting"
      ) {
        this.pushMessage(
          id,
          STATUS_BUFFER,
          makeMessage("system", "System wake detected — reconnecting…"),
        );
        void this.connectServer(id, { manual: true });
      }
    }
  }

  private getControl(serverId: string): ServerControl {
    let ctrl = this.controls.get(serverId);
    if (!ctrl) {
      ctrl = createControl();
      this.controls.set(serverId, ctrl);
    }
    return ctrl;
  }

  /** True (and forgets the request) if the user ran /join for this channel and it hasn't expired. */
  private takeRequestedJoin(serverId: string, channel: string): boolean {
    const key = joinKey(serverId, channel);
    const expires = this.requestedJoins.get(key);
    this.requestedJoins.delete(key);
    return expires !== undefined && expires > Date.now();
  }

  private forgetRequestedJoins(serverId: string): void {
    const prefix = joinKey(serverId, "");
    for (const key of this.requestedJoins.keys()) {
      if (key.startsWith(prefix)) this.requestedJoins.delete(key);
    }
  }

  private clearServerTimers(ctrl: ServerControl): void {
    if (ctrl.reconnectTimer) {
      clearTimeout(ctrl.reconnectTimer);
      ctrl.reconnectTimer = null;
    }
    if (ctrl.connectTimer) {
      clearTimeout(ctrl.connectTimer);
      ctrl.connectTimer = null;
    }
    if (ctrl.stableTimer) {
      clearTimeout(ctrl.stableTimer);
      ctrl.stableTimer = null;
    }
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): StoreSnapshot => this.snapshot;

  private emitQueued = false;

  /** Coalesces all state changes made in one tick (a socket read, a history batch) into one render. */
  private emit(): void {
    if (this.emitQueued) return;
    this.emitQueued = true;
    queueMicrotask(() => {
      this.emitQueued = false;
      this.flush();
    });
  }

  private flush(): void {
    const servers: ServerState[] = [];
    for (const id of this.serverOrder) {
      const s = this.servers.get(id);
      if (s) servers.push({ ...s });
    }
    this.snapshot = {
      servers,
      active: this.active ? { ...this.active } : null,
      update: this.update,
    };
    for (const listener of this.listeners) {
      listener();
    }
  }

  initWelcome(): void {
    if (this.serverOrder.length > 0) return;
    const id = "local";
    const status = createBuffer(STATUS_BUFFER, "status");
    status.messages.push(
      makeMessage("system", "Welcome to honk, a terminal IRC client."),
      makeMessage(
        "system",
        "Connect to a server with: /connect irc.libera.chat 6697 yournick",
      ),
      makeMessage(
        "system",
        "Or create honk.json (see honk.example.json) for multi-server auto-connect. Type /help for commands.",
      ),
      makeMessage("system", "To look around without connecting anywhere, type /demo."),
    );
    const server: ServerState = {
      id,
      name: "local",
      config: { id, host: "", nick: defaultNick() },
      status: "disconnected",
      nick: defaultNick(),
      tls: false,
      buffers: { [STATUS_BUFFER]: status },
      bufferOrder: [STATUS_BUFFER],
    };
    this.servers.set(id, server);
    this.controls.set(id, createControl());
    this.serverOrder.push(id);
    this.active = { serverId: id, buffer: STATUS_BUFFER };
    this.emit();
  }

  /**
   * Shows a line from honk itself, not from a server, such as the update notice.
   * It goes to the first server's *status buffer, which is where honk starts.
   * As a system line, it does not count as unread.
   */
  addAppNotice(text: string): void {
    const id = this.serverOrder[0];
    if (!id) return;
    this.pushMessage(id, STATUS_BUFFER, makeMessage("system", text));
  }

  /**
   * Shows that a newer release exists: a short label in the status bar, which
   * stays visible in every buffer, and the full sentence in *status.
   */
  showUpdate(update: UpdateNotice, text: string): void {
    this.update = { ...update };
    this.addAppNotice(text);
    this.emit();
  }

  addServer(config: ServerConfig): void {
    if (
      this.servers.has("local") &&
      this.serverOrder.length === 1 &&
      config.id !== "local"
    ) {
      this.servers.delete("local");
      this.controls.delete("local");
      this.serverOrder = [];
      this.active = null;
    }

    const existing = this.servers.get(config.id);
    const via =
      config.via || (config.username?.includes("/") ? config.host : undefined);
    if (existing) {
      existing.config = config;
      existing.name = existing.networkName || config.name || config.host;
      existing.via = via;
      existing.nick = config.nick;
      existing.tls = config.tls ?? true;
    } else {
      const statusBuf = createBuffer(STATUS_BUFFER, "status");
      const server: ServerState = {
        id: config.id,
        name: config.name || config.host,
        via,
        config,
        status: "disconnected",
        nick: config.nick,
        tls: config.tls ?? true,
        buffers: { [STATUS_BUFFER]: statusBuf },
        bufferOrder: [STATUS_BUFFER],
      };
      this.servers.set(config.id, server);
      this.controls.set(config.id, createControl());
      this.serverOrder.push(config.id);
    }

    if (!this.active) {
      this.active = { serverId: config.id, buffer: STATUS_BUFFER };
    }
    this.emit();

    if (config.autoConnect !== false && config.host) {
      void this.connectServer(config.id, { manual: true });
    }
  }

  async connectServer(
    serverId: string,
    opts: { manual?: boolean } = {},
  ): Promise<void> {
    const server = this.servers.get(serverId);
    if (!server || !server.config.host) return;

    const ctrl = this.getControl(serverId);
    this.clearServerTimers(ctrl);
    ctrl.manualDisconnect = false;
    ctrl.fatalError = false;
    ctrl.registered = false;
    ctrl.nickCollisionTries = 0;
    if (opts.manual) {
      ctrl.attempts = 0;
    }

    // Tear down any previous client cleanly before replacing
    const prev = this.clients.get(serverId);
    this.clients.delete(serverId);
    if (prev) safeDisconnect(prev);

    const cfg = server.config;
    const tls = cfg.tls ?? true;
    const port = cfg.port ?? (tls ? 6697 : 6667);

    // Determine channels to join:
    // - On bouncers (soju), only send config.channels on first connect when no channels are open;
    //   on reconnect, soju replays joined channels automatically.
    // - On direct servers, rejoin all currently open channels merged with config.channels.
    const openChannels = server.bufferOrder.filter(
      (b) => server.buffers[b]?.kind === "channel",
    );
    const skipJoin =
      Boolean(server.via) && ctrl.hasEverConnected && openChannels.length > 0;
    const channelsToJoin = skipJoin
      ? []
      : [...new Set([...(cfg.channels ?? []), ...openChannels])];

    server.status = "connecting";
    server.reconnectInfo = undefined;
    server.tls = tls;
    this.pushMessage(
      serverId,
      STATUS_BUFFER,
      makeMessage(
        "system",
        `Connecting to ${cfg.host}:${port} (${tls ? "TLS" : "plain"}) as ${cfg.nick}…`,
      ),
    );

    const client = new Client({
      nick: cfg.nick,
      username: cfg.username ?? cfg.nick,
      realname: cfg.realname ?? cfg.nick,
      password: cfg.password,
      serverPassword: cfg.serverPassword,
      authMethod: cfg.authMethod ?? (cfg.password ? "sasl" : undefined),
      ...(channelsToJoin.length > 0
        ? { channels: channelsToJoin as [string, ...string[]] }
        : {}),
    });

    // Use node:net / node:tls adapter for reliable TLS on Bun. safeDisconnect aborts
    // a connect that is still pending (e.g. after the connect timeout below).
    const abort = new AbortController();
    connectAborts.set(client, abort);
    (client as unknown as { runtime: ReturnType<typeof createNodeRuntime> }).runtime =
      createNodeRuntime(abort.signal);

    // Request IRCv3 draft/chathistory when advertised by server/bouncer (e.g. soju)
    if (!client.state.caps.requested.includes("draft/chathistory")) {
      client.state.caps.requested.push("draft/chathistory");
    }

    this.clients.set(serverId, client);
    this.bindClientEvents(serverId, client);

    // Per-attempt connect + registration timeout (catches DNS/TCP/TLS blackholes)
    ctrl.connectTimer = setTimeout(() => {
      if (this.clients.get(serverId) !== client || ctrl.registered) return;
      this.pushMessage(
        serverId,
        STATUS_BUFFER,
        makeMessage("error", `Connection timed out after ${CONNECT_TIMEOUT_MS / 1000}s.`),
      );
      this.clients.delete(serverId);
      safeDisconnect(client);
      this.scheduleReconnect(serverId);
    }, CONNECT_TIMEOUT_MS);

    const conn = await client.connect(cfg.host, { port, tls });
    if (!conn && this.clients.get(serverId) === client) {
      // connect() failed and emitted an error event; ensure reconnect is scheduled if non-fatal
      this.scheduleReconnect(serverId);
    }
  }

  private scheduleReconnect(serverId: string): void {
    const server = this.servers.get(serverId);
    const ctrl = this.controls.get(serverId);
    if (!server || !ctrl || !server.config.host) return;
    if (ctrl.manualDisconnect || ctrl.fatalError) return;
    // Idempotent: if a retry is already scheduled, don't double-schedule
    if (ctrl.reconnectTimer) return;
    this.clearServerTimers(ctrl);

    const delayMs = computeBackoffMs(ctrl.attempts);
    ctrl.attempts += 1;
    const attempt = ctrl.attempts;
    const nextRetryAt = Date.now() + delayMs;

    server.status = "reconnecting";
    server.reconnectInfo = { attempt, nextRetryAt };

    const secs = Math.max(1, Math.round(delayMs / 1000));
    this.pushMessage(
      serverId,
      STATUS_BUFFER,
      makeMessage("system", `Reconnecting in ${secs}s (attempt ${attempt})…`),
    );

    ctrl.reconnectTimer = setTimeout(() => {
      ctrl.reconnectTimer = null;
      if (ctrl.manualDisconnect || ctrl.fatalError) return;
      void this.connectServer(serverId, { manual: false });
    }, delayMs);
  }

  disconnectServer(serverId: string, reason = "Leaving"): void {
    const ctrl = this.getControl(serverId);
    ctrl.manualDisconnect = true;
    ctrl.registered = false;
    this.clearServerTimers(ctrl);
    this.forgetRequestedJoins(serverId);

    const client = this.clients.get(serverId);
    this.clients.delete(serverId);
    const server = this.servers.get(serverId);
    if (client) {
      try {
        client.quit(reason);
      } catch {
        // ignore
      }
      safeDisconnect(client);
    }
    if (server) {
      server.status = "disconnected";
      server.reconnectInfo = undefined;
      this.pushMessage(
        serverId,
        STATUS_BUFFER,
        makeMessage("system", "Disconnected."),
      );
      if (client) this.noteOffline(serverId, "Disconnected. Use /connect to reconnect.");
    }
  }

  disconnectAll(): void {
    if (this.wakeInterval) {
      clearInterval(this.wakeInterval);
      this.wakeInterval = null;
    }
    for (const id of [...this.serverOrder]) {
      if (this.clients.has(id) || this.controls.get(id)?.reconnectTimer) {
        this.disconnectServer(id);
      }
    }
  }

  private bindClientEvents(serverId: string, client: Client): void {
    const isStale = () => this.clients.get(serverId) !== client;
    /** The server state, or undefined if this client was replaced. */
    const live = () => (isStale() ? undefined : this.servers.get(serverId));

    // The channels a quitting/renamed nick was in, read before the nicklist plugin
    // removes the nick. Keyed by the event payload.
    const priorChannels = new WeakMap<object, string[]>();
    // The privmsg/notice plugins emit { source, params } without the IRCv3 tags (server
    // time, msgid). They emit inside the raw event, so link each payload to the raw tags.
    type Tags = Record<string, string | undefined>;
    const chatTags = new WeakMap<object, Tags>();
    let rawChatTags: Tags | undefined;
    beforeEmit(client, (event, payload) => {
      const server = live();
      if (!server || typeof payload !== "object" || payload === null) return;
      if (event === "raw:privmsg" || event === "raw:notice") {
        rawChatTags = (payload as { tags?: Tags }).tags;
        return;
      }
      if (/^(privmsg|notice):|^ctcp_action$/.test(event)) {
        if (rawChatTags) chatTags.set(payload, rawChatTags);
        return;
      }
      if (event === "quit" || event === "nick") {
        const source = (payload as { source?: { name?: string } }).source;
        priorChannels.set(payload, channelsWithNick(server, normalizeNick(source?.name)));
      }
    });

    client.on("error", (err) => {
      if (isStale()) return;
      const server = this.servers.get(serverId);
      const ctrl = this.getControl(serverId);
      const errText = err.message || String(err);

      this.pushMessage(
        serverId,
        STATUS_BUFFER,
        makeMessage("error", `Error (${err.type}): ${errText}`),
      );

      const certCode = tlsCertErrorCode(err);
      if (certCode || isFatalErrorMessage(errText)) {
        ctrl.fatalError = true;
        this.clearServerTimers(ctrl);
        if (server) {
          server.status = "error";
          server.reconnectInfo = undefined;
        }
        this.pushMessage(
          serverId,
          STATUS_BUFFER,
          makeMessage(
            "error",
            certCode
              ? `Auto-reconnect paused: the server's TLS certificate was rejected (${certCode}). Check the host name and port, then run /connect.`
              : "Auto-reconnect paused (fatal/auth error). Fix credentials and run /connect.",
          ),
        );
        return;
      }

      if (err.type === "connect" || errText.includes("Ping timeout")) {
        this.scheduleReconnect(serverId);
      }
    });

    client.on("connected", () => {
      if (isStale()) return;
      this.pushMessage(
        serverId,
        STATUS_BUFFER,
        makeMessage("system", "Socket connected, registering…"),
      );
    });

    client.on("register", (msg) => {
      const server = live();
      if (!server) return;
      const ctrl = this.getControl(serverId);

      if (ctrl.connectTimer) {
        clearTimeout(ctrl.connectTimer);
        ctrl.connectTimer = null;
      }
      ctrl.registered = true;
      const isReconnect = ctrl.hasEverConnected;
      ctrl.hasEverConnected = true;
      ctrl.nickCollisionTries = 0;

      // Only reset backoff after staying registered stably for STABLE_RESET_MS
      if (ctrl.stableTimer) clearTimeout(ctrl.stableTimer);
      ctrl.stableTimer = setTimeout(() => {
        ctrl.stableTimer = null;
        if (this.clients.get(serverId) === client && ctrl.registered) {
          ctrl.attempts = 0;
        }
      }, STABLE_RESET_MS);

      server.status = "connected";
      server.reconnectInfo = undefined;
      server.nick = msg.params.nick || server.nick;
      this.pushMessage(
        serverId,
        STATUS_BUFFER,
        makeMessage("system", `Registered as ${server.nick}.`),
      );
      // Channels show "You joined" when the server re-joins them; DMs get a line here.
      if (isReconnect) {
        for (const name of server.bufferOrder) {
          if (server.buffers[name]?.kind === "dm") {
            this.pushMessage(serverId, name, makeMessage("system", "Reconnected."));
          }
        }
      }
    });

    client.on("isupport:network", (msg) => {
      const server = live();
      const net = msg.params.value?.trim();
      if (!server || !net) return;
      server.networkName = net;
      server.name = net;
      this.emit();
    });

    client.on("disconnected", () => {
      const server = live();
      if (!server) return;
      const ctrl = this.getControl(serverId);

      ctrl.registered = false;
      this.forgetRequestedJoins(serverId);
      if (ctrl.stableTimer) {
        clearTimeout(ctrl.stableTimer);
        ctrl.stableTimer = null;
      }

      if (ctrl.manualDisconnect || ctrl.fatalError) {
        if (server.status !== "disconnected" && !ctrl.fatalError) {
          server.status = "disconnected";
          server.reconnectInfo = undefined;
          this.emit();
        }
        return;
      }

      this.pushMessage(
        serverId,
        STATUS_BUFFER,
        makeMessage("system", "Connection lost."),
      );
      this.noteOffline(serverId, "Connection lost. Reconnecting…");
      this.scheduleReconnect(serverId);
    });

    client.on("motd_reply", (msg) => {
      if (isStale()) return;
      for (const line of msg.params.motd ?? []) {
        if (line.trim()) {
          this.pushMessage(serverId, STATUS_BUFFER, makeMessage("system", line));
        }
      }
    });

    client.on("error_reply", (msg) => {
      if (isStale()) return;
      const server = this.servers.get(serverId);
      const ctrl = this.getControl(serverId);

      // Handle nick collision (433) during initial registration on direct servers
      if (
        msg.command === "err_nicknameinuse" &&
        !ctrl.registered &&
        server &&
        ctrl.nickCollisionTries < 3
      ) {
        ctrl.nickCollisionTries += 1;
        const fallback = `${server.config.nick}${"_".repeat(ctrl.nickCollisionTries)}`;
        server.nick = fallback;
        this.pushMessage(
          serverId,
          STATUS_BUFFER,
          makeMessage("system", `Nick in use, trying ${fallback}…`),
        );
        client.nick(fallback);
        return;
      }

      if (JOIN_ERRORS.has(msg.command) && msg.params.args[1]) {
        this.requestedJoins.delete(joinKey(serverId, msg.params.args[1]));
      }

      const detail = [msg.params.args.join(" "), msg.params.text]
        .filter(Boolean)
        .join(": ");
      this.pushMessage(
        serverId,
        this.replyTarget(serverId),
        makeMessage("error", `${msg.command}${detail ? ` — ${detail}` : ""}`),
      );
    });

    client.on("join", (msg) => {
      const server = live();
      if (!server) return;
      const channel = msg.params.channel;
      const who = normalizeNick(msg.source?.name);
      this.ensureBuffer(serverId, channel, "channel");
      if (sameNick(who, server.nick)) {
        // Switch for a /join, or from this server's *status (auto-join at startup).
        // Auto-joins and reconnect re-joins never take focus from another buffer.
        const requested = this.takeRequestedJoin(serverId, channel);
        if (
          requested ||
          (this.active?.serverId === serverId && this.active.buffer === STATUS_BUFFER)
        ) {
          this.setActive(serverId, channel);
        }
        this.pushMessage(
          serverId,
          channel,
          makeMessage("join", `You joined ${channel}`),
        );
        // Fetch recent scrollback from bouncer/server if draft/chathistory is enabled
        if (client.state.caps.enabled.has("draft/chathistory")) {
          requestHistory(client, "LATEST", channel, "*", 50);
        }
      } else {
        this.pushMessage(
          serverId,
          channel,
          makeMessage("join", `${who} joined ${channel}`),
        );
      }
    });

    client.on("part", (msg) => {
      const server = live();
      if (!server) return;
      const channel = msg.params.channel;
      const who = normalizeNick(msg.source?.name);
      if (sameNick(who, server.nick)) {
        this.removeBuffer(serverId, channel);
      } else {
        const reason = msg.params.comment ? ` (${msg.params.comment})` : "";
        this.pushMessage(
          serverId,
          channel,
          makeMessage("part", `${who} left ${channel}${reason}`),
        );
      }
    });

    client.on("quit", (msg) => {
      const server = live();
      if (!server) return;
      const who = normalizeNick(msg.source?.name);
      const reason = msg.params.comment ? ` (${msg.params.comment})` : "";
      for (const bufName of priorChannels.get(msg) ?? channelsWithNick(server, who)) {
        this.pushMessage(serverId, bufName, makeMessage("part", `${who} quit${reason}`));
      }
    });

    client.on("kick", (msg) => {
      const server = live();
      if (!server) return;
      const { channel, nick, comment } = msg.params;
      const by = normalizeNick(msg.source?.name) || "someone";
      const reason = comment ? ` (${comment})` : "";
      if (sameNick(nick, server.nick)) {
        // The channel's buffer goes away, so say why in *status, where the view lands.
        this.removeBuffer(serverId, channel);
        this.pushMessage(
          serverId,
          STATUS_BUFFER,
          makeMessage("error", `You were kicked from ${channel} by ${by}${reason}`),
        );
        return;
      }
      this.pushMessage(
        serverId,
        channel,
        makeMessage("error", `${nick} was kicked by ${by}${reason}`),
      );
    });

    client.on("nick", (msg) => {
      const server = live();
      if (!server) return;
      const oldNick = normalizeNick(msg.source?.name);
      const newNick = msg.params.nick;
      if (sameNick(oldNick, server.nick)) {
        server.nick = newNick;
        this.pushMessage(
          serverId,
          STATUS_BUFFER,
          makeMessage("system", `You are now known as ${newNick}`),
        );
        return;
      }
      const line = `${oldNick} is now known as ${newNick}`;
      for (const bufName of priorChannels.get(msg) ?? channelsWithNick(server, oldNick)) {
        this.pushMessage(serverId, bufName, makeMessage("system", line));
      }
      // An open DM follows the person to the new nick. If a DM with the new nick is
      // already open, the old one is merged into it, so one person has one DM.
      if (this.hasBuffer(serverId, oldNick)) {
        if (this.hasBuffer(serverId, newNick) && !sameNick(oldNick, newNick)) {
          this.mergeBuffer(serverId, oldNick, newNick);
        } else {
          this.renameBuffer(serverId, oldNick, newNick);
        }
        this.pushMessage(serverId, newNick, makeMessage("system", line));
      }
    });

    client.on("topic_reply", (msg) => {
      if (isStale()) return;
      const buf = this.ensureBuffer(serverId, msg.params.channel, "channel");
      if (!buf) return;
      const nextTopic = msg.params.topic ?? "";
      const changed = buf.topic !== nextTopic;
      buf.topic = nextTopic;
      if (nextTopic && changed) {
        this.pushMessage(
          serverId,
          msg.params.channel,
          makeMessage("system", `Topic: ${nextTopic}`),
        );
      } else {
        this.emit();
      }
    });

    client.on("topic", (msg) => {
      if (isStale()) return;
      const buf = this.ensureBuffer(serverId, msg.params.channel, "channel");
      if (!buf) return;
      const who = msg.source?.name ?? "someone";
      buf.topic = msg.params.topic ?? "";
      this.pushMessage(
        serverId,
        msg.params.channel,
        makeMessage(
          "system",
          `${who} changed the topic to: ${buf.topic || "(cleared)"}`,
        ),
      );
    });

    client.on("nicklist", (msg) => {
      if (isStale()) return;
      const buf = this.ensureBuffer(serverId, msg.params.channel, "channel");
      if (!buf) return;
      // The plugin builds a fresh array on every change, so no copy is needed.
      buf.users = msg.params.nicklist;
      this.emit();
    });

    client.on("batch_end", (batch) => {
      if (batch.params.type !== "chathistory") return;
      const server = live();
      if (!server) return;

      const batchTarget = batch.params.params[0];
      for (const raw of batch.params.messages) {
        const cmd = raw.command;
        if (cmd !== "privmsg" && cmd !== "notice") continue;

        const from = normalizeNick(raw.source?.name) || "unknown";
        const rawText = raw.params[1] ?? "";
        const isSelf = sameNick(from, server.nick);
        const target =
          batchTarget ||
          routeTarget(raw.params[0] ?? STATUS_BUFFER, from, isSelf);

        // Detect CTCP ACTION (\x01ACTION text\x01)
        const actionMatch = /^\x01ACTION ([\s\S]*?)\x01?$/.exec(rawText);
        const msgKind: MessageKind =
          cmd === "notice" ? "notice" : actionMatch ? "action" : "message";
        const text = actionMatch ? actionMatch[1]! : rawText;

        this.pushMessage(
          serverId,
          target,
          makeMessage(msgKind, text, {
            from,
            msgid: raw.tags?.msgid,
            timestamp: tagTime(raw.tags),
            isSelf,
            isHistory: true,
          }),
        );
      }
    });

    const isHistoryBatch = (tags?: Record<string, string | undefined>): boolean => {
      const ref = tags?.batch;
      if (!ref) return false;
      const batch = client.state.batches.get(ref);
      return batch?.type === "chathistory";
    };

    const onChat = (
      kind: "message" | "action",
      msg: {
        source?: { name?: string };
        params: { target: string; text: string };
        tags?: Record<string, string | undefined>;
      },
    ) => {
      const server = live();
      if (!server) return;
      const tags = msg.tags ?? chatTags.get(msg);
      const from = normalizeNick(msg.source?.name) || "unknown";
      const isSelf = sameNick(from, server.nick);
      const target = routeTarget(msg.params.target, from, isSelf);
      // A DM opened as "/msg dave" takes the sender's real casing ("Dave") when they write.
      if (!isSelf && !isChannelName(target)) this.renameBuffer(serverId, target, target);
      const isHistory = isHistoryBatch(tags);
      const isMention =
        !isSelf &&
        !isHistory &&
        (!isChannelName(target) || mentionsNick(msg.params.text, server.nick));

      if (!isHistory && isSelf && this.wasRecentlyEchoed(serverId, target, msg.params.text)) {
        return;
      }

      this.pushMessage(
        serverId,
        target,
        makeMessage(kind, msg.params.text, {
          from,
          msgid: tags?.msgid,
          timestamp: tagTime(tags),
          isMention,
          isSelf,
          isHistory,
        }),
      );
    };

    client.on("privmsg", (msg) => onChat("message", msg));
    client.on("ctcp_action", (msg) => onChat("action", msg));

    // With echo-message, the library reports our own lines (typed here, or sent from
    // another client on the same bouncer account) as echo:* instead of privmsg/notice.
    // onChat drops the echo of a line this client already showed.
    client.on("echo:privmsg", (msg) => onChat("message", msg));

    const onNotice = (msg: {
      source?: { name?: string };
      params: { target: string; text: string };
      tags?: Record<string, string | undefined>;
    }) => {
      if (isStale()) return;
      const tags = msg.tags ?? chatTags.get(msg);
      const from = normalizeNick(msg.source?.name) || "server";
      const target = isChannelName(msg.params.target)
        ? msg.params.target
        : STATUS_BUFFER;
      this.pushMessage(
        serverId,
        target,
        makeMessage("notice", msg.params.text, {
          from,
          msgid: tags?.msgid,
          timestamp: tagTime(tags),
          isHistory: isHistoryBatch(tags),
        }),
      );
    };
    client.on("notice", onNotice);
    client.on("echo:notice", onNotice);

    client.on("whois_reply", (msg) => {
      if (isStale()) return;
      const p = msg.params;
      const channels = p.channels?.length
        ? ` | channels: ${p.channels.join(" ")}`
        : "";
      this.pushMessage(
        serverId,
        this.replyTarget(serverId),
        makeMessage(
          "system",
          `WHOIS ${p.nick} (${p.username}@${p.host}) "${p.realname}" on ${p.server}${channels}`,
        ),
      );
    });
  }

  /**
   * Tells every open channel and DM that the connection is gone, and empties the user
   * lists, which are stale until the server re-joins (and sends NAMES again).
   */
  private noteOffline(serverId: string, text: string): void {
    const server = this.servers.get(serverId);
    if (!server) return;
    for (const name of server.bufferOrder) {
      const buf = server.buffers[name];
      if (!buf || buf.kind === "status") continue;
      if (buf.users.length > 0) {
        server.buffers = { ...server.buffers, [name]: { ...buf, users: [] } };
      }
      this.pushMessage(serverId, name, makeMessage("system", text));
    }
  }

  /** Where replies to a command (errors, WHOIS) go: the active buffer if it is on this server. */
  private replyTarget(serverId: string): string {
    return this.active?.serverId === serverId ? this.active.buffer : STATUS_BUFFER;
  }

  private wasRecentlyEchoed(
    serverId: string,
    target: string,
    text: string,
  ): boolean {
    const buf = this.servers.get(serverId)?.buffers[this.bufferKey(serverId, target)];
    if (!buf || buf.messages.length === 0) return false;
    const now = Date.now();
    for (
      let i = buf.messages.length - 1;
      i >= Math.max(0, buf.messages.length - 5);
      i--
    ) {
      const m = buf.messages[i]!;
      if (m.isSelf && m.text === text && now - m.timestamp.getTime() < 5000) {
        return true;
      }
    }
    return false;
  }

  private ensureBuffer(
    serverId: string,
    name: string,
    kind: BufferKind = bufferKindFor(name),
  ): BufferState | null {
    const server = this.servers.get(serverId);
    if (!server) return null;
    const existing = server.buffers[this.bufferKey(serverId, name)];
    if (existing) return existing;

    const buf = createBuffer(name, kind);
    server.buffers = { ...server.buffers, [name]: buf };
    server.bufferOrder = sortBufferOrder(server, [...server.bufferOrder, name]);
    return buf;
  }

  /**
   * The key of the buffer called `name`, ignoring case (IRC nicks and channels are
   * case-insensitive), or `name` itself if there is none yet.
   */
  private bufferKey(serverId: string, name: string): string {
    const server = this.servers.get(serverId);
    if (!server || server.buffers[name]) return name;
    return server.bufferOrder.find((b) => sameNick(b, name)) ?? name;
  }

  private hasBuffer(serverId: string, name: string): boolean {
    const key = this.bufferKey(serverId, name);
    return Boolean(this.servers.get(serverId)?.buffers[key]);
  }

  /** Renames a buffer (a DM after a nick change). Does nothing if `to` already exists. */
  private renameBuffer(serverId: string, from: string, to: string): void {
    const server = this.servers.get(serverId);
    const key = this.bufferKey(serverId, from);
    const buf = server?.buffers[key];
    if (!server || !buf || key === to) return;
    // "*Status" from a bouncer matches "*status" ignoring case; the status buffer keeps its name.
    if (key === STATUS_BUFFER || sameNick(to, STATUS_BUFFER)) return;
    const toKey = this.bufferKey(serverId, to);
    if (toKey !== key && server.buffers[toKey]) return;

    const { [key]: _, ...rest } = server.buffers;
    server.buffers = { ...rest, [to]: { ...buf, name: to } };
    server.bufferOrder = sortBufferOrder(
      server,
      server.bufferOrder.map((b) => (b === key ? to : b)),
    );
    if (this.active?.serverId === serverId && this.active.buffer === key) {
      this.active = { serverId, buffer: to };
    }
    this.emit();
  }

  /** Moves the lines of DM `from` into DM `into` (in time order) and removes `from`. */
  private mergeBuffer(serverId: string, from: string, into: string): void {
    const server = this.servers.get(serverId);
    const fromKey = this.bufferKey(serverId, from);
    const intoKey = this.bufferKey(serverId, into);
    const src = server?.buffers[fromKey];
    const dst = server?.buffers[intoKey];
    if (!server || !src || !dst || fromKey === intoKey) return;
    if (fromKey === STATUS_BUFFER || intoKey === STATUS_BUFFER) return;

    const limit = Math.max(
      src.messageLimit ?? MAX_MESSAGES,
      dst.messageLimit ?? MAX_MESSAGES,
    );
    // Array.prototype.sort is stable, so lines with the same time keep their order.
    const messages = [...src.messages, ...dst.messages].sort(
      (a, b) => a.timestamp.getTime() - b.timestamp.getTime(),
    );
    if (messages.length > limit) messages.splice(0, messages.length - limit);
    const unreadIds = new Set([src.firstUnreadId, dst.firstUnreadId]);
    const firstUnreadId = messages.find((m) => unreadIds.has(m.id))?.id;

    const { [fromKey]: _, ...rest } = server.buffers;
    server.buffers = {
      ...rest,
      [intoKey]: {
        ...dst,
        messages,
        messageLimit: limit,
        unread: src.unread + dst.unread,
        hasMention: src.hasMention || dst.hasMention,
        firstUnreadId,
      },
    };
    server.bufferOrder = server.bufferOrder.filter((b) => b !== fromKey);
    if (this.active?.serverId === serverId && this.active.buffer === fromKey) {
      this.active = { serverId, buffer: intoKey };
    }
    this.emit();
  }

  private removeBuffer(serverId: string, bufferName: string): void {
    const server = this.servers.get(serverId);
    const name = this.bufferKey(serverId, bufferName);
    if (!server || name === STATUS_BUFFER) return;
    const { [name]: _, ...rest } = server.buffers;
    server.buffers = rest;
    server.bufferOrder = server.bufferOrder.filter((b) => b !== name);
    if (this.active?.serverId === serverId && this.active.buffer === name) {
      this.active = { serverId, buffer: STATUS_BUFFER };
    }
    this.emit();
  }

  private pushMessage(
    serverId: string,
    targetName: string,
    message: ChatMessage,
  ): void {
    const server = this.servers.get(serverId);
    const bufferName = this.bufferKey(serverId, targetName);
    const buf = this.ensureBuffer(serverId, bufferName);
    if (!server || !buf) return;

    // Deduplicate history / replay messages by msgid or (timestamp + sender + text)
    if (message.isHistory) {
      const msgTime = message.timestamp.getTime();
      const isDup = buf.messages.some(
        (m) =>
          (message.msgid && m.msgid === message.msgid) ||
          (m.from === message.from &&
            m.text === message.text &&
            Math.abs(m.timestamp.getTime() - msgTime) < 2000),
      );
      if (isDup) return;
    }

    // Live lines go at the end. History lines (CHATHISTORY playback, /history BEFORE)
    // are inserted in time order; the scan from the end replaces a full re-sort.
    const messages = [...buf.messages];
    let at = messages.length;
    if (message.isHistory) {
      const t = message.timestamp.getTime();
      while (at > 0 && messages[at - 1]!.timestamp.getTime() > t) at--;
    }
    messages.splice(at, 0, message);
    // History lines go in front of older lines, so trimming the oldest would drop them
    // right away. Grow the buffer's limit for them instead.
    let limit = buf.messageLimit ?? MAX_MESSAGES;
    if (message.isHistory && messages.length > limit) {
      limit = Math.min(MAX_MESSAGES_WITH_HISTORY, messages.length);
    }
    if (messages.length > limit) messages.splice(0, messages.length - limit);

    const isActive =
      this.active?.serverId === serverId && this.active.buffer === bufferName;
    const countsAsUnread =
      !isActive &&
      !message.isHistory &&
      !message.isSelf &&
      (message.kind === "message" || message.kind === "action");

    server.buffers = {
      ...server.buffers,
      [bufferName]: {
        ...buf,
        messages,
        messageLimit: limit,
        unread: countsAsUnread ? buf.unread + 1 : buf.unread,
        hasMention: countsAsUnread && message.isMention ? true : buf.hasMention,
        firstUnreadId:
          countsAsUnread && !buf.firstUnreadId ? message.id : buf.firstUnreadId,
      },
    };
    this.emit();
  }

  private clearUnreadDivider(serverId: string, bufferName: string): void {
    const server = this.servers.get(serverId);
    const buf = server?.buffers[bufferName];
    if (server && buf?.firstUnreadId) {
      server.buffers = {
        ...server.buffers,
        [bufferName]: { ...buf, firstUnreadId: undefined },
      };
    }
  }

  setActive(serverId: string, name: string): void {
    const server = this.servers.get(serverId);
    if (!server) return;
    const bufferName = this.bufferKey(serverId, name);
    const buf = server.buffers[bufferName];
    if (!buf) return;

    // Clear the unread divider on the buffer we are leaving
    if (
      this.active &&
      (this.active.serverId !== serverId || this.active.buffer !== bufferName)
    ) {
      this.clearUnreadDivider(this.active.serverId, this.active.buffer);
    }

    this.active = { serverId, buffer: bufferName };
    if (buf.unread > 0 || buf.hasMention) {
      server.buffers = {
        ...server.buffers,
        [bufferName]: { ...buf, unread: 0, hasMention: false },
      };
    }
    this.emit();
  }

  openDm(serverId: string, nick: string): void {
    this.ensureBuffer(serverId, nick, "dm");
    this.setActive(serverId, nick);
  }

  cycleBuffer(delta: 1 | -1): void {
    const flat: ActiveBuffer[] = [];
    for (const id of this.serverOrder) {
      const s = this.servers.get(id);
      if (!s) continue;
      for (const b of s.bufferOrder) {
        flat.push({ serverId: id, buffer: b });
      }
    }
    if (flat.length === 0) return;
    const idx = this.active
      ? flat.findIndex(
          (x) =>
            x.serverId === this.active!.serverId &&
            x.buffer === this.active!.buffer,
        )
      : 0;
    const nextIdx = (idx + delta + flat.length) % flat.length;
    const next = flat[nextIdx]!;
    this.setActive(next.serverId, next.buffer);
  }

  // ---- The offline demo (honk --demo, /demo). The data is in demo.ts. ----

  /** Servers that belong to the demo. They have no client; the methods below answer for them. */
  private demoServers = new Set<string>();
  private demoReplyCount = 0;

  /** Adds the demo networks, opens #honk, and starts the timeline of incoming messages. */
  startDemo(): void {
    if (this.demoServers.size > 0) {
      this.setActive(DEMO_START.serverId, DEMO_START.buffer);
      return;
    }
    // The welcome screen's placeholder server goes away, as it does for a real server.
    if (this.servers.has("local") && this.serverOrder.length === 1) {
      this.servers.delete("local");
      this.controls.delete("local");
      this.serverOrder = [];
    }

    const now = Date.now();
    for (const net of DEMO_NETWORKS) {
      const buffers: Record<string, BufferState> = {};
      for (const def of net.buffers) {
        const kind = bufferKindFor(def.name);
        const buf = createBuffer(def.name, kind);
        buf.topic = def.topic ?? "";
        if (kind === "channel") buf.users = demoUsers(def.users ?? []);
        for (const line of def.lines) {
          const msg = makeMessage(line.kind, line.text, {
            from: line.from,
            timestamp: new Date(now - line.mins * 60_000),
            isMention:
              line.from !== undefined &&
              (kind === "dm" || mentionsNick(line.text, DEMO_NICK)),
          });
          buf.messages.push(msg);
          if (line.unread) {
            buf.unread += 1;
            buf.hasMention ||= Boolean(msg.isMention);
            buf.firstUnreadId ??= msg.id;
          }
        }
        buffers[def.name] = buf;
      }
      const server: ServerState = {
        id: net.id,
        name: net.name,
        via: net.via,
        // No host: nothing can connect it, and the wake check skips it.
        config: { id: net.id, host: "", nick: DEMO_NICK, autoConnect: false },
        status: "connected",
        nick: DEMO_NICK,
        tls: true,
        buffers,
        bufferOrder: [],
      };
      server.bufferOrder = sortBufferOrder(server, Object.keys(buffers));
      this.servers.set(net.id, server);
      this.controls.set(net.id, createControl());
      this.serverOrder.push(net.id);
      this.demoServers.add(net.id);
    }

    // The start buffer is on screen, so it has no badge. Its divider stays until you leave.
    const start = this.servers.get(DEMO_START.serverId)!;
    const startBuf = start.buffers[DEMO_START.buffer]!;
    start.buffers = {
      ...start.buffers,
      [DEMO_START.buffer]: { ...startBuf, unread: 0, hasMention: false },
    };
    if (this.active) this.clearUnreadDivider(this.active.serverId, this.active.buffer);
    this.active = { ...DEMO_START };
    this.emit();

    for (const event of DEMO_TIMELINE) {
      setTimeout(() => this.demoIncoming(event), event.afterMs);
    }
    const lastMs = Math.max(...DEMO_TIMELINE.map((e) => e.afterMs));
    let next = 0;
    setTimeout(() => {
      setInterval(() => {
        this.demoIncoming(DEMO_AMBIENT[next % DEMO_AMBIENT.length]!);
        next += 1;
      }, DEMO_AMBIENT_EVERY_MS);
    }, lastMs);
  }

  /** A message from a demo person. Skipped if it is for a channel you have left. */
  private demoIncoming(event: DemoEvent): void {
    const server = this.servers.get(event.serverId);
    if (!server) return;
    const isDm = bufferKindFor(event.buffer) === "dm";
    if (!isDm && !this.hasBuffer(event.serverId, event.buffer)) return;
    this.pushMessage(
      event.serverId,
      event.buffer,
      makeMessage(event.kind ?? "message", event.text, {
        from: event.from,
        isMention: isDm || mentionsNick(event.text, server.nick),
      }),
    );
  }

  /** Someone answers what you said: the other person in a DM, someone in the channel otherwise. */
  private demoRespond(serverId: string, bufferName: string): void {
    const server = this.servers.get(serverId);
    const buf = server?.buffers[this.bufferKey(serverId, bufferName)];
    if (!server || !buf) return;
    let from = bufferName;
    if (buf.kind === "channel") {
      const others = buf.users.filter((u) => !sameNick(u.nick, server.nick));
      if (others.length === 0) return;
      from = others[this.demoReplyCount % others.length]!.nick;
    }
    const text = DEMO_REPLIES[this.demoReplyCount % DEMO_REPLIES.length]!;
    this.demoReplyCount += 1;
    setTimeout(
      () => this.demoIncoming({ serverId, buffer: bufferName, from, text }),
      DEMO_REPLY_DELAY_MS,
    );
  }

  /**
   * Runs a command on a demo server without a connection. True if it handled the command;
   * false lets the normal handler run it (/help, /clear, /quit...).
   */
  private demoCommand(
    cmd: string,
    args: string[],
    rest: string,
    server: ServerState,
    activeBuffer: string,
    reply: (text: string, kind?: MessageKind) => void,
  ): boolean {
    const id = server.id;
    switch (cmd) {
      case "j":
      case "join": {
        if (!args[0]) {
          reply("Usage: /join #channel", "error");
          return true;
        }
        const targets = args[0]
          .split(",")
          .filter(Boolean)
          .map((c) => (isChannelName(c) ? c : `#${c}`));
        for (const target of targets) {
          if (!this.hasBuffer(id, target)) {
            this.ensureBuffer(id, target, "channel");
            const buf = server.buffers[target]!;
            server.buffers = {
              ...server.buffers,
              [target]: { ...buf, users: demoUsers([]) },
            };
            this.pushMessage(id, target, makeMessage("join", `${server.nick} joined ${target}`));
          }
          this.setActive(id, target);
        }
        return true;
      }

      case "p":
      case "part":
      case "leave": {
        const target = args[0] && isChannelName(args[0]) ? args[0] : activeBuffer;
        if (target === STATUS_BUFFER) {
          reply("Use /part inside a channel or DM.", "error");
        } else {
          this.removeBuffer(id, target);
        }
        return true;
      }

      case "msg":
      case "query": {
        const target = args[0];
        const text = args.slice(1).join(" ");
        if (!target) {
          reply("Usage: /msg <nick|#channel> [message]", "error");
          return true;
        }
        this.ensureBuffer(id, target);
        this.setActive(id, target);
        if (text) {
          this.pushMessage(id, target, makeMessage("message", text, { from: server.nick, isSelf: true }));
          this.demoRespond(id, target);
        }
        return true;
      }

      case "me": {
        if (!rest || activeBuffer === STATUS_BUFFER) {
          reply("Usage: /me <action> (inside a channel or DM)", "error");
          return true;
        }
        this.pushMessage(id, activeBuffer, makeMessage("action", rest, { from: server.nick, isSelf: true }));
        this.demoRespond(id, activeBuffer);
        return true;
      }

      case "nick": {
        const next = args[0];
        if (!next) {
          reply("Usage: /nick <newnick>", "error");
          return true;
        }
        const old = server.nick;
        const buffers = { ...server.buffers };
        for (const name of server.bufferOrder) {
          const buf = buffers[name];
          if (buf?.kind !== "channel") continue;
          buffers[name] = {
            ...buf,
            users: sortUsers(
              buf.users.map((u) => (sameNick(u.nick, old) ? { ...u, nick: next } : u)),
            ),
          };
        }
        server.buffers = buffers;
        server.nick = next;
        server.config = { ...server.config, nick: next };
        reply(`You are now known as ${next}`);
        return true;
      }

      case "topic": {
        const buf = server.buffers[activeBuffer];
        if (buf?.kind !== "channel") {
          reply("Use /topic inside a channel.", "error");
          return true;
        }
        if (!rest) {
          reply(buf.topic ? `Topic: ${buf.topic}` : "No topic is set.");
          return true;
        }
        server.buffers = { ...server.buffers, [activeBuffer]: { ...buf, topic: rest } };
        reply(`${server.nick} changed the topic to: ${rest}`);
        return true;
      }

      case "whois": {
        if (!args[0]) {
          reply("Usage: /whois <nick>", "error");
          return true;
        }
        for (const line of demoWhois(args[0])) reply(line);
        return true;
      }

      case "history": {
        const buf = server.buffers[activeBuffer];
        if (!buf || buf.kind === "status") {
          reply("Use /history inside a channel or DM.", "error");
          return true;
        }
        const oldest = buf.messages[0]?.timestamp.getTime() ?? Date.now();
        DEMO_HISTORY.forEach((line, i) => {
          const minsBefore = DEMO_HISTORY.length - i;
          this.pushMessage(
            id,
            activeBuffer,
            makeMessage("message", line.text, {
              from: line.from,
              timestamp: new Date(oldest - minsBefore * 60_000),
              isHistory: true,
            }),
          );
        });
        return true;
      }

      case "connect":
      case "server":
      case "disconnect":
      case "raw": {
        reply(`/${cmd} does not work in the offline demo. Quit and start honk without --demo.`, "error");
        return true;
      }

      default:
        return false;
    }
  }

  handleInput(raw: string): "quit" | void {
    const trimmed = raw.trim();
    if (!trimmed) return;

    if (trimmed.startsWith("/")) {
      return this.handleCommand(trimmed.slice(1));
    }
    this.sendText(raw);
  }

  /**
   * Sends pasted lines to the active buffer, one message each. A line that starts with
   * "/" is sent as text, not run as a command.
   */
  sendLines(lines: string[]): void {
    if (!this.active) return;
    if (lines.length > MAX_PASTE_LINES) {
      this.pushMessage(
        this.active.serverId,
        this.active.buffer,
        makeMessage(
          "error",
          `The paste has ${lines.length} lines; at most ${MAX_PASTE_LINES} are sent at once. Nothing was sent.`,
        ),
      );
      return;
    }
    for (const line of lines) {
      if (!this.sendText(line)) return;
    }
  }

  /** Sends one message to the active buffer. False (with an error shown) if it can't. */
  private sendText(raw: string): boolean {
    if (!raw.trim() || !this.active) return false;
    const { serverId, buffer } = this.active;
    const server = this.servers.get(serverId);
    if (server && this.demoServers.has(serverId) && buffer !== STATUS_BUFFER) {
      this.clearUnreadDivider(serverId, buffer);
      this.pushMessage(
        serverId,
        buffer,
        makeMessage("message", raw, { from: server.nick, isSelf: true }),
      );
      this.demoRespond(serverId, buffer);
      return true;
    }
    const client = this.clients.get(serverId);
    if (!server || !client || server.status !== "connected") {
      this.pushMessage(
        serverId,
        buffer,
        makeMessage(
          "error",
          server?.status === "reconnecting"
            ? "Reconnecting… wait a moment or run /connect to retry now."
            : "Not connected. Use /connect <host> [port] [nick].",
        ),
      );
      return false;
    }

    if (buffer === STATUS_BUFFER) {
      this.pushMessage(
        serverId,
        buffer,
        makeMessage("system", "Join a channel first with /join #channel"),
      );
      return false;
    }

    client.privmsg(buffer, raw);
    this.clearUnreadDivider(serverId, buffer);
    this.pushMessage(
      serverId,
      buffer,
      makeMessage("message", raw, { from: server.nick, isSelf: true }),
    );
    return true;
  }

  private handleCommand(line: string): "quit" | void {
    const spaceIdx = line.indexOf(" ");
    const cmd = (spaceIdx === -1 ? line : line.slice(0, spaceIdx)).toLowerCase();
    const rest = spaceIdx === -1 ? "" : line.slice(spaceIdx + 1).trim();
    const args = rest ? rest.split(/\s+/) : [];

    const activeServerId = this.active?.serverId;
    const activeBuffer = this.active?.buffer ?? STATUS_BUFFER;
    const server = activeServerId ? this.servers.get(activeServerId) : undefined;
    const client = activeServerId ? this.clients.get(activeServerId) : undefined;

    const reply = (text: string, kind: MessageKind = "system") => {
      if (activeServerId) {
        this.pushMessage(activeServerId, activeBuffer, makeMessage(kind, text));
      }
    };

    if (server && this.demoServers.has(server.id)) {
      if (this.demoCommand(cmd, args, rest, server, activeBuffer, reply)) return;
    }

    switch (cmd) {
      case "help": {
        const list = SLASH_COMMANDS.map((c) => (c.args ? `/${c.name} ${c.args}` : `/${c.name}`))
          .join(" | ");
        reply(`Commands: ${list}. Press Ctrl+K for the omnibox.`);
        return;
      }

      case "connect": {
        const hostArg = args[0];
        if (!hostArg) {
          if (server && server.config.host) {
            void this.connectServer(server.id, { manual: true });
          } else {
            reply("Usage: /connect <host> [port|+tlsport] [nick] (6697 is TLS)", "error");
          }
          return;
        }
        const [host = "", inlinePort] = hostArg.split(":");
        const portArg = inlinePort ?? (parsePortArg(args[1]) ? args[1] : undefined);
        const parsedPort = parsePortArg(portArg);
        if (portArg !== undefined && !parsedPort) {
          return reply(`Invalid port: ${portArg}`, "error");
        }
        const nickArg = inlinePort || !parsedPort ? args[1] : args[2];

        // Reconnect a known server rather than replace its config (SASL, channels...).
        const known = this.serverOrder
          .map((id) => this.servers.get(id))
          .find(
            (s) =>
              s &&
              sameHost(s.config.host, host) &&
              (!parsedPort || s.config.port === parsedPort.port),
          );
        if (known) {
          if (nickArg) known.config = { ...known.config, nick: nickArg };
          this.setActive(known.id, STATUS_BUFFER);
          void this.connectServer(known.id, { manual: true });
          return;
        }

        const { port, tls } = parsedPort ?? { port: 6697, tls: true };
        let id = serverIdFromHost(host);
        if (this.servers.has(id)) id = `${id}:${port}`;
        this.addServer({
          id,
          name: host,
          host,
          port,
          tls,
          nick: nickArg || server?.nick || defaultNick(),
          autoConnect: true,
        });
        this.setActive(id, STATUS_BUFFER);
        return;
      }

      case "disconnect": {
        if (activeServerId) {
          this.disconnectServer(activeServerId, rest || "Leaving");
        }
        return;
      }

      case "j":
      case "join": {
        if (!client || !server) return reply("Not connected.", "error");
        if (!args[0]) return reply("Usage: /join #channel[,#channel...] [key[,key...]]", "error");
        // "/join #a,#b keyA": the server sends one JOIN per channel.
        const keys = args[1]?.split(",") ?? [];
        const targets = args[0]
          .split(",")
          .filter(Boolean)
          .map((c) => (isChannelName(c) ? c : `#${c}`));
        const descriptions = targets.map((target, i): string | [string, string] =>
          keys[i] ? [target, keys[i]] : target,
        );
        if (descriptions.length === 0) return reply("Usage: /join #channel", "error");
        const expires = Date.now() + REQUESTED_JOIN_TTL_MS;
        for (const target of targets) {
          // Already in it: the server sends no JOIN, so switch now.
          if (server.buffers[this.bufferKey(server.id, target)]?.kind === "channel") {
            this.setActive(server.id, target);
          } else {
            this.requestedJoins.set(joinKey(server.id, target), expires);
          }
        }
        client.join(...(descriptions as [string, ...(string | [string, string])[]]));
        return;
      }

      case "p":
      case "part":
      case "leave": {
        if (!client || !server) return reply("Not connected.", "error");
        const target =
          args[0] && isChannelName(args[0]) ? args[0] : activeBuffer;
        const reason =
          args[0] && isChannelName(args[0]) ? args.slice(1).join(" ") : rest;
        if (!isChannelName(target)) {
          if (target !== STATUS_BUFFER) {
            this.removeBuffer(server.id, target);
          }
          return;
        }
        client.part(target, reason || undefined);
        return;
      }

      case "msg":
      case "query": {
        if (!client || !server) return reply("Not connected.", "error");
        const target = args[0];
        const text = args.slice(1).join(" ");
        if (!target)
          return reply("Usage: /msg <nick|#channel> [message]", "error");
        this.ensureBuffer(server.id, target);
        this.setActive(server.id, target);
        if (text) {
          client.privmsg(target, text);
          this.pushMessage(
            server.id,
            target,
            makeMessage("message", text, { from: server.nick, isSelf: true }),
          );
        }
        return;
      }

      case "me": {
        if (!client || !server) return reply("Not connected.", "error");
        if (!rest || activeBuffer === STATUS_BUFFER) {
          return reply("Usage: /me <action> (inside a channel or DM)", "error");
        }
        client.action(activeBuffer, rest);
        this.pushMessage(
          server.id,
          activeBuffer,
          makeMessage("action", rest, { from: server.nick, isSelf: true }),
        );
        return;
      }

      case "nick": {
        if (!client) return reply("Not connected.", "error");
        if (!args[0]) return reply("Usage: /nick <newnick>", "error");
        client.nick(args[0]);
        return;
      }

      case "topic": {
        if (!client || !isChannelName(activeBuffer)) {
          return reply("Use /topic inside a channel.", "error");
        }
        if (rest) {
          client.topic(activeBuffer, rest);
        } else {
          client.topic(activeBuffer);
        }
        return;
      }

      case "whois": {
        if (!client) return reply("Not connected.", "error");
        if (!args[0]) return reply("Usage: /whois <nick>", "error");
        client.whois(args[0]);
        return;
      }

      case "raw": {
        if (!client) return reply("Not connected.", "error");
        if (!rest) return reply("Usage: /raw <COMMAND ...>", "error");
        const [rawCmd, ...rawParams] = rest.split(" ");
        void client.send(rawCmd as never, ...(rawParams as never[]));
        return;
      }

      case "history": {
        if (!client || !server) return reply("Not connected.", "error");
        if (!client.state.caps.enabled.has("draft/chathistory")) {
          return reply("Server does not advertise draft/chathistory.", "error");
        }
        if (activeBuffer === STATUS_BUFFER) {
          return reply("Use /history inside a channel or DM.", "error");
        }
        const wanted = Math.min(200, Math.max(1, Number(args[0]) || 50));
        const buf = server.buffers[activeBuffer];
        // Older lines past the cap would be fetched and then trimmed right away.
        // When the request must shrink, the notice below takes one line of the room too.
        const room = MAX_MESSAGES_WITH_HISTORY - (buf?.messages.length ?? 0);
        const limit = wanted <= room ? wanted : room - 1;
        if (limit <= 0) {
          return reply(
            `Scrollback is full (${MAX_MESSAGES_WITH_HISTORY} lines). Use /clear to start over.`,
            "error",
          );
        }
        if (limit < wanted) {
          reply(
            `Fetching only ${limit} lines: scrollback holds at most ${MAX_MESSAGES_WITH_HISTORY}.`,
          );
        }
        const oldest = buf?.messages.find(
          (m) => m.kind === "message" || m.kind === "action" || m.kind === "notice",
        );
        if (oldest) {
          requestHistory(
            client,
            "BEFORE",
            activeBuffer,
            `timestamp=${oldest.timestamp.toISOString()}`,
            limit,
          );
        } else {
          requestHistory(client, "LATEST", activeBuffer, "*", limit);
        }
        return;
      }

      case "clear": {
        if (!server) return;
        const buf = server.buffers[activeBuffer];
        if (!buf) return;
        server.buffers = {
          ...server.buffers,
          [activeBuffer]: { ...buf, messages: [], messageLimit: undefined },
        };
        this.emit();
        return;
      }

      case "demo": {
        this.startDemo();
        return;
      }

      case "quit":
      case "exit": {
        this.disconnectAll();
        return "quit";
      }

      default:
        reply(
          `Unknown command: /${cmd}. Type /help for available commands.`,
          "error",
        );
    }
  }
}
