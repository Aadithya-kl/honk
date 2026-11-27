import { expect, test } from "bun:test";
import { fuzzyMatch, matchLabel } from "./fuzzy.ts";

const score = (q: string, t: string) => fuzzyMatch(q, t)?.score ?? -1;
const positions = (q: string, t: string) => fuzzyMatch(q, t)?.positions;

test("every query character must appear in order", () => {
  expect(fuzzyMatch("abc", "a b c")).not.toBeNull();
  expect(fuzzyMatch("acb", "abc")).toBeNull();
  expect(fuzzyMatch("abcd", "abc")).toBeNull();
  expect(fuzzyMatch("x", "")).toBeNull();
});

test("an empty query matches everything with score 0", () => {
  expect(fuzzyMatch("", "anything")).toEqual({ score: 0, positions: [] });
});

test("case does not matter", () => {
  expect(positions("RUST", "#rust")).toEqual([1, 2, 3, 4]);
  expect(positions("rust", "#Rust")).toEqual([1, 2, 3, 4]);
});

test("a match at a word start beats one inside a word", () => {
  expect(score("re", "Server: Reconnect alpha")).toBeGreaterThan(
    score("re", "Preferences: Color Theme..."),
  );
  expect(positions("re", "Server: Reconnect alpha")).toEqual([8, 9]);
});

test("letters next to each other beat letters spread out", () => {
  expect(score("foob", "foobar")).toBeGreaterThan(score("foob", "foo-bar"));
  expect(score("tog", "View: Toggle Sidebar")).toBeGreaterThan(score("tog", "Set Topic Global"));
});

test("the best placement is found, not the first one", () => {
  // The first "a" leads to a long gap; the "ab" at the end is a tight run.
  expect(positions("ab", "a_____ab")).toEqual([6, 7]);
  // Word starts win over an earlier placement inside words.
  expect(positions("ts", "View: Toggle Sidebar")).toEqual([6, 13]);
});

test("word starts after ':' and '#' count", () => {
  expect(score("cl", "Chat: Clear Buffer")).toBeGreaterThan(score("cl", "Uncle"));
  expect(score("rust", "#rust")).toBeGreaterThan(score("rust", "trust"));
});

test("initials match across words", () => {
  const m = fuzzyMatch("tsb", "View: Toggle Sidebar");
  expect(m?.positions).toEqual([6, 13, 17]);
});

test("equal matches in different-length targets score the same, so callers break ties", () => {
  expect(score("#rust", "#rust")).toBe(score("#rust", "#rust-offtopic"));
});

test("camelCase and digits start words", () => {
  expect(positions("tn", "TokyoNight")).toEqual([0, 5]);
  expect(score("n", "TokyoNight")).toBeGreaterThan(score("n", "Tokyonight"));
  expect(score("2", "base16-2")).toBeGreaterThan(0);
});

test("a match in the label ranks above one that needs the extra text", () => {
  const alice = matchLabel("al", "alice", "alpha");
  const bob = matchLabel("al", "bob", "alpha");
  expect(alice!.score).toBeGreaterThan(bob!.score);
  expect(alice!.positions).toEqual([0, 1]);
  // The extra text is only tried when the label alone does not match.
  expect(matchLabel("alice beta", "alice", "beta")?.positions).toHaveLength(10);
  expect(matchLabel("zz", "alice", "alpha")).toBeNull();
  expect(matchLabel("beta", "alice")).toBeNull();
});
