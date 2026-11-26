# honk

A terminal IRC client, built with [Bun](https://bun.sh) and [OpenTUI](https://github.com/anomalyco/opentui).

## Install

On macOS or Linux:

```sh
curl -fsSL https://agustingianni.github.io/honk/install.sh | sh
```

The [script](site/install.sh) picks the binary for your OS and CPU, checks its
SHA-256 checksum, and puts it in `~/.local/bin`. It never uses sudo and never
edits your shell config. Settings:

- `HONK_VERSION=v0.1.0` installs that release instead of the latest one.
- `HONK_INSTALL_DIR=~/bin` installs into another folder.

On Alpine and other musl-based distros, honk needs the C++ runtime first:

```sh
apk add libstdc++ libgcc
```

```sh
curl -fsSL https://agustingianni.github.io/honk/install.sh | HONK_VERSION=v0.1.0 sh
```

### Install by hand

Download `honk-<os>-<cpu>.gz` from the
[latest release](https://github.com/agustingianni/honk/releases/latest) and
unpack it.
Use `curl` rather than a browser: on macOS, a file downloaded in a browser is
quarantined, and Gatekeeper blocks it because the binary is not signed.

```sh
# Pick one: darwin-arm64 (Apple Silicon), darwin-x64, linux-x64, linux-arm64,
# linux-x64-musl or linux-arm64-musl (Alpine and other musl-based distros)
PLATFORM=darwin-arm64

mkdir -p ~/.local/bin
curl -fL "https://github.com/agustingianni/honk/releases/latest/download/honk-$PLATFORM.gz" \
  | gunzip > ~/.local/bin/honk
chmod +x ~/.local/bin/honk
```

If you downloaded it in a browser anyway, remove the quarantine flag:

```sh
xattr -d com.apple.quarantine ~/.local/bin/honk
```

### Check a download

Each release has a `SHA256SUMS` file with the checksum of each `.gz` file.
Both the `.gz` files and the binaries inside them are signed with a build
provenance attestation. To check that your binary was built by this repo's
release workflow from a tagged commit:

```sh
gh attestation verify ~/.local/bin/honk -R agustingianni/honk
```

## Usage

Connect to one server from the command line:

```sh
honk --server irc.libera.chat --nick goose --channel '#libera'
```

To look around first, without connecting anywhere, run the offline demo. It has
made-up networks, channels and people, and sends nothing over the network:

```sh
honk --demo
```

Flags: `--server host[:port]`, `--port`, `--nick`, `--channel` (can repeat),
`--password` (uses SASL), `--sasl`, `--no-tls`, `--config path`, `--demo`,
`--version` (or `-v`).
TLS is on by default. Type `/help` inside the client for the commands.

## Configuration

To connect to several servers at startup, create a config file. honk reads the
first one it finds:

1. the file given with `--config`
2. `./honk.json`
3. `~/.config/honk/config.json`

Start from [`honk.example.json`](honk.example.json):

```sh
mkdir -p ~/.config/honk
curl -fL -o ~/.config/honk/config.json \
  https://raw.githubusercontent.com/agustingianni/honk/main/honk.example.json
```

Each server takes `host`, `nick`, and optionally `port`, `tls`, `channels`,
`username`, `realname`, `password`, `serverPassword`, `authMethod`
(`sasl`, `saslExternal` or `NickServ`) and `autoConnect`.

## Website

The website is the plain HTML in `site/`. A push to `main` that changes
`site/` publishes it to https://agustingianni.github.io/honk/ through the
`pages` workflow. `site/install.sh` is the install script above.

The recording on the website comes from `scripts/demo.tape`. To record it
again after a UI change, install [VHS](https://github.com/charmbracelet/vhs)
and run `bun run record-demo`. It writes `site/demo.mp4`, `site/demo.webm`
and `site/demo.png`.

## Development

```sh
bun install
bun run dev         # run with hot reload
bun run demo        # run the offline demo
bun run typecheck
bun run build       # binary for this machine in dist/honk
bun run release     # binaries for every platform in dist/
```

## Testing on Linux

`scripts/test-linux.sh` runs the Linux binaries and `install.sh` in Docker, on
Alpine, Debian, Ubuntu, Fedora and Arch Linux, for x64 and arm64. In each
container it installs honk with `install.sh` and runs `honk --demo`.

```sh
bun run release
sh scripts/test-linux.sh               # every distro
sh scripts/test-linux.sh alpine:3.20   # one image
```

## Releasing

Push a tag. The release workflow builds the binaries, runs
`scripts/test-linux.sh` on an x64 and an arm64 runner, and only if every
distro passes, signs the binaries and attaches them to a GitHub release.

```sh
git tag v0.1.0
git push origin v0.1.0
```

## License

[MIT](LICENSE)
