import type { InputRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { memo, useRef, useState, type ReactNode } from "react";
import { sameNick, STATUS_BUFFER } from "../irc/names.ts";
import { nickColor, theme } from "../theme.ts";
import type { BufferState, ChatMessage, ServerState } from "../types.ts";
import { getCompletions } from "./completion.ts";
import { HEADER_HEIGHT, scrollboxStyle, truncate } from "./display.ts";
import { FormattedText } from "./format.tsx";

interface ChatPaneProps {
  server: ServerState | undefined;
  buffer: BufferState | undefined;
  inputFocused: boolean;
  paneWidth: number;
  onSubmit: (value: string) => void;
}

const NICK_COL_WIDTH = 12;
const BLANK_TIME = "     ";
const BLANK_NICK = " ".repeat(NICK_COL_WIDTH);
const GROUP_WINDOW_MS = 5 * 60_000;

function formatTime(date: Date): string {
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

function padNick(nick: string): string {
  return truncate(nick, NICK_COL_WIDTH).padStart(NICK_COL_WIDTH, " ");
}

function UnreadDivider({ paneWidth }: { paneWidth: number }) {
  const label = " new ";
  const innerWidth = Math.max(label.length + 4, paneWidth - 2);
  const sideTotal = Math.max(4, innerWidth - label.length);
  const left = Math.floor(sideTotal / 2);
  const right = sideTotal - left;
  return (
    <box width="100%" paddingLeft={1} paddingRight={1} marginTop={1} marginBottom={1}>
      <text>
        <span fg={theme.red}>{"─".repeat(left)}</span>
        <span fg={theme.red}>
          <strong>{label}</strong>
        </span>
        <span fg={theme.red}>{"─".repeat(right)}</span>
      </text>
    </box>
  );
}

/**
 * One chat line: time, a 12-column label, the gutter, then the body.
 * Memoized because message objects keep their identity across store updates,
 * so typing or a new line only renders the rows that changed.
 */
const MessageRow = memo(function MessageRow({
  msg,
  grouped,
}: {
  msg: ChatMessage;
  grouped: boolean;
}) {
  const sender = msg.from ?? "";
  const senderColor = msg.isSelf ? theme.accent : nickColor(sender);
  let label: ReactNode;
  let labelFg: string;
  let body: ReactNode;
  let bg: string | undefined;

  switch (msg.kind) {
    case "message":
      label = <strong>{padNick(sender)}</strong>;
      labelFg = senderColor;
      bg = msg.isMention ? theme.bgMention : theme.bgBase;
      body = (
        <FormattedText
          text={msg.text}
          defaultFg={msg.isMention ? theme.fgBright : theme.fgPrimary}
        />
      );
      break;
    case "action":
      label = padNick("*");
      labelFg = theme.accentAlt;
      bg = msg.isMention ? theme.bgMention : theme.bgBase;
      body = (
        <>
          <span fg={senderColor}>
            <em>{sender} </em>
          </span>
          <FormattedText text={msg.text} defaultFg={theme.accentAlt} forceItalic />
        </>
      );
      break;
    case "notice":
      label = padNick(`-${msg.from ?? "notice"}-`);
      labelFg = theme.yellow;
      body = <FormattedText text={msg.text} defaultFg={theme.yellow} />;
      break;
    case "error":
      label = padNick("!");
      labelFg = theme.red;
      body = <span fg={theme.red}>{msg.text}</span>;
      break;
    default: {
      // join, part, system
      label = padNick(msg.kind === "join" ? "→" : msg.kind === "part" ? "←" : "·");
      labelFg = theme.fgDim;
      const textColor = msg.kind === "system" ? theme.fgSecondary : theme.fgMuted;
      body = <span fg={textColor}>{msg.text}</span>;
    }
  }

  return (
    <box width="100%" paddingLeft={1} paddingRight={1} backgroundColor={bg}>
      <text>
        {grouped ? (
          <>
            <span fg={theme.fgDim}>{BLANK_TIME} </span>
            <span fg={theme.fgDim}>{BLANK_NICK}</span>
          </>
        ) : (
          <>
            <span fg={theme.fgMuted}>{formatTime(msg.timestamp)} </span>
            <span fg={labelFg}>{label}</span>
          </>
        )}
        <span fg={theme.gutter}> │ </span>
        {body}
      </text>
    </box>
  );
});

export function ChatPane({ server, buffer, inputFocused, paneWidth, onSubmit }: ChatPaneProps) {
  const inputRef = useRef<InputRenderable>(null);
  const [inputValue, setInputValue] = useState("");

  // Tab completion state
  const completionRef = useRef<{ matches: string[]; index: number } | null>(null);
  // Up/Down sent-message history
  const historyRef = useRef<string[]>([]);
  const historyIdxRef = useRef<number>(-1);
  const draftRef = useRef<string>("");
  // Guard so programmatic inputRef.current.value updates don't reset completion/history
  const programmaticRef = useRef(false);

  const setInputText = (next: string) => {
    programmaticRef.current = true;
    setInputValue(next);
    if (inputRef.current) {
      inputRef.current.value = next;
    }
    programmaticRef.current = false;
  };

  useKeyboard((key) => {
    if (!inputFocused) return;

    if (key.name === "tab") {
      const current = inputRef.current?.value ?? inputValue;
      const active = completionRef.current;

      if (active && active.matches[active.index] === current) {
        const delta = key.shift ? -1 : 1;
        const nextIdx =
          (active.index + delta + active.matches.length) % active.matches.length;
        active.index = nextIdx;
        setInputText(active.matches[nextIdx]!);
        return;
      }

      const channels = (server?.bufferOrder ?? []).filter(
        (b) => server?.buffers[b]?.kind === "channel",
      );
      const matches = getCompletions(current, {
        users: buffer?.users ?? [],
        messages: buffer?.messages ?? [],
        channels,
        myNick: server?.nick ?? "",
      });

      if (matches.length > 0) {
        completionRef.current = { matches, index: 0 };
        setInputText(matches[0]!);
      }
      return;
    }

    // Up/Down and Ctrl+P/Ctrl+N (as in readline) walk the sent-line history.
    const plain = !key.meta && !key.option && !key.ctrl && !key.shift;
    const historyUp = (key.name === "up" && plain) || (key.ctrl && key.name === "p");
    const historyDown = (key.name === "down" && plain) || (key.ctrl && key.name === "n");

    if (historyUp) {
      const hist = historyRef.current;
      if (hist.length === 0) return;
      completionRef.current = null;
      if (historyIdxRef.current === -1) {
        draftRef.current = inputRef.current?.value ?? inputValue;
        historyIdxRef.current = hist.length - 1;
      } else if (historyIdxRef.current > 0) {
        historyIdxRef.current -= 1;
      }
      setInputText(hist[historyIdxRef.current]!);
      return;
    }

    if (historyDown) {
      const hist = historyRef.current;
      if (historyIdxRef.current === -1) return;
      completionRef.current = null;
      if (historyIdxRef.current < hist.length - 1) {
        historyIdxRef.current += 1;
        setInputText(hist[historyIdxRef.current]!);
      } else {
        historyIdxRef.current = -1;
        setInputText(draftRef.current);
      }
    }
  });

  const title = buffer ? buffer.name : STATUS_BUFFER;
  // Cut at the end to fit beside the title and the user count (2 + 2 padding,
  // " — ", and the count with its margin). Formatting codes count as characters,
  // so a coloured topic may be cut a little early.
  const usersText = buffer?.kind === "channel" ? `${buffer.users.length} users` : "";
  const topicRoom =
    paneWidth - 4 - (buffer?.name ?? STATUS_BUFFER).length - 3 - (usersText ? usersText.length + 2 : 0);
  const topic = topicRoom >= 4 ? truncate(buffer?.topic ?? "", topicRoom) : "";
  const promptLabel = server
    ? `${server.name}/${title}`
    : title;

  const handleInput = (val: string) => {
    setInputValue(val);
    if (!programmaticRef.current) {
      completionRef.current = null;
      historyIdxRef.current = -1;
    }
  };

  const handleSubmit = (val: string) => {
    const text = val || inputValue;
    if (!text.trim()) return;
    const hist = historyRef.current;
    if (hist[hist.length - 1] !== text) {
      hist.push(text);
      if (hist.length > 100) hist.shift();
    }
    historyIdxRef.current = -1;
    draftRef.current = "";
    completionRef.current = null;
    onSubmit(text);
    setInputText("");
  };

  return (
    <box
      flexDirection="column"
      flexGrow={1}
      height="100%"
      backgroundColor={theme.bgBase}
    >
      {/* Top topic header */}
      <box
        height={HEADER_HEIGHT}
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
        paddingRight={2}
        backgroundColor={theme.bgBase}
        flexDirection="row"
        justifyContent="space-between"
      >
        <text flexShrink={1} wrapMode="none">
          <span fg={theme.accent}>
            <strong>{title}</strong>
          </span>
          {topic ? (
            <>
              <span fg={theme.fgMuted}> — </span>
              <FormattedText text={topic} defaultFg={theme.fgMuted} />
            </>
          ) : null}
        </text>
        {buffer?.kind === "channel" && (
          <text fg={theme.fgMuted} flexShrink={0} marginLeft={2}>
            {usersText}
          </text>
        )}
      </box>

      {/* Scrollable message feed */}
      <scrollbox
        flexGrow={1}
        stickyScroll
        stickyStart="bottom"
        scrollX={false}
        style={scrollboxStyle(theme.bgBase)}
      >
        {/* No top padding: the header's own bottom padding is the gap. */}
        <box flexDirection="column" paddingBottom={1}>
          {buffer?.messages.map((msg, idx) => {
            const showDivider = msg.id === buffer.firstUnreadId;
            const prev = idx > 0 ? buffer.messages[idx - 1] : undefined;
            const grouped =
              !showDivider &&
              msg.kind === "message" &&
              prev?.kind === "message" &&
              sameNick(prev.from, msg.from) &&
              msg.timestamp.getTime() - prev.timestamp.getTime() < GROUP_WINDOW_MS;

            return (
              <box key={msg.id} flexDirection="column" width="100%">
                {showDivider && <UnreadDivider paneWidth={paneWidth} />}
                <MessageRow msg={msg} grouped={grouped} />
              </box>
            );
          })}
        </box>
      </scrollbox>

      {/* Shaded prompt input bar */}
      <box
        height={3}
        paddingLeft={2}
        paddingRight={2}
        paddingTop={1}
        backgroundColor={theme.bgInput}
        flexDirection="row"
        alignItems="flex-start"
      >
        <text>
          <span fg={theme.accent}>
            <strong>{promptLabel}</strong>
          </span>
          <span fg={theme.cyan}> ❯ </span>
        </text>
        <input
          ref={inputRef}
          flexGrow={1}
          focused={inputFocused}
          value={inputValue}
          placeholder="Message or /help..."
          backgroundColor={theme.bgInput}
          textColor={theme.fgBright}
          placeholderColor={theme.fgMuted}
          onInput={handleInput}
          onSubmit={handleSubmit}
        />
      </box>
    </box>
  );
}
