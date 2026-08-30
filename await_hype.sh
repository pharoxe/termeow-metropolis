#!/bin/bash
cd ~/.hermes/terminal
for i in $(seq 1 80); do
  N=$(sqlite3 data/deepdive.db "select count(*) from deepdive_verdict where symbol='HYPE-USD';" 2>/dev/null||echo 0)
  [ "$N" -ge 1 ] && break
  pgrep -f deepdive_worker.py >/dev/null || { echo "worker stopped"; tail -3 ~/.hermes/logs/deepdive.log; exit 0; }
  sleep 30
done
echo "════════ HYPE-USD — first workup on an HL-only symbol ════════"
sqlite3 -line data/deepdive.db "select symbol,as_of,action,rating,entry,stop,target,horizon,round(elapsed_s) secs from deepdive_verdict where symbol='HYPE-USD' order by id desc limit 1;"
echo; echo "── thesis ──"
sqlite3 data/deepdive.db "select thesis from deepdive_verdict where symbol='HYPE-USD' order by id desc limit 1;"
echo; echo "── which vendor actually served it, and how thin was the news? ──"
python3 - <<'PY'
import json, os, glob
g = sorted(glob.glob(os.path.expanduser("~/.tradingagents/logs/HYPE-USD/TradingAgentsStrategy_logs/*.json")))
if not g: print("  (no state snapshot)"); raise SystemExit
s = json.load(open(g[-1]))
for k in ("market_report","news_report","sentiment_report","fundamentals_report"):
    v = s.get(k) or ""
    print(f"  {k:22} {len(v):>6} chars{'   <-- empty/thin' if len(v) < 1200 else ''}")
m = s.get("market_report") or ""
print("  source:", "Hyperliquid" if "Hyperliquid" in m else "yfinance/other")
PY
echo; echo "── the DEEP tab row ──"
curl -s -m 8 "http://localhost:9300/api/deepdive" | python3 -c "
import sys,json;d=json.load(sys.stdin)
for v in d['verdicts'][:3]:
    print(f\"  {v['symbol']:9} {v['as_of']}  {v['action']:5} entry={v['entry']} stop={v['stop']} target={v['target']}  {round(v['elapsed_s'] or 0)}s  UNVALIDATED\")"
