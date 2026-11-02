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
HOSTD_PID=""
cleanup() {
  if [[ -n "${OMPWEB_PID:-}" ]] && kill -0 "$OMPWEB_PID" 2>/dev/null; then
    kill "$OMPWEB_PID" 2>/dev/null || true
  fi
  if [[ -n "${HOSTD_PID:-}" ]] && kill -0 "$HOSTD_PID" 2>/dev/null; then
    kill "$HOSTD_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

# Sign-in gate, hash-only: the launcher serves a non-loopback bind only with
# OMP_WEB_PASSWORD_HASH (the scrypt hash from `ompweb hash-password`), and a
# plaintext OMP_WEB_PASSWORD set alongside a hash makes it refuse to start.
# Resolve the hash before the first launch: an explicit hash wins (a stray
# plaintext is dropped with a note); otherwise hash the legacy plaintext ONCE
# and persist it under the bound .omp store, so restarts keep the same sign-in
# state instead of signing every browser out, and re-hash only when the
# password actually changed.
if [[ -n "${OMP_WEB_PASSWORD_HASH:-}" ]]; then
  if [[ -n "${OMP_WEB_PASSWORD:-}" ]]; then
    echo "Note: OMP_WEB_PASSWORD ignored; OMP_WEB_PASSWORD_HASH takes precedence."
    unset OMP_WEB_PASSWORD
  fi
elif [[ -n "${OMP_WEB_PASSWORD:-}" ]]; then
  password_hash_file=/root/.omp/agent/omp-web/docker-password.hash
  if [[ ! -s "$password_hash_file" ]] || \
     ! printf '%s' "$OMP_WEB_PASSWORD" | node -e '
const { readFileSync } = require("node:fs");
const { verifyPassword } = require("/opt/ompweb/bin/omp-web-password-hash.js");
let password = "";
process.stdin.on("data", (chunk) => { password += chunk; });
process.stdin.on("end", () => {
  process.exit(verifyPassword(password, readFileSync(process.argv[1], "utf8").trim()) ? 0 : 1);
});' "$password_hash_file"; then
    mkdir -p "$(dirname "$password_hash_file")"
    if printf '%s' "$OMP_WEB_PASSWORD" | ompweb hash-password > "${password_hash_file}.tmp" 2>/dev/null; then
      mv "${password_hash_file}.tmp" "$password_hash_file"
      chmod 600 "$password_hash_file" 2>/dev/null || true
    else
      rm -f "${password_hash_file}.tmp"
      echo "Warning: could not hash OMP_WEB_PASSWORD; ompweb will refuse the 0.0.0.0 bind."
    fi
  fi
  if [[ -s "$password_hash_file" ]]; then
    export OMP_WEB_PASSWORD_HASH="$(cat "$password_hash_file")"
    unset OMP_WEB_PASSWORD
  fi
fi

while true; do
  ompweb --hostname 0.0.0.0 --port 6767 --no-open &
  OMPWEB_PID=$!
  wait "$OMPWEB_PID"
  OMPWEB_PID=""
  echo "ompweb exited ($?). Restarting in 3s..."
  sleep 3
done &

# The JS host daemon (`ompweb host`) owns this machine's omp children, so a
# web-server restart or upgrade leaves runs going and the new server adopts
# them over the daemon's link (lib/hosts). It is supervised beside the web
# loop: the web server writes the local link (<agent dir>/omp-web/host.json)
# when it boots, so until that exists the daemon exits at once and this loop
# retries — the stdin redirect keeps a token prompt from ever blocking it.
# The reaper's orphan sweep deliberately never touches this daemon (PPid != 1).
while true; do
  ompweb host </dev/null
  echo "ompweb host exited ($?). Restarting in 3s..."
  sleep 3
done &
HOSTD_PID=$!

exec tail -f /dev/null
