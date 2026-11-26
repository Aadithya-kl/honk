#!/bin/sh
# Tests the Linux release binaries and site/install.sh in Docker, on several
# distros and on both x64 and arm64. Run `bun run release` first.
#
#   sh scripts/test-linux.sh                  # every distro and CPU
#   sh scripts/test-linux.sh alpine:3.20      # only these images
#
# On an Apple Silicon Mac, Docker runs the x64 images through emulation.

set -eu
cd "$(dirname "$0")/.."

[ -f dist/honk-linux-x64 ] || {
	echo "dist/ is empty. Run: bun run release" >&2
	exit 1
}

# Same as the release workflow: install.sh checks downloads against this file.
(cd dist && if command -v sha256sum >/dev/null 2>&1; then sha256sum honk-*; else shasum -a 256 honk-*; fi) >dist/SHA256SUMS

if [ $# -gt 0 ]; then
	images="$*"
else
	images="alpine:3.20 debian:12-slim ubuntu:24.04 fedora:41 archlinux:latest"
fi

log=$(mktemp -d)
failed=0
for image in $images; do
	for platform in linux/amd64 linux/arm64; do
		# Arch Linux publishes images for x64 only.
		case "$image" in archlinux*) [ "$platform" = linux/amd64 ] || continue ;; esac

		name="$image ($platform)"
		file="$log/$(printf '%s' "$image-$platform" | tr ':/' '__').log"
		docker run --rm -t --platform "$platform" -e TERM=xterm-256color \
			-v "$PWD/dist:/rel:ro" \
			-v "$PWD/site/install.sh:/install.sh:ro" \
			-v "$PWD/scripts/test-in-container.sh:/test.sh:ro" \
			"$image" sh /test.sh >"$file" 2>&1 || true

		# The demo must run until SIGTERM and then quit, and its screen must
		# show the demo network and channel.
		if grep -q "PASS: demo ran until SIGTERM" "$file" && grep -q "libera.chat" "$file" && grep -q "#honk" "$file"; then
			printf 'PASS  %s\n' "$name"
		else
			printf 'FAIL  %s  (log: %s)\n' "$name" "$file"
			failed=1
		fi
	done
done

[ "$failed" = 0 ] && rm -rf "$log"
exit "$failed"
