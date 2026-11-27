# Security policy

## Report a vulnerability

Please do not open a public issue for a security problem.

Report it privately instead: open the repository's
[Security tab](https://github.com/agustingianni/honk/security) and click
**Report a vulnerability**, or go straight to the
[new advisory form](https://github.com/agustingianni/honk/security/advisories/new).
Only you and the maintainer can see the report.

Please include:

- the output of `honk --version`
- your OS and terminal
- the steps to reproduce the problem, such as the exact IRC messages a server
  or another user sent

honk is a project maintained by one person in their free time. I will try to
reply within a week. When a fix is ready, I will publish a new release and a
GitHub security advisory that credits you, unless you ask me not to.

## Supported versions

Only the latest release gets security fixes. Run `honk upgrade` to get it.

## What counts

Some examples of problems I want to hear about:

- An IRC server or another user can make honk do something it should not:
  crash, run commands, write files, or send messages you did not type.
- Text from the network reaches your terminal as control sequences, so it can
  change the screen, the window title, or the clipboard.
- honk sends a password or other secret somewhere it should not go, or connects
  without TLS when the config asks for TLS.
- The install script or `honk upgrade` accepts a binary that does not match the
  release's checksum or attestation.

Problems in a dependency are welcome too. If you can, also report them to that
project.
