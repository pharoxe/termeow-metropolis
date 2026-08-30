# Terminal V

Local Bloomberg-style microstructure desk for Hyperliquid crypto perps and `xyz:` equity perps. It runs on your machine, binds `127.0.0.1:9300`, and degrades instead of 500ing when an upstream is down.

This repo is **source only**. Live stores (`data/`, sqlite, `.env`) are gitignored.

## Run

```bash
python3 server.py
```

Open [http://127.0.0.1:9300](http://127.0.0.1:9300). Optional: `--port` / `--host`. Python 3.10+ and `websockets` are enough to boot the UI and HL REST. The browser opens its own Hyperliquid websocket for live mids.

```bash
pip install websockets tzdata
```

## What it is

- Chart desk (TRADE layout default; F4 restores DEFAULT)
- Tape, book, CVD (own pane), whale triangles at fill time when a matching HL fill exists
- NEWS: CN follows the charted name; ALL is the unfiltered river
- DES: four cited lines for the loaded name (`qwen3.6` via local Ollama, 30s cap; falls back to cites-only)
- BURN / buyback tab: labeled windows, not a fake live squeeze
- Research pipeline is a **read-only** bridge to `~/.hermes/trading_system/equity/equity_intel.db` (not in this repo)

## Optional

| Piece | If missing |
| --- | --- |
| Ollama `qwen3.6` on `:11434` | DES stays cites-only |
| `FINNHUB_API_KEY` in `~/.hermes/.env` | equity news / earnings calendar degrade |
| `deepdive_worker.py` + Ollama | DEEP tab empty, health warns |
| equity intel DB | NEWS empty with an honest note, not a quiet tape |

## Layout

```
server.py           HTTP + collectors
static/             app.js / index.html / style.css
datasources/        HL, whales, flow, depth, buyback, funding_x, …
des.py              cited DES note
research.py         read-only news/cards bridge
deepdive*.py        overnight FA worker (separate process)
data/               runtime JSON (not committed)
```

## Honesty rules

If a number cannot point at a tape field, a fill hash, or a headline URL, it does not speak. Empty CN on BTC is “this name, not a quiet market.” Unlocks are a declared blind spot on BURN, not a zero.

UNVALIDATED research, not advice.
