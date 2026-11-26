#!/bin/sh
# Runs inside one Linux container, started by scripts/test-linux.sh.
#
# 1. Checks that install.sh's download() works with this distro's curl or wget,
#    against a real https URL.
# 2. Runs install.sh. A stand-in for curl/wget serves the release files from
#    /rel instead of GitHub, so this works before a release exists.
# 3. Checks that install.sh picked the right binary for this CPU and libc.
# 4. Runs `honk --demo` for a few seconds. The caller checks the screen output.
#
# Mounted: /install.sh (site/install.sh) and /rel (dist/, with SHA256SUMS).

set -eu

# shellcheck disable=SC1091 # only exists inside the container
. /etc/os-release
echo "== $PRETTY_NAME, $(uname -m)"

# Debian and Ubuntu container images have no curl or wget. Real systems almost
# always have curl, so install it.
if ! command -v curl >/dev/null 2>&1 && ! command -v wget >/dev/null 2>&1; then
	if command -v apt-get >/dev/null 2>&1; then
		apt-get update -qq >/dev/null
		apt-get install -y -qq curl ca-certificates >/dev/null 2>&1
	fi
fi
tool=$(command -v curl || command -v wget)
echo "download tool: $tool"

# 1. The real download(), with the real tool. Load install.sh without its last
#    line (the call to main).
sed '$d' /install.sh >/tmp/install-lib.sh
# shellcheck disable=SC1091 # written just above
. /tmp/install-lib.sh
download https://agustingianni.github.io/honk/install.sh /tmp/live-install.sh
[ "$(head -n 1 /tmp/live-install.sh)" = "#!/bin/sh" ] || {
	echo "FAIL: download() fetched something unexpected"
	exit 1
}
echo "PASS: download() works over https"

# 2. install.sh, with the stand-in for the download tool.
mkdir -p /shim
cat >/shim/"$(basename "$tool")" <<EOF
#!/bin/sh
# Test stand-in for curl and wget: copies release files from /rel.
out=""; url=""
while [ \$# -gt 0 ]; do
	case "\$1" in
	--help) exec "$tool" --help ;;
	--output | -O) out=\$2; shift ;;
	--output-document=*) out=\${1#*=} ;;
	https://*) url=\$1 ;;
	esac
	shift
done
cp "/rel/\${url##*/}" "\$out"
EOF
chmod +x /shim/*

# On Alpine, honk needs libstdc++ and libgcc, which the image does not have.
# install.sh must stop and say how to add them, then work once they are there.
if [ "$ID" = alpine ]; then
	if HOME=/root PATH="/shim:$PATH" sh /install.sh >/tmp/no-libs.log 2>&1; then
		echo "FAIL: install.sh did not notice that libstdc++ is missing"
		exit 1
	fi
	grep -q "apk add libstdc++ libgcc" /tmp/no-libs.log || {
		cat /tmp/no-libs.log
		echo "FAIL: install.sh did not say how to add libstdc++"
		exit 1
	}
	echo "PASS: install.sh stops and asks for libstdc++ and libgcc"
	apk add -q libstdc++ libgcc
fi

HOME=/root PATH="/shim:$PATH" sh /install.sh

# 3. The right binary: compare with what this machine should get.
case "$(uname -m)" in
x86_64) want=honk-linux-x64 ;;
aarch64) want=honk-linux-arm64 ;;
*) want="unknown-$(uname -m)" ;;
esac
[ "$ID" = alpine ] && want="$want-musl"
want_sum=$(awk -v f="$want" '$2 == f { print $1 }' /rel/SHA256SUMS)
got_sum=$(sha256sum /root/.local/bin/honk | cut -d ' ' -f 1)
if [ "$got_sum" != "$want_sum" ]; then
	echo "FAIL: installed binary is not $want"
	exit 1
fi
echo "PASS: install.sh installed $want"

# 4. The demo. After 6 seconds, timeout sends SIGTERM, and 4 seconds later
#    SIGKILL if honk is still running. honk passes if it was still running at
#    6 seconds and quit by itself after SIGTERM.
#    GNU timeout runs the command in a background process group unless given
#    --foreground, and there honk is stopped (SIGTTOU) when it sets up the
#    terminal. BusyBox timeout (Alpine) has no such flag and needs none.
stty cols 140 rows 40 2>/dev/null || true
fg=""
if timeout --help 2>&1 | grep -q -- --foreground; then
	fg=--foreground
fi
set +e
start=$(date +%s)
timeout $fg -k 4 6 /root/.local/bin/honk --demo
code=$?
elapsed=$(($(date +%s) - start))
echo
echo "demo exit code $code after $elapsed seconds"
if [ "$elapsed" -ge 6 ] && [ "$elapsed" -lt 10 ] && [ "$code" -ne 137 ]; then
	echo "PASS: demo ran until SIGTERM, then quit"
else
	echo "FAIL: demo stopped early, or ignored SIGTERM"
fi
