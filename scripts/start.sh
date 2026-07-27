#!/usr/bin/env bash
#
# puara-server — start the show stack: soundworks server + OSC bridge.
#
# Both run in this one terminal; Ctrl-C stops both. ENV defaults to `dev`
# (HTTPS, written by scripts/install.sh) and falls back to `default` (plain
# HTTP, desktop testing only) when config/env-dev.yaml is absent.
#
# Usage:
#   ./scripts/start.sh                  server + bridge
#   ./scripts/start.sh --env default    plain HTTP, no certificate
#   ./scripts/start.sh --no-bridge      server only
#   ./scripts/start.sh --dump           also run oscdump on the first OSC port
#   ./scripts/start.sh --serve-ca       only serve the mkcert root CA to phones
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CA_PORT=8001

ENV_NAME=""
RUN_BRIDGE=1
RUN_DUMP=0
SERVE_CA_ONLY=0

while [ $# -gt 0 ]; do
  case "$1" in
    --env) ENV_NAME="${2:?--env needs a name}"; shift 2 ;;
    --no-bridge) RUN_BRIDGE=0; shift ;;
    --dump) RUN_DUMP=1; shift ;;
    --serve-ca) SERVE_CA_ONLY=1; shift ;;
    -h|--help) sed -n '2,15p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

cd "$REPO_ROOT"

info() { printf '\033[1m%s\033[0m\n' "$1"; }
warn() { printf '\033[33m! %s\033[0m\n' "$1"; }

detect_lan_ip() {
  ip -4 -o addr show scope global 2>/dev/null \
    | grep -vE '\b(docker|br-|virbr|veth|tailscale)' \
    | awk '{print $4}' | cut -d/ -f1 | head -1
}

# ------------------------------------------------------- serve the root CA
# Plain HTTP on purpose: a phone that does not trust the CA yet cannot fetch it
# over a certificate signed by that same CA. Only the public certificate is
# exposed here, never the CA private key.
if [ "$SERVE_CA_ONLY" -eq 1 ]; then
  command -v mkcert >/dev/null 2>&1 || { echo "mkcert not found — run ./scripts/install.sh" >&2; exit 1; }
  CAROOT="$(mkcert -CAROOT)"
  [ -f "${CAROOT}/rootCA.pem" ] || { echo "no rootCA.pem in ${CAROOT}" >&2; exit 1; }

  SERVE_DIR="$(mktemp -d)"
  trap 'rm -rf "$SERVE_DIR"' EXIT
  # .crt is the extension both iOS and Android recognize on download
  cp "${CAROOT}/rootCA.pem" "${SERVE_DIR}/rootCA.crt"
  LAN_IP="$(detect_lan_ip || echo 127.0.0.1)"

  info "Serving the mkcert root CA on http://${LAN_IP}:${CA_PORT}/rootCA.crt"
  echo "  Open that URL on the phone, install it, then trust it:"
  echo "    iOS      profile install, THEN Settings > General > About >"
  echo "             Certificate Trust Settings > enable"
  echo "    Android  Settings > Security > Install a certificate > CA certificate"
  echo
  warn "This CA lets whoever holds ${CAROOT}/rootCA-key.pem impersonate any"
  warn "HTTPS site to that phone. Own test devices only; remove it afterwards."
  echo
  echo "  Ctrl-C to stop serving (do that as soon as the phone is enrolled)."
  cd "$SERVE_DIR"
  exec python3 -m http.server "$CA_PORT" --bind "$LAN_IP"
fi

# -------------------------------------------------------------- env pick
if [ -z "$ENV_NAME" ]; then
  if [ -f "config/env-dev.yaml" ]; then
    ENV_NAME="dev"
  else
    ENV_NAME="default"
    warn "no config/env-dev.yaml — falling back to plain HTTP."
    warn "Phone sensors need HTTPS: run ./scripts/install.sh to set it up."
  fi
fi

[ -f "config/env-${ENV_NAME}.yaml" ] \
  || { echo "config/env-${ENV_NAME}.yaml not found" >&2; exit 1; }

[ -f ".build/server.js" ] \
  || { echo ".build/server.js missing — run npm run build (or ./scripts/install.sh)" >&2; exit 1; }

# ------------------------------------------------------------- teardown
PIDS=()
cleanup() {
  trap - INT TERM EXIT
  for pid in "${PIDS[@]:-}"; do
    [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
  echo
  info "stopped"
}
trap cleanup INT TERM EXIT

# --------------------------------------------------------------- server
info "Starting server (ENV=${ENV_NAME})"
ENV="$ENV_NAME" node .build/server.js &
PIDS+=($!)

# The bridge is a soundworks client and needs the server up before it connects.
sleep 2

# --------------------------------------------------------------- bridge
if [ "$RUN_BRIDGE" -eq 1 ]; then
  info "Starting OSC bridge"
  ENV="$ENV_NAME" node .build/clients/puara-bridge.js &
  PIDS+=($!)
fi

# -------------------------------------------------------------- oscdump
if [ "$RUN_DUMP" -eq 1 ]; then
  if ! command -v oscdump >/dev/null 2>&1; then
    warn "oscdump not found (apt install liblo-tools) — skipping --dump"
  else
    OSC_PORT="$(node -e "
      import('./src/shared/load-puara-config.js')
        .then(m => console.log(m.loadPuaraConfig().oscDestinations[0].port));
    " 2>/dev/null || echo 9000)"
    warn "oscdump binds UDP ${OSC_PORT} exclusively — ossia score cannot also"
    warn "listen there. Add a second entry to oscDestinations for both at once."
    info "Starting oscdump on ${OSC_PORT}"
    oscdump "$OSC_PORT" &
    PIDS+=($!)
  fi
fi

echo
info "Running. Ctrl-C to stop everything."
wait
