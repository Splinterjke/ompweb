#!/usr/bin/env bash
set -uo pipefail

unset GIT_SSH GIT_SSH_COMMAND 2>/dev/null || true
if [[ -n "${LC_ALL:-}" ]] && ! locale -a 2>/dev/null | grep -qi "^${LC_ALL}$"; then
  export LC_ALL=C.UTF-8
fi

git config --global safe.directory /work
git config --global commit.gpgsign false
git config --global tag.gpgSign false
git config --global user.name "agent"
git config --global user.email "agent@net"

if [[ $# -gt 0 ]]; then
  if [[ "$1" == "omp" ]]; then shift; fi
  exec "$@"
fi

echo "Container ready. Starting ompweb as a child (container stays alive)."
OMPWEB_PID=""
cleanup() {
  if [[ -n "${OMPWEB_PID:-}" ]] && kill -0 "$OMPWEB_PID" 2>/dev/null; then
    kill "$OMPWEB_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

# Pin the Rust host binary to the image's canonical vendor layout
# (vendor/ompweb-host/<plat>-<arch>/ompweb-host), the path the launcher probes.
# Set explicitly so the exact path stays authoritative even if the vendor probe
# regresses. An externally-provided OMPWEB_HOST_BIN (e.g. a bind-mounted host
# build) wins — only the default is computed from the container arch.
case "$(uname -m)" in aarch64|arm64) OMPWEB_HOST_ARCH=arm64 ;; *) OMPWEB_HOST_ARCH=x64 ;; esac
export OMPWEB_HOST_BIN="${OMPWEB_HOST_BIN:-/opt/ompweb/vendor/ompweb-host/linux-${OMPWEB_HOST_ARCH}/ompweb-host}"

while true; do
  ompweb --hostname 0.0.0.0 --port 6767 --no-open &
  OMPWEB_PID=$!
  wait "$OMPWEB_PID"
  OMPWEB_PID=""
  echo "ompweb exited ($?). Restarting in 3s..."
  sleep 3
done &

exec tail -f /dev/null
