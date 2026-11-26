import { memo } from "react";
import { nickColor, prefixColor, theme, useThemeVersion } from "../theme.ts";
import type { BufferState } from "../types.ts";
import { HEADER_HEIGHT, scrollboxStyle, truncate } from "./display.ts";

interface NicklistProps {
  users: BufferState["users"];
  myNick: string;
  onSelectUser: (nick: string) => void;
}

/** Memoized: only re-renders when this buffer's user list, the nick, the handler or the theme changes. */
export const Nicklist = memo(function Nicklist({
  users,
  myNick,
  onSelectUser,
}: NicklistProps) {
  useThemeVersion();
  const myLower = myNick.toLowerCase();

  return (
    <box
      flexDirection="column"
      width={20}
      height="100%"
      backgroundColor={theme.bgNicklist}
    >
      <box
        height={HEADER_HEIGHT}
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
        paddingRight={1}
        backgroundColor={theme.bgNicklist}
      >
        <text fg={theme.fgMuted}>
          <strong>USERS ({users.length})</strong>
        </text>
      </box>

      <scrollbox
        flexGrow={1}
        scrollX={false}
        style={scrollboxStyle(theme.bgNicklist)}
      >
        <box flexDirection="column" paddingBottom={1}>
          {users.length === 0 ? (
            <box paddingLeft={2}>
              <text fg={theme.fgDim}>No users</text>
            </box>
          ) : (
            users.map((u) => {
              const isSelf = u.nick.toLowerCase() === myLower;
              const color = isSelf ? theme.accent : nickColor(u.nick);
              return (
                <box
                  key={u.nick}
                  height={1}
                  paddingLeft={1}
                  paddingRight={1}
                  onMouseDown={() => {
                    if (!isSelf) onSelectUser(u.nick);
                  }}
                >
                  <text>
                    <span fg={prefixColor(u.prefix)}>
                      {u.prefix ? u.prefix : " "}
                    </span>
                    <span fg={color}>
                      {isSelf ? (
                        <strong>{truncate(u.nick, 16)}</strong>
                      ) : (
                        truncate(u.nick, 16)
                      )}
                    </span>
                  </text>
                </box>
              );
            })
          )}
        </box>
      </scrollbox>
    </box>
  );
});
