import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AttestationResult,
  checksumFor,
  compareVersions,
  defaultReceiptPath,
  REPO,
  upgrade,
  type UpgradeOptions,
} from "./upgrade.ts";

// A fake github.com with one release. Tests change `release` to shape it.
const release = {
  tag: "v0.3.0" as string | undefined, // undefined: the repo has no releases
  asset: "new honk binary",
  sums: "", // filled from `asset` unless a test sets it
};
const requests: string[] = [];

const server = Bun.serve({
  port: 0,
  fetch(req): Response {
    const { origin, pathname: path } = new URL(req.url);
    requests.push(`${req.method} ${path}`);
    if (path === `/${REPO}/releases/latest`) {
      const to = release.tag ? `/${REPO}/releases/tag/${release.tag}` : `/${REPO}/releases`;
      // GitHub sends an absolute URL.
      return new Response(null, { status: 302, headers: { location: `${origin}${to}` } });
    }
    const download = `/${REPO}/releases/download/${release.tag}/`;
    if (path === `${download}SHA256SUMS`) return new Response(release.sums);
    if (path === `${download}honk-linux-x64`) return new Response(release.asset);
    return new Response("not found", { status: 404 });
  },
});
const githubUrl = server.url.origin;

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const root = mkdtempSync(join(tmpdir(), "honk-upgrade-test-"));
let dir: string;
let binary: string;
let receipt: string;
let logs: string[];

function options(overrides: Partial<UpgradeOptions> = {}): UpgradeOptions {
  return {
    version: "v0.2.0",
    target: "linux-x64",
    execPath: binary,
    receiptPath: receipt,
    githubUrl,
    verifyAttestation: async (): Promise<AttestationResult> => "skipped",
    log: (line) => logs.push(line),
    ...overrides,
  };
}

function writeReceipt(path: string) {
  writeFileSync(receipt, JSON.stringify({ installer: "install.sh", path, target: "linux-x64" }));
}

beforeEach(() => {
  release.tag = "v0.3.0";
  release.asset = "new honk binary";
  release.sums = `${sha256(release.asset)}  honk-linux-x64\n${"0".repeat(64)}  honk-darwin-arm64\n`;
  requests.length = 0;
  logs = [];
  // realpath, because macOS puts tmpdir behind the /var -> /private/var symlink.
  dir = realpathSync(mkdtempSync(join(root, "case-")));
  mkdirSync(join(dir, "bin"));
  binary = join(dir, "bin", "honk");
  writeFileSync(binary, "old honk binary");
  chmodSync(binary, 0o755);
  receipt = join(dir, "receipt.json");
  writeReceipt(binary);
});

afterAll(() => {
  server.stop(true);
  rmSync(root, { recursive: true, force: true });
});

const binaryText = () => readFileSync(binary, "utf-8");
const leftovers = () => readdirSync(join(dir, "bin")).filter((f) => f !== "honk");

describe("upgrade", () => {
  test("replaces the binary with the latest release", async () => {
    await upgrade(options());
    expect(binaryText()).toBe("new honk binary");
    expect(statSync(binary).mode & 0o777).toBe(0o755);
    expect(leftovers()).toEqual([]);
    expect(logs.at(-1)).toBe("upgraded honk from v0.2.0 to v0.3.0");
  });

  test("does nothing when this is already the latest release", async () => {
    await upgrade(options({ version: "v0.3.0" }));
    expect(binaryText()).toBe("old honk binary");
    expect(logs.at(-1)).toBe("honk v0.3.0 is up to date (the latest release is v0.3.0)");
    expect(requests).toEqual([`HEAD /${REPO}/releases/latest`]);
  });

  test("does not go back to an older release", async () => {
    await upgrade(options({ version: "v0.10.0" }));
    expect(binaryText()).toBe("old honk binary");
  });

  test("replaces the real file when it runs through a symlink", async () => {
    const link = join(dir, "honk-link");
    symlinkSync(binary, link);
    await upgrade(options({ execPath: link }));
    expect(binaryText()).toBe("new honk binary");
    expect(readFileSync(link, "utf-8")).toBe("new honk binary");
  });

  test("refuses when there is no receipt", async () => {
    rmSync(receipt);
    await expect(upgrade(options())).rejects.toThrow(/no install receipt/);
    expect(binaryText()).toBe("old honk binary");
    expect(requests).toEqual([]);
  });

  test("refuses a copy that install.sh did not install", async () => {
    writeReceipt("/somewhere/else/honk");
    await expect(upgrade(options())).rejects.toThrow(
      /install.sh installed honk at \/somewhere\/else\/honk, but this copy is/,
    );
    expect(binaryText()).toBe("old honk binary");
  });

  test("refuses a broken receipt", async () => {
    writeFileSync(receipt, "{not json");
    await expect(upgrade(options())).rejects.toThrow(/not valid JSON/);
  });

  test("refuses a build that is not a release", async () => {
    await expect(upgrade(options({ version: "dev", target: undefined }))).rejects.toThrow(
      /not built by the release workflow/,
    );
  });

  test("keeps the old binary when the checksum does not match", async () => {
    release.asset = "tampered honk binary";
    await expect(upgrade(options())).rejects.toThrow(/checksum mismatch for honk-linux-x64/);
    expect(binaryText()).toBe("old honk binary");
    expect(leftovers()).toEqual([]);
  });

  test("keeps the old binary when the attestation check fails", async () => {
    const opts = options({ verifyAttestation: async () => "failed" });
    await expect(upgrade(opts)).rejects.toThrow(/attestation check failed/);
    expect(binaryText()).toBe("old honk binary");
    expect(leftovers()).toEqual([]);
  });

  test("fails before the big download when SHA256SUMS has no entry for this target", async () => {
    release.sums = `${"0".repeat(64)}  honk-darwin-arm64\n`;
    await expect(upgrade(options())).rejects.toThrow(/no entry for honk-linux-x64/);
    expect(requests.some((r) => r.endsWith("/honk-linux-x64"))).toBe(false);
  });

  test("reports a repo with no releases", async () => {
    release.tag = undefined;
    await expect(upgrade(options())).rejects.toThrow(/could not find the latest release/);
  });

  test("reports a folder it cannot write to", async () => {
    if (process.getuid?.() === 0) return; // root can write anywhere
    chmodSync(join(dir, "bin"), 0o555);
    try {
      await expect(upgrade(options())).rejects.toThrow(/cannot write to/);
      expect(binaryText()).toBe("old honk binary");
    } finally {
      chmodSync(join(dir, "bin"), 0o755);
    }
  });
});

describe("compareVersions", () => {
  test.each([
    ["v0.3.0", "v0.2.0", 1],
    ["v0.2.0", "v0.3.0", -1],
    ["v0.10.0", "v0.9.0", 1], // numbers, not text
    ["v1.0.0", "v1.0.0", 0],
    ["v1.0.0", "v1.0.0-rc.1", 1], // a release is newer than its pre-release
    ["v1.0.0-rc.1", "v1.0.0-rc.2", -1],
  ])("%s vs %s", (a, b, sign) => {
    expect(Math.sign(compareVersions(a, b))).toBe(sign);
  });

  test("returns NaN for tags it cannot read", () => {
    expect(compareVersions("nightly", "v1.0.0")).toBeNaN();
    expect(compareVersions("nightly", "nightly")).toBe(0);
  });
});

describe("checksumFor", () => {
  const hash = "a".repeat(64);
  test("reads both sha256sum formats", () => {
    expect(checksumFor(`${hash}  honk-linux-x64\n`, "honk-linux-x64")).toBe(hash);
    expect(checksumFor(`${hash} *honk-linux-x64\n`, "honk-linux-x64")).toBe(hash);
  });
  test("does not match a name that only starts the same", () => {
    expect(checksumFor(`${hash}  honk-linux-x64-musl\n`, "honk-linux-x64")).toBeUndefined();
  });
});

describe("defaultReceiptPath", () => {
  test("uses XDG_STATE_HOME, and treats an empty value as unset", () => {
    expect(defaultReceiptPath({ XDG_STATE_HOME: "/state" })).toBe("/state/honk/receipt.json");
    expect(defaultReceiptPath({ XDG_STATE_HOME: "" })).toMatch(/\.local\/state\/honk\/receipt\.json$/);
  });
});
