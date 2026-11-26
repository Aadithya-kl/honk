/**
 * Notices when the computer's network changes: Wi-Fi off or back on, another network,
 * a VPN coming up.
 *
 * There is no event for this that works the same on macOS and Linux without native
 * code, so this polls os.networkInterfaces() and compares a fingerprint of the
 * addresses. Only addresses that can reach other machines count: loopback
 * (127.0.0.1, ::1) and link-local (169.254.x.x, fe80::) addresses are left out. macOS
 * adds and drops link-local addresses on its own (AirDrop, VPN tunnels), and they
 * would look like changes.
 */

import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";

/** How often to look. Cheap: one system call, no network traffic. */
export const NETWATCH_INTERVAL_MS = 2_000;

export type InterfaceMap = NodeJS.Dict<NetworkInterfaceInfo[]>;

function isLinkLocal(info: NetworkInterfaceInfo): boolean {
  return info.family === "IPv4"
    ? info.address.startsWith("169.254.")
    : /^fe[89ab]/i.test(info.address);
}

/**
 * The addresses that matter, as one sorted string. Empty when the computer has no
 * usable address (offline).
 */
export function networkFingerprint(interfaces: InterfaceMap): string {
  const entries: string[] = [];
  for (const [name, infos] of Object.entries(interfaces)) {
    for (const info of infos ?? []) {
      if (info.internal || isLinkLocal(info)) continue;
      entries.push(`${name} ${info.address}`);
    }
  }
  return entries.sort().join("\n");
}

export interface NetworkWatcherOptions {
  /** Called when the addresses change. `online` is false when no usable address is left. */
  onChange(online: boolean): void;
  getInterfaces?: () => InterfaceMap;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

export class NetworkWatcher {
  private last = "";
  private handle: unknown = null;
  private readonly getInterfaces: () => InterfaceMap;

  constructor(private readonly options: NetworkWatcherOptions) {
    this.getInterfaces = options.getInterfaces ?? networkInterfaces;
    this.last = this.read();
  }

  start(): void {
    if (this.handle !== null) return;
    const set = this.options.setInterval ?? ((fn, ms) => setInterval(fn, ms));
    this.handle = set(() => this.check(), NETWATCH_INTERVAL_MS);
  }

  stop(): void {
    if (this.handle === null) return;
    const clear =
      this.options.clearInterval ??
      ((h) => clearInterval(h as ReturnType<typeof setInterval>));
    clear(this.handle);
    this.handle = null;
  }

  /** Reads the addresses once and reports a change. The timer calls this. */
  check(): void {
    const now = this.read();
    if (now === this.last) return;
    this.last = now;
    this.options.onChange(now !== "");
  }

  private read(): string {
    try {
      return networkFingerprint(this.getInterfaces());
    } catch {
      // Treat a failed read as "no change".
      return this.last;
    }
  }
}
