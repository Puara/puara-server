#!/usr/bin/env bash
#
# puara-server — one-shot setup for a Linux workstation or show machine.
#
# Safe to rerun: every step checks its own result first and skips if already
# done. Nothing that already exists is overwritten — not the certificate, not
# config/env-dev.yaml. Delete the file yourself if you want it regenerated.
#
# No sudo required. mkcert lands in ~/.local/bin.
#
# Usage: ./scripts/install.sh [--no-https]
#
set -euo pipefail

MKCERT_VERSION="v1.4.4"
# sha256 of the linux-amd64 release binary, verified on the machine this was
# written for. Bump both together when moving to a newer mkcert.
MKCERT_SHA256="6d31c65b03972c6dc4a14ab429f2928300518b26503f58723e532d1b0a3bbb52"
NODE_MIN_MAJOR=18

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CERT_DIR="${REPO_ROOT}/certs"
ENV_FILE="${REPO_ROOT}/config/env-dev.yaml"
LOCAL_BIN="${HOME}/.local/bin"

WANT_HTTPS=1
for arg in "$@"; do
  case "$arg" in
    --no-https) WANT_HTTPS=0 ;;
    -h|--help) sed -n '2,12p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
skip() { printf '    \033[2m· %s\033[0m\n' "$1"; }
ok()   { printf '    \033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '    \033[33m!\033[0m %s\n' "$1"; }

cd "$REPO_ROOT"

# ---------------------------------------------------------------- node
step "Checking Node.js"
if ! command -v node >/dev/null 2>&1; then
  echo "node not found. Install Node.js >= ${NODE_MIN_MAJOR} (nvm, nodesource or your distro) and rerun." >&2
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt "$NODE_MIN_MAJOR" ]; then
  echo "node $(node -v) is too old — soundworks 5 needs >= ${NODE_MIN_MAJOR}." >&2
  exit 1
fi
ok "node $(node -v)"

# ---------------------------------------------------------- dependencies
# package-lock.json is gitignored in this repo, so `npm ci` is not an option.
step "Installing npm dependencies"
npm install --no-fund --no-audit
ok "node_modules ready"

# ------------------------------------------------------- LAN IP detection
# Skip docker/virtual bridges — phones need the real interface address.
detect_lan_ip() {
  ip -4 -o addr show scope global 2>/dev/null \
    | grep -vE '\b(docker|br-|virbr|veth|tailscale)' \
    | awk '{print $4}' | cut -d/ -f1 | head -1
}

LAN_IP="$(detect_lan_ip || true)"

# --------------------------------------------------------------- mkcert
if [ "$WANT_HTTPS" -eq 1 ]; then
  step "Setting up mkcert (HTTPS for real phones)"

  if command -v mkcert >/dev/null 2>&1; then
    skip "mkcert already installed ($(command -v mkcert))"
  else
    mkdir -p "$LOCAL_BIN"
    TMP_MKCERT="$(mktemp)"
    trap 'rm -f "$TMP_MKCERT"' EXIT
    URL="https://github.com/FiloSottile/mkcert/releases/download/${MKCERT_VERSION}/mkcert-${MKCERT_VERSION}-linux-amd64"
    echo "    downloading ${MKCERT_VERSION}…"
    curl -sSfL -o "$TMP_MKCERT" "$URL"
    GOT="$(sha256sum "$TMP_MKCERT" | awk '{print $1}')"
    if [ "$GOT" != "$MKCERT_SHA256" ]; then
      echo "mkcert checksum mismatch — refusing to install." >&2
      echo "  expected ${MKCERT_SHA256}" >&2
      echo "  got      ${GOT}" >&2
      exit 1
    fi
    install -m 755 "$TMP_MKCERT" "${LOCAL_BIN}/mkcert"
    rm -f "$TMP_MKCERT"; trap - EXIT
    ok "mkcert installed to ${LOCAL_BIN}/mkcert"
    case ":${PATH}:" in
      *":${LOCAL_BIN}:"*) ;;
      *) warn "${LOCAL_BIN} is not on your PATH — add it to use mkcert directly" ;;
    esac
  fi

  MKCERT="$(command -v mkcert || echo "${LOCAL_BIN}/mkcert")"

  # ------------------------------------------------------ certificate
  step "Issuing the LAN certificate"
  mkdir -p "$CERT_DIR"
  EXISTING_CERT="$(find "$CERT_DIR" -maxdepth 1 -name '*.pem' ! -name '*-key.pem' | head -1)"

  if [ -n "$EXISTING_CERT" ]; then
    skip "certificate already present: $(basename "$EXISTING_CERT")"
    skip "delete certs/*.pem and rerun to reissue (phones keep trusting the same CA)"
    CERT_FILE="$EXISTING_CERT"
  elif [ -z "$LAN_IP" ]; then
    warn "no LAN IP detected — skipping certificate. Connect to a network and rerun."
    CERT_FILE=""
  else
    ( cd "$CERT_DIR" && "$MKCERT" "$LAN_IP" "$(hostname).local" "$(hostname)" localhost 127.0.0.1 )
    CERT_FILE="$(find "$CERT_DIR" -maxdepth 1 -name '*.pem' ! -name '*-key.pem' | head -1)"
    ok "certificate issued for ${LAN_IP}"
  fi

  # --------------------------------------------------- env-dev.yaml
  step "Writing config/env-dev.yaml"
  if [ -f "$ENV_FILE" ]; then
    skip "config/env-dev.yaml exists — left untouched"
  elif [ -z "$CERT_FILE" ]; then
    warn "no certificate, so no env-dev.yaml — rerun once you have a LAN IP"
  else
    KEY_FILE="${CERT_FILE%.pem}-key.pem"
    cat > "$ENV_FILE" <<YAML
type: development
port: 8000
serverAddress: '${LAN_IP}'
useHttps: true
httpsInfos:
  cert: ${CERT_FILE}
  key: ${KEY_FILE}
baseUrl: ''
auth:
  clients: []
  login: ''
  password: ''
YAML
    ok "config/env-dev.yaml written (gitignored)"
  fi
else
  step "Skipping HTTPS setup (--no-https)"
  skip "phones will have no motion sensors over plain HTTP — desktop testing only"
fi

# ------------------------------------------------------- native addon
# gesture-tester branch: the bridge runs the real C++ puara-gestures descriptors
# through a Node addon compiled against a checkout of that library. Optional —
# without it the audience system runs exactly as on main, and the bridge says so
# at startup instead of failing.
step "Building the puara-gestures addon"
GESTURES_PATH="${PUARA_GESTURES_PATH:-$(cd "${REPO_ROOT}/.." && pwd)/puara-gestures}"

if [ ! -f "${GESTURES_PATH}/include/puara/gestures.h" ]; then
  warn "puara-gestures not found at ${GESTURES_PATH}"
  skip "clone it beside this repo, or set PUARA_GESTURES_PATH, and rerun"
  skip "the server still runs; there will be no /puara/gestures output"
elif [ ! -f "${GESTURES_PATH}/3rdparty/IMU_Sensor_Fusion/imu_orientation.cpp" ]; then
  warn "${GESTURES_PATH} is missing its 3rdparty submodule"
  skip "run: git -C '${GESTURES_PATH}' submodule update --init --recursive"
elif ! command -v c++ >/dev/null 2>&1 && ! command -v g++ >/dev/null 2>&1; then
  warn "no C++ compiler found — skipping the addon"
  skip "install build-essential (or Xcode command line tools) and rerun"
else
  ok "puara-gestures at ${GESTURES_PATH}"
  ok "on branch $(git -C "$GESTURES_PATH" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '(not a git checkout)')"
  # node-gyp downloads the matching node headers into ~/.cache/node-gyp on first
  # use. Offline machines that carry system headers (a distro nodejs-dev) can be
  # pointed at them instead, so try that before giving up.
  if PUARA_GESTURES_PATH="$GESTURES_PATH" npx node-gyp rebuild --directory=native >/tmp/puara-addon-build.log 2>&1; then
    ok "addon built"
  elif PUARA_GESTURES_PATH="$GESTURES_PATH" npx node-gyp rebuild --directory=native --nodedir=/usr >>/tmp/puara-addon-build.log 2>&1; then
    ok "addon built against system node headers"
  else
    warn "addon build failed — see /tmp/puara-addon-build.log"
    skip "the server still runs, without the C++ descriptors"
  fi
fi

# ---------------------------------------------------------------- build
step "Building"
npm run build
ok "build complete"

# ------------------------------------------------------------- summary
step "Done"
cat <<EOF
    Start the server:   ./scripts/start.sh
    Watch the C++ descriptors: ./scripts/start.sh --dump  (or the dashboard)
    Desktop only:       ./scripts/start.sh --env default

EOF

if [ "$WANT_HTTPS" -eq 1 ] && command -v mkcert >/dev/null 2>&1; then
  CAROOT="$(mkcert -CAROOT 2>/dev/null || true)"
  cat <<EOF
    Each test phone needs the mkcert root CA installed once, or wss:// fails
    silently and the sensors stay dark:

      CA file: ${CAROOT}/rootCA.pem
      Serve it to the phone: ./scripts/start.sh --serve-ca

    iOS   install the profile, THEN Settings > General > About >
          Certificate Trust Settings > enable it (both steps required)
    Android  Settings > Security > Install a certificate > CA certificate

    Installing a CA lets whoever holds ${CAROOT}/rootCA-key.pem
    impersonate any HTTPS site to that phone. Keep that key on this machine,
    use your own test devices, and remove the CA from the phone when done.
    Audience devices should never install it — see docs/DEPLOYMENT.md tier 2.
EOF
fi
