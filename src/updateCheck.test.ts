import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CHECK_INTERVAL_MS,
  checkForUpdate,
  defaultCachePath,
  noticeLines,
  readCache,
  updateCheckDisabled,
  type UpdateCheckOptions,
} from "./updateCheck.ts";
import type { UpdateNotice } from "./types.ts";
import { REPO } from "./upgrade.ts";

// A fake github.com. `mode` picks how it answers the releases/latest page.
let mode: "ok" | "error" | "hang" = "ok";
let latestTag = "v0.3.0";
let requests = 0;

const server = Bun.serve({
  port: 0,
  async fetch(req): Promise<Response> {
    requests++;
    const { origin, pathname } = new URL(req.url);
    if (pathname !== `/${REPO}/releases/latest`) return new Response("not found", { status: 404 });
    if (mode === "error") return new Response("unavailable", { status: 503 });
    if (mode === "hang") await Bun.sleep(1000);
    const location = `${origin}/${REPO}/releases/tag/${latestTag}`;
    return new Response(null, { status: 302, headers: { location } });
  },
});

const NOW = 1_800_000_000_000;
const root = mkdtempSync(join(tmpdir(), "honk-update-check-test-"));
let cachePath: string;
let notices: string[];
let updates: UpdateNotice[];

function options(overrides: Partial<UpdateCheckOptions> = {}): UpdateCheckOptions {
  return {
    version: "v0.2.0",
    cachePath,
    githubUrl: server.url.origin,
    now: () => NOW,
    timeoutMs: 2000,
    upgradeable: () => true,
    // Records the first line, the sentence. The link line is tested below.
    notify: (update, lines) => {
      updates.push(update);
      notices.push(lines[0]!);
    },
    ...overrides,
  };
}

function writeCache(checkedAt: number, latest: string) {
  mkdirSync(join(cachePath, ".."), { recursive: true });
  writeFileSync(cachePath, JSON.stringify({ checkedAt, latest }));
}

beforeEach(() => {
  mode = "ok";
  latestTag = "v0.3.0";
  requests = 0;
  notices = [];
  updates = [];
  cachePath = join(mkdtempSync(join(root, "case-")), "honk", "update-check.json");
});

afterAll(() => {
  server.stop(true);
  rmSync(root, { recursive: true, force: true });
});

const NOTICE = "honk v0.3.0 is available (you have v0.2.0). Run: honk upgrade";

describe("checkForUpdate", () => {
  test("with no cache, asks GitHub, saves the answer and shows the notice", async () => {
    await checkForUpdate(options());
    expect(notices).toEqual([NOTICE]);
    expect(updates).toEqual([{ latest: "v0.3.0", upgradeable: true }]);
    expect(requests).toBe(1);
    expect(readCache(cachePath)).toEqual({ checkedAt: NOW, latest: "v0.3.0" });
  });

  test("shows nothing when this is the latest release", async () => {
    await checkForUpdate(options({ version: "v0.3.0" }));
    expect(notices).toEqual([]);
    expect(readCache(cachePath)?.latest).toBe("v0.3.0");
  });

  test("shows nothing when this is newer than the latest release", async () => {
    await checkForUpdate(options({ version: "v0.4.0" }));
    expect(notices).toEqual([]);
  });

  test("a cache younger than a day answers without a request", async () => {
    writeCache(NOW - CHECK_INTERVAL_MS + 60_000, "v0.3.0");
    await checkForUpdate(options());
    expect(notices).toEqual([NOTICE]);
    expect(requests).toBe(0);
  });

  test("an old cache is checked again, and the new answer wins", async () => {
    writeCache(NOW - CHECK_INTERVAL_MS, "v0.3.0");
    latestTag = "v0.4.0";
    await checkForUpdate(options());
    expect(requests).toBe(1);
    expect(notices).toEqual(["honk v0.4.0 is available (you have v0.2.0). Run: honk upgrade"]);
    expect(readCache(cachePath)).toEqual({ checkedAt: NOW, latest: "v0.4.0" });
  });

  test("when GitHub fails, uses the old cache and keeps it for the next start", async () => {
    writeCache(NOW - 2 * CHECK_INTERVAL_MS, "v0.3.0");
    mode = "error";
    await checkForUpdate(options());
    expect(notices).toEqual([NOTICE]);
    expect(readCache(cachePath)).toEqual({ checkedAt: NOW - 2 * CHECK_INTERVAL_MS, latest: "v0.3.0" });
  });

  test("when GitHub fails and there is no cache, shows nothing and writes nothing", async () => {
    mode = "error";
    await checkForUpdate(options());
    expect(notices).toEqual([]);
    expect(readCache(cachePath)).toBeUndefined();
  });

  test("gives up after the timeout", async () => {
    mode = "hang";
    const started = Date.now();
    await checkForUpdate(options({ timeoutMs: 100 }));
    expect(Date.now() - started).toBeLessThan(900);
    expect(notices).toEqual([]);
  });

  test("checks again when the cache is from the future (the clock went back)", async () => {
    writeCache(NOW + 60_000, "v0.3.0");
    await checkForUpdate(options());
    expect(requests).toBe(1);
  });

  test("a broken cache counts as no cache", async () => {
    mkdirSync(join(cachePath, ".."), { recursive: true });
    writeFileSync(cachePath, "{not json");
    await checkForUpdate(options());
    expect(requests).toBe(1);
    expect(readCache(cachePath)?.latest).toBe("v0.3.0");
  });

  test("a tag it cannot compare shows nothing", async () => {
    latestTag = "nightly";
    await checkForUpdate(options());
    expect(notices).toEqual([]);
  });

  test("does not suggest honk upgrade for a copy it cannot replace", async () => {
    await checkForUpdate(options({ upgradeable: () => false }));
    expect(notices).toEqual(["honk v0.3.0 is available (you have v0.2.0). Update it the way you installed it."]);
    expect(updates).toEqual([{ latest: "v0.3.0", upgradeable: false }]);
  });

  test("a cache it cannot write does not stop the notice", async () => {
    const blocked = join(root, "a-file");
    writeFileSync(blocked, "");
    await checkForUpdate(options({ cachePath: join(blocked, "honk", "update-check.json") }));
    expect(notices).toEqual([NOTICE]);
  });
});

describe("updateCheckDisabled", () => {
  test("checks a release build by default", () => {
    expect(updateCheckDisabled({}, "v0.2.0", [])).toBeUndefined();
  });
  test.each([
    ["a source build", {}, "dev", []],
    ["HONK_NO_UPDATE_CHECK", { HONK_NO_UPDATE_CHECK: "1" }, "v0.2.0", []],
    ["CI", { CI: "true" }, "v0.2.0", []],
    ["the demo", {}, "v0.2.0", ["--demo"]],
  ] as const)("skips %s", (_, env, version, args) => {
    expect(updateCheckDisabled(env, version, [...args])).toBeString();
  });
});

describe("paths and text", () => {
  test("defaultCachePath uses XDG_CACHE_HOME, and treats an empty value as unset", () => {
    expect(defaultCachePath({ XDG_CACHE_HOME: "/c" })).toBe("/c/honk/update-check.json");
    expect(defaultCachePath({ XDG_CACHE_HOME: "" })).toMatch(/\.cache\/honk\/update-check\.json$/);
  });
  test("noticeLines: the sentence, then the release notes link on its own line", () => {
    expect(noticeLines("v0.2.0", "v0.3.0", true)).toEqual([
      NOTICE,
      "What's new in v0.3.0: https://github.com/agustingianni/honk/releases/tag/v0.3.0",
    ]);
  });
});
