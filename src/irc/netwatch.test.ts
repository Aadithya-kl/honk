import { describe, expect, test } from "bun:test";
import type { NetworkInterfaceInfo } from "node:os";
import { type InterfaceMap, networkFingerprint, NetworkWatcher } from "./netwatch.ts";

function addr(address: string, internal = false): NetworkInterfaceInfo {
  const family = address.includes(":") ? "IPv6" : "IPv4";
  return {
    address,
    family,
    internal,
    netmask: family === "IPv4" ? "255.255.255.0" : "ffff:ffff:ffff:ffff::",
    mac: "00:00:00:00:00:00",
    cidr: null,
    ...(family === "IPv6" ? { scopeid: 0 } : {}),
  } as NetworkInterfaceInfo;
}

const LOOPBACK: InterfaceMap = { lo0: [addr("127.0.0.1", true), addr("::1", true)] };
const WIFI: InterfaceMap = {
  ...LOOPBACK,
  en0: [addr("fe80::1"), addr("192.168.86.199"), addr("2001:db8::5")],
};

describe("networkFingerprint", () => {
  test("is empty with only loopback and link-local addresses", () => {
    expect(
      networkFingerprint({
        ...LOOPBACK,
        en0: [addr("fe80::10dc:753f:5ea0:d642"), addr("169.254.3.4")],
        utun0: [addr("FE80::6cb7:899:70cf:9363")],
      }),
    ).toBe("");
  });

  test("lists the usable addresses, sorted", () => {
    expect(networkFingerprint(WIFI)).toBe("en0 192.168.86.199\nen0 2001:db8::5");
  });

  test("does not depend on the order the system lists them in", () => {
    const reordered: InterfaceMap = {
      en0: [addr("2001:db8::5"), addr("192.168.86.199")],
      ...LOOPBACK,
    };
    expect(networkFingerprint(reordered)).toBe(networkFingerprint(WIFI));
  });
});

describe("NetworkWatcher", () => {
  function setup(initial: InterfaceMap) {
    let current = initial;
    const changes: boolean[] = [];
    const watcher = new NetworkWatcher({
      onChange: (online) => changes.push(online),
      getInterfaces: () => current,
    });
    return { watcher, changes, set: (next: InterfaceMap) => (current = next) };
  }

  test("reports nothing while the network stays the same", () => {
    const { watcher, changes } = setup(WIFI);
    watcher.check();
    watcher.check();
    expect(changes).toEqual([]);
  });

  test("reports Wi-Fi going away and coming back", () => {
    const { watcher, changes, set } = setup(WIFI);
    set(LOOPBACK);
    watcher.check();
    set(WIFI);
    watcher.check();
    expect(changes).toEqual([false, true]);
  });

  test("reports a move to another network", () => {
    const { watcher, changes, set } = setup(WIFI);
    set({ ...LOOPBACK, en0: [addr("10.0.0.7")] });
    watcher.check();
    expect(changes).toEqual([true]);
  });

  test("ignores link-local addresses coming and going", () => {
    const { watcher, changes, set } = setup(WIFI);
    set({ ...WIFI, awdl0: [addr("fe80::c50:25ff:fe5f:feba")] });
    watcher.check();
    expect(changes).toEqual([]);
  });

  test("a failed read is not a change", () => {
    let fail = false;
    const changes: boolean[] = [];
    const watcher = new NetworkWatcher({
      onChange: (online) => changes.push(online),
      getInterfaces: () => {
        if (fail) throw new Error("EPERM");
        return WIFI;
      },
    });
    fail = true;
    watcher.check();
    expect(changes).toEqual([]);
  });

  test("start polls on the interval and stop ends it", () => {
    const calls: { ms: number; fn: () => void }[] = [];
    let cleared = false;
    const watcher = new NetworkWatcher({
      onChange: () => {},
      getInterfaces: () => WIFI,
      setInterval: (fn, ms) => {
        calls.push({ fn, ms });
        return 1;
      },
      clearInterval: () => {
        cleared = true;
      },
    });
    watcher.start();
    watcher.start();
    expect(calls.map((c) => c.ms)).toEqual([2_000]);
    watcher.stop();
    expect(cleared).toBe(true);
  });
});
