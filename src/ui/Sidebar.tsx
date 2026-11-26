import { STATUS_BUFFER } from "../irc/names.ts";
import { theme } from "../theme.ts";
import type { ActiveBuffer, ServerState } from "../types.ts";
import {
  bufferDisplayName,
  scrollboxStyle,
  statusIndicator,
  truncate,
  unreadBadge,
} from "./display.ts";

interface SidebarProps {
  servers: ServerState[];
  active: ActiveBuffer | null;
  onSelect: (serverId: string, buffer: string) => void;
  onConnectServer: (serverId: string) => void;
}

export function Sidebar({
  servers,
  active,
  onSelect,
  onConnectServer,
}: SidebarProps) {
  return (
    <box
      flexDirection="column"
      width={24}
      height="100%"
      backgroundColor={theme.bgSidebar}
    >
      <box
        height={1}
        paddingLeft={2}
        paddingRight={1}
        backgroundColor={theme.bgHeader}
        alignItems="center"
      >
        <text fg={theme.fgMuted}>
          <strong>SERVERS</strong>
        </text>
      </box>

      <scrollbox
        flexGrow={1}
        scrollX={false}
        style={scrollboxStyle(theme.bgSidebar)}
      >
        {servers.map((server) => {
          const st = statusIndicator(server.status);
          return (
            <box key={server.id} flexDirection="column" marginTop={1}>
              {/* Server header */}
              <box
                height={1}
                paddingLeft={1}
                paddingRight={1}
                onMouseDown={() => {
                  onSelect(server.id, STATUS_BUFFER);
                  if (server.status === "disconnected" && server.config.host) {
                    onConnectServer(server.id);
                  }
                }}
              >
                <text>
                  <span fg={st.color}>{st.glyph} </span>
                  <span fg={theme.fgBright}>
                    <strong>{truncate(server.name, 19)}</strong>
                  </span>
                </text>
              </box>

              {/* Buffers under this server */}
              {server.bufferOrder.map((bufName) => {
                const buf = server.buffers[bufName];
                if (!buf) return null;
                const isActive =
                  active?.serverId === server.id && active?.buffer === bufName;
                const displayName = bufferDisplayName(buf);
                const maxNameLen = buf.unread > 0 ? 13 : 18;

                return (
                  <box
                    key={bufName}
                    height={1}
                    flexDirection="row"
                    justifyContent="space-between"
                    paddingRight={1}
                    backgroundColor={
                      isActive ? theme.bgActiveRow : theme.bgSidebar
                    }
                    onMouseDown={() => onSelect(server.id, bufName)}
                  >
                    <text>
                      <span fg={isActive ? theme.accent : theme.bgSidebar}>
                        {isActive ? "▎" : " "}
                      </span>
                      <span
                        fg={
                          isActive
                            ? theme.fgBright
                            : buf.hasMention
                              ? theme.red
                              : buf.unread > 0
                                ? theme.fgPrimary
                                : buf.kind === "status"
                                  ? theme.fgMuted
                                  : theme.fgSecondary
                        }
                      >
                        {" "}
                        {isActive ? (
                          <strong>{truncate(displayName, maxNameLen)}</strong>
                        ) : (
                          truncate(displayName, maxNameLen)
                        )}
                      </span>
                    </text>

                    {buf.unread > 0 && (
                      <text fg={buf.hasMention ? theme.red : theme.accent}>
                        <strong>{unreadBadge(buf.unread)}</strong>
                      </text>
                    )}
                  </box>
                );
              })}
            </box>
          );
        })}
      </scrollbox>
    </box>
  );
}
