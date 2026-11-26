# honk

A terminal IRC client, built with [Bun](https://bun.sh) and [OpenTUI](https://github.com/anomalyco/opentui).

## Install

On macOS or Linux:

```sh
curl -fsSL https://agustingianni.github.io/honk/install.sh | sh
```

The [script](site/install.sh) picks the binary for your OS and CPU, checks its
SHA-256 checksum, and puts it in `~/.local/bin`. It never uses sudo and never
edits your shell config. It also writes a small file,
`~/.local/state/honk/receipt.json`, that records where it put honk, so that a
later `honk upgrade` only replaces a copy this script installed. Settings:

- `HONK_VERSION=v0.1.0` installs that release instead of the latest one.
- `HONK_INSTALL_DIR=~/bin` installs into another folder.

```sh
curl -fsSL https://agustingianni.github.io/honk/install.sh | HONK_VERSION=v0.1.0 sh
```

On Alpine and other musl-based distros, honk needs the C++ runtime first:

```sh
apk add libstdc++ libgcc
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
curl -fL -o /tmp/honk.gz \
  "https://github.com/agustingianni/honk/releases/latest/download/honk-$PLATFORM.gz" &&
  gunzip -c /tmp/honk.gz > ~/.local/bin/honk.new &&
  chmod +x ~/.local/bin/honk.new &&
  mv ~/.local/bin/honk.new ~/.local/bin/honk
```

Each step runs only if the one before it worked, so a failed download leaves
an installed honk as it was. `honk upgrade` does not replace a copy installed
by hand, because only the install script records where it put honk. To
upgrade, repeat these steps.

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

### Upgrade

If you installed honk with the install script, upgrade it with:

```sh
honk upgrade
```

It downloads the latest release and checks it the same way the install script
does: the checksum, and the attestation when `gh` is installed and logged in.
Then it replaces the binary. A honk that is already running keeps working.

`honk upgrade` only replaces the copy that the install script recorded in
`~/.local/state/honk/receipt.json`. If you installed honk another way, upgrade
it that way, or run the install script again.

Once a day at most, honk asks GitHub in the background for the latest release
tag. When there is a newer one, the status bar at the bottom shows it, such as
`v0.3.0 available: honk upgrade`, and the status buffer explains it. It only
reads the tag: nothing is downloaded until you run `honk upgrade`. To turn the
check off, set `HONK_NO_UPDATE_CHECK=1`. It is also off when `CI` is set and in
`--demo`.

Behind a proxy, `honk upgrade` and the update check use `HTTPS_PROXY` (or
`ALL_PROXY`) and skip the hosts in `NO_PROXY`, like curl does.

### Uninstall

If you installed honk with the install script, delete the binary, the install
receipt and the update check's cache:

```sh
rm ~/.local/bin/honk
rm -rf ~/.local/state/honk ~/.cache/honk
```

If you installed into another folder with `HONK_INSTALL_DIR`, delete `honk`
from there instead. If you set `XDG_STATE_HOME` or `XDG_CACHE_HOME`, the other
two folders are `$XDG_STATE_HOME/honk` and `$XDG_CACHE_HOME/honk`.

Your config is in `~/.config/honk/`. It can hold server passwords, so delete it
too if you don't need it. If you installed honk another way, remove it that way.

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
`--version` (or `-v`), `--help` (or `-h`).
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

### Notifications

When someone mentions your nick or sends you a DM, honk shows a desktop
notification. It does not notify for the buffer on screen while the terminal
window has focus, and it sends at most one notification per buffer every 10
seconds.

honk asks your terminal to show the notification, so it works over SSH too: the
notification appears on the computer you are sitting at. Terminals that support
it include iTerm2, Ghostty, WezTerm, kitty, foot, GNOME Terminal and other VTE
terminals, and Windows Terminal. In other terminals, honk shows no notification.

Inside tmux, let the notification through to the outer terminal:

```sh
# ~/.tmux.conf
set -g allow-passthrough on
```

To turn notifications off, add this to the top level of the config file:

```json
{ "notifications": false, "servers": [] }
```

### Themes

Choose a color theme at the top level of the config file, or with `--theme`:

```json
{ "theme": "catppuccin-mocha", "servers": [] }
```

The default is `tokyo-night`. honk also has more than 60 built-in themes from
[Tinted Theming](https://github.com/tinted-theming/schemes), such as `nord`,
`dracula` and `gruvbox-dark`.
[src/themes/SOURCE.md](src/themes/SOURCE.md) lists all of them, with their
authors. If you write a name honk does not know, it uses `tokyo-night` and lists
the valid names in `*status`.

To add a theme, put any Base16 or Base24 scheme file from that collection in
`~/.config/honk/themes/`. The file name is the theme's name, so
`~/.config/honk/themes/kanagawa.yaml` is `"theme": "kanagawa"`. honk skips a
file whose text would be hard to read on its background, and says why in
`*status`.

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

The built-in themes are listed in `src/themes/catalog.json`. To choose them by
looking at each one in the demo, run `bun run review-themes` (y keeps a theme, n
leaves it out). After you edit `catalog.json` by hand, run
`bun run fetch-themes`. Both commands rewrite `src/themes/schemes/`,
`bundled.ts` and `SOURCE.md`; commit those files.

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

Set `"version"` in `package.json` to the new version and commit it. Then push a
tag with the same version and a `v` in front. The release workflow builds the
binaries, runs `scripts/test-linux.sh` on an x64 and an arm64 runner, and only
if every distro passes, signs the binaries and attaches them to a GitHub
release. It stops right away if the tag and `package.json` do not match.

```sh
# package.json has "version": "0.2.0"
git tag v0.2.0
git push origin v0.2.0
```

## License

[MIT](LICENSE)
