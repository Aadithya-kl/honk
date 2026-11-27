import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { FakeIrcd } from "../../dev/fakeircd/server.ts";
import { until } from "../../dev/fakeircd/testing.ts";
import { IrcManager } from "./manager.ts";

let alpha: FakeIrcd;
let beta: FakeIrcd;
let m: IrcManager;

const server = (id: string) => m.getSnapshot().servers.find((s) => s.id === id)!;
const texts = (id: string, buffer: string) =>
  server(id).buffers[buffer]?.messages.map((x) => x.text) ?? [];

beforeEach(async () => {
  alpha = await FakeIrcd.start({ network: "alpha" });
  beta = await FakeIrcd.start({ network: "beta" });
  m = new IrcManager();
  for (const [id, irc] of [
    ["alpha", alpha],
    ["beta", beta],
  ] as const) {
    m.addServer({
      id,
      name: id,
      host: "127.0.0.1",
      port: irc.port,
      tls: false,
      nick: "goose",
      channels: ["#honk"],
      autoConnect: false,
    });
  }
  await m.connectServer("alpha");
  await m.connectServer("beta");
  await until(() => Boolean(server("alpha").buffers["#honk"] && server("beta").buffers["#honk"]));
  m.setActive("alpha", "#honk");
});

afterEach(async () => {
  m.disconnectAll();
  await alpha.stop();
  await beta.stop();
});

describe("runCommandOn", () => {
  test("joins on a server that is not the active one, and moves there", async () => {
    m.runCommandOn("beta", "/join #go");
    await until(() => m.getSnapshot().active?.buffer === "#go");
    expect(m.getSnapshot().active).toEqual({ serverId: "beta", buffer: "#go" });
    expect(beta.channelList()["#go"]).toContain("goose");
    expect(alpha.channelList()["#go"]).toBeUndefined();
  });

  test("a failed join on another server shows in the buffer you are in", async () => {
    beta.ban("#secret");
    m.runCommandOn("beta", "/join #secret");
    await until(() => texts("alpha", "#honk").some((t) => t.includes("#secret")));
    expect(texts("alpha", "#honk").at(-1)).toBe(
      "beta: Can't join #secret: you are banned from it.",
    );
    expect(m.getSnapshot().active).toEqual({ serverId: "alpha", buffer: "#honk" });
  });

  test("replies name the server, in the buffer you are in", async () => {
    m.runCommandOn("beta", "/join");
    // The snapshot is rebuilt in a microtask, not on every line.
    await until(() => texts("alpha", "#honk").some((t) => t.includes("Usage: /join")));
    expect(texts("alpha", "#honk").at(-1)).toStartWith("beta: Usage: /join");
    expect(texts("beta", "*status").some((t) => t.includes("Usage: /join"))).toBe(false);
  });

  test("disconnects and reconnects the server it names", async () => {
    m.runCommandOn("beta", "/disconnect");
    await until(() => server("beta").status === "disconnected");
    expect(server("alpha").status).toBe("connected");
    m.runCommandOn("beta", "/connect");
    await until(() => server("beta").status === "connected");
    await until(() => beta.channelList()["#honk"]?.includes("goose") ?? false);
  });
});
