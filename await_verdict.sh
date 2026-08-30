#!/bin/bash
cd ~/.hermes/terminal
for i in $(seq 1 60); do
  N=$(sqlite3 data/deepdive.db "select count(*) from deepdive_verdict;" 2>/dev/null || echo 0)
  [ "$N" -ge 1 ] && break
  pgrep -f deepdive_worker.py >/dev/null || { echo "worker stopped before producing a verdict"; tail -3 ~/.hermes/logs/deepdive.log; exit 0; }
  sleep 30
done
echo "════════ VERDICT (worker's own run, fixed parser) ════════"
sqlite3 -line data/deepdive.db "select symbol,as_of,action,rating,entry,stop,target,horizon,round(elapsed_s) secs,model_deep,model_quick from deepdive_verdict order by id desc limit 1;"
echo
echo "── thesis ──"
sqlite3 data/deepdive.db "select thesis from deepdive_verdict order by id desc limit 1;"
echo
echo "════════ WHAT THE DEEP TAB SHOWS ════════"
curl -s -m 8 "http://localhost:9300/api/deepdive" | python3 -c "
import sys,json;d=json.load(sys.stdin)
print('meta: DEEP DIVE ·',d['validation'],'·',d['scored_n'],'SCORED OUTCOMES')
for v in d['verdicts']:
    print(f\"  {v['symbol']:5} {v['as_of']}  {v['action']:5} entry={v['entry']} stop={v['stop']} target={v['target']}  {round(v['elapsed_s'] or 0)}s  UNVALIDATED\")
for q in d['queue']:
    print(f\"  queue {q['symbol']:5} {q['state'].upper()} {(q['reason'] or '')[:50]}\")
print(); print(d['coverage'])
"
