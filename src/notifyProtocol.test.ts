import { describe, expect, test } from "bun:test";
import {
  chooseNotificationProtocol,
  parseNotificationSetting,
  protocolForTerminal,
  type TmuxInfo,
} from "./notifyProtocol.ts";

const IN_TMUX = { TMUX: "/tmp/tmux-501/default,123,0" };

const tmux = (info: TmuxInfo | null) => () => info;
const neverAsked = () => {
  throw new Error("tmux was asked");
};

describe("protocolForTerminal", () => {
  test("knows the terminals OpenTUI knows, by their XTVERSION answer", () => {
    expect(protocolForTerminal("ghostty 1.2.3")).toBe("osc777");
    expect(protocolForTerminal("WezTerm 20240203-110809-5046fc22")).toBe("osc777");
    expect(protocolForTerminal("VTE(7800)")).toBe("osc777");
    expect(protocolForTerminal("iTerm2 3.5.0")).toBe("osc9");
    expect(protocolForTerminal("kitty(0.40.0)")).toBe("osc99");
    expect(protocolForTerminal("foot(1.18.0)")).toBe("osc99");
    // zellij inside tmux: tmux reports zellij as the outer terminal.
    expect(protocolForTerminal("Zellij(4601)")).toBe("osc99");
  });

  test("returns nothing for other terminals and for no answer", () => {
    expect(protocolForTerminal("XTerm(390)")).toBeUndefined();
    expect(protocolForTerminal("Alacritty 0.14")).toBeUndefined();
    expect(protocolForTerminal("")).toBeUndefined();
  });
});

describe("parseNotificationSetting", () => {
  test("missing or true is on, false is off", () => {
    expect(parseNotificationSetting(undefined)).toEqual({ enabled: true });
    expect(parseNotificationSetting(true)).toEqual({ enabled: true });
    expect(parseNotificationSetting(false)).toEqual({ enabled: false });
  });

  test("a protocol name is on, with that protocol", () => {
    expect(parseNotificationSetting("osc777")).toEqual({ enabled: true, protocol: "osc777" });
  });

  test("anything else is on, with a warning", () => {
    const setting = parseNotificationSetting("osc5");
    expect(setting.enabled).toBe(true);
    expect(setting.protocol).toBeUndefined();
    expect(setting.warning).toContain('not "osc5"');
  });
});

describe("chooseNotificationProtocol", () => {
  test("outside tmux, leaves the choice to OpenTUI and does not run tmux", () => {
    expect(chooseNotificationProtocol({}, undefined, neverAsked)).toEqual({});
  });

  test("outside tmux, a protocol in the config is used as is", () => {
    // For screen, or honk on an SSH host while tmux runs on your own computer.
    expect(chooseNotificationProtocol({ STY: "1.pts" }, "osc777", neverAsked)).toEqual({
      protocol: "osc777",
    });
  });

  test("inside zellij, picks OSC 99, unless the config names another", () => {
    expect(chooseNotificationProtocol({ ZELLIJ: "0" }, undefined, neverAsked)).toEqual({
      protocol: "osc99",
    });
    expect(chooseNotificationProtocol({ ZELLIJ: "0" }, "osc9", neverAsked)).toEqual({
      protocol: "osc9",
    });
  });

  test("inside tmux with passthrough all, picks the outer terminal's protocol", () => {
    const ghostty = tmux({ termtype: "ghostty 1.2.3", passthrough: "all" });
    expect(chooseNotificationProtocol(IN_TMUX, undefined, ghostty)).toEqual({ protocol: "osc777" });
    const iterm = tmux({ termtype: "iTerm2 3.5.0", passthrough: "all" });
    expect(chooseNotificationProtocol(IN_TMUX, undefined, iterm)).toEqual({ protocol: "osc9" });
  });

  test("with passthrough on, sends notifications but says hidden windows get none", () => {
    const t = tmux({ termtype: "ghostty 1.2.3", passthrough: "on" });
    const choice = chooseNotificationProtocol(IN_TMUX, undefined, t);
    expect(choice.protocol).toBe("osc777");
    expect(choice.warning).toContain("set -g allow-passthrough all");
  });

  test("inside tmux, a protocol in the config beats the outer terminal's", () => {
    const t = tmux({ termtype: "ghostty 1.2.3", passthrough: "all" });
    expect(chooseNotificationProtocol(IN_TMUX, "osc9", t)).toEqual({ protocol: "osc9" });
  });

  test("inside tmux with passthrough off, sends nothing and says how to fix it", () => {
    const t = tmux({ termtype: "ghostty 1.2.3", passthrough: "off" });
    const choice = chooseNotificationProtocol(IN_TMUX, undefined, t);
    expect(choice.protocol).toBeUndefined();
    expect(choice.warning).toContain("set -g allow-passthrough all");
  });

  test("inside tmux with an unknown terminal, names it and the config setting", () => {
    const t = tmux({ termtype: "Alacritty 0.14", passthrough: "on" });
    const choice = chooseNotificationProtocol(IN_TMUX, undefined, t);
    expect(choice.protocol).toBeUndefined();
    expect(choice.warning).toContain("Alacritty 0.14");
    expect(choice.warning).toContain('"notifications"');
  });

  test("when tmux can't be asked, changes nothing", () => {
    expect(chooseNotificationProtocol(IN_TMUX, undefined, tmux(null))).toEqual({});
  });

  test("OPENTUI_NOTIFICATION_PROTOCOL set by the user wins", () => {
    const env = { ...IN_TMUX, OPENTUI_NOTIFICATION_PROTOCOL: "osc9" };
    expect(chooseNotificationProtocol(env, "osc777", neverAsked)).toEqual({});
  });
});
