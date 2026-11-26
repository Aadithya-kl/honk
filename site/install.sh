#!/bin/sh
# Installs honk, a terminal IRC client: https://github.com/agustingianni/honk
#
#   curl -fsSL https://agustingianni.github.io/honk/install.sh | sh
#
# Settings, as environment variables:
#   HONK_VERSION=v0.1.0       install this release instead of the latest one
#   HONK_INSTALL_DIR=~/bin    install into this folder instead of ~/.local/bin
#
# For example:
#   curl -fsSL https://agustingianni.github.io/honk/install.sh | HONK_VERSION=v0.1.0 sh
#
# What it does:
#   1. Finds your OS and CPU, and picks the matching binary from the GitHub release.
#   2. Downloads the binary and SHA256SUMS, and checks the binary's checksum.
#   3. If the GitHub CLI (gh) is installed and logged in, also checks the build
#      provenance attestation: proof that GitHub Actions built the binary from
#      this repo.
#   4. Moves the binary to ~/.local/bin/honk. It never uses sudo and never edits
#      your shell config files.
#
# All the code is inside main(), which only runs on the last line. If the
# download stops halfway, the shell never reaches that line, so nothing runs.

set -eu

REPO="agustingianni/honk"

say() {
	if [ $# -eq 0 ]; then
		printf '\n'
	else
		printf 'honk: %s\n' "$*"
	fi
}

fail() {
	printf 'honk: error: %s\n' "$*" >&2
	exit 1
}

download() { # download <url> <file>
	if command -v curl >/dev/null 2>&1; then
		curl --proto '=https' --tlsv1.2 --fail --silent --show-error --location \
			--retry 3 --output "$2" "$1"
	elif command -v wget >/dev/null 2>&1; then
		wget --https-only --quiet --output-document="$2" "$1"
	else
		fail "this installer needs curl or wget"
	fi
}

sha256_of() { # sha256_of <file>
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum "$1" | cut -d ' ' -f 1
	elif command -v shasum >/dev/null 2>&1; then
		shasum -a 256 "$1" | cut -d ' ' -f 1
	else
		fail "this installer needs sha256sum or shasum to check the download"
	fi
}

detect_target() {
	os=$(uname -s)
	arch=$(uname -m)

	case "$os" in
	Darwin)
		os=darwin
		# On Apple Silicon, a shell that runs under Rosetta 2 reports x86_64.
		# The arm64 binary is faster there, so pick it.
		if [ "$arch" = x86_64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || true)" = 1 ]; then
			arch=arm64
		fi
		;;
	Linux)
		os=linux
		if ldd --version 2>&1 | grep -qi musl; then
			fail "Linux with musl libc (such as Alpine) is not supported yet"
		fi
		;;
	MINGW* | MSYS* | CYGWIN* | Windows_NT)
		fail "Windows is not supported yet"
		;;
	*)
		fail "this OS is not supported: $os"
		;;
	esac

	case "$arch" in
	x86_64 | amd64) arch=x64 ;;
	arm64 | aarch64) arch=arm64 ;;
	*) fail "this CPU is not supported: $arch" ;;
	esac

	printf '%s-%s\n' "$os" "$arch"
}

print_path_help() { # print_path_help <dir>
	# Show $HOME/... rather than /Users/name/... in the line to copy.
	case "$1" in
	"$HOME"/*) dir="\$HOME${1#"$HOME"}" ;;
	*) dir="$1" ;;
	esac
	# shellcheck disable=SC2088 # the ~ paths are only printed, never opened
	case "$(basename "${SHELL:-sh}")" in
	zsh) rc="~/.zshrc" line="export PATH=\"$dir:\$PATH\"" ;;
	bash) rc="~/.bashrc" line="export PATH=\"$dir:\$PATH\"" ;;
	fish) rc="~/.config/fish/config.fish" line="fish_add_path $dir" ;;
	*) rc="your shell's startup file" line="export PATH=\"$dir:\$PATH\"" ;;
	esac
	say
	say "$1 is not on your PATH. Add this line to $rc:"
	say
	say "  $line"
	say
	say "Then open a new terminal."
}

main() {
	target=$(detect_target)
	asset="honk-$target"
	install_dir="${HONK_INSTALL_DIR:-$HOME/.local/bin}"

	if [ -n "${HONK_VERSION:-}" ]; then
		base_url="https://github.com/$REPO/releases/download/$HONK_VERSION"
		version_label="$HONK_VERSION"
	else
		base_url="https://github.com/$REPO/releases/latest/download"
		version_label="the latest release"
	fi

	tmp=$(mktemp -d)
	trap 'rm -rf "$tmp"' EXIT INT TERM

	say "downloading $asset from $version_label"
	download "$base_url/$asset" "$tmp/$asset"
	download "$base_url/SHA256SUMS" "$tmp/SHA256SUMS"

	expected=$(awk -v f="$asset" '$2 == f { print $1 }' "$tmp/SHA256SUMS")
	[ -n "$expected" ] || fail "SHA256SUMS has no entry for $asset"
	actual=$(sha256_of "$tmp/$asset")
	if [ "$actual" != "$expected" ]; then
		fail "checksum mismatch for $asset (expected $expected, got $actual)"
	fi
	say "checksum OK"

	if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
		if gh attestation verify "$tmp/$asset" --repo "$REPO" >/dev/null 2>&1; then
			say "attestation OK (built by GitHub Actions from $REPO)"
		else
			fail "attestation check failed for $asset. Do not run this file."
		fi
	fi

	mkdir -p "$install_dir"
	chmod 755 "$tmp/$asset"
	# Copy next to the target first, then rename, so the swap is atomic and a
	# running honk is not overwritten in place.
	cp "$tmp/$asset" "$install_dir/.honk.new"
	mv -f "$install_dir/.honk.new" "$install_dir/honk"
	say "installed $install_dir/honk"

	case ":$PATH:" in
	*":$install_dir:"*) ;;
	*) print_path_help "$install_dir" ;;
	esac

	say
	say "Try it:"
	say "  honk --server irc.libera.chat --nick your_nick --channel '#libera'"
	say
	say "To connect to several servers at startup, see"
	say "  https://github.com/$REPO#configuration"
}

main "$@"
