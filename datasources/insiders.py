"""EDGAR Form 4 insider-buy clusters for the tradeable equity universe.

Signal = open-market purchases only (transactionCode P, acquired). Grants,
awards, option exercises, gifts and 10b5-1 sells are noise for this purpose.
A "cluster" is a ticker where insiders bought recently — ranked by number of
distinct buyers, then total dollars.

All data is public EDGAR: per-CIK submissions index, then each Form 4's raw
XML. SEC asks for a descriptive User-Agent and gentle request rates.
"""

import html
import json
import os
import re
import tempfile
import time
import urllib.request
from datetime import date, timedelta

UA = {"User-Agent": "hl-terminal research vish2030@gmail.com"}
TIMEOUT = 15
WINDOW_DAYS = 35
MAX_XML_FETCHES = 400          # per-cycle politeness cap (new filings only)
SLEEP = 0.12                   # ~8 req/s, inside SEC's 10/s guidance
STORE_KEEP_DAYS = 60           # prune parsed filings older than this

CIK_MAP_PATH = "/Users/vish/.hermes/trading_system/equity/cik_map.json"
STORE_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                          "data", "insiders_store.json")


def _load_store():
    """accession -> parsed form-4 record; survives restarts so each scan
    only fetches filings it has never seen."""
    try:
        with open(STORE_PATH) as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return {}


def _save_store(store):
    os.makedirs(os.path.dirname(STORE_PATH), exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(STORE_PATH), suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as fh:
            json.dump(store, fh)
        os.replace(tmp, STORE_PATH)
    except OSError:
        try:
            os.unlink(tmp)
        except OSError:
            pass


def _get(url):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        return resp.read()


def _recent_form4s(cik, since):
    """[(accession, filing_date, primary_doc)] for Form 4s filed since `since`."""
    url = "https://data.sec.gov/submissions/CIK{:010d}.json".format(cik)
    d = json.loads(_get(url))
    r = (d.get("filings") or {}).get("recent") or {}
    forms = r.get("form") or []
    out = []
    for i in range(len(forms)):
        if forms[i] != "4":
            continue
        fdate = r["filingDate"][i]
        if fdate < since:
            continue
        out.append((r["accessionNumber"][i], fdate, r["primaryDocument"][i]))
    return out


_RE_OWNER = re.compile(r"<rptOwnerName>([^<]+)</rptOwnerName>")
_RE_TITLE = re.compile(r"<officerTitle>([^<]*)</officerTitle>")
_RE_DIRECTOR = re.compile(r"<isDirector>(1|true)</isDirector>")
_RE_TXN = re.compile(
    r"<nonDerivativeTransaction>.*?</nonDerivativeTransaction>", re.S)
_RE_CODE = re.compile(r"<transactionCode>([A-Z])</transactionCode>")
_RE_SHARES = re.compile(r"<transactionShares>\s*<value>([\d.]+)")
_RE_PRICE = re.compile(r"<transactionPricePerShare>\s*<value>([\d.]+)")
_RE_AD = re.compile(r"<transactionAcquiredDisposedCode>\s*<value>([AD])")


def _parse_form4(cik, accession, primary_doc):
    """Return (owner, role, buy_usd, sell_usd) from one Form 4's raw XML."""
    doc = primary_doc.split("/")[-1]          # strip the xsl-render prefix
    url = "https://www.sec.gov/Archives/edgar/data/{}/{}/{}".format(
        cik, accession.replace("-", ""), doc)
    xml = _get(url).decode(errors="ignore")
    m = _RE_OWNER.search(xml)
    owner = html.unescape(m.group(1).strip()) if m else "unknown"
    tm = _RE_TITLE.search(xml)
    role = html.unescape(tm.group(1).strip()) if tm and tm.group(1).strip() \
        else ("Director" if _RE_DIRECTOR.search(xml) else "")
    buy_usd = sell_usd = 0.0
    for block in _RE_TXN.findall(xml):
        code_m = _RE_CODE.search(block)
        sh_m = _RE_SHARES.search(block)
        px_m = _RE_PRICE.search(block)
        ad_m = _RE_AD.search(block)
        if not (code_m and sh_m and px_m):
            continue
        usd = float(sh_m.group(1)) * float(px_m.group(1))
        code = code_m.group(1)
        acquired = ad_m and ad_m.group(1) == "A"
        if code == "P" and acquired:
            buy_usd += usd
        elif code == "S":
            sell_usd += usd
    return owner, role, buy_usd, sell_usd


def insider_clusters(tickers):
    """Scan Form 4s for `tickers`; return buy clusters ranked by conviction."""
    try:
        cik_map = json.load(open(CIK_MAP_PATH))
    except OSError:
        return {"clusters": [], "error": "cik map unavailable"}
    since = (date.today() - timedelta(days=WINDOW_DAYS)).isoformat()

    todo = []   # (ticker, cik, accession, fdate, doc)
    scanned = 0
    for t in tickers:
        cik = cik_map.get(t)
        if not cik:
            continue
        try:
            for acc, fdate, doc in _recent_form4s(cik, since):
                todo.append((t, cik, acc, fdate, doc))
            scanned += 1
        except Exception:
            pass
        time.sleep(SLEEP)

    # Incremental: only fetch filings the persistent store has never seen.
    store = _load_store()
    fresh = [x for x in todo if x[2] not in store]
    fresh.sort(key=lambda x: x[3], reverse=True)     # newest filings first
    truncated = len(fresh) > MAX_XML_FETCHES
    parsed_new = 0
    for t, cik, acc, fdate, doc in fresh[:MAX_XML_FETCHES]:
        try:
            owner, role, buy, sell = _parse_form4(cik, acc, doc)
        except Exception:
            continue
        finally:
            time.sleep(SLEEP)
        store[acc] = {"ticker": t, "owner": owner, "role": role,
                      "buy_usd": buy, "sell_usd": sell, "date": fdate}
        parsed_new += 1

    # Prune old entries, then persist so the next cycle starts warm.
    keep_after = (date.today() - timedelta(days=STORE_KEEP_DAYS)).isoformat()
    store = {a: r for a, r in store.items() if r.get("date", "") >= keep_after}
    _save_store(store)

    # Build clusters from every stored filing inside the display window.
    tickers_set = set(tickers)
    per = {}
    for rec_ in store.values():
        t, fdate = rec_["ticker"], rec_["date"]
        if fdate < since or t not in tickers_set:
            continue
        rec = per.setdefault(t, {"buys": {}, "sell_usd": 0.0, "last_buy": None})
        rec["sell_usd"] += rec_["sell_usd"]
        if rec_["buy_usd"] > 0:
            b = rec["buys"].setdefault(
                rec_["owner"], {"usd": 0.0, "role": rec_["role"], "date": fdate})
            b["usd"] += rec_["buy_usd"]
            if fdate > b["date"]:
                b["date"] = fdate
            if rec["last_buy"] is None or fdate > rec["last_buy"]:
                rec["last_buy"] = fdate

    clusters = []
    for t, rec in per.items():
        if not rec["buys"]:
            continue
        total = sum(b["usd"] for b in rec["buys"].values())
        clusters.append({
            "ticker": t,
            "n_insiders": len(rec["buys"]),
            "total_buy_usd": round(total),
            "sell_usd_context": round(rec["sell_usd"]),
            "last_buy": rec["last_buy"],
            "buyers": sorted(
                [{"name": o, "role": b["role"], "usd": round(b["usd"]),
                  "date": b["date"]} for o, b in rec["buys"].items()],
                key=lambda x: x["usd"], reverse=True)[:5],
        })
    clusters.sort(key=lambda c: (c["n_insiders"], c["total_buy_usd"]), reverse=True)
    return {
        "clusters": clusters,
        "window_days": WINDOW_DAYS,
        "tickers_scanned": scanned,
        "form4s_seen": len(todo),
        "form4s_new": len(fresh),
        "form4s_parsed": parsed_new,
        "store_size": len(store),
        "truncated": truncated,
    }
