// Builds a standalone binary for each platform into dist/.
// OpenTUI ships its native code in one package per platform, and a normal
// `bun install` only fetches the one for this machine, so fetch them all first.
import { $ } from "bun";

const targets = [
  "darwin-arm64",
  "darwin-x64",
  "linux-x64",
  "linux-arm64",
  // musl libc, for Alpine and other musl-based distros
  "linux-x64-musl",
  "linux-arm64-musl",
];

// The version that `honk --version` prints. In the release workflow, a tag push
// sets GITHUB_REF_NAME to the tag, such as "v0.2.0". A local build describes the
// commit instead, such as "v0.1.0-3-gabc1234-dirty".
async function releaseVersion(): Promise<string> {
  if (process.env.GITHUB_REF_TYPE === "tag" && process.env.GITHUB_REF_NAME) {
    return process.env.GITHUB_REF_NAME;
  }
  const described = await $`git describe --tags --always --dirty`.nothrow().quiet();
  return described.exitCode === 0 ? described.text().trim() : "dev";
}

const version = await releaseVersion();
console.log(`building honk ${version}`);

const all = "*"; // passed as a value so the shell does not expand it as a glob
await $`bun install --os=${all} --cpu=${all}`;
await $`rm -rf dist`;

for (const target of targets) {
  // OpenTUI loads its musl native library only when OPENTUI_LIBC is "musl" at
  // run time, and the glibc one otherwise, which fails on Alpine. Fix the value
  // at build time for the musl targets.
  const libc = target.endsWith("-musl")
    ? ["--define", `process.env.OPENTUI_LIBC=${JSON.stringify("musl")}`]
    : [];
  // --define puts these values into src/version.ts. Each value is JSON, so the
  // strings keep their quotes.
  await $`bun build src/index.tsx --compile --minify --target=bun-${target} \
    --define __HONK_VERSION__=${JSON.stringify(version)} \
    --define __HONK_TARGET__=${JSON.stringify(target)} \
    ${libc} \
    --outfile dist/honk-${target}`;
  // Releases ship the gzipped file: about a third of the size. -n leaves out the
  // name and time, so the same binary always gives the same .gz. -k keeps the
  // binary, for local testing.
  await $`gzip -9 -n -k dist/honk-${target}`;
}

await $`ls -lh dist`;
