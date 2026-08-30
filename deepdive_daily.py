#!/usr/bin/env python3
"""Queue the daily deep dives. Run by launchd each morning; the worker drains them.

Reads watchlist_deep.txt. Symbols the gate refuses (stale date, no data) are
skipped with a logged reason rather than queued and failed.
"""
import os
import sys
from datetime import date

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import deepdive

LIST = os.path.join(os.path.dirname(os.path.abspath(__file__)), "watchlist_deep.txt")
LOG = os.path.expanduser("~/.hermes/logs/deepdive.log")


def log(m):
    line = f"{date.today()} daily: {m}"
    print(line, flush=True)
    try:
        with open(LOG, "a") as f:
            f.write(line + "\n")
    except OSError:
        pass


def main():
    syms = []
    with open(LIST) as f:
        for ln in f:
            ln = ln.split("#")[0].strip()
            if ln:
                syms.append(ln.upper())
    queued = blocked = 0
    for s in syms:
        r = deepdive.enqueue(s)
        if r.get("state") == "queued":
            queued += 1
        else:
            blocked += 1
            log(f"{s} skipped — {'; '.join(r.get('blocks') or ['unknown'])}")
    log(f"queued {queued}, skipped {blocked}, of {len(syms)} — "
        f"~{queued * 8} min of work")


if __name__ == "__main__":
    main()
