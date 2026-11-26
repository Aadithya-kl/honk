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
#   2. Downloads the gzipped binary and SHA256SUMS, checks the checksum, and
#      unpacks the binary.
#   3. If the GitHub CLI (gh) is installed and logged in, also checks the build
#      provenance attestation: proof that GitHub Actions built the binary from
#      this repo.
#   4. Moves the binary to ~/.local/bin/honk. It never uses sudo and never edits
#      your shell config files.
#   5. Writes an install receipt to ~/.local/state/honk/receipt.json (or under
#      $XDG_STATE_HOME). It records where this script put honk, so that
#      `honk upgrade` only replaces a copy that this script installed, and never
#      one that Homebrew or another package manager owns.
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
		# BusyBox wget (Alpine) has no --https-only. Our URLs are all https anyway;
		# the flag only stops a redirect to http, so use it where it exists.
		if wget --help 2>&1 | grep -q -- --https-only; then
			wget --https-only -q -O "$2" "$1"
		else
			wget -q -O "$2" "$1"
		fi
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

# True on Linux with musl libc (Alpine, Void musl...). Its dynamic loader is
# /lib/ld-musl-<arch>.so.1, and its ldd prints "musl libc".
is_musl() {
	for loader in /lib/ld-musl-*.so.1; do
		[ -e "$loader" ] && return 0
	done
	ldd --version 2>&1 | grep -qi musl
}

# The musl builds load the C++ runtime (libstdc++ and libgcc) at start, and
# Alpine does not install it by default. Check before downloading 115 MB.
check_musl_libs() {
	for lib in libstdc++.so.6 libgcc_s.so.1; do
		found=""
		for dir in /lib /usr/lib /usr/local/lib; do
			if [ -e "$dir/$lib" ]; then
				found=1
			fi
		done
		if [ -z "$found" ]; then
			fail "honk needs libstdc++ and libgcc, which are not installed. On Alpine, run: apk add libstdc++ libgcc"
		fi
	done
}

detect_target() {
	os=$(uname -s)
	arch=$(uname -m)
	libc=""

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
		if is_musl; then
			libc=-musl
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

	printf '%s-%s%s\n' "$os" "$arch" "$libc"
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

json_string() { # json_string <text>: prints <text> as a quoted JSON string
	# Escape backslashes first, then double quotes. A path with a newline or
	# another control character would still break the JSON; we do not expect one.
	printf '"%s"' "$(printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')"
}

# Records where this script installed honk. `honk upgrade` reads it and only
# replaces the binary at this path. The path has its symlinks resolved, because
# honk compares it with the real path of the running binary.
write_receipt() { # write_receipt <real install dir> <target>
	state_dir="${XDG_STATE_HOME:-$HOME/.local/state}/honk"
	receipt="$state_dir/receipt.json"
	if ! mkdir -p "$state_dir" 2>/dev/null; then
		say "warning: could not create $state_dir, so honk upgrade will not work"
		return 0
	fi
	# Write next to the receipt, then rename, so a reader never sees half a file.
	if {
		printf '{\n'
		printf '  "installer": "install.sh",\n'
		printf '  "path": %s,\n' "$(json_string "$1/honk")"
		printf '  "target": %s,\n' "$(json_string "$2")"
		printf '  "installedAt": "%s"\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
		printf '}\n'
	} 2>/dev/null >"$receipt.new" && mv -f "$receipt.new" "$receipt"; then
		return 0
	fi
	rm -f "$receipt.new"
	say "warning: could not write $receipt, so honk upgrade will not work"
}

main() {
	target=$(detect_target)
	case "$target" in
	*-musl) check_musl_libs ;;
	esac
	binary="honk-$target"
	asset="$binary.gz"
	install_dir="${HONK_INSTALL_DIR:-$HOME/.local/bin}"

	if [ -n "${HONK_VERSION:-}" ]; then
		base_url="https://github.com/$REPO/releases/download/$HONK_VERSION"
		version_label="$HONK_VERSION"
	else
		base_url="https://github.com/$REPO/releases/latest/download"
		version_label="the latest release"
	fi

	command -v gzip >/dev/null 2>&1 || fail "this installer needs gzip to unpack the download"

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
	if ! gzip -dc "$tmp/$asset" >"$tmp/$binary" 2>/dev/null; then
		fail "could not unpack $asset. Its checksum matches, so the release itself is broken: please report it at https://github.com/$REPO/issues"
	fi

	# The attestation covers the unpacked binary too, so `gh attestation verify`
	# also works later on the installed file.
	if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
		if gh attestation verify "$tmp/$binary" --repo "$REPO" >/dev/null 2>&1; then
			say "attestation OK (built by GitHub Actions from $REPO)"
		else
			fail "attestation check failed for $binary. Do not run this file."
		fi
	fi

	mkdir -p "$install_dir"
	chmod 755 "$tmp/$binary"
	# Copy next to the target first, then rename, so the swap is atomic and a
	# running honk is not overwritten in place.
	cp "$tmp/$binary" "$install_dir/.honk.new"
	mv -f "$install_dir/.honk.new" "$install_dir/honk"
	say "installed $install_dir/honk"
	write_receipt "$(cd "$install_dir" && pwd -P)" "$target"

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
