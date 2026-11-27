import { afterEach, expect, test } from "bun:test";
import { until } from "../../dev/fakeircd/testing.ts";
import { IrcManager } from "./manager.ts";

let m: IrcManager | undefined;
afterEach(() => m?.disconnectAll());

test("/whois in the demo is worded as a real WHOIS reply", async () => {
  m = new IrcManager();
  m.startDemo();
  m.setActive("demo-libera", "#honk");
  m.handleInput("/whois alice");
  const lines = () =>
    m!
      .getSnapshot()
      .servers.find((s) => s.id === "demo-libera")
      ?.buffers["#honk"]?.messages.map((x) => x.text)
      .filter((t) => t.startsWith("alice ")) ?? [];
  await until(() => lines().length > 0);
  expect(lines()).toEqual([
    "alice is ~alice@user/alice",
    "alice is in @#honk",
    "alice is on libera.chat",
    "alice has been idle 2 minutes",
  ]);
});
