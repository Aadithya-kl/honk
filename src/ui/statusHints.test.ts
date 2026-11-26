import { describe, expect, test } from "bun:test";
import { type StatusHintOptions, statusHints } from "./statusHints.ts";

const all = { sidebarFits: true, nicklistFits: true };
const upgradeable = { latest: "v0.3.0", upgradeable: true };

/** The hints as the status bar prints them. */
function line(o: StatusHintOptions, room: number): string {
  return statusHints(o, room)
    .map((h) => `${h.key} ${h.label}`)
    .join("  ");
}

describe("statusHints", () => {
  test("with room, shows every hint and no update", () => {
    expect(line({ ...all, update: null }, 200)).toBe(
      "^K omnibox  ^B sidebar  Alt+U users  Alt+↑/↓ switch  ^C quit",
    );
  });

  test("a newer release comes first, with the command to run", () => {
    expect(line({ ...all, update: upgradeable }, 200)).toBe(
      "v0.3.0 available: honk upgrade  ^K omnibox  ^B sidebar  Alt+U users  Alt+↑/↓ switch  ^C quit",
    );
  });

  test("a copy honk upgrade cannot replace gets only the short label", () => {
    expect(line({ ...all, update: { latest: "v0.3.0", upgradeable: false } }, 200)).toBe(
      "v0.3.0 available  ^K omnibox  ^B sidebar  Alt+U users  Alt+↑/↓ switch  ^C quit",
    );
  });

  test("when space runs out, the panel keys drop before the update", () => {
    expect(line({ ...all, update: upgradeable }, 75)).toBe(
      "v0.3.0 available: honk upgrade  ^K omnibox  Alt+↑/↓ switch  ^C quit",
    );
  });

  test("when the long label does not fit, it shortens instead of going away", () => {
    expect(line({ ...all, update: upgradeable }, 40)).toBe("v0.3.0 available  ^K omnibox  ^C quit");
  });

  test("in very little space, ^K omnibox and ^C quit stay longest", () => {
    expect(line({ ...all, update: upgradeable }, 22)).toBe("^K omnibox  ^C quit");
  });
});
