# Terminal V

Local Bloomberg-style microstructure desk for Hyperliquid crypto perps and `xyz:` equity perps. One Python process, one static UI, no framework, no database server. It binds **127.0.0.1:9300** and degrades a pane instead of returning 500 when an upstream is missing.

This GitHub repo is **source only**. Runtime JSON under `data/`, sqlite, and `.env` are gitignored.

---

## What you get on a fresh machine

| After boot | Status |
| --- | --- |
| UI, watchlist, live mids, candles, book, 24h % | Works (public Hyperliquid REST + browser WS) |
| Flow / CVD / depth history | Starts empty, fills **forward** from live websockets. HL publishes no archive. Useful tape in hours, depth in about a day. |
| Whale **positions** | Sweep starts immediately. **Events** need two sweeps to diff (~10–15 min). Fill-tx timestamps need HL `userFillsByTime`. |
| NEWS / RESEARCH / intel cards | Empty until `equity_intel.db` exists (separate pipeline). Honest empty, not a quiet tape. |
| DES four-line note | Cites-only until local Ollama has `qwen3.6`. |
| EVENT RADAR earnings | Degraded until `FINNHUB_API_KEY` is in `~/.hermes/.env`. NFP/FOMC calendar still works. |
| BURN / buybacks | Warms from public sources; history accrues over days. Unlocks are a declared blind spot. |
| Deep-dive tab | Empty until `deepdive_worker.py` + TradingAgents + Ollama. |

UNVALIDATED research, not advice.

---

## 1. Requirements

- **Python 3.9+** (`python3 --version`)
- macOS or Linux (Windows: run the manual command; no launchd unit)
- Outbound HTTPS to `api.hyperliquid.xyz` (and `wss://api.hyperliquid.xyz/ws` for tape/depth)
- A browser. Hard-refresh after JS updates (`Cache-Control: no-store`, but modules can stick)

Optional later: [Ollama](https://ollama.com), a free [Finnhub](https://finnhub.io) API key, the equity research tree, a TradingAgents checkout.

---

## 2. Clone and boot (minimum)

```bash
git clone git@github.com:Brokent00th/terminal-v.git
cd terminal-v
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
cp .env.example .env
# put a real email in TERMINAL_CONTACT_EMAIL (SEC User-Agent)
mkdir -p data
.venv/bin/python server.py --port 9300 --host 127.0.0.1
```

Open [http://127.0.0.1:9300](http://127.0.0.1:9300). You should see the desk, live crypto mids, and empty NEWS with an honest note.

Installer (venv + launchd on macOS or systemd user unit on Linux):

```bash
chmod +x deploy/install.sh
./deploy/install.sh
```

If `com.hermes.terminal` already points at another copy, the installer refuses to hijack it. Start this tree on another port:

```bash
.venv/bin/python server.py --port 9301 --host 127.0.0.1
```

Or `FORCE=1 ./deploy/install.sh` to replace the existing agent.

Logs (launchd): `~/.hermes/logs/hl-terminal.log`

---

## 3. One-time env

`finnhub_cal.py` reads **`~/.hermes/.env`**, not only the repo `.env`.

```bash
mkdir -p ~/.hermes
# merge keys you care about
cp .env ~/.hermes/.env   # or append FINNHUB_API_KEY=... to the existing file
```

| Variable | Used by | If missing |
| --- | --- | --- |
| `TERMINAL_CONTACT_EMAIL` | SEC / CoinGecko User-Agent | Placeholder; SEC may throttle |
| `FINNHUB_API_KEY` | EVENT RADAR earnings | Calendar still has NFP/FOMC; earnings empty |
| `EQUITY_SYNTHESIS_MODEL` | DES (`des.py`) | Defaults to `qwen3.6:latest` |
| `TERMINAL_CIK_MAP` | INSIDERS | Pane degrades |

Nothing in `.env` is required for mids, candles, or the book.

---

## 4. DES (optional, local LLM)

```bash
# install Ollama, then:
ollama pull qwen3.6
# confirm
curl -s http://127.0.0.1:11434/api/tags
```

Restart `server.py`. Chart a name; DES should fill four cited lines in ~5–30s. If Ollama is down, the card stays **cites-only** and says so. DES follows the loaded coin; the DES chip in the NEWS header hides it.

---

## 5. NEWS / intel (optional, separate pipeline)

`/api/research` is a **read-only** bridge to:

```
~/.hermes/trading_system/equity/equity_intel.db
```

That DB is **not** in this repo. It is produced by the equity digest (`news_fetch.py` / Finnhub company-news + EDGAR, triage, synthesis) on a weekday US-hours cron. Without the file:

- CN / ALL show an honest empty
- BTC CN empty is expected even with the DB (Finnhub has no crypto company-news)

Do not invent a second crawl inside this repo.

---

## 6. Deep-dive worker (optional)

`deepdive_worker.py` expects:

- Ollama on `localhost:11434` (model used in production: `ornith-1.5:35b`)
- a TradingAgents checkout at `~/dev/TradingAgents` with its own `.venv`
- `data/deepdive.db` (created under this tree / `~/.hermes/terminal/data` depending on install)

Launch the worker as its own process (or the `com.hermes.deepdive-worker` launchd plist if you have one). If it is not running, health warns `no deep-dive worker is alive` and the DEEP tab stays empty. The UI server still runs.

---

## 7. Verify

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:9300/
curl -s http://127.0.0.1:9300/api/health   # local machinery only
curl -s "http://127.0.0.1:9300/api/universe" | python3 -c "import sys,json; d=json.load(sys.stdin); print('crypto', len(d.get('crypto') or []))"
```

Health `degraded` with 0 fails is normal on a fresh box (no deepdive worker, empty history files still warming). Failures are collector/store problems, not “HL is unreachable” — that route does not probe upstreams.

---

## 8. What will not appear on day one

Hyperliquid does not sell history. `data/flow_buckets.json`, `depth_minute.json`, `whale_events.json`, buyback series, etc. are **accrued**. A second machine starts at zero even if you clone this repo. Copy `data/*.json` only if you intend to move a live desk (not required to boot).

Browser layout (watchlist, TRADE vs DEFAULT, indicator toggles) lives in `localStorage` keys `hlterm_*`. It does not travel with git.

---

## 9. Do not bind this to the public internet

Default host is `127.0.0.1`. There is **no auth**, no TLS, and no request log. `/api/notify` can relay into Telegram via a local `hermes` CLI. `/api/alerts` is one global log. Fix or remove those before `--host 0.0.0.0`.

---

## Layout

```
server.py            HTTP + collector threads
static/              app.js, index.html, style.css
datasources/         HL, whales, flow, depth, buyback, funding_x, …
des.py               cited DES note
research.py          read-only news/cards bridge
deepdive*.py         overnight FA (separate worker)
deploy/              install.sh, launchd plist, systemd unit
data/                runtime JSON (gitignored, created at run)
.env.example         copy to .env
```

Chart: TRADE is the factory layout (F4 = DEFAULT). CVD is its own pane. Whale triangles sit at fill time (HL fill tx) when a match exists, else sweep-detect, on the fill/entry price.

---

## Honesty

If a line cannot point at a tape field, a fill hash, or a headline URL, it does not speak. Empty CN on BTC is “this name, not a quiet market.” Unlocks are declared on the BURN tab, not shown as zero. Spread is printed in real basis points (bid/ask), not the ±25bps depth band.
