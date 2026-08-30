#!/bin/bash
cd ~/.hermes/terminal
for i in $(seq 1 80); do
  N=$(sqlite3 data/deepdive.db "select count(*) from deepdive_verdict where symbol='HYPE-USD';" 2>/dev/null||echo 0)
  [ "$N" -ge 1 ] && break
  pgrep -f deepdive_worker.py >/dev/null || { echo "worker stopped"; tail -3 ~/.hermes/logs/deepdive.log; exit 0; }
  sleep 30
done
echo "════ HYPE-USD — crypto analyst set, no fabricated fundamentals ════"
sqlite3 -line data/deepdive.db "select symbol,as_of,action,rating,entry,stop,target,horizon,round(elapsed_s) secs from deepdive_verdict where symbol='HYPE-USD' order by id desc limit 1;"
echo; echo "── thesis ──"
sqlite3 data/deepdive.db "select thesis from deepdive_verdict where symbol='HYPE-USD' order by id desc limit 1;"
echo; echo "── which analysts actually ran ──"
python3 - <<'PY'
import json, glob, os
g = sorted(glob.glob(os.path.expanduser("~/.tradingagents/logs/HYPE-USD/TradingAgentsStrategy_logs/*.json")))
s = json.load(open(g[-1]))
for k in ("market_report","sentiment_report","news_report","fundamentals_report"):
    v = s.get(k) or ""
    mark = "  <-- correctly absent" if (k=="fundamentals_report" and len(v)<50) else ""
    print(f"  {k:22} {len(v):>6} chars{mark}")
m = s.get("market_report") or ""
import re
px = re.findall(r"\b(5[6-9]\.\d\d|6[0-2]\.\d\d)\b", m)[:6]
print("  price levels cited:", px or "none found")
PY
