/**
 * What honk remembers between runs that is not a setting: which omnibox actions you used
 * last, so they rank first among equal matches (see Omnibox.rankActions). It lives apart
 * from the config, which you edit by hand:
 *
 *   $XDG_STATE_HOME/honk/state.json, or ~/.local/state/honk/state.json
 *
 *   { "version": 1, "recentActions": { "cmd-clear": 3, "cmd-theme": 2, "cmd-reconnect": 1 } }
 *
 * A missing or broken file means no history. Nothing here ever stops honk.
 */
import { mkdir, rename, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface HonkState {
  /** Action key -> when it was last used: 1 is the oldest, higher is more recent. */
  recentActions: Record<string, number>;
}

/** The most actions remembered. VS Code keeps 50 too. */
export const MAX_RECENT_ACTIONS = 50;

export function defaultStatePath(env: Record<string, string | undefined> = process.env): string {
  const base = env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  return join(base, "honk", "state.json");
}

export function emptyState(): HonkState {
  return { recentActions: {} };
}

/** The state in `path`, or an empty one if the file is missing or not what honk wrote. */
export function loadState(path: string): HonkState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return emptyState();
  }
  const recent = (parsed as { recentActions?: unknown } | null)?.recentActions;
  if (!recent || typeof recent !== "object" || Array.isArray(recent)) return emptyState();
  const entries = Object.entries(recent).filter(
    (e): e is [string, number] => typeof e[1] === "number" && Number.isFinite(e[1]),
  );
  return { recentActions: renumber(entries) };
}

/**
 * `recent` with `key` as the most recent action. Only the newest MAX_RECENT_ACTIONS stay,
 * numbered 1 to n, so the numbers never grow.
 */
export function withActionUsed(
  recent: Readonly<Record<string, number>>,
  key: string,
): Record<string, number> {
  const others = Object.entries(recent).filter(([k]) => k !== key);
  return renumber([...others, [key, Number.POSITIVE_INFINITY]]);
}

/** Oldest first, then numbered 1 to n, keeping the newest MAX_RECENT_ACTIONS. */
function renumber(entries: [string, number][]): Record<string, number> {
  const newest = entries.sort((a, b) => a[1] - b[1]).slice(-MAX_RECENT_ACTIONS);
  return Object.fromEntries(newest.map(([k], i) => [k, i + 1]));
}

/**
 * Writes the state to `path`, creating its folder. It writes a temporary file and renames
 * it, so a crash mid-write leaves the old file whole.
 */
export async function saveState(path: string, state: HonkState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify({ version: 1, ...state }, null, 2)}\n`);
  await rename(tmp, path);
}
