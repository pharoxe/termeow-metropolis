#!/usr/bin/env bash
# Bring Terminal V up on this machine from a git clone. Idempotent.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="${HERE}"
PY="${PYTHON:-python3}"

command -v "${PY}" >/dev/null || { echo "no ${PY} on PATH"; exit 1; }
"${PY}" - <<'V'
import sys
assert sys.version_info >= (3, 9), "Terminal V needs Python 3.9+, found %s" % (sys.version,)
print("python ok: %d.%d.%d" % sys.version_info[:3])
V

echo "==> venv + deps"
[ -d "${HERE}/.venv" ] || "${PY}" -m venv "${HERE}/.venv"
"${HERE}/.venv/bin/pip" install -q --upgrade pip
"${HERE}/.venv/bin/pip" install -q -r "${HERE}/requirements.txt"

[ -f "${HERE}/.env" ] || { cp "${HERE}/.env.example" "${HERE}/.env"; echo "created .env — fill TERMINAL_CONTACT_EMAIL"; }
mkdir -p "${HERE}/data" "${HOME}/.hermes/logs"

echo "==> byte-compiling"
"${HERE}/.venv/bin/python" -m compileall -q "${APP}" >/dev/null || true

VENVPY="${HERE}/.venv/bin/python"
case "$(uname -s)" in
  Darwin)
    P="${HOME}/Library/LaunchAgents/com.hermes.terminal.plist"
    if [ -f "${P}" ] && ! grep -q "${APP}/server.py" "${P}" && [ "${FORCE:-0}" != "1" ]; then
      echo "!! com.hermes.terminal already exists and points elsewhere:"
      grep -o '[^<>]*server\.py' "${P}" | head -1
      echo "   refusing to replace it. Re-run with FORCE=1 to override,"
      echo "   or start this copy manually: ${VENVPY} ${APP}/server.py --port 9301"
      exit 3
    fi
    sed -e "s|__PYTHON__|${VENVPY}|g" -e "s|__APPDIR__|${APP}|g" \
        -e "s|__LOGDIR__|${HOME}/.hermes/logs|g" \
        "${HERE}/deploy/com.hermes.terminal.plist" > "${P}"
    launchctl unload "${P}" 2>/dev/null || true
    launchctl load "${P}"
    echo "==> launchd loaded: com.hermes.terminal" ;;
  Linux)
    mkdir -p "${HOME}/.config/systemd/user"
    U="${HOME}/.config/systemd/user/terminal-v.service"
    sed -e "s|__PYTHON__|${VENVPY}|g" -e "s|__APPDIR__|${APP}|g" \
        "${HERE}/deploy/terminal-v.service" > "${U}"
    systemctl --user daemon-reload
    systemctl --user enable --now terminal-v.service
    echo "==> systemd unit enabled: terminal-v" ;;
  *) echo "unknown OS — run: ${VENVPY} ${APP}/server.py --port 9300" ;;
esac
echo "==> http://127.0.0.1:9300/"
