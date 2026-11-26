// Builds a standalone binary for each platform into dist/.
// OpenTUI ships its native code in one package per platform, and a normal
// `bun install` only fetches the one for this machine, so fetch them all first.
import { $ } from "bun";

const targets = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"];

const all = "*"; // passed as a value so the shell does not expand it as a glob
await $`bun install --os=${all} --cpu=${all}`;
await $`rm -rf dist`;

for (const target of targets) {
  await $`bun build src/index.tsx --compile --minify --target=bun-${target} --outfile dist/irc-${target}`;
}

await $`ls -lh dist`;
