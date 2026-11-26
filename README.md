# honk

A terminal IRC client, built with [Bun](https://bun.sh) and [OpenTUI](https://github.com/anomalyco/opentui).

## Install

Download the binary for your platform from the
[latest release](https://github.com/agustingianni/honk/releases/latest).
Use `curl` rather than a browser: on macOS, a file downloaded in a browser is
quarantined, and Gatekeeper blocks it because the binary is not signed.

```sh
# Pick one: darwin-arm64 (Apple Silicon), darwin-x64, linux-x64, linux-arm64
PLATFORM=darwin-arm64

mkdir -p ~/.local/bin
curl -fL -o ~/.local/bin/honk \
  "https://github.com/agustingianni/honk/releases/latest/download/honk-$PLATFORM"
chmod +x ~/.local/bin/honk
```

Make sure `~/.local/bin` is on your `PATH`.

If you downloaded it in a browser anyway, remove the quarantine flag:

```sh
xattr -d com.apple.quarantine ~/.local/bin/honk
```

## Usage

Connect to one server from the command line:

```sh
honk --server irc.libera.chat --nick goose --channel '#libera'
```

Flags: `--server host[:port]`, `--port`, `--nick`, `--channel` (can repeat),
`--password` (uses SASL), `--sasl`, `--no-tls`, `--config path`.
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

## Development

```sh
bun install
bun run dev         # run with hot reload
bun run typecheck
bun run build       # binary for this machine in dist/honk
bun run release     # binaries for every platform in dist/
```

## Releasing

Push a tag. The release workflow builds the binaries and attaches them to a
GitHub release.

```sh
git tag v0.1.0
git push origin v0.1.0
```

## License

[MIT](LICENSE)
