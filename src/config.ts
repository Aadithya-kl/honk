import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { AppConfig, AuthMethod, ServerConfig } from "./types.ts";

export function defaultNick(): string {
  return process.env.USER || "guest";
}

export function serverIdFromHost(host: string): string {
  return host.split(".")[1] || host;
}

function parseArgs(argv: string[]) {
  const flags: Record<string, string | boolean | string[]> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    if (key.startsWith("no-")) {
      flags[key.slice(3)] = false;
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      flags[key] = true;
    } else {
      i++;
      if (key === "channel") {
        const list = (flags[key] as string[] | undefined) ?? [];
        list.push(next);
        flags[key] = list;
      } else {
        flags[key] = next;
      }
    }
  }
  return flags;
}

function readConfigFile(path: string): AppConfig | null {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf-8");
  const parsed = JSON.parse(raw) as Partial<AppConfig>;
  if (!Array.isArray(parsed.servers)) return { servers: [] };
  return {
    servers: parsed.servers.map((s, idx) => ({
      id: s.id || s.name || s.host || `server-${idx + 1}`,
      name: s.name || s.id || s.host,
      via: s.via,
      host: s.host,
      port: s.port ?? (s.tls === false ? 6667 : 6697),
      tls: s.tls ?? true,
      nick: s.nick || defaultNick(),
      username: s.username,
      realname: s.realname,
      password: s.password,
      serverPassword: s.serverPassword,
      authMethod: s.authMethod ?? (s.password ? "sasl" : undefined),
      channels: s.channels ?? [],
      autoConnect: s.autoConnect ?? true,
    })),
  };
}

export function loadConfig(argv: string[] = process.argv.slice(2)): AppConfig {
  const flags = parseArgs(argv);

  // 1. Check explicit --config or default file locations
  const candidates: string[] = [];
  if (typeof flags.config === "string") {
    candidates.push(resolve(flags.config));
  } else {
    candidates.push(resolve("irc.json"));
    candidates.push(join(homedir(), ".config", "irc", "config.json"));
  }

  let config: AppConfig = { servers: [] };

  for (const candidate of candidates) {
    const loaded = readConfigFile(candidate);
    if (loaded) {
      config = loaded;
      break;
    }
  }

  // 2. Allow quick CLI --server override/addition
  if (typeof flags.server === "string") {
    const [hostPart, portPart] = flags.server.split(":");
    const host = hostPart!;
    const tls = flags.tls === undefined ? true : Boolean(flags.tls);
    const port = portPart
      ? Number(portPart)
      : typeof flags.port === "string"
        ? Number(flags.port)
        : tls
          ? 6697
          : 6667;
    const nick = typeof flags.nick === "string" ? flags.nick : defaultNick();
    const password =
      typeof flags.password === "string" ? flags.password : undefined;
    const channels = Array.isArray(flags.channel)
      ? flags.channel
      : typeof flags.channel === "string"
        ? [flags.channel]
        : [];
    const authMethod: AuthMethod | undefined =
      flags.sasl === true || password ? "sasl" : undefined;

    const cliServer: ServerConfig = {
      id: serverIdFromHost(host),
      name: host,
      host,
      port,
      tls,
      nick,
      password,
      authMethod,
      channels,
      autoConnect: true,
    };

    config = {
      servers: [cliServer, ...config.servers.filter((s) => s.id !== cliServer.id)],
    };
  }

  return config;
}
