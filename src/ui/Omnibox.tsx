import { useKeyboard } from "@opentui/react";
import { useEffect, useMemo, useState } from "react";
import { nickColor, theme } from "../theme.ts";
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
  /** Keep the omnibox open after selecting (used by the "?" help items). */
  keepOpen?: boolean;
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
}

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
}: OmniboxProps) {
  const [query, setQuery] = useState("");
  // The selected item's id, not its row: the list is rebuilt when buffers or unread
  // counts change, and a row number would then point at another item or past the end.
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const activeServer = active
    ? servers.find((s) => s.id === active.serverId)
    : servers[0];

  const items = useMemo<OmniboxItem[]>(() => {
    const trimmed = query.trimStart();

    // ? — VS Code-style mode help
    if (trimmed === "?") {
      return [
        {
          id: "help-buffers",
          label: "(no prefix)",
          labelColor: theme.accent,
          detail: "Quick open channels & DMs across all servers",
          onSelect: () => setQuery(""),
          keepOpen: true,
        },
        {
          id: "help-cmd",
          label: ">",
          labelColor: theme.yellow,
          detail: "Run a command (sidebar, users, clear, disconnect, quit…)",
          onSelect: () => setQuery(">"),
          keepOpen: true,
        },
        {
          id: "help-users",
          label: "@",
          labelColor: theme.accentAlt,
          detail: "Find a user and open a DM",
          onSelect: () => setQuery("@"),
          keepOpen: true,
        },
        {
          id: "help-channels",
          label: "#",
          labelColor: theme.cyan,
          detail: "Filter channels or join a new #channel",
          onSelect: () => setQuery("#"),
          keepOpen: true,
        },
      ];
    }

    // > — Command Palette mode
    if (trimmed.startsWith(">")) {
      const q = trimmed.slice(1).trim();
      const commands: OmniboxItem[] = [
        {
          id: "cmd-sidebar",
          label: "View: Toggle Sidebar",
          hint: "^B",
          onSelect: () => onToggleSidebar(),
        },
        {
          id: "cmd-nicklist",
          label: "View: Toggle User List",
          hint: "^U",
          onSelect: () => onToggleNicklist(),
        },
        {
          id: "cmd-clear",
          label: "Chat: Clear Active Buffer",
          detail: active?.buffer,
          onSelect: () => onRunCommand("/clear"),
        },
        ...(activeServer && active && activeServer.buffers[active.buffer]?.kind === "channel"
          ? [
              {
                id: "cmd-part",
                label: `Channel: Part ${active.buffer}`,
                detail: activeServer.name,
                onSelect: () => onRunCommand(`/part ${active.buffer}`),
              },
            ]
          : []),
        ...(activeServer?.config.host
          ? [
              {
                id: "cmd-reconnect",
                label: `Server: Reconnect ${activeServer.name}`,
                onSelect: () => onRunCommand("/connect"),
              },
              {
                id: "cmd-disconnect",
                label: `Server: Disconnect ${activeServer.name}`,
                onSelect: () => onRunCommand("/disconnect"),
              },
            ]
          : []),
        {
          id: "cmd-help",
          label: "IRC: Show Slash Commands",
          detail: "/help",
          onSelect: () => onRunCommand("/help"),
        },
        {
          id: "cmd-quit",
          label: "App: Quit",
          hint: "^C",
          onSelect: () => onRunCommand("/quit"),
        },
      ];

      const scored = commands
        .map((item) => ({
          item,
          score: fuzzyScore(q, `${item.label} ${item.detail ?? ""}`),
        }))
        .filter((x) => x.score >= 0)
        .sort((a, b) => b.score - a.score)
        .map((x) => x.item);

      // If user typed a slash command like "> /connect ..."
      if (q.startsWith("/")) {
        scored.unshift({
          id: `cmd-raw-${q}`,
          label: `Run ${q}`,
          labelColor: theme.cyan,
          onSelect: () => onRunCommand(q),
        });
      }

      return scored.slice(0, 10);
    }

    // @ — User / DM switcher mode
    if (trimmed.startsWith("@")) {
      const q = trimmed.slice(1).trim();
      const seen = new Set<string>();
      const users: { serverId: string; serverName: string; nick: string; score: number }[] = [];

      for (const s of servers) {
        for (const bufName of s.bufferOrder) {
          const buf = s.buffers[bufName];
          if (!buf) continue;
          const myLower = s.nick.toLowerCase();
          for (const u of buf.users) {
            if (u.nick.toLowerCase() === myLower) continue;
            const key = `${s.id}:${u.nick.toLowerCase()}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const score = fuzzyScore(q, `${u.nick} ${s.name}`);
            if (score < 0) continue;
            users.push({ serverId: s.id, serverName: s.name, nick: u.nick, score });
          }
        }
      }

      users.sort((a, b) => b.score - a.score);
      const list = users.slice(0, 10).map(
        (u): OmniboxItem => ({
          id: `user-${u.serverId}:${u.nick.toLowerCase()}`,
          label: `@${u.nick}`,
          labelColor: nickColor(u.nick),
          detail: u.serverName,
          onSelect: () => onOpenDm(u.serverId, u.nick),
        }),
      );

      if (q && activeServer && !q.includes(" ")) {
        const exact = list.some(
          (i) => i.label.toLowerCase() === `@${q.toLowerCase()}`,
        );
        if (!exact) {
          list.push({
            id: `dm-new-${q}`,
            label: `Message @${q}`,
            labelColor: theme.accentAlt,
            detail: activeServer.name,
            onSelect: () => onOpenDm(activeServer.id, q),
          });
        }
      }
      return list;
    }

    // Default (or #) — Quick Open buffers across all servers
    const channelOnly = trimmed.startsWith("#");
    const q = trimmed;
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

        // Boost mentions, unreads, and recently visited buffers when query is empty
        let boost = 0;
        if (!q) {
          if (buf.hasMention) boost += 400;
          else if (buf.unread > 0) boost += 200 + Math.min(buf.unread, 50);
          const recIdx = recentKeys.indexOf(key);
          if (recIdx !== -1) boost += 100 - recIdx;
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
    const list = candidates.slice(0, 10).map((x) => x.item);

    // If user typed #newchannel not yet joined, offer to join it
    if (channelOnly && q.length > 1 && !q.includes(" ") && activeServer) {
      const alreadyJoined = Boolean(activeServer.buffers[q]);
      if (!alreadyJoined) {
        list.push({
          id: `join-${q}`,
          label: `+ Join ${q}`,
          labelColor: theme.green,
          detail: activeServer.name,
          onSelect: () => onRunCommand(`/join ${q}`),
        });
      }
    }

    return list;
  }, [
    query,
    servers,
    active,
    activeServer,
    recentKeys,
    onClose,
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
  const selectedIndex = foundIndex === -1 ? 0 : foundIndex;
  const moveSelection = (delta: 1 | -1) => {
    if (items.length === 0) return;
    const next = items[(selectedIndex + delta + items.length) % items.length];
    setSelectedId(next?.id ?? null);
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

  const select = (item: OmniboxItem | undefined) => {
    item?.onSelect();
    if (!item?.keepOpen) onClose();
  };
  const executeSelected = () => select(items[selectedIndex]);

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
          placeholder="Jump to buffer… (> commands, @ users, # join, ? help)"
          backgroundColor={theme.bgInput}
          textColor={theme.fgBright}
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
          items.map((item, idx) => {
            const isSel = idx === selectedIndex;
            const maxLabel = modalWidth - 20;
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
                    {isSel ? (
                      <strong>{truncate(item.label, maxLabel)}</strong>
                    ) : (
                      truncate(item.label, maxLabel)
                    )}
                  </span>
                </text>

                <text>
                  {item.detail ? (
                    <span fg={theme.fgMuted}>{item.detail}</span>
                  ) : null}
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
      </box>
    </box>
  );
}
