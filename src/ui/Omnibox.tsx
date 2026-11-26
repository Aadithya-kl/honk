import { useKeyboard } from "@opentui/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { nickColor, theme, useThemeVersion } from "../theme.ts";
import type { ThemeEntry } from "../themes/index.ts";
import { findSlashCommand, needsArgs, SLASH_COMMANDS } from "../irc/commands.ts";
import { sameNick } from "../irc/names.ts";
import type { ActiveBuffer, ServerState } from "../types.ts";
import { bufferDisplayName, truncate, unreadBadge } from "./display.ts";

interface OmniboxItem {
  id: string;
  label: string;
  labelColor?: string;
  detail?: string;
  badge?: string;
  badgeColor?: string;
  hint?: string;
  /** Runs before the omnibox closes. */
  onSelect: () => void;
  /** Keep the omnibox open after selecting (items that change the query, like "?" help). */
  keepOpen?: boolean;
  /** In the theme list: the theme this row previews when selected. */
  themeId?: string;
}

interface OmniboxProps {
  servers: ServerState[];
  active: ActiveBuffer | null;
  recentKeys: string[];
  width: number;
  onClose: () => void;
  onSelectBuffer: (serverId: string, buffer: string) => void;
  onOpenDm: (serverId: string, nick: string) => void;
  onRunCommand: (command: string) => void;
  onToggleSidebar: () => void;
  onToggleNicklist: () => void;
  themes: ThemeEntry[];
  /** The theme in use, which closing the theme list without a choice goes back to. */
  themeId: string;
  /** Shows a theme without saving it. */
  onPreviewTheme: (id: string) => void;
  /** Uses a theme and saves it in the config file. */
  onChooseTheme: (id: string) => void;
}

/** "main": buffers and the prefix modes. "theme": the color theme list. */
type OmniboxMode = "main" | "theme";

const MAX_RESULTS = 10;
const THEME_ACTION_LABEL = "Preferences: Color Theme...";
/** How far back the active buffer is read to rank recent speakers first in "@" mode. */
const RECENT_SPEAKER_SCAN = 300;

function fuzzyScore(query: string, target: string): number {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  if (!q) return 1;
  if (t === q) return 1000;
  if (t.startsWith(q)) return 500 - t.length;
  const idx = t.indexOf(q);
  if (idx !== -1) return 300 - idx - t.length * 0.1;

  let qi = 0;
  let score = 0;
  let consecutive = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      qi++;
      consecutive++;
      score += 10 + consecutive * 5;
    } else {
      consecutive = 0;
    }
  }
  return qi === q.length ? score : -1;
}

interface KnownUser {
  serverId: string;
  serverName: string;
  nick: string;
  /** An open DM buffer with this user. */
  hasDm: boolean;
}

/** Every user in a channel or an open DM, once per server, without yourself. */
function collectUsers(servers: ServerState[]): KnownUser[] {
  const users = new Map<string, KnownUser>();
  for (const s of servers) {
    for (const bufName of s.bufferOrder) {
      const buf = s.buffers[bufName];
      if (!buf) continue;
      const nicks = buf.kind === "dm" ? [buf.name] : buf.users.map((u) => u.nick);
      for (const nick of nicks) {
        if (sameNick(nick, s.nick)) continue;
        const key = `${s.id}:${nick.toLowerCase()}`;
        const known = users.get(key);
        if (known) {
          if (buf.kind === "dm") known.hasDm = true;
          continue;
        }
        users.set(key, { serverId: s.id, serverName: s.name, nick, hasDm: buf.kind === "dm" });
      }
    }
  }
  return [...users.values()];
}

/** Fits a row into `width` columns: the label keeps at least half, then the detail is cut. */
function fitRow(item: OmniboxItem, width: number): { label: string; detail?: string } {
  const extras =
    (item.hint ? item.hint.length + 1 : 0) + (item.badge ? item.badge.length + 1 : 0);
  const room = Math.max(4, width - extras);
  const detailWanted = item.detail ? item.detail.length + 2 : 0;
  const labelMax = Math.max(room - detailWanted, Math.min(item.label.length, Math.ceil(room / 2)));
  const label = truncate(item.label, labelMax);
  const detailRoom = room - label.length - 2;
  const detail = item.detail && detailRoom >= 4 ? truncate(item.detail, detailRoom) : undefined;
  return { label, detail };
}

export function Omnibox({
  servers,
  active,
  recentKeys,
  width,
  onClose,
  onSelectBuffer,
  onOpenDm,
  onRunCommand,
  onToggleSidebar,
  onToggleNicklist,
  themes,
  themeId,
  onPreviewTheme,
  onChooseTheme,
}: OmniboxProps) {
  const [mode, setMode] = useState<OmniboxMode>("main");
  const [query, setQuery] = useState("");
  // The selected item's id, not its row: the list is rebuilt when buffers or unread
  // counts change, and a row number would then point at another item or past the end.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const themeVersion = useThemeVersion();
  /** A theme was previewed, so closing must restore the theme in use. */
  const previewedRef = useRef(false);
  /** A theme was chosen with Enter or a click: keep it on close. */
  const chosenRef = useRef(false);
  const openThemeList = () => {
    setMode("theme");
    setQuery("");
  };

  const activeServer = active
    ? servers.find((s) => s.id === active.serverId)
    : servers[0];

  /** `more`: matches left out of the list, so the user knows to type more. */
  const { items, more } = useMemo<{ items: OmniboxItem[]; more: number }>(() => {
    const trimmed = query.trimStart();
    const top = (list: OmniboxItem[]) => ({
      items: list.slice(0, MAX_RESULTS),
      more: Math.max(0, list.length - MAX_RESULTS),
    });
    // The action and slash command lists are short and fixed: show them whole.
    const all = (list: OmniboxItem[]) => ({ items: list, more: 0 });

    // The color theme list. It is long, so the rows scroll (see `visible` below).
    if (mode === "theme") {
      const q = trimmed.trim();
      return all(
        themes
          .map((entry, order) => ({
            entry,
            order,
            score: fuzzyScore(q, `${entry.name} ${entry.id} ${entry.variant}`),
          }))
          .filter((x) => x.score >= 0)
          .sort((a, b) => (q ? b.score - a.score : 0) || a.order - b.order)
          .map(({ entry }): OmniboxItem => ({
            id: `theme-${entry.id}`,
            themeId: entry.id,
            label: entry.name,
            detail: [
              entry.variant,
              entry.source === "user" ? "yours" : undefined,
              entry.id === themeId ? "current" : undefined,
            ]
              .filter(Boolean)
              .join(", "),
            onSelect: () => {
              chosenRef.current = true;
              onChooseTheme(entry.id);
            },
          })),
      );
    }
    const themeAction = (id: string): OmniboxItem => ({
      id,
      label: THEME_ACTION_LABEL,
      detail: themes.find((t) => t.id === themeId)?.name,
      onSelect: openThemeList,
      keepOpen: true,
    });

    // ? -- mode help, as in VS Code
    if (trimmed === "?") {
      const mode = (id: string, label: string, color: string, detail: string, next: string) => ({
        id,
        label,
        labelColor: color,
        detail,
        onSelect: () => setQuery(next),
        keepOpen: true,
      });
      return top([
        mode("help-buffers", "(no prefix)", theme.accent, "Jump to a channel, DM or user", ""),
        mode("help-cmd", ">", theme.yellow, "Run an action (part, nick, topic, quit...)", ">"),
        mode("help-slash", "/", theme.cyan, "Run a slash command, with its usage shown", "/"),
        mode("help-users", "@", theme.accentAlt, "Find a user and open a DM", "@"),
        mode("help-channels", "#", theme.cyan, "Filter channels or join a new #channel", "#"),
      ]);
    }

    // / -- slash commands, also reachable as "> /..."
    const slash = trimmed.startsWith("/")
      ? trimmed
      : trimmed.startsWith(">") && trimmed.slice(1).trimStart().startsWith("/")
        ? trimmed.slice(1).trimStart()
        : null;
    if (slash !== null) {
      const [word = "", ...restWords] = slash.slice(1).split(" ");
      const known = findSlashCommand(word);
      // Arguments typed (or started): one item that runs the line as typed.
      if (restWords.length > 0) {
        return top([
          {
            id: "slash-run",
            label: `Run ${slash.trimEnd()}`,
            labelColor: theme.cyan,
            detail: known ? `/${known.name} ${known.args ?? ""}`.trimEnd() : "unknown command",
            onSelect: () => onRunCommand(slash),
          },
        ]);
      }
      const matches = SLASH_COMMANDS.map((cmd) => ({ cmd, score: fuzzyScore(word, cmd.name) }))
        .filter((x) => x.score >= 0)
        .sort((a, b) => b.score - a.score)
        .map(({ cmd }): OmniboxItem => ({
          id: `slash-${cmd.name}`,
          label: cmd.args ? `/${cmd.name} ${cmd.args}` : `/${cmd.name}`,
          labelColor: theme.cyan,
          detail: cmd.summary,
          // A command that needs arguments fills the query, so the user types them next.
          onSelect: needsArgs(cmd)
            ? () => setQuery(`/${cmd.name} `)
            : () => onRunCommand(`/${cmd.name}`),
          keepOpen: needsArgs(cmd),
        }));
      if (matches.length === 0 && word) {
        matches.push({
          id: "slash-run",
          label: `Run ${slash}`,
          labelColor: theme.cyan,
          detail: "unknown command",
          onSelect: () => onRunCommand(slash),
        });
      }
      return all(matches);
    }

    // > -- command palette: actions that fit the current buffer and server
    if (trimmed.startsWith(">")) {
      const q = trimmed.slice(1).trim();
      const buf = activeServer && active ? activeServer.buffers[active.buffer] : undefined;
      const fill = (next: string) => ({ onSelect: () => setQuery(next), keepOpen: true });
      const status = activeServer?.status;
      const online = status === "connected" || status === "connecting" || status === "reconnecting";
      const commands: OmniboxItem[] = [];
      const add = (...list: OmniboxItem[]) => commands.push(...list);

      add(
        { id: "cmd-join", label: "Channel: Join a Channel...", hint: "#", ...fill("#") },
        { id: "cmd-dm", label: "User: Open a DM...", hint: "@", ...fill("@") },
      );
      if (buf?.kind === "channel" && active) {
        add(
          {
            id: "cmd-topic",
            label: "Channel: Set Topic...",
            detail: active.buffer,
            ...fill("/topic "),
          },
          {
            id: "cmd-part",
            label: `Channel: Part ${active.buffer}`,
            detail: activeServer?.name,
            onSelect: () => onRunCommand(`/part ${active.buffer}`),
          },
        );
      }
      if (buf?.kind === "dm" && active) {
        add(
          {
            id: "cmd-whois",
            label: `User: Whois ${active.buffer}`,
            onSelect: () => onRunCommand(`/whois ${active.buffer}`),
          },
          {
            id: "cmd-close-dm",
            label: `User: Close DM with ${active.buffer}`,
            onSelect: () => onRunCommand("/part"),
          },
        );
      }
      if (buf && buf.kind !== "status") {
        add({
          id: "cmd-history",
          label: "Chat: Load Older Messages",
          detail: "/history",
          onSelect: () => onRunCommand("/history"),
        });
      }
      add({
        id: "cmd-clear",
        label: "Chat: Clear Buffer",
        detail: active?.buffer,
        onSelect: () => onRunCommand("/clear"),
      });
      add(
        themeAction("cmd-theme"),
        { id: "cmd-sidebar", label: "View: Toggle Sidebar", hint: "^B", onSelect: onToggleSidebar },
        {
          id: "cmd-nicklist",
          label: "View: Toggle User List",
          hint: "Alt+U",
          onSelect: onToggleNicklist,
        },
      );
      if (activeServer && online) {
        add({
          id: "cmd-nick",
          label: "Server: Change Nick...",
          detail: activeServer.nick,
          ...fill("/nick "),
        });
      }
      if (activeServer?.config.host) {
        add({
          id: "cmd-reconnect",
          label: `Server: ${online ? "Reconnect" : "Connect"} ${activeServer.name}`,
          onSelect: () => onRunCommand("/connect"),
        });
        if (online) {
          add({
            id: "cmd-disconnect",
            label: `Server: Disconnect ${activeServer.name}`,
            onSelect: () => onRunCommand("/disconnect"),
          });
        }
      }
      add(
        { id: "cmd-connect", label: "Server: Connect to a New Server...", ...fill("/connect ") },
        { id: "cmd-slash", label: "IRC: Slash Commands...", hint: "/", ...fill("/") },
        { id: "cmd-quit", label: "App: Quit", hint: "^C", onSelect: () => onRunCommand("/quit") },
      );

      return all(
        commands
          .map((item) => ({ item, score: fuzzyScore(q, `${item.label} ${item.detail ?? ""}`) }))
          .filter((x) => x.score >= 0)
          .sort((a, b) => b.score - a.score)
          .map((x) => x.item),
      );
    }

    // @ -- find a user and open a DM
    if (trimmed.startsWith("@")) {
      const q = trimmed.slice(1).trim();
      // Recent speakers in the buffer you are in, newest first.
      const recentSpeakers = new Map<string, number>();
      const activeBuf = active ? activeServer?.buffers[active.buffer] : undefined;
      const msgs = activeBuf?.messages ?? [];
      for (let i = msgs.length - 1; i >= Math.max(0, msgs.length - RECENT_SPEAKER_SCAN); i--) {
        const from = msgs[i]!.from?.toLowerCase();
        if (from && !recentSpeakers.has(from)) recentSpeakers.set(from, recentSpeakers.size);
      }

      const here =
        activeBuf?.kind === "channel"
          ? new Set(activeBuf.users.map((u) => u.nick.toLowerCase()))
          : new Set<string>();
      const inThisDm = (u: KnownUser) =>
        activeBuf?.kind === "dm" &&
        u.serverId === active?.serverId &&
        sameNick(u.nick, activeBuf.name);

      const users = collectUsers(servers)
        .map((u) => {
          let score = fuzzyScore(q, `${u.nick} ${u.serverName}`);
          if (score >= 0 && !q) {
            // People you talk with first: open DMs, then who spoke here lately,
            // then the rest of this channel. The DM you are in goes last.
            const lower = u.nick.toLowerCase();
            const sameServer = u.serverId === active?.serverId;
            if (inThisDm(u)) {
              score -= 10_000;
            } else if (u.hasDm) {
              const dmKey = `${u.serverId}:${lower}`;
              const recIdx = recentKeys.findIndex((k) => k.toLowerCase() === dmKey);
              score += 3000 - (recIdx === -1 ? 50 : recIdx);
            }
            const spoke = sameServer ? recentSpeakers.get(lower) : undefined;
            if (spoke !== undefined) score += 2000 - spoke;
            else if (sameServer && here.has(lower)) score += 1000;
          }
          return { u, score };
        })
        .filter((x) => x.score >= 0)
        .sort((a, b) => b.score - a.score || a.u.nick.localeCompare(b.u.nick));

      const list = users.map(
        ({ u }): OmniboxItem => ({
          id: `user-${u.serverId}:${u.nick.toLowerCase()}`,
          label: u.nick,
          labelColor: nickColor(u.nick),
          detail: u.hasDm ? `has a DM, ${u.serverName}` : u.serverName,
          onSelect: () => onOpenDm(u.serverId, u.nick),
        }),
      );

      const result = top(list);
      // A nick nobody shares a channel with: offer a new DM anyway.
      if (q && activeServer && !q.includes(" ") && !sameNick(q, activeServer.nick)) {
        const exact = users.some(({ u }) => u.serverId === activeServer.id && sameNick(u.nick, q));
        if (!exact) {
          result.items.push({
            id: `dm-new-${q}`,
            label: `Message ${q}`,
            labelColor: theme.accentAlt,
            detail: `new DM, ${activeServer.name}`,
            onSelect: () => onOpenDm(activeServer.id, q),
          });
        }
      }
      return result;
    }

    // Default (or #) -- quick open buffers across all servers
    const channelOnly = trimmed.startsWith("#");
    const q = trimmed;
    // "#" alone ranks like an empty query: what needs you first, the current buffer last.
    const browsing = !q || q === "#";
    const candidates: { item: OmniboxItem; score: number }[] = [];

    for (const s of servers) {
      for (const bufName of s.bufferOrder) {
        const buf = s.buffers[bufName];
        if (!buf) continue;
        if (channelOnly && buf.kind !== "channel") continue;

        const key = `${s.id}:${bufName}`;
        const displayName = bufferDisplayName(buf);
        const baseScore = fuzzyScore(q, `${displayName} ${s.name}`);
        if (baseScore < 0) continue;

        // Boost mentions, unreads, and recently visited buffers when browsing
        let boost = 0;
        if (browsing) {
          if (buf.hasMention) boost += 400;
          else if (buf.unread > 0) boost += 200 + Math.min(buf.unread, 50);
          const recIdx = recentKeys.indexOf(key);
          if (recIdx !== -1) boost += 100 - recIdx;
          // The buffer you are in goes last, so Ctrl+K then Enter goes back to the previous one.
          if (active?.serverId === s.id && active.buffer === bufName) boost -= 10_000;
        }

        candidates.push({
          score: baseScore + boost,
          item: {
            id: `buf-${key}`,
            label: displayName,
            labelColor:
              buf.kind === "channel"
                ? theme.fgBright
                : buf.kind === "dm"
                  ? theme.accentAlt
                  : theme.fgMuted,
            detail: s.name,
            badge: buf.unread > 0 ? unreadBadge(buf.unread) : undefined,
            badgeColor: buf.hasMention ? theme.red : theme.accent,
            onSelect: () => onSelectBuffer(s.id, bufName),
          },
        });
      }
    }

    candidates.sort((a, b) => b.score - a.score);
    const found = candidates.map((x) => x.item);

    // A typed name that is a user, not a buffer: offer a DM with them, after the buffers.
    if (!channelOnly && q && !q.includes(" ")) {
      const lower = q.toLowerCase();
      for (const u of collectUsers(servers)) {
        if (u.hasDm || !u.nick.toLowerCase().includes(lower)) continue;
        found.push({
          id: `user-${u.serverId}:${u.nick.toLowerCase()}`,
          label: `@${u.nick}`,
          labelColor: nickColor(u.nick),
          detail: `user, ${u.serverName}`,
          onSelect: () => onOpenDm(u.serverId, u.nick),
        });
      }
    }
    const result = top(found);

    // "theme" or "color" typed: offer the theme list, after the buffers.
    if (!channelOnly && q.length >= 3 && "color theme".includes(q.toLowerCase())) {
      result.items.push(themeAction("theme-open"));
    }

    // If user typed #newchannel not yet joined, offer to join it
    if (channelOnly && q.length > 1 && !q.includes(" ") && activeServer) {
      const alreadyJoined = activeServer.bufferOrder.some((b) => sameNick(b, q));
      if (!alreadyJoined) {
        result.items.push({
          id: `join-${q}`,
          label: `+ Join ${q}`,
          labelColor: theme.green,
          detail: activeServer.name,
          onSelect: () => onRunCommand(`/join ${q}`),
        });
      }
    }

    return result;
  }, [
    mode,
    themes,
    themeId,
    onChooseTheme,
    // Rows carry theme colors, so rebuild them while a theme is previewed.
    themeVersion,
    query,
    servers,
    active,
    activeServer,
    recentKeys,
    onSelectBuffer,
    onOpenDm,
    onRunCommand,
    onToggleSidebar,
    onToggleNicklist,
  ]);

  useEffect(() => {
    setSelectedId(null);
  }, [query]);

  const foundIndex = items.findIndex((item) => item.id === selectedId);
  // The theme list opens on the theme in use.
  const startIndex =
    mode === "theme" && !query ? Math.max(0, items.findIndex((i) => i.themeId === themeId)) : 0;
  const selectedIndex = foundIndex === -1 ? startIndex : foundIndex;

  // Preview the selected theme. When the omnibox closes without a choice
  // (Esc, Ctrl+K, a buffer chosen elsewhere), go back to the theme in use.
  const previewThemeId = mode === "theme" ? items[selectedIndex]?.themeId : undefined;
  useEffect(() => {
    if (previewThemeId) onPreviewTheme(previewThemeId);
  }, [previewThemeId, onPreviewTheme]);
  const restoreRef = useRef(() => onPreviewTheme(themeId));
  restoreRef.current = () => onPreviewTheme(themeId);
  useEffect(
    () => () => {
      if (previewedRef.current && !chosenRef.current) restoreRef.current();
    },
    [],
  );
  if (previewThemeId) previewedRef.current = true;
  // Several keys can arrive before React re-renders, so each move starts from the
  // previous move's result (the updater's `prev`), not from this render's selection.
  const itemsRef = useRef(items);
  itemsRef.current = items;
  // Where the highlight is when nothing was selected yet (the current theme in the theme list).
  const startIndexRef = useRef(startIndex);
  startIndexRef.current = startIndex;
  const moveSelection = (delta: 1 | -1) => {
    setSelectedId((prev) => {
      const list = itemsRef.current;
      if (list.length === 0) return prev;
      const found = list.findIndex((item) => item.id === prev);
      const at = found === -1 ? startIndexRef.current : found;
      return list[(at + delta + list.length) % list.length]?.id ?? null;
    });
  };

  useKeyboard((key) => {
    if (key.name === "escape") {
      onClose();
      return;
    }
    if (key.name === "down" || (key.ctrl && key.name === "n")) {
      moveSelection(1);
      return;
    }
    if (key.name === "up" || (key.ctrl && key.name === "p")) {
      moveSelection(-1);
      return;
    }
  });

  const modalWidth = Math.min(64, Math.max(36, width - 6));
  const leftOffset = Math.max(0, Math.floor((width - modalWidth) / 2));
  // Border (2), the selection marker and its space (2), right padding (1).
  const rowWidth = modalWidth - 5;

  const select = (item: OmniboxItem | undefined) => {
    item?.onSelect();
    if (!item?.keepOpen) onClose();
  };
  const executeSelected = () => select(items[selectedIndex]);

  // The theme list can be long: show a window of rows that keeps the selection
  // in view.
  const windowStart =
    mode === "theme"
      ? Math.min(
          Math.max(0, selectedIndex - Math.floor(MAX_RESULTS / 2)),
          Math.max(0, items.length - MAX_RESULTS),
        )
      : 0;
  const visible = mode === "theme" ? items.slice(windowStart, windowStart + MAX_RESULTS) : items;

  return (
    <box
      position="absolute"
      top={1}
      left={leftOffset}
      width={modalWidth}
      zIndex={100}
      flexDirection="column"
      backgroundColor={theme.bgOverlay}
      border
      borderStyle="rounded"
      borderColor={theme.borderOverlay}
    >
      {/* Input row */}
      <box
        height={1}
        paddingLeft={1}
        paddingRight={1}
        backgroundColor={theme.bgInput}
        flexDirection="row"
      >
        <text fg={theme.accent}>
          <strong>❯ </strong>
        </text>
        <input
          flexGrow={1}
          focused
          value={query}
          placeholder={
            mode === "theme"
              ? "Color theme (Up/Down to preview, Enter to keep, Esc to cancel)"
              : "Jump to buffer… (> actions, / commands, @ users, ? help)"
          }
          backgroundColor={theme.bgInput}
          textColor={theme.fgBright}
          // Set these too: the input copies them once, when it is created.
          focusedBackgroundColor={theme.bgInput}
          focusedTextColor={theme.fgBright}
          placeholderColor={theme.fgMuted}
          onInput={setQuery}
          onSubmit={executeSelected}
        />
      </box>

      {/* Results list */}
      <box flexDirection="column" paddingTop={1} paddingBottom={0}>
        {items.length === 0 ? (
          <box height={1} paddingLeft={2}>
            <text fg={theme.fgMuted}>No matching results</text>
          </box>
        ) : (
          visible.map((item, row) => {
            const isSel = windowStart + row === selectedIndex;
            const { label, detail } = fitRow(item, rowWidth);
            return (
              <box
                key={item.id}
                height={1}
                paddingRight={1}
                flexDirection="row"
                justifyContent="space-between"
                backgroundColor={isSel ? theme.bgOverlaySel : theme.bgOverlay}
                onMouseDown={() => select(item)}
              >
                <text>
                  <span fg={isSel ? theme.accent : theme.bgOverlay}>
                    {isSel ? "▎" : " "}
                  </span>
                  <span fg={item.labelColor ?? theme.fgPrimary}>
                    {" "}
                    {isSel ? <strong>{label}</strong> : label}
                  </span>
                </text>

                <text>
                  {detail ? <span fg={theme.fgMuted}>{detail}</span> : null}
                  {item.hint ? (
                    <span fg={theme.cyan}> {item.hint}</span>
                  ) : null}
                  {item.badge ? (
                    <span fg={item.badgeColor ?? theme.accent}>
                      {" "}
                      <strong>{item.badge}</strong>
                    </span>
                  ) : null}
                </text>
              </box>
            );
          })
        )}
        {more > 0 ? (
          <box height={1} paddingLeft={2}>
            <text fg={theme.fgMuted}>{`${more} more, type to narrow the list`}</text>
          </box>
        ) : null}
        {mode === "theme" && items.length > MAX_RESULTS ? (
          <box height={1} paddingLeft={2}>
            <text fg={theme.fgMuted}>{`${selectedIndex + 1} of ${items.length}`}</text>
          </box>
        ) : null}
      </box>
    </box>
  );
}
