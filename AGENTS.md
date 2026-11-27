# AGENTS.md

## Commit messages

Commits use [Conventional Commits](https://www.conventionalcommits.org). The
release tooling reads them: the type decides the next version, and the subject
of each `feat` and `fix` commit becomes one line in CHANGELOG.md. Write that
subject for people who use honk, in the imperative, lowercase after the colon.

| Type | Use it for | Version bump |
|---|---|---|
| `feat` | something new a user can see or do | minor |
| `fix` | a bug a user could hit | patch |
| `perf` | faster or lighter, same behavior | patch |
| `refactor`, `test`, `docs`, `chore`, `ci`, `build` | everything else | none |

A `!` after the type marks a breaking change: config keys, command names, or
flags that change or go away, such as `feat!: rename the config key theme to colors`.

Good subjects describe what the user gets:

```
feat: connect to several servers at once
fix: /join now accepts a channel key
perf: start faster with many channels in the config
```

The changelog only shows the subject, so a subject such as
`feat: add ServerPool class` tells a user nothing. Put the implementation
details in the commit body.

Make one commit per user-visible change, so each change gets its own changelog
line. Tests, docs, and refactors that belong to a change go in that change's
commit.

## Releases

Releases happen only when the user asks for one. Until then, the `version` in
package.json, git tags, and CHANGELOG.md stay as they are.
