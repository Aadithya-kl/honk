import {
  useKeyboard,
  useRenderer,
  useTerminalDimensions,
} from "@opentui/react";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { IrcManager } from "./irc/manager.ts";
import { STATUS_BUFFER } from "./irc/names.ts";
import { theme } from "./theme.ts";
import { ChatPane } from "./ui/ChatPane.tsx";
import { Nicklist } from "./ui/Nicklist.tsx";
import { Omnibox } from "./ui/Omnibox.tsx";
import { Sidebar } from "./ui/Sidebar.tsx";
import { StatusBar } from "./ui/StatusBar.tsx";

const NO_USERS: never[] = [];

interface AppProps {
  manager: IrcManager;
}

export function App({ manager }: AppProps) {
  const renderer = useRenderer();
  const { width } = useTerminalDimensions();
  const snapshot = useSyncExternalStore(manager.subscribe, manager.getSnapshot);

  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [nicklistOpen, setNicklistOpen] = useState(true);
  const [omniboxOpen, setOmniboxOpen] = useState(false);
  const [recentKeys, setRecentKeys] = useState<string[]>([]);

  useEffect(() => {
    if (!snapshot.active) return;
    const key = `${snapshot.active.serverId}:${snapshot.active.buffer}`;
    setRecentKeys((prev) => [key, ...prev.filter((k) => k !== key)].slice(0, 20));
  }, [snapshot.active?.serverId, snapshot.active?.buffer]);

  const quit = useCallback(() => {
    manager.disconnectAll();
    renderer.destroy();
    process.exit(0);
  }, [manager, renderer]);

  // Stable handlers, so memoized children (Nicklist, the Omnibox item list) skip work.
  const submit = useCallback(
    (value: string) => {
      if (manager.handleInput(value) === "quit") quit();
    },
    [manager, quit],
  );
  const selectBuffer = useCallback(
    (serverId: string, buf: string) => manager.setActive(serverId, buf),
    [manager],
  );
  const openDm = useCallback(
    (serverId: string, nick: string) => manager.openDm(serverId, nick),
    [manager],
  );
  const closeOmnibox = useCallback(() => setOmniboxOpen(false), []);
  const toggleSidebar = useCallback(() => setSidebarOpen((v) => !v), []);
  const toggleNicklist = useCallback(() => setNicklistOpen((v) => !v), []);

  useKeyboard((key) => {
    if (key.ctrl && key.name === "c") {
      quit();
      return;
    }
    if (key.ctrl && key.name === "k") {
      setOmniboxOpen((v) => !v);
      return;
    }
    if (omniboxOpen) return;

    if (key.ctrl && key.name === "b") {
      setSidebarOpen((v) => !v);
      return;
    }
    if (key.ctrl && key.name === "u") {
      setNicklistOpen((v) => !v);
      return;
    }
    if ((key.meta || key.option) && key.name === "up") {
      manager.cycleBuffer(-1);
      return;
    }
    if ((key.meta || key.option) && key.name === "down") {
      manager.cycleBuffer(1);
      return;
    }
    if (key.ctrl && key.name === "p") {
      manager.cycleBuffer(-1);
      return;
    }
    if (key.ctrl && key.name === "n") {
      manager.cycleBuffer(1);
    }
  });

  const activeServer = snapshot.active
    ? snapshot.servers.find((s) => s.id === snapshot.active!.serverId)
    : snapshot.servers[0];

  const activeBuffer =
    activeServer?.buffers[snapshot.active?.buffer ?? STATUS_BUFFER];
  const activeServerId = activeServer?.id;
  const selectUser = useCallback(
    (nick: string) => {
      if (activeServerId) manager.openDm(activeServerId, nick);
    },
    [manager, activeServerId],
  );

  const showSidebar = sidebarOpen && width >= 65;
  const showNicklist = nicklistOpen && width >= 90;
  const chatWidth =
    width - (showSidebar ? 24 : 0) - (showNicklist ? 20 : 0);

  return (
    <box
      flexDirection="column"
      width="100%"
      height="100%"
      backgroundColor={theme.bgBase}
    >
      <box flexDirection="row" flexGrow={1} width="100%">
        {showSidebar && (
          <Sidebar
            servers={snapshot.servers}
            active={snapshot.active}
            onSelect={selectBuffer}
            onConnectServer={(serverId) =>
              void manager.connectServer(serverId, { manual: true })
            }
          />
        )}

        <ChatPane
          server={activeServer}
          buffer={activeBuffer}
          inputFocused={!omniboxOpen}
          paneWidth={chatWidth}
          onSubmit={submit}
        />

        {showNicklist && (
          <Nicklist
            users={activeBuffer?.kind === "channel" ? activeBuffer.users : NO_USERS}
            myNick={activeServer?.nick ?? ""}
            onSelectUser={selectUser}
          />
        )}
      </box>

      <StatusBar server={activeServer} />

      {omniboxOpen && (
        <Omnibox
          servers={snapshot.servers}
          active={snapshot.active}
          recentKeys={recentKeys}
          width={width}
          onClose={closeOmnibox}
          onSelectBuffer={selectBuffer}
          onOpenDm={openDm}
          onRunCommand={submit}
          onToggleSidebar={toggleSidebar}
          onToggleNicklist={toggleNicklist}
        />
      )}
    </box>
  );
}
