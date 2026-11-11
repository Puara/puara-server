#!/usr/bin/env bash
#
# puara-server — one-shot setup for a Linux or macOS workstation or show
# machine. On Windows, use scripts\install.cmd instead.
#
# Safe to rerun: every step checks its own result first and skips if already
# done. Nothing that already exists is overwritten — not the certificate, not
# config/env-dev.yaml. Delete the file yourself if you want it regenerated.
#
# No sudo required. mkcert lands in ~/.local/bin. macOS's own bash 3.2 runs
# this, so keep it that way: no associative arrays, mapfile or ${x,,}.
#
# Usage: ./scripts/install.sh [--no-https]
#
set -euo pipefail

MKCERT_VERSION="v1.4.4"
# sha256 of each release binary (the release publishes none). linux-amd64 was
# verified on the machine this was first written for; the others were taken
# from the same release on 2026-11-11. Bump them all with the version, and keep
# scripts/install.ps1 in step.
mkcert_sha256() {
  case "$1" in
    linux-amd64)  echo "6d31c65b03972c6dc4a14ab429f2928300518b26503f58723e532d1b0a3bbb52" ;;
    linux-arm64)  echo "b98f2cc69fd9147fe4d405d859c57504571adec0d3611c3eefd04107c7ac00d0" ;;
    darwin-amd64) echo "a32dfab51f1845d51e810db8e47dcf0e6b51ae3422426514bf5a2b8302e97d4e" ;;
    darwin-arm64) echo "c8af0df44bce04359794dad8ea28d750437411d632748049d08644ffb66a60c6" ;;
  esac
}
NODE_MIN_MAJOR=18

case "$(uname -s)" in
  Linux)  OS=linux ;;
  Darwin) OS=darwin ;;
  *)
    echo "unsupported system: $(uname -s)." >&2
    echo "On Windows, run scripts\\install.cmd from a Command Prompt or PowerShell." >&2
    exit 1 ;;
esac
case "$(uname -m)" in
  x86_64|amd64)  ARCH=amd64 ;;
  arm64|aarch64) ARCH=arm64 ;;
  *)             ARCH="$(uname -m)" ;;
esac

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CERT_DIR="${REPO_ROOT}/certs"
ENV_FILE="${REPO_ROOT}/config/env-dev.yaml"
LOCAL_BIN="${HOME}/.local/bin"
# macOS gives each user a private TMPDIR; Linux usually leaves it unset
LOG_DIR="${TMPDIR:-/tmp}"
LOG_DIR="${LOG_DIR%/}"
ADDON_LOG="${LOG_DIR}/puara-addon-build.log"
BUILD_LOG="${LOG_DIR}/puara-build.log"

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
  if [ "$OS" = darwin ]; then
    echo "node not found. Install Node.js >= ${NODE_MIN_MAJOR} (the LTS installer from nodejs.org, or brew install node) and rerun." >&2
  else
    echo "node not found. Install Node.js >= ${NODE_MIN_MAJOR} (nvm, nodesource or your distro) and rerun." >&2
  fi
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt "$NODE_MIN_MAJOR" ]; then
  echo "node $(node -v) is too old — soundworks 5 needs >= ${NODE_MIN_MAJOR}." >&2
  exit 1
fi
ok "node $(node -v)"

# ---------------------------------------------------------- dependencies
# `npm ci` installs exactly what package-lock.json pins, so every machine builds
# the tree that was tested — a fresh upstream release cannot change it under a
# show. It replaces node_modules on each run; bump versions with `npm install`
# and commit the lockfile.
step "Installing npm dependencies"
npm ci --no-fund --no-audit
ok "node_modules ready"

# ------------------------------------------------------- LAN IP detection
# Skips docker/VM/VPN adapters — phones need the real interface address. In
# Node, so Linux, macOS and Windows all choose it the same way.
LAN_IP="$(node scripts/lan-ip.mjs || true)"

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

# The bare host name; the certificate also gets <name>.local. macOS answers
# `hostname` with the .local name already, so ask it for the Bonjour name.
host_name() {
  if [ "$OS" = darwin ]; then
    scutil --get LocalHostName 2>/dev/null || hostname -s
  else
    hostname
  fi
}

# --------------------------------------------------------------- mkcert
if [ "$WANT_HTTPS" -eq 1 ]; then
  step "Setting up mkcert (HTTPS for real phones)"

  MKCERT_SHA256="$(mkcert_sha256 "${OS}-${ARCH}")"
  if command -v mkcert >/dev/null 2>&1; then
    skip "mkcert already installed ($(command -v mkcert))"
  elif [ -x "${LOCAL_BIN}/mkcert" ]; then
    skip "mkcert already installed (${LOCAL_BIN}/mkcert)"
  elif [ -z "$MKCERT_SHA256" ]; then
    echo "no pinned mkcert build for ${OS}-${ARCH}." >&2
    echo "Install mkcert yourself (https://github.com/FiloSottile/mkcert), or rerun with --no-https." >&2
    exit 1
  else
    mkdir -p "$LOCAL_BIN"
    TMP_MKCERT="$(mktemp)"
    trap 'rm -f "$TMP_MKCERT"' EXIT
    URL="https://github.com/FiloSottile/mkcert/releases/download/${MKCERT_VERSION}/mkcert-${MKCERT_VERSION}-${OS}-${ARCH}"
    echo "    downloading ${MKCERT_VERSION} (${OS}-${ARCH})…"
    curl -sSfL -o "$TMP_MKCERT" "$URL"
    GOT="$(sha256_of "$TMP_MKCERT")"
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
    HOST="$(host_name)"
    ( cd "$CERT_DIR" && "$MKCERT" "$LAN_IP" "${HOST}.local" "$HOST" localhost 127.0.0.1 )
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
# The bridge runs the real C++ puara-gestures descriptors through a Node addon
# compiled against a checkout of that library. Optional — without it the
# audience system runs as usual, and the bridge says so at startup instead of
# failing.
step "Building the puara-gestures addon"
GESTURES_PATH="${PUARA_GESTURES_PATH:-$(cd "${REPO_ROOT}/.." && pwd)/puara-gestures}"

if [ ! -f "${GESTURES_PATH}/include/puara/gestures.h" ]; then
  warn "puara-gestures not found at ${GESTURES_PATH}"
  skip "clone it beside this repo, or set PUARA_GESTURES_PATH, and rerun"
  skip "the server still runs; there will be no /puara/gestures output"
elif [ ! -f "${GESTURES_PATH}/3rdparty/IMU_Sensor_Fusion/imu_orientation.cpp" ]; then
  warn "${GESTURES_PATH} is missing its 3rdparty submodule"
  skip "run: git -C '${GESTURES_PATH}' submodule update --init --recursive"
elif [ "$OS" = darwin ] && ! xcode-select -p >/dev/null 2>&1; then
  # /usr/bin/c++ exists on every Mac, but only as a stub until the tools are in
  warn "Xcode command line tools not installed — skipping the addon"
  skip "run: xcode-select --install   then rerun this script"
elif [ "$OS" = linux ] && ! command -v c++ >/dev/null 2>&1 && ! command -v g++ >/dev/null 2>&1; then
  warn "no C++ compiler found — skipping the addon"
  skip "install build-essential (or your distro's g++) and rerun"
else
  ok "puara-gestures at ${GESTURES_PATH}"
  ok "on branch $(git -C "$GESTURES_PATH" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '(not a git checkout)')"
  # node-gyp downloads the matching node headers into ~/.cache/node-gyp on first
  # use. Offline machines that carry system headers (a distro nodejs-dev) can be
  # pointed at them instead, so try that before giving up.
  if PUARA_GESTURES_PATH="$GESTURES_PATH" npx node-gyp rebuild --directory=native >"$ADDON_LOG" 2>&1; then
    ok "addon built"
  elif [ "$OS" = linux ] && PUARA_GESTURES_PATH="$GESTURES_PATH" npx node-gyp rebuild --directory=native --nodedir=/usr >>"$ADDON_LOG" 2>&1; then
    ok "addon built against system node headers"
  else
    warn "addon build failed — see ${ADDON_LOG}"
    # The addon uses descriptors that are still open puara-gestures PRs, so a
    # checkout of that repo's main fails on the first one it lacks.
    if grep -qE "namespace .puara_gestures." "$ADDON_LOG"; then
      skip "this checkout lacks descriptors the addon uses (open puara-gestures PRs)"
      skip "assemble them, then rerun: ./scripts/combine-gestures-prs.sh --all --exclude 135 --build"
    fi
    skip "the server still runs, without the C++ descriptors"
  fi
fi

# ---------------------------------------------------------------- build
step "Building"
if ! npm run build 2>&1 | tee "$BUILD_LOG"; then
  warn "build failed — see ${BUILD_LOG}"
  # @swc/core >= 1.16 unpacks its native binary into ~/.cache on first load and
  # refuses if a directory above it is group- or world-writable.
  if grep -q "ERR_SWC_NATIVE_CACHE" "$BUILD_LOG"; then
    skip "swc will not unpack into ~/.cache: a parent directory is writable by another user"
    if [ "$OS" = darwin ]; then
      skip "check: stat -f '%Lp %Su %N' / /Users ~ ~/.cache   (fix: chmod go-w on the writable one)"
    else
      skip "check: stat -c '%a %U %n' / /home ~ ~/.cache   (fix: chmod go-w on the writable one)"
    fi
    skip "or point swc at a fresh dir outside it: SWC_NATIVE_BINDING_CACHE=/tmp/swc-\$USER npm run build"
  fi
  exit 1
fi
ok "build complete"

# ------------------------------------------------------------- summary
step "Done"
cat <<EOF
    Start the server:   ./scripts/start.sh
    Watch the C++ descriptors: ./scripts/start.sh --dump  (or the dashboard)
    Desktop only:       ./scripts/start.sh --env default

EOF

if [ "$OS" = darwin ]; then
  cat <<EOF
    macOS: if the firewall is on, allow incoming connections for "node" when
    it first asks, or phones will not reach the server.

EOF
fi

if [ "$WANT_HTTPS" -eq 1 ] && [ -n "${MKCERT:-}" ] && [ -x "$MKCERT" ]; then
  CAROOT="$("$MKCERT" -CAROOT 2>/dev/null || true)"
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
