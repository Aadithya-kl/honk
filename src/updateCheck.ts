// The "a new honk is available" notice. At most once a day, honk asks GitHub
// for the latest release tag in the background, and keeps the answer in
// ~/.cache/honk/update-check.json. It never downloads anything: `honk upgrade`
// does that when the user runs it.

import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { UpdateNotice } from "./types.ts";
import { compareVersions, defaultReceiptPath, latestRelease, readReceipt, REPO } from "./upgrade.ts";
import { VERSION } from "./version.ts";

export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 5000;

interface UpdateCache {
  /** When GitHub last answered, in milliseconds since 1970. */
  checkedAt: number;
  /** The latest release tag at that time, such as "v0.3.0". */
  latest: string;
}

export interface UpdateCheckOptions {
  /** The running version, such as "v0.2.0". */
  version: string;
  cachePath: string;
  /** "https://github.com". Tests pass a local server. */
  githubUrl: string;
  now: () => number;
  timeoutMs: number;
  /** True when `honk upgrade` can replace this copy, so the notice can suggest it. */
  upgradeable: () => boolean;
  /** Gets the notice for the status bar, and the lines for *status. */
  notify: (update: UpdateNotice, lines: string[]) => void;
}

export function defaultCachePath(env: NodeJS.ProcessEnv = process.env): string {
  // Like ${XDG_CACHE_HOME:-...} in sh: an empty value counts as unset.
  const cacheHome = env.XDG_CACHE_HOME || join(homedir(), ".cache");
  return join(cacheHome, "honk", "update-check.json");
}

/** The reason not to check, or undefined to check. */
export function updateCheckDisabled(
  env: NodeJS.ProcessEnv,
  version: string,
  args: string[],
): string | undefined {
  if (version === "dev") return "not a release build";
  if (env.HONK_NO_UPDATE_CHECK) return "HONK_NO_UPDATE_CHECK is set";
  if (env.CI) return "CI is set";
  if (args.includes("--demo")) return "the offline demo sends nothing over the network";
  return undefined;
}

/** Returns the cache, or undefined when it is missing or not in the expected form. */
export function readCache(path: string): UpdateCache | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<UpdateCache> | null;
    if (typeof parsed?.checkedAt === "number" && typeof parsed.latest === "string") {
      return { checkedAt: parsed.checkedAt, latest: parsed.latest };
    }
  } catch {
    // Missing or broken: check again, and the write below replaces it.
  }
  return undefined;
}

function writeCache(path: string, cache: UpdateCache): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.new`;
    writeFileSync(tmp, `${JSON.stringify(cache)}\n`);
    renameSync(tmp, path);
  } catch {
    // A cache we cannot write only means we check again at the next start.
  }
}

/** The GitHub page with the release notes of `tag`. */
export function releaseNotesUrl(tag: string): string {
  return `https://github.com/${REPO}/releases/tag/${encodeURIComponent(tag)}`;
}

/**
 * The lines for *status: what to do, and where to read what changed. The link
 * has its own line, so it does not wrap in the middle of the sentence.
 */
export function noticeLines(current: string, latest: string, upgradeable: boolean): string[] {
  const how = upgradeable ? "Run: honk upgrade" : "Update it the way you installed it.";
  return [
    `honk ${latest} is available (you have ${current}). ${how}`,
    `What's new in ${latest}: ${releaseNotesUrl(latest)}`,
  ];
}

/**
 * Notifies when a newer release exists. A cache younger than a day answers
 * without a request. Otherwise it asks GitHub. When that fails (offline, or a
 * timeout), it falls back to the old cache, and asks again at the next start.
 * It never throws.
 */
export async function checkForUpdate(o: UpdateCheckOptions): Promise<void> {
  const cache = readCache(o.cachePath);
  const age = cache ? o.now() - cache.checkedAt : Infinity;
  // A negative age means the clock went back, so the cache cannot be trusted.
  let latest = cache && age >= 0 && age < CHECK_INTERVAL_MS ? cache.latest : undefined;

  if (latest === undefined) {
    try {
      latest = await latestRelease(o.githubUrl, AbortSignal.timeout(o.timeoutMs));
      writeCache(o.cachePath, { checkedAt: o.now(), latest });
    } catch {
      latest = cache?.latest;
    }
  }

  // compareVersions gives NaN for a tag it cannot read, and NaN > 0 is false,
  // so an odd tag never shows a notice.
  if (latest !== undefined && compareVersions(latest, o.version) > 0) {
    const upgradeable = o.upgradeable();
    o.notify({ latest, upgradeable }, noticeLines(o.version, latest, upgradeable));
  }
}

/** True when the install receipt names this binary, the same test `honk upgrade` makes. */
function installedByScript(): boolean {
  try {
    return readReceipt(defaultReceiptPath()) === realpathSync(process.execPath);
  } catch {
    return false;
  }
}

/** Starts the check in the background for this binary. It never blocks or throws. */
export function startUpdateCheck(notify: UpdateCheckOptions["notify"]): void {
  if (updateCheckDisabled(process.env, VERSION, process.argv.slice(2))) return;
  void checkForUpdate({
    version: VERSION,
    cachePath: defaultCachePath(),
    githubUrl: "https://github.com",
    now: Date.now,
    timeoutMs: TIMEOUT_MS,
    upgradeable: installedByScript,
    notify,
  });
}
