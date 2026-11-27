import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultStatePath,
  loadState,
  MAX_RECENT_ACTIONS,
  saveState,
  withActionUsed,
} from "./state.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "honk-state-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("the state file follows XDG_STATE_HOME, else ~/.local/state", () => {
  expect(defaultStatePath({ XDG_STATE_HOME: "/x/state" })).toBe("/x/state/honk/state.json");
  expect(defaultStatePath({})).toEndWith("/.local/state/honk/state.json");
});

test("a used action becomes the most recent", () => {
  let recent = withActionUsed({}, "cmd-clear");
  recent = withActionUsed(recent, "cmd-theme");
  expect(recent).toEqual({ "cmd-clear": 1, "cmd-theme": 2 });
  recent = withActionUsed(recent, "cmd-clear");
  expect(recent).toEqual({ "cmd-theme": 1, "cmd-clear": 2 });
});

test("only the newest actions are kept, and the numbers stay small", () => {
  let recent: Record<string, number> = {};
  for (let i = 0; i < MAX_RECENT_ACTIONS + 10; i++) recent = withActionUsed(recent, `a${i}`);
  expect(Object.keys(recent)).toHaveLength(MAX_RECENT_ACTIONS);
  expect(recent.a0).toBeUndefined();
  expect(recent[`a${MAX_RECENT_ACTIONS + 9}`]).toBe(MAX_RECENT_ACTIONS);
});

test("saved state loads back", async () => {
  const path = join(dir, "nested", "honk", "state.json");
  await saveState(path, { recentActions: { "cmd-clear": 1, "cmd-reconnect": 2 } });
  expect(loadState(path)).toEqual({ recentActions: { "cmd-clear": 1, "cmd-reconnect": 2 } });
  expect(JSON.parse(readFileSync(path, "utf8")).version).toBe(1);
});

test("a missing or broken file is an empty state", () => {
  expect(loadState(join(dir, "none.json"))).toEqual({ recentActions: {} });
  const path = join(dir, "state.json");
  for (const text of ["{oops", "null", "[]", '{"recentActions": [1]}', '{"recentActions": "x"}']) {
    writeFileSync(path, text);
    expect(loadState(path)).toEqual({ recentActions: {} });
  }
});

test("entries that are not numbers are dropped, the rest renumbered", () => {
  const path = join(dir, "state.json");
  writeFileSync(path, JSON.stringify({ recentActions: { a: 7, b: "x", c: 3, d: null } }));
  expect(loadState(path)).toEqual({ recentActions: { c: 1, a: 2 } });
});
