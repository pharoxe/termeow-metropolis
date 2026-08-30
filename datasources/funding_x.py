"""Cross-venue funding: HL vs Binance vs Bybit, normalised to APR.

Every funding read in the terminal was HL-only, so "crowded" meant
"crowded on Hyperliquid" — a small, noisy sample on a mid-cap alt. HL's
own `predictedFundings` returns the predicted rate on all three venues
for ~232 coins in one unauthenticated call, which turns crowding into a
cross-venue measurement: when HL funding is far above what Binance and
Bybit charge for the same exposure, the crowd is HERE, and the dislocation
is also the carry available to whoever arbs it away.

THE INTERVAL TRAP (why everything is an APR): HL charges hourly; Binance
and Bybit charge every 4h OR 8h — and it varies per coin, so even a
per-venue constant is wrong. A naive rate comparison is off by 4-8x,
which is exactly what most public dashboards get wrong. Every rate is
annualised through its own record's fundingIntervalHours before any
comparison happens.

Equity perps (xyz:) have no CEX listing: they are absent from this map
and every consumer must render HL-only rather than fabricate a comparison.
"""

import json
import os
import statistics
import tempfile
import threading
import time
import urllib.request

INFO = "https://api.hyperliquid.xyz/info"
TIMEOUT = 30
HOURS_YEAR = 24 * 365


def _post(payload):
    req = urllib.request.Request(
        INFO, data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        return json.loads(resp.read())


def _apr(rec):
    """One venue record -> APR %, through its OWN funding interval."""
    if not rec:
        return None
    try:
        rate = float(rec.get("fundingRate"))
        hours = float(rec.get("fundingIntervalHours") or 0)
    except (TypeError, ValueError):
        return None
    if not hours:
        return None
    return rate * (HOURS_YEAR / hours) * 100.0


def fetch():
    """{coin: {hl_apr, binance_apr, bybit_apr, cex_median_apr, disloc_apr}}.

    disloc_apr = HL APR minus the CEX median: positive means longs pay MORE
    on HL than elsewhere (the crowd is here), negative means HL shorts are
    the crowded side. None when no CEX venue lists the coin — absence of a
    comparison is reported as absence, not as zero.
    """
    raw = _post({"type": "predictedFundings"})
    out = {}
    for coin, venue_list in raw or []:
        rec = {"hl_apr": None, "binance_apr": None, "bybit_apr": None}
        for venue, vrec in venue_list or []:
            apr = _apr(vrec)
            if venue == "HlPerp":
                rec["hl_apr"] = apr
            elif venue == "BinPerp":
                rec["binance_apr"] = apr
            elif venue == "BybitPerp":
                rec["bybit_apr"] = apr
        cex = [v for v in (rec["binance_apr"], rec["bybit_apr"]) if v is not None]
        rec["cex_median_apr"] = statistics.median(cex) if cex else None
        rec["disloc_apr"] = (rec["hl_apr"] - rec["cex_median_apr"]
                             if rec["hl_apr"] is not None and cex else None)
        rec["n_cex"] = len(cex)
        out[coin] = rec
    return out


STORE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                     "data", "funding_x_history.json")
RETAIN_H = 400 * 24

# Single-writer, like every other store in this codebase — and unlike this one
# until now. snapshot() did read-modify-write with NO lock and a FIXED
# `STORE + ".tmp"` path, so it was safe only for as long as exactly one caller
# ever existed: two concurrent writers would interleave into one tmp file and
# os.replace a torn 400-day archive into place. mkstemp gives each writer its
# own file (the pattern the other nine stores here already use) and the lock
# makes the read-modify-write atomic.
_LOCK = threading.Lock()


def snapshot(fx):
    """Append this hour's cross-venue dislocation to disk.

    `predictedFundings` is a LIVE endpoint with no archive: an hour that is
    not written is gone permanently. The dislocation series is the only
    record that HL was crowded relative to the CEXes at a given moment, and
    it is the input to every question worth asking about venue crowding —
    none of which can be asked retrospectively.
    """
    hour = int(time.time() // 3600)
    row = {}
    for coin, r in (fx or {}).items():
        d = r.get("disloc_apr")
        if d is None:
            continue
        row[coin] = [round(r["hl_apr"], 1), round(r["cex_median_apr"], 1)]
    if not row:
        return None
    # Load, mutate and write under one lock — see _LOCK. Building `row` above
    # needs no lock and is the only part that touches the caller's data.
    with _LOCK:
        try:
            with open(STORE) as fh:
                store = json.load(fh)
            if not isinstance(store, dict):
                store = {}
        except (OSError, ValueError):
            store = {}
        store[str(hour)] = row
        for k in list(store):
            if int(k) < hour - RETAIN_H:
                del store[k]
        os.makedirs(os.path.dirname(STORE), exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=os.path.dirname(STORE), suffix=".tmp")
        try:
            with os.fdopen(fd, "w") as fh:
                json.dump(store, fh, separators=(",", ":"))
            os.replace(tmp, STORE)
        except Exception:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise
    return hour


def summary(fx):
    """Board-level read: how dislocated is HL overall, and where."""
    dis = [(c, r["disloc_apr"]) for c, r in (fx or {}).items()
           if r.get("disloc_apr") is not None]
    if not dis:
        return None
    vals = [d for _, d in dis]
    dis.sort(key=lambda x: abs(x[1]), reverse=True)
    return {
        "n": len(vals),
        "median_disloc_apr": statistics.median(vals),
        "top": [{"coin": c, "disloc_apr": round(d, 1)} for c, d in dis[:5]],
    }
