// `honk upgrade`: replaces this binary with the latest GitHub release.
//
// It does the same checks as site/install.sh: the SHA-256 checksum from the
// release's SHA256SUMS file, and the build provenance attestation when the
// GitHub CLI (gh) is installed and logged in. It only replaces a binary that
// install.sh installed, as recorded in its receipt, so it never overwrites a
// copy that Homebrew or another package manager owns.

import { createHash } from "node:crypto";
import { chmodSync, createReadStream, readFileSync, realpathSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { TARGET, VERSION } from "./version.ts";

export const REPO = "agustingianni/honk";
const INSTALL_COMMAND = "curl -fsSL https://agustingianni.github.io/honk/install.sh | sh";

/** An error with a message for the user, printed without a stack trace. */
export class UpgradeError extends Error {}

export type AttestationResult = "ok" | "failed" | "skipped";

export interface UpgradeOptions {
  /** The running version, such as "v0.2.0". */
  version: string;
  /** The release asset name without "honk-", such as "darwin-arm64". */
  target: string | undefined;
  /** The path of the running binary. It may be a symlink. */
  execPath: string;
  receiptPath: string;
  /** "https://github.com". Tests pass a local server. */
  githubUrl: string;
  verifyAttestation: (file: string) => Promise<AttestationResult>;
  log: (line: string) => void;
}

/** Where install.sh writes its receipt. Matches write_receipt in site/install.sh. */
export function defaultReceiptPath(env: NodeJS.ProcessEnv = process.env): string {
  // Like ${XDG_STATE_HOME:-...} in sh: an empty value counts as unset.
  const stateHome = env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  return join(stateHome, "honk", "receipt.json");
}

/** Returns the path install.sh recorded, or undefined when there is no receipt. */
export function readReceipt(path: string): string | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new UpgradeError(`the install receipt ${path} is not valid JSON`);
  }
  const recorded = (parsed as { path?: unknown } | null)?.path;
  if (typeof recorded !== "string" || recorded === "") {
    throw new UpgradeError(`the install receipt ${path} has no "path"`);
  }
  return recorded;
}

/**
 * Finds the tag of the latest release. It reads the redirect of the
 * github.com/<repo>/releases/latest web page instead of calling the REST API,
 * because unauthenticated API calls are limited to 60 an hour per IP address.
 *
 *   /agustingianni/honk/releases/latest -> /agustingianni/honk/releases/tag/v0.2.0
 */
export async function latestRelease(githubUrl: string, signal?: AbortSignal): Promise<string> {
  const pageUrl = `${githubUrl}/${REPO}/releases/latest`;
  const res = await fetch(pageUrl, { method: "HEAD", redirect: "manual", signal });
  const location = res.headers.get("location");
  if (res.status < 300 || res.status >= 400 || !location) {
    throw new UpgradeError(`could not find the latest release (${pageUrl} answered ${res.status})`);
  }
  const match = /\/releases\/tag\/([^/]+)$/.exec(new URL(location, pageUrl).pathname);
  if (!match) {
    // With no releases at all, GitHub redirects to the list of releases instead.
    throw new UpgradeError(`could not find the latest release (${pageUrl} redirects to ${location})`);
  }
  return decodeURIComponent(match[1]!);
}

/**
 * Compares two release tags such as "v0.2.0" and "v0.10.0-rc.1". Returns a
 * negative number when a is older, 0 when they are the same, and a positive
 * number when a is newer. Returns NaN when either one is not of that form.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => /^v?(\d+)\.(\d+)\.(\d+)(-.+)?$/.exec(v);
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return a === b ? 0 : NaN;
  for (let i = 1; i <= 3; i++) {
    const diff = Number(pa[i]) - Number(pb[i]);
    if (diff !== 0) return diff;
  }
  // A release comes after its own pre-releases: v0.2.0 is newer than v0.2.0-rc.1.
  const preA = pa[4];
  const preB = pb[4];
  if (preA === preB) return 0;
  if (!preA) return 1;
  if (!preB) return -1;
  return preA < preB ? -1 : 1;
}

/** Reads the checksum of `asset` from a SHA256SUMS file in `sha256sum` format. */
export function checksumFor(sums: string, asset: string): string | undefined {
  for (const line of sums.split("\n")) {
    // "<64 hex digits>  <name>", or "<hex> *<name>" for sha256sum's binary mode.
    const match = /^([0-9a-f]{64}) [ *](.+)$/.exec(line.trim());
    if (match && match[2] === asset) return match[1];
  }
  return undefined;
}

async function sha256OfFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  // Read in chunks: the binary is over 100 MB.
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function fetchOk(url: string): Promise<Response> {
  const res = await fetch(url);
  if (!res.ok) throw new UpgradeError(`download failed: ${url} answered ${res.status}`);
  return res;
}

/** Checks the attestation with gh, like install.sh does. Skips it when gh is missing or logged out. */
export async function verifyAttestationWithGh(file: string): Promise<AttestationResult> {
  if (!Bun.which("gh")) return "skipped";
  const run = (args: string[]) =>
    Bun.spawn(["gh", ...args], { stdout: "ignore", stderr: "ignore" }).exited;
  if ((await run(["auth", "status"])) !== 0) return "skipped";
  return (await run(["attestation", "verify", file, "--repo", REPO])) === 0 ? "ok" : "failed";
}

export async function upgrade(o: UpgradeOptions): Promise<void> {
  if (o.version === "dev" || !o.target) {
    throw new UpgradeError(
      "this honk was not built by the release workflow, so it cannot upgrade itself. " +
        "If you run it from source, use git pull.",
    );
  }

  // Compare real paths, with symlinks resolved, as install.sh records them.
  const self = realpathSync(o.execPath);
  const installed = readReceipt(o.receiptPath);
  if (installed === undefined) {
    throw new UpgradeError(
      `honk upgrade only replaces a copy that install.sh installed, and there is no install receipt at ${o.receiptPath}. ` +
        `If a package manager installed honk, upgrade it there. To install with the script instead, run: ${INSTALL_COMMAND}`,
    );
  }
  if (installed !== self) {
    throw new UpgradeError(
      `install.sh installed honk at ${installed}, but this copy is ${self}. ` +
        `Upgrade this copy the way you installed it, or run: ${installed} upgrade`,
    );
  }

  o.log("checking for a new release");
  const latest = await latestRelease(o.githubUrl);
  // NaN (a tag we cannot compare) is not <= 0, so a different tag still upgrades.
  if (compareVersions(latest, o.version) <= 0) {
    o.log(`honk ${o.version} is up to date (the latest release is ${latest})`);
    return;
  }

  const asset = `honk-${o.target}`;
  const base = `${o.githubUrl}/${REPO}/releases/download/${encodeURIComponent(latest)}`;

  // The small file first, so a release without this asset fails before the big download.
  const sums = await (await fetchOk(`${base}/SHA256SUMS`)).text();
  const expected = checksumFor(sums, asset);
  if (!expected) throw new UpgradeError(`the ${latest} SHA256SUMS has no entry for ${asset}`);

  // Download next to the binary, then rename over it. On one file system the
  // rename is atomic, and a honk that is running keeps its old copy.
  const tmp = join(dirname(self), `.honk.new-${process.pid}`);
  try {
    o.log(`downloading ${asset} ${latest}`);
    try {
      await Bun.write(tmp, await fetchOk(`${base}/${asset}`));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EACCES" || code === "EPERM" || code === "EROFS") {
        throw new UpgradeError(`cannot write to ${dirname(self)} (${code}). honk upgrade never uses sudo.`);
      }
      throw err;
    }

    const actual = await sha256OfFile(tmp);
    if (actual !== expected) {
      throw new UpgradeError(`checksum mismatch for ${asset} (expected ${expected}, got ${actual})`);
    }
    o.log("checksum OK");

    const attestation = await o.verifyAttestation(tmp);
    if (attestation === "failed") {
      throw new UpgradeError(`the attestation check failed for ${asset}. The download was deleted.`);
    }
    if (attestation === "ok") o.log(`attestation OK (built by GitHub Actions from ${REPO})`);

    chmodSync(tmp, 0o755);
    renameSync(tmp, self);
  } finally {
    rmSync(tmp, { force: true });
  }
  o.log(`upgraded honk from ${o.version} to ${latest}`);
}

/** Runs `honk upgrade` for this binary and returns the process exit code. */
export async function runUpgrade(): Promise<number> {
  try {
    await upgrade({
      version: VERSION,
      target: TARGET,
      execPath: process.execPath,
      receiptPath: defaultReceiptPath(),
      githubUrl: "https://github.com",
      verifyAttestation: verifyAttestationWithGh,
      log: (line) => console.log(`honk: ${line}`),
    });
    return 0;
  } catch (err) {
    const message = err instanceof UpgradeError ? err.message : String(err);
    console.error(`honk: error: ${message}`);
    return 1;
  }
}
