import type { ChatMessage, NickEntry } from "../types.ts";

const SLASH_COMMANDS = [
  "connect",
  "disconnect",
  "join",
  "part",
  "msg",
  "query",
  "me",
  "nick",
  "topic",
  "whois",
  "raw",
  "clear",
  "demo",
  "history",
  "help",
  "quit",
] as const;

interface CompletionContext {
  users: NickEntry[];
  messages: ChatMessage[];
  channels: string[];
  myNick: string;
}

function isFuzzyMatch(query: string, target: string): boolean {
  let qi = 0;
  for (let ti = 0; ti < target.length && qi < query.length; ti++) {
    if (target[ti] === query[qi]) qi++;
  }
  return qi === query.length;
}

/**
 * Ranks candidates:
 *  1. Prefix matches (prioritizing recent speakers when provided)
 *  2. Substring matches
 *  3. Fuzzy subsequence matches
 */
function rankCandidates(
  query: string,
  candidates: string[],
  recentOrder?: Map<string, number>,
): string[] {
  const sortBucket = (arr: string[]) =>
    arr.sort((a, b) => {
      const ra = recentOrder?.get(a.toLowerCase()) ?? Number.POSITIVE_INFINITY;
      const rb = recentOrder?.get(b.toLowerCase()) ?? Number.POSITIVE_INFINITY;
      if (ra !== rb) return ra - rb;
      return a.localeCompare(b);
    });

  const q = query.toLowerCase();
  if (!q) return sortBucket([...candidates]);

  const prefix: string[] = [];
  const substr: string[] = [];
  const fuzzy: string[] = [];

  for (const c of candidates) {
    const lower = c.toLowerCase();
    if (lower.startsWith(q)) {
      prefix.push(c);
    } else if (lower.includes(q)) {
      substr.push(c);
    } else if (isFuzzyMatch(q, lower)) {
      fuzzy.push(c);
    }
  }

  return [...sortBucket(prefix), ...sortBucket(substr), ...sortBucket(fuzzy)];
}

/**
 * Computes full-line replacement candidates for the trailing token in `input`.
 */
export function getCompletions(
  input: string,
  ctx: CompletionContext,
): string[] {
  // Don't complete if input ends with whitespace
  if (!input || /\s$/.test(input)) return [];

  const lastSpace = input.lastIndexOf(" ");
  const before = lastSpace === -1 ? "" : input.slice(0, lastSpace + 1);
  const token = lastSpace === -1 ? input : input.slice(lastSpace + 1);
  if (!token) return [];

  // 1. Slash command at start of line
  if (before === "" && token.startsWith("/")) {
    const q = token.slice(1);
    const matches = rankCandidates(q, [...SLASH_COMMANDS]);
    return matches.map((cmd) => `/${cmd} `);
  }

  // 2. Channel name (#...)
  if (token.startsWith("#")) {
    const matches = rankCandidates(token, ctx.channels);
    return matches.map((ch) => `${before}${ch} `);
  }

  // 3. Nick completion (channel users + recent speakers, excluding self)
  const myLower = ctx.myNick.toLowerCase();
  const recentOrder = new Map<string, number>();
  let rank = 0;
  for (let i = ctx.messages.length - 1; i >= 0; i--) {
    const from = ctx.messages[i]!.from;
    if (!from) continue;
    const lower = from.toLowerCase();
    if (lower === myLower || recentOrder.has(lower)) continue;
    recentOrder.set(lower, rank++);
  }

  const nickMap = new Map<string, string>();
  for (const u of ctx.users) {
    const lower = u.nick.toLowerCase();
    if (lower !== myLower) nickMap.set(lower, u.nick);
  }
  for (let i = ctx.messages.length - 1; i >= 0; i--) {
    const from = ctx.messages[i]!.from;
    if (!from) continue;
    const lower = from.toLowerCase();
    if (lower !== myLower && !nickMap.has(lower)) {
      nickMap.set(lower, from);
    }
  }

  const matches = rankCandidates(token, [...nickMap.values()], recentOrder);
  const suffix = before === "" ? ": " : " ";
  return matches.map((nick) => `${before}${nick}${suffix}`);
}
