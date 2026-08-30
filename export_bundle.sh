#!/usr/bin/env bash
# Export Terminal V as a portable, self-describing bundle.
#
#   ./export_bundle.sh [--with-data] [--out DIR] [--no-git]
#
# Produces <out>/terminal-v-<stamp>/ plus a .tar.gz and a .sha256.
# Code is COPIED then SANITISED (the originals are never touched):
#   * the owner's contact email in SEC/CoinGecko User-Agents -> placeholder
#   * the one hardcoded /Users/vish CIK map path -> env-overridable
#   * .env, data/, __pycache__ and every *.bak* are excluded by construction
# Anything else that still names an absolute path is REPORTED in MANIFEST.txt
# rather than silently rewritten.
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="${HOME}/terminal-v-export"
WITH_DATA=0
DO_GIT=1

while [ $# -gt 0 ]; do
  case "$1" in
    --with-data) WITH_DATA=1; shift ;;
    --no-git)    DO_GIT=0; shift ;;
    --out)       OUT="$2"; shift 2 ;;
    -h|--help)   sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
done

BUNDLE="${OUT}/terminal-v-${STAMP}"
APP="${BUNDLE}/terminal"
mkdir -p "${APP}/datasources" "${APP}/static" "${BUNDLE}/deploy"

echo "==> copying code from ${SRC}"
# Top-level modules and helper scripts, excluding backups.
for f in "${SRC}"/*.py "${SRC}"/*.sh "${SRC}"/*.txt; do
  [ -e "$f" ] || continue
  case "$f" in *.bak*|*export_bundle.sh) continue ;; esac
  cp "$f" "${APP}/"
done
for f in "${SRC}"/datasources/*.py; do
  case "$f" in *.bak*) continue ;; esac
  cp "$f" "${APP}/datasources/"
done
for f in "${SRC}"/static/*; do
  # _-prefixed files are local scratch (design labs, probes) — not product.
  case "$f" in *.bak*|*/_*) continue ;; esac
  [ -f "$f" ] && cp "$f" "${APP}/static/"
done
mkdir -p "${APP}/data"
cat > "${APP}/data/.gitkeep" <<'K'
K

if [ "${WITH_DATA}" = "1" ]; then
  echo "==> copying accrued data (this history CANNOT be refetched)"
  for f in "${SRC}"/data/*.json "${SRC}"/data/*.db; do
    [ -e "$f" ] || continue
    case "$f" in *.tmp|*.lock) continue ;; esac
    cp "$f" "${APP}/data/"
  done
fi

echo "==> sanitising the copy"
EMAIL_RE='vish2030@gmail\.com'
grep -rl "${EMAIL_RE}" "${APP}" 2>/dev/null | while read -r f; do
  sed -i '' "s/${EMAIL_RE}/__CONTACT_EMAIL__/g" "$f" 2>/dev/null \
    || sed -i "s/${EMAIL_RE}/__CONTACT_EMAIL__/g" "$f"
done
# The single hardcoded absolute path, made env-overridable.
# The deepdive layer hardcodes ~/.hermes/terminal/data for its OWN state,
# unlike every other module (which resolves relative to __file__). On a second
# machine that writes outside the install. Repoint at the bundle's data dir.
python3 - "${APP}" <<'PY2'
import os, re, sys
app = sys.argv[1]
rel = ('os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "%s")')
for fn, var, base in (("deepdive.py", "DEEPDIVE_DB", "deepdive.db"),
                      ("deepdive_worker.py", "LOCK", "deepdive.lock")):
    p = os.path.join(app, fn)
    if not os.path.exists(p):
        continue
    s = open(p).read()
    new = re.sub(r'^%s = os\.path\.expanduser\("~/\.hermes/terminal/data/[^"]*"\)' % var,
                 "%s = %s" % (var, rel % base), s, count=1, flags=re.M)
    if new != s:
        open(p, "w").write(new)
        print("   repointed %s in %s" % (var, fn))
PY2

INS="${APP}/datasources/insiders.py"
if [ -f "${INS}" ]; then
  python3 - "${INS}" <<'PY'
import re, sys
p = sys.argv[1]
s = open(p).read()
s = re.sub(
    r'^CIK_MAP_PATH = "/Users/[^"]*"',
    'CIK_MAP_PATH = os.path.expanduser(os.environ.get(\n'
    '    "TERMINAL_CIK_MAP", "~/.hermes/trading_system/equity/cik_map.json"))',
    s, count=1, flags=re.M)
open(p, "w").write(s)
PY
fi

echo "==> writing requirements / env template"
cat > "${BUNDLE}/requirements.txt" <<'R'
# Terminal V runs on the standard library. This is the entire dependency tree.
websockets>=12.0
# Linux/Windows only: zoneinfo has no bundled tz database off macOS.
tzdata; sys_platform != "darwin"
R

cat > "${BUNDLE}/.env.example" <<'E'
# Copy to .env and fill in. Nothing here is required to boot; each missing
# value degrades one pane rather than breaking the server.

# Sent as the contact in SEC EDGAR / CoinGecko User-Agent headers.
# SEC's fair-access policy expects a real address. install.sh substitutes it.
TERMINAL_CONTACT_EMAIL=you@example.com

# Earnings calendar (EVENT RADAR). Free tier is NON-COMMERCIAL.
FINNHUB_API_KEY=

# Optional: SEC CIK map used by the INSIDERS pane.
# TERMINAL_CIK_MAP=~/.hermes/trading_system/equity/cik_map.json
E

echo "==> writing deploy units"
cat > "${BUNDLE}/deploy/com.hermes.terminal.plist" <<'P'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>com.hermes.terminal</string>
    <key>ProgramArguments</key>
    <array>
        <string>__PYTHON__</string>
        <string>__APPDIR__/server.py</string>
        <string>--port</string><string>9300</string>
    </array>
    <key>WorkingDirectory</key><string>__APPDIR__</string>
    <key>EnvironmentVariables</key>
    <dict><key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>ThrottleInterval</key><integer>10</integer>
    <key>StandardOutPath</key><string>__LOGDIR__/hl-terminal.log</string>
    <key>StandardErrorPath</key><string>__LOGDIR__/hl-terminal.log</string>
</dict>
</plist>
P

cat > "${BUNDLE}/deploy/terminal-v.service" <<'S'
[Unit]
Description=Terminal V market terminal
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=__APPDIR__
ExecStart=__PYTHON__ __APPDIR__/server.py --port 9300 --host 127.0.0.1
Restart=always
RestartSec=10
EnvironmentFile=-__BUNDLE__/.env
# The collectors rewrite multi-MB JSON stores; give them room and time.
TimeoutStopSec=30

[Install]
WantedBy=default.target
S

cat > "${BUNDLE}/deploy/install.sh" <<'I'
#!/usr/bin/env bash
# Bring Terminal V up on this machine. Idempotent.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="${HERE}/terminal"
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

[ -f "${HERE}/.env" ] || { cp "${HERE}/.env.example" "${HERE}/.env"; echo "created .env - fill it in"; }

# Substitute the contact placeholder left by the exporter.
EMAIL="$(grep -E '^TERMINAL_CONTACT_EMAIL=' "${HERE}/.env" | cut -d= -f2- || true)"
if [ -n "${EMAIL}" ] && [ "${EMAIL}" != "you@example.com" ]; then
  grep -rl '__CONTACT_EMAIL__' "${APP}" 2>/dev/null | while read -r f; do
    sed -i '' "s/__CONTACT_EMAIL__/${EMAIL}/g" "$f" 2>/dev/null \
      || sed -i "s/__CONTACT_EMAIL__/${EMAIL}/g" "$f"
  done
  echo "==> contact email substituted"
else
  echo "!! TERMINAL_CONTACT_EMAIL not set - SEC requests will carry a placeholder"
fi

echo "==> byte-compiling"
"${HERE}/.venv/bin/python" -m compileall -q "${APP}" >/dev/null

mkdir -p "${HOME}/.hermes/logs"
VENVPY="${HERE}/.venv/bin/python"
case "$(uname -s)" in
  Darwin)
    P="${HOME}/Library/LaunchAgents/com.hermes.terminal.plist"
    # Refuse to hijack an existing agent that points somewhere else. The label
    # is shared with any Terminal V already installed on this machine, and a
    # blind load would silently replace a running desk with this copy.
    if [ -f "${P}" ] && ! grep -q "${APP}/server.py" "${P}" && [ "${FORCE:-0}" != "1" ]; then
      echo "!! com.hermes.terminal already exists and points elsewhere:"
      grep -o '[^<>]*server\.py' "${P}" | head -1
      echo "   refusing to replace it. Re-run with FORCE=1 to override,"
      echo "   or start this copy manually on another port:"
      echo "     ${HERE}/.venv/bin/python ${APP}/server.py --port 9301"
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
        -e "s|__BUNDLE__|${HERE}|g" \
        "${HERE}/deploy/terminal-v.service" > "${U}"
    systemctl --user daemon-reload
    systemctl --user enable --now terminal-v.service
    echo "==> systemd unit enabled: terminal-v" ;;
  *) echo "unknown OS - run manually: ${VENVPY} ${APP}/server.py --port 9300" ;;
esac
echo "==> http://127.0.0.1:9300/"
I
chmod +x "${BUNDLE}/deploy/install.sh"

# Supervision travels with the code. The health route is inside server.py and
# ships automatically; these are the pieces that live outside the app dir and
# would otherwise be silently missing on a second machine — which is the exact
# failure they exist to catch.
if [ -f "${HOME}/.hermes/scripts/terminal_watchdog.py" ]; then
  cp "${HOME}/.hermes/scripts/terminal_watchdog.py" "${BUNDLE}/deploy/"
fi
for pl in com.hermes.terminal-watchdog com.hermes.deepdive-worker; do
  src="${HOME}/Library/LaunchAgents/${pl}.plist"
  [ -f "${src}" ] && sed -e "s|/Users/[^/]*/.hermes/terminal|__APPDIR__|g" \
                         -e "s|/Users/[^/]*/.hermes|__HERMES__|g" \
                         -e "s|/Users/[^/]*|__HOME__|g" \
                         "${src}" > "${BUNDLE}/deploy/${pl}.plist"
done


echo "==> building manifest"
{
  echo "Terminal V export"
  echo "  exported-at : $(date -u +%Y-%m-%dT%H:%M:%SZ) (UTC)"
  echo "  source-host : $(hostname)"
  echo "  source-dir  : ${SRC}"
  echo "  python      : $(python3 --version 2>&1)"
  echo "  with-data   : ${WITH_DATA}"
  echo
  echo "LINE COUNTS"
  echo "  python   : $(find "${APP}" -name '*.py' | xargs wc -l | tail -1 | awk '{print $1}')"
  echo "  frontend : $(cat "${APP}"/static/app.js "${APP}"/static/index.html "${APP}"/static/style.css 2>/dev/null | wc -l | tr -d ' ')"
  echo
  echo "ABSOLUTE PATHS STILL PRESENT (review before running elsewhere)"
  if grep -rn '/Users/[a-z]' "${APP}" --include='*.py' 2>/dev/null | head -40; then :; else echo "  none"; fi
  echo
  echo "PATHS THAT REACH OUTSIDE THE BUNDLE (\$HOME-relative)"
  echo "  These are reads of the external systems listed below, not bugs -- but"
  echo "  on a machine without them the owning pane degrades to empty."
  grep -rn 'expanduser("~/' "${APP}" --include='*.py' 2>/dev/null \
    | sed "s|${APP}/||" | sed 's/^/  /' | head -20 || echo "  none"
  echo
  echo "EXTERNAL DEPENDENCIES NOT IN THIS TARBALL"
  echo "  ~/.hermes/trading_system/equity/equity_intel.db  -> RESEARCH + NEWS panes"
  echo "  ~/dev/TradingAgents (+ its .venv)                -> deep-dive layer"
  echo "  ollama @ localhost:11434                         -> deep-dive layer"
  echo "  hermes CLI (send -t telegram)                    -> alert delivery"
  echo "  FINNHUB_API_KEY                                  -> EVENT RADAR earnings"
  echo "  Each is optional: absent, the owning pane degrades and the rest runs."
  echo
  echo "SHA256"
} > "${BUNDLE}/MANIFEST.txt"
( cd "${BUNDLE}" && find terminal -type f \( -name '*.py' -o -name '*.js' -o -name '*.css' -o -name '*.html' \) -print0 \
    | sort -z | xargs -0 shasum -a 256 ) >> "${BUNDLE}/MANIFEST.txt"

cat > "${BUNDLE}/README.md" <<'M'
# Terminal V — portable bundle

A Bloomberg-style market terminal on free public data. Standard library plus
one dependency (`websockets`); no framework, no build step, no database server.

## Bring it up

    ./deploy/install.sh

Creates a venv, installs deps, writes `.env` from the template, byte-compiles,
and registers a launchd agent (macOS) or a systemd user unit (Linux). Then open
<http://127.0.0.1:9300/>.

Manual, without the service manager:

    python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
    .venv/bin/python terminal/server.py --port 9300

## What is in the tarball

`terminal/` — all server code, datasources and the single-page front end.
Backups (`*.bak*`), `__pycache__` and `.env` are excluded by construction.

`terminal/data/` — empty unless exported with `--with-data`.

## What is NOT, and cannot be

**Accrued history.** The order-book and trade-tape stores are built by live
websocket collectors and Hyperliquid publishes no archive, so an hour not
collected is permanently unanswerable. A fresh install starts empty and fills
forward: the tape is useful within hours, depth within a day, the buyback
day-over-day series within a week. Export with `--with-data` to carry it.

**The research pipeline.** `/api/research` and `/api/signals` read
`equity_intel.db`, which lives in a separate system. Absent, those panes return
empty and everything else runs — `research.py` checks for the file first.

**The deep-dive layer.** `deepdive_worker.py` shells into a TradingAgents
checkout at `~/dev/TradingAgents` and needs Ollama on `localhost:11434`. Absent,
queued deep dives never drain; nothing else notices.

**Alert delivery.** `/api/notify` shells out to a `hermes` CLI. Without it,
alerts still fire and are still logged; only Telegram delivery fails.

## Before exposing this beyond localhost

It ships bound to `127.0.0.1` and that is the right default. It has no auth,
no TLS, and no request logging. `/api/notify` is an unauthenticated relay into
whatever Telegram chat the `hermes` CLI is configured for, and `/api/alerts`
serves one global log to every caller. Fix or remove both before binding to a
public interface.

## Where local state lives

Per-browser, in `localStorage` under `hlterm_*` (watchlist, price alerts,
indicator toggles, desk layout). It does not travel in this bundle. To move a
desk setup, copy those keys from the browser console on the old machine.
M

if [ "${DO_GIT}" = "1" ] && command -v git >/dev/null; then
  echo "==> git init (there is no version control on the source; this creates it)"
  cat > "${BUNDLE}/.gitignore" <<'G'
.venv/
.env
__pycache__/
*.pyc
terminal/data/*
!terminal/data/.gitkeep
G
  ( cd "${BUNDLE}" && git init -q && git add -A \
      && git -c user.email=export@localhost -c user.name=export \
         commit -qm "Terminal V export ${STAMP}" ) && echo "    committed"
fi

echo "==> packing"
( cd "${OUT}" && tar czf "terminal-v-${STAMP}.tar.gz" "terminal-v-${STAMP}" )
( cd "${OUT}" && shasum -a 256 "terminal-v-${STAMP}.tar.gz" > "terminal-v-${STAMP}.tar.gz.sha256" )

echo
echo "bundle : ${BUNDLE}"
echo "tarball: ${OUT}/terminal-v-${STAMP}.tar.gz  ($(du -h "${OUT}/terminal-v-${STAMP}.tar.gz" | cut -f1))"
echo "sha256 : $(cut -d' ' -f1 < "${OUT}/terminal-v-${STAMP}.tar.gz.sha256")"
