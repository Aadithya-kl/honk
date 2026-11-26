import { useEffect, useState } from "react";
import { theme } from "../theme.ts";
import type { ServerState } from "../types.ts";
import { statusIndicator } from "./display.ts";

interface StatusBarProps {
  server: ServerState | undefined;
}

export function StatusBar({ server }: StatusBarProps) {
  const [now, setNow] = useState(() => Date.now());
  const isReconnecting =
    server?.status === "reconnecting" && Boolean(server.reconnectInfo);

  useEffect(() => {
    if (!isReconnecting) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [isReconnecting, server?.reconnectInfo?.nextRetryAt]);

  const status = server?.status ?? "disconnected";
  const dot = statusIndicator(status);

  const retrySeconds =
    isReconnecting && server?.reconnectInfo
      ? Math.max(0, Math.ceil((server.reconnectInfo.nextRetryAt - now) / 1000))
      : 0;

  return (
    <box
      height={2}
      width="100%"
      paddingTop={1}
      paddingLeft={2}
      paddingRight={2}
      backgroundColor={theme.bgFooter}
      flexDirection="row"
      justifyContent="space-between"
    >
      <text>
        <span fg={dot.color}>{dot.glyph} </span>
        <span fg={theme.fgPrimary}>
          <strong>{server?.name ?? "disconnected"}</strong>
        </span>
        {server?.via && (
          <span fg={theme.fgMuted}>
            {" "}via <span fg={theme.accentAlt}>{server.via}</span>
          </span>
        )}
        {server?.tls && <span fg={theme.cyan}> TLS</span>}
        {isReconnecting && server?.reconnectInfo ? (
          <span fg={theme.yellow}>
            {"  "}reconnecting in {retrySeconds}s (attempt{" "}
            {server.reconnectInfo.attempt})
          </span>
        ) : status === "connecting" ? (
          <span fg={theme.yellow}>{"  "}connecting…</span>
        ) : (
          server?.nick && (
            <span fg={theme.fgMuted}>
              {"  "}nick: <span fg={theme.fgSecondary}>{server.nick}</span>
            </span>
          )
        )}
      </text>

      <text fg={theme.fgMuted}>
        <span fg={theme.accent}>^K</span> omnibox{"  "}
        <span fg={theme.accent}>^B</span> sidebar{"  "}
        <span fg={theme.accent}>^U</span> users{"  "}
        <span fg={theme.accent}>Alt+↑/↓</span> switch{"  "}
        <span fg={theme.accent}>^C</span> quit
      </text>
    </box>
  );
}
