// Checks that commit subjects follow Conventional Commits, as AGENTS.md asks.
// release-please reads them to pick the next version and to write CHANGELOG.md,
// so a subject it can't read is a change missing from the changelog.
//
//   bun scripts/check-commits.ts origin/main..HEAD
//   bun scripts/check-commits.ts --title "feat: show typing indicators"
//
// CI checks the commits of each push to main. For a pull request it checks only
// the title: a squash merge makes the title the commit message, and the PR's own
// commits ("wip", "fix typo") disappear. Merge commits are skipped: their subject
// comes from git, not from a person.
import { $ } from "bun";

/** The types AGENTS.md lists. */
export const TYPES = ["feat", "fix", "perf", "refactor", "test", "docs", "chore", "ci", "build"];

const SHAPE = /^(\w+)(\([a-z0-9-]+\))?!?: \S/;

/**
 * Why `subject` is not a Conventional Commit subject, or null if it is.
 *
 *   "feat: connect to several servers"   -> null
 *   "fix(deps)!: drop Node 18"           -> null
 *   "feature: connect to several servers" -> "feature" is not a type ...
 *   "Add a bug report form"              -> the subject must start with a type ...
 */
export function subjectProblem(subject: string): string | null {
  const shape = SHAPE.exec(subject);
  if (!shape) {
    return `the subject must start with a type, such as "feat: " or "fix: ". Types: ${TYPES.join(", ")}.`;
  }
  if (!TYPES.includes(shape[1]!)) {
    return `"${shape[1]}" is not a type. Types: ${TYPES.join(", ")}.`;
  }
  return null;
}

const USAGE = "usage: bun scripts/check-commits.ts <from>..<to> | --title <text>";

if (import.meta.main && process.argv[2] === "--title") {
  const title = process.argv[3];
  if (title === undefined) {
    console.error(USAGE);
    process.exit(2);
  }
  const problem = subjectProblem(title);
  if (problem) {
    console.error(`check-commits: the PR title "${title}" does not work as a commit subject.`);
    console.error(`check-commits: ${problem}`);
    console.error('check-commits: see "Commit messages" in AGENTS.md.');
    process.exit(1);
  }
  console.log("check-commits: PR title ok");
} else if (import.meta.main) {
  const range = process.argv[2];
  if (!range) {
    console.error(USAGE);
    process.exit(2);
  }
  const log = await $`git log --no-merges --format=%h%x09%s ${range}`.text();
  const commits = log.split("\n").filter(Boolean);
  let bad = 0;
  for (const line of commits) {
    const tab = line.indexOf("\t");
    const sha = line.slice(0, tab);
    const subject = line.slice(tab + 1);
    const problem = subjectProblem(subject);
    if (!problem) continue;
    bad++;
    console.error(`check-commits: ${sha} "${subject}"`);
    console.error(`check-commits: ${problem}`);
  }
  if (bad > 0) {
    console.error('check-commits: see "Commit messages" in AGENTS.md.');
    process.exit(1);
  }
  console.log(`check-commits: ${commits.length} commits ok`);
}
