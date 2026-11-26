import { describe, expect, test } from "bun:test";
import { lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveThemeSetting, setThemeInConfigText } from "./config.ts";

describe("setThemeInConfigText", () => {
  test("replaces an existing theme and keeps the rest of the text", () => {
    const text = `{
  "theme": "nord",
  "servers": [ { "host": "irc.libera.chat" } ]
}
`;
    expect(setThemeInConfigText(text, "dracula")).toBe(`{
  "theme": "dracula",
  "servers": [ { "host": "irc.libera.chat" } ]
}
`);
  });

  test("adds the theme as the first key, with the file's indent", () => {
    const text = `{
    "notifications": false,
    "servers": []
}
`;
    expect(setThemeInConfigText(text, "nord")).toBe(`{
    "theme": "nord",
    "notifications": false,
    "servers": []
}
`);
  });

  test("fills an empty object", () => {
    expect(setThemeInConfigText("{}\n", "nord")).toBe('{ "theme": "nord" }\n');
    expect(setThemeInConfigText("{ }", "nord")).toBe('{ "theme": "nord" }');
  });

  test("adds a top-level theme when only a nested one exists", () => {
    const text = '{ "servers": [ { "theme": "x" } ] }';
    expect(setThemeInConfigText(text, "nord")).toBe(
      '{\n  "theme": "nord", "servers": [ { "theme": "x" } ] }',
    );
  });

  test("refuses text that is not a JSON object", () => {
    expect(() => setThemeInConfigText("[]", "nord")).toThrow();
    expect(() => setThemeInConfigText('{ "servers": [ }', "nord")).toThrow();
  });
});

describe("saveThemeSetting", () => {
  test("creates a missing file and its folder, and loadConfig reads it back", () => {
    const dir = mkdtempSync(join(tmpdir(), "honk-config-"));
    try {
      const path = join(dir, "honk", "config.json");
      saveThemeSetting(path, "nord");
      expect(readFileSync(path, "utf-8")).toBe('{\n  "theme": "nord"\n}\n');
      const config = loadConfig(["--config", path]);
      expect(config.theme).toBe("nord");
      expect(config.path).toBe(path);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("updates an existing file", () => {
    const dir = mkdtempSync(join(tmpdir(), "honk-config-"));
    try {
      const path = join(dir, "config.json");
      writeFileSync(path, '{ "theme": "nord", "servers": [] }\n');
      saveThemeSetting(path, "dracula");
      expect(readFileSync(path, "utf-8")).toBe('{ "theme": "dracula", "servers": [] }\n');
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("writes through a symlink and keeps the link", () => {
    const dir = mkdtempSync(join(tmpdir(), "honk-config-"));
    try {
      const real = join(dir, "dotfiles-config.json");
      const link = join(dir, "config.json");
      writeFileSync(real, '{ "servers": [] }\n');
      symlinkSync(real, link);
      saveThemeSetting(link, "nord");
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(readFileSync(real, "utf-8")).toBe('{\n  "theme": "nord", "servers": [] }\n');
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("a --config file that does not exist yet is where the theme goes", () => {
    const dir = mkdtempSync(join(tmpdir(), "honk-config-"));
    try {
      const path = join(dir, "mine.json");
      const config = loadConfig(["--config", path]);
      expect(config.path).toBe(path);
      saveThemeSetting(config.path!, "nord");
      expect(loadConfig(["--config", path]).theme).toBe("nord");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
