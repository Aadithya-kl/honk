import { expect, test } from "bun:test";
import { plainSegments } from "./format.tsx";

const plain = (text: string) =>
  plainSegments(text)
    .map((s) => s.text)
    .join("");

test("system lines lose mIRC color codes, digits and all", () => {
  // From Ergo's default MOTD: \x03 starts a color, then fg[,bg] digits.
  expect(plain("- this is \x034red\x03 and \x032blue\x03 text.")).toBe(
    "- this is red and blue text.",
  );
  expect(plain("\x031,0 00 \x030,1 01")).toBe(" 00  01");
});

test("bold, italics, underline and reset codes go too", () => {
  expect(plain("\x02bold\x02 \x1Ditalic\x1D \x1Funder\x1F\x0F done")).toBe(
    "bold italic under done",
  );
});

test("URLs are still links", () => {
  expect(plainSegments("see https://docs.inspircd.org now")).toEqual([
    { text: "see " },
    { text: "https://docs.inspircd.org", href: "https://docs.inspircd.org" },
    { text: " now" },
  ]);
});
