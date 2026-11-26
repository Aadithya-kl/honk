import { Client } from "irc-client-ts";
import { defaultNick, parsePortArg, sameHost, serverIdFromHost } from "../config.ts";
import type {
  ActiveBuffer,
  BufferKind,
  BufferState,
  ChatMessage,
  MessageKind,
  ServerConfig,
  ServerState,
  StoreSnapshot,
} from "../types.ts";
import {
  bufferKindFor,
  isChannelName,
  normalizeNick,
  sameNick,
  STATUS_BUFFER,
} from "./names.ts";
import { createNodeRuntime } from "./runtime.ts";

const MAX_MESSAGES = 500;

// Reconnect & health tuning
const CONNECT_TIMEOUT_MS = 15_000;
const STABLE_RESET_MS = 10_000;
const BACKOFF_BASE_MS = 2_000;
const BACKOFF_MAX_MS = 60_000;
const WAKE_CHECK_INTERVAL_MS = 5_000;
const WAKE_JUMP_THRESHOLD_MS = 15_000;

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

function mentionsNick(text: string, nick: string): boolean {
  if (!nick) return false;
  const escaped = nick.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "i").test(text);
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
  private snapshot: StoreSnapshot = { servers: [], active: null };
  private wakeInterval: ReturnType<typeof setInterval> | null = null;
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
      makeMessage("system", "Welcome to irc — Bun + OpenTUI IRC client."),
      makeMessage(
        "system",
        "Connect to a server with: /connect irc.libera.chat 6697 yournick",
      ),
      makeMessage(
        "system",
        "Or create irc.json (see irc.example.json) for multi-server auto-connect. Type /help for commands.",
      ),
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

    // State from before the nicklist plugin handled an event, keyed by the event payload:
    // the channels a quitting/renamed nick was in, and whether a joined buffer existed.
    const priorChannels = new WeakMap<object, string[]>();
    const priorBufferExisted = new WeakMap<object, boolean>();
    beforeEmit(client, (event, payload) => {
      const server = live();
      if (!server || typeof payload !== "object" || payload === null) return;
      const msg = payload as { source?: { name?: string }; params?: { channel?: string } };
      if (event === "quit" || event === "nick") {
        priorChannels.set(payload, channelsWithNick(server, normalizeNick(msg.source?.name)));
      } else if (event === "join" && msg.params?.channel) {
        priorBufferExisted.set(payload, Boolean(server.buffers[msg.params.channel]));
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
      const alreadyExisted =
        priorBufferExisted.get(msg) ?? Boolean(server.buffers[channel]);
      this.ensureBuffer(serverId, channel, "channel");
      if (sameNick(who, server.nick)) {
        // Don't hijack active buffer on silent reconnect re-joins
        if (!alreadyExisted || this.active?.buffer === STATUS_BUFFER) {
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
      const by = msg.source?.name ?? "someone";
      const reason = comment ? ` (${comment})` : "";
      this.pushMessage(
        serverId,
        channel,
        makeMessage("error", `${nick} was kicked by ${by}${reason}`),
      );
      if (sameNick(nick, server.nick)) {
        this.removeBuffer(serverId, channel);
      }
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
      for (const bufName of priorChannels.get(msg) ?? channelsWithNick(server, oldNick)) {
        this.pushMessage(
          serverId,
          bufName,
          makeMessage("system", `${oldNick} is now known as ${newNick}`),
        );
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
      const from = normalizeNick(msg.source?.name) || "unknown";
      const isSelf = sameNick(from, server.nick);
      const target = routeTarget(msg.params.target, from, isSelf);
      const isHistory = isHistoryBatch(msg.tags);
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
          msgid: msg.tags?.msgid,
          timestamp: tagTime(msg.tags),
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
      const from = normalizeNick(msg.source?.name) || "server";
      const target = isChannelName(msg.params.target)
        ? msg.params.target
        : STATUS_BUFFER;
      this.pushMessage(
        serverId,
        target,
        makeMessage("notice", msg.params.text, {
          from,
          msgid: msg.tags?.msgid,
          timestamp: tagTime(msg.tags),
          isHistory: isHistoryBatch(msg.tags),
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

  /** Where replies to a command (errors, WHOIS) go: the active buffer if it is on this server. */
  private replyTarget(serverId: string): string {
    return this.active?.serverId === serverId ? this.active.buffer : STATUS_BUFFER;
  }

  private wasRecentlyEchoed(
    serverId: string,
    target: string,
    text: string,
  ): boolean {
    const buf = this.servers.get(serverId)?.buffers[target];
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
    const existing = server.buffers[name];
    if (existing) return existing;

    const buf = createBuffer(name, kind);
    server.buffers = { ...server.buffers, [name]: buf };
    const order = [...server.bufferOrder, name];
    order.sort((a, b) => {
      if (a === STATUS_BUFFER) return -1;
      if (b === STATUS_BUFFER) return 1;
      const ka = server.buffers[a]?.kind ?? "dm";
      const kb = server.buffers[b]?.kind ?? "dm";
      if (ka !== kb) return ka === "channel" ? -1 : 1;
      return a.localeCompare(b);
    });
    server.bufferOrder = order;
    return buf;
  }

  private removeBuffer(serverId: string, name: string): void {
    const server = this.servers.get(serverId);
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
    bufferName: string,
    message: ChatMessage,
  ): void {
    const server = this.servers.get(serverId);
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
    if (messages.length > MAX_MESSAGES) messages.splice(0, messages.length - MAX_MESSAGES);

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

  setActive(serverId: string, bufferName: string): void {
    const server = this.servers.get(serverId);
    if (!server) return;
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

  handleInput(raw: string): "quit" | void {
    const trimmed = raw.trim();
    if (!trimmed) return;

    if (trimmed.startsWith("/")) {
      return this.handleCommand(trimmed.slice(1));
    }

    if (!this.active) return;
    const { serverId, buffer } = this.active;
    const server = this.servers.get(serverId);
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
      return;
    }

    if (buffer === STATUS_BUFFER) {
      this.pushMessage(
        serverId,
        buffer,
        makeMessage("system", "Join a channel first with /join #channel"),
      );
      return;
    }

    client.privmsg(buffer, raw);
    this.clearUnreadDivider(serverId, buffer);
    this.pushMessage(
      serverId,
      buffer,
      makeMessage("message", raw, { from: server.nick, isSelf: true }),
    );
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

    switch (cmd) {
      case "help": {
        reply(
          "Commands: /connect <host> [port|+tlsport] [nick] | /disconnect | /join #chan | /part [msg] | /msg <nick> <text> | /me <action> | /nick <new> | /topic [text] | /whois <nick> | /clear | /quit",
        );
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
        const chan = args[0];
        if (!chan) return reply("Usage: /join #channel", "error");
        const target = isChannelName(chan) ? chan : `#${chan}`;
        client.join(target);
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
        const limit = Math.min(200, Math.max(1, Number(args[0]) || 50));
        const buf = server.buffers[activeBuffer];
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
          [activeBuffer]: { ...buf, messages: [] },
        };
        this.emit();
        return;
      }

      case "demo": {
        if (!server) return;
        const demoName = "#demo";
        const now = Date.now();
        const t = (minsAgo: number) => new Date(now - minsAgo * 60_000);
        const me = server.nick || "goose";
        const unreadMsg = makeMessage(
          "message",
          `hey ${me}, check out \x0309grouped messages\x0f + \x02mIRC bold\x02 + \x1Ditalic\x1D!`,
          { from: "bob", timestamp: t(2), isMention: true },
        );

        const demoBuf: BufferState = {
          name: demoName,
          kind: "channel",
          topic: "\x02Demo channel\x02 — \x0311https://opentui.com\x0f (local only, no IRC traffic)",
          users: [
            { prefix: "@", nick: "alice" },
            { prefix: "+", nick: "bob" },
            { prefix: "", nick: "charlie" },
            { prefix: "", nick: me },
          ],
          messages: [
            makeMessage("join", "alice joined #demo", { timestamp: t(8) }),
            makeMessage("message", "hey, just pushed the new OpenTUI build", {
              from: "alice",
              timestamp: t(6),
            }),
            makeMessage(
              "message",
              "check out https://github.com/anomalyco/opentui — clickable link!",
              { from: "alice", timestamp: t(6) },
            ),
            makeMessage(
              "message",
              "supports \x0304red\x0f, \x0308gold\x0f, \x0313pink\x0f, and \x0473dacaTrueColor hex\x0f",
              { from: "alice", timestamp: t(5) },
            ),
            makeMessage("action", "tests the live hot-reload", {
              from: "charlie",
              timestamp: t(4),
            }),
            unreadMsg,
            makeMessage(
              "message",
              "notice how repeated nicks collapse within 5 minutes",
              { from: "bob", timestamp: t(1) },
            ),
            makeMessage(
              "message",
              "and the coral 'new' divider clears when you reply or switch away",
              { from: "bob", timestamp: t(1) },
            ),
          ],
          unread: 0,
          hasMention: false,
          firstUnreadId: unreadMsg.id,
        };

        this.ensureBuffer(server.id, demoName, "channel");
        server.buffers = { ...server.buffers, [demoName]: demoBuf };
        this.active = { serverId: server.id, buffer: demoName };
        this.emit();
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
