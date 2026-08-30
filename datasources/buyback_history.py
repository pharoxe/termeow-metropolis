"""Daily buyback/burn history in USD, per token.

The BURN tab could say what a programme is doing *now* but not what it has been
doing, so there was no way to see a buyback decelerating — which is the only
part of this data that carries information. Each token needs a different
source, and they are not interchangeable:

  HYPE   the fund's own spot fills          exact, ~40d (HL retention)
  JUP    Solana post-token-balances         exact, ~90d
  PUMP   CoinGecko market_cap / price       validated against the mint
  CAKE   EVM archive: sink + totalSupply    CoinGecko's supply is static here
  ASTER  EVM archive: dead-address balance  totalSupply never moves
  VVV    EVM archive: sink + totalSupply    burns to 0x0, not 0xdEaD

Everything is disk-cached and rebuilt in the background, because a full EVM
walk is ~360 archive calls and a JUP walk is ~17k signatures.
"""

import json
import os
import tempfile
import threading
import time

from cache import CACHE
from datasources import hl

STORE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                     "data", "buyback_history.json")

AF_ADDR = "0xfefefefefefefefefefefefefefefefefefefefe"
REBUILD_S = 6 * 3600
# HYPE fills are cheap (HL retention, ~40d) and are the live programme the
# BURN tab actually watches. Rebuilding them on the same 15-minute cadence
# as `_buyback_loop` is what makes this file's mtime mean "the writer is
# turning" instead of "an EVM walk finished some hours ago". Archive walks
# (EVM, JUP) stay on REBUILD_S — 360 calls / 17k signatures cannot run
# every 15 minutes.
CHEAP_REBUILD_S = 15 * 60
CHEAP_TOKENS = {"HYPE"}
WRITER_KEY = "_writer"
_LOCK = threading.Lock()
_BUILDING = set()

# Sink-burners on EVM: the burn counter is the dead-address balance, and
# totalSupply is tracked alongside so mint can be netted off.
# 4th element, when present: ("supply", genesis) — the token burns via
# _burn so totalSupply declines and there is nothing at a sink address.
# "held" then stores genesis - totalSupply: a strictly-increasing cumulative
# burn counter with exactly the shape of a sink balance, so every downstream
# consumer (merge, stats, trend, payout) works unchanged.
EVM_TOKENS = {
    "WLFI": ("ethereum", "0xda5e1988097297dcdc1f90d4dfe7909e847cbef6", 18,
             ("supply", 100_000_000_000.0)),
    "UNI": ("ethereum", "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984", 18),
    "LIT": ("ethereum", "0x232ce3bd40fcd6f80f3d55a522d03f25df784ee2", 18),
    "CAKE": ("binance-smart-chain", "0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82", 18),
    "ASTER": ("binance-smart-chain", "0x000ae314e2a2172a039b26378814c252734f556a", 18),
    "VVV": ("base", "0xacfe6019ed1a7dc6f7b508c02d1b04ec88cc21bf", 18),
}

# Where a reader can check the numbers themselves.
EXPLORERS = {
    "HYPE": ("https://hypurrscan.io/address/" + AF_ADDR, AF_ADDR, "Assistance Fund"),
    "WLFI": ("https://etherscan.io/token/0xda5e1988097297dcdc1f90d4dfe7909e847cbef6",
             "0xa713fc94db054aa435af4d9c66c3433dca98559f", "WLFI Onchain Purchases"),
    "ETHFI": ("https://etherscan.io/token/0xFe0c30065B384F05761f15d0CC899D4F9F9Cc0eB",
              "0xFe0c30065B384F05761f15d0CC899D4F9F9Cc0eB", "ETHFI token"),
    "UNI": ("https://etherscan.io/token/0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984?a=0x000000000000000000000000000000000000dEaD",
            "0x000000000000000000000000000000000000dEaD", "UNI burn address"),
    "LIT": ("https://etherscan.io/token/0x232ce3bd40fcd6f80f3d55a522d03f25df784ee2?a=0x000000000000000000000000000000000000dEaD",
            "0x000000000000000000000000000000000000dEaD", "LIT burn address"),
    "JUP": ("https://solscan.io/account/6tZT9AUcQn4iHMH79YZEXSy55kDLQ4VbA3PMtfLVNsFX",
            "6tZT9AUcQn4iHMH79YZEXSy55kDLQ4VbA3PMtfLVNsFX", "Litterbox Trust"),
    "DYDX": ("https://www.mintscan.io/dydx/address/dydx1zc0jd76vfluauk6pc6rsq5dkwyjz9h8uqgppj6",
             "dydx1zc0jd76vfluauk6pc6rsq5dkwyjz9h8uqgppj6", "Treasury SubDAO buyback acct"),
    "AAVE": ("https://etherscan.io/address/0x25F2226B597E8F9514B3F68F00f494cF4f286491",
             "0x25F2226B597E8F9514B3F68F00f494cF4f286491", "DAO Ecosystem Reserve"),
    "SKY": ("https://etherscan.io/address/0xbe8e3e3618f7474f8cb1d074a26affef007e98fb",
            "0xbe8e3e3618f7474f8cb1d074a26affef007e98fb", "Smart Burn Engine receiver"),
    "CAKE": ("https://bscscan.com/token/0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82?a=0x000000000000000000000000000000000000dEaD",
             "0x000000000000000000000000000000000000dEaD", "CAKE burn address"),
    "ASTER": ("https://bscscan.com/token/0x000ae314e2a2172a039b26378814c252734f556a?a=0x000000000000000000000000000000000000dEaD",
              "0x000000000000000000000000000000000000dEaD", "ASTER burn address"),
    "VVV": ("https://basescan.org/token/0xacfe6019ed1a7dc6f7b508c02d1b04ec88cc21bf?a=0x0000000000000000000000000000000000000000",
            "0x0000000000000000000000000000000000000000", "VVV burn address"),
    "PUMP": ("https://solscan.io/token/pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn",
             "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn", "PUMP mint"),
    "BNB": ("https://bscscan.com/address/0x0000000000000000000000000000000000000000",
            "0x0000000000000000000000000000000000000000", "BNB burn"),
}


def _load():
    try:
        with open(STORE) as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return {}


def _save(d):
    os.makedirs(os.path.dirname(STORE), exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(STORE), suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as fh:
            json.dump(d, fh)
        os.replace(tmp, STORE)
    except OSError:
        try:
            os.unlink(tmp)
        except OSError:
            pass


def store_mtime():
    """Epoch mtime of the history file, or None if it does not exist."""
    try:
        return os.path.getmtime(STORE)
    except OSError:
        return None


def note_writer(fresh):
    """Persist the 15-min refresh loop's stamp into this file.

    Health used to stat mtime and treat it as that loop. The loop only
    stamped in-memory `_BUYBACK_FRESH`, and this file was rewritten only
    when an archive walk finished (REBUILD_S = 6h). Result: the BURN chip
    said 11m, /api/health said DOWN. Writing the same stamp the chip reads
    makes mtime and `fresh.at` one clock. Called on SUCCESS only — a failed
    fetch must not look like a fresh write.
    """
    rec = {
        "at": fresh.get("at") or 0.0,
        "runs": fresh.get("runs") or 0,
        "err": fresh.get("err"),
        "err_where": fresh.get("err_where"),
        "failed_at": fresh.get("failed_at"),
        "noted_at": time.time(),
    }
    with _LOCK:
        store = _load()
        store[WRITER_KEY] = rec
        _save(store)


def _rebuild_s(token):
    return CHEAP_REBUILD_S if token in CHEAP_TOKENS else REBUILD_S


def _day(ms):
    return int(ms // 86400000)


MAX_DAYS = 400          # keep well past the longest window; drop the tail


def _normalize(series):
    """Snap every entry to a day boundary, summing within a day.

    The EVM walk timestamps points as `head_ts - i*86400`, so they drift by
    however long it has been since the last rebuild. Merging those raw would
    accumulate ~180 near-duplicate entries per rebuild instead of updating
    180 days. Day-keying makes a rebuild idempotent.
    """
    by_day = {}
    for r in series or []:
        d = _day(r["ms"]) * 86400000
        cur = by_day.get(d)
        if cur is None:
            cur = by_day[d] = {"ms": d, "usd": 0.0}
        cur["usd"] += r.get("usd") or 0.0
        if r.get("tokens") is not None:
            cur["tokens"] = (cur.get("tokens") or 0.0) + r["tokens"]
    return [by_day[k] for k in sorted(by_day)]


def _merge(old, new):
    """Keep history the source can no longer serve.

    Hyperliquid retains ~40 days of fills, so re-fetching and REPLACING meant
    HYPE's history slid forward and could never reach the 90-day window the
    monotonic alert rule needs. A day the new pull covers is authoritative for
    that day; days only the old series has are kept.
    """
    merged = {r["ms"]: r for r in _normalize(old)}
    for r in _normalize(new):
        merged[r["ms"]] = r
    out = [merged[k] for k in sorted(merged)]
    return out[-MAX_DAYS:]


# ---------------------------------------------------------------- HYPE
def hype_series():
    """Daily USD bought, from the fund's own fills. Exact, no modelling."""
    start = (time.time() - 45 * 86400) * 1000
    seen, rows, cursor = set(), [], int(start)
    for _ in range(30):                       # 2000-row pages
        page = hl.user_fills_by_time(AF_ADDR, cursor)
        if not isinstance(page, list) or not page:
            break
        fresh = 0
        for f in page:
            k = (f["time"], f.get("tid") or (f["px"] + f["sz"]))
            if k in seen:
                continue
            seen.add(k)
            rows.append(f)
            fresh += 1
        last = max(f["time"] for f in page)
        if len(page) < 2000 or not fresh:
            break
        cursor = last + 1
    by_day = {}
    for f in rows:
        if not str(f.get("dir", "")).lower().startswith("buy"):
            continue
        d = _day(f["time"])
        by_day[d] = by_day.get(d, 0.0) + float(f["sz"]) * float(f["px"])
    return [{"ms": d * 86400000, "usd": v} for d, v in sorted(by_day.items())]


# ---------------------------------------------------------------- JUP
def jup_series(days=90):
    """Daily USD bought, from the trust's balance walk × that day's price."""
    from datasources import onchain, coingecko
    ta = onchain.solana_token_account(
        "6tZT9AUcQn4iHMH79YZEXSy55kDLQ4VbA3PMtfLVNsFX",
        "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN")
    if not ta:
        return []
    cutoff = time.time() - days * 86400
    sigs, before = [], None
    for _ in range(25):
        page = onchain.solana_signatures(ta, before=before)
        if not page:
            break
        sigs.extend(page)
        bt = [p["blockTime"] for p in page if p.get("blockTime")]
        if not bt or min(bt) < cutoff or len(page) < 1000:
            break
        before = page[-1]["signature"]
    ok = [s for s in sigs if s.get("blockTime") and not s.get("err")]
    if not ok:
        return []
    # One sample per day: the day's last transaction.
    last_of_day = {}
    for s in ok:
        d = s["blockTime"] // 86400
        if d not in last_of_day or s["blockTime"] > last_of_day[d]["blockTime"]:
            last_of_day[d] = s
    bals = []
    for d in sorted(last_of_day):
        b = onchain.solana_post_balance(ta, last_of_day[d]["signature"])
        if b is not None:
            bals.append({"ms": d * 86400000, "held": b})
    px = coingecko.price_history("jupiter-exchange-solana", days)
    return _delta_to_usd(bals, px, "held")


# ---------------------------------------------------------------- EVM
def evm_series(token, days=180, points=None):
    """Daily USD burned, from the dead-address balance × that day's price."""
    from datasources import onchain, coingecko
    spec = EVM_TOKENS[token]
    chain, contract, dec = spec[0], spec[1], spec[2]
    supply_mode = spec[3] if len(spec) > 3 else None
    urls = onchain.archive_urls(chain)
    if not urls:
        return []
    url = urls[0]
    head_ts, head_blk = onchain._block_ts(url, "latest")
    per_day = int(86400 / onchain.CHAIN_BLOCK_S.get(chain, 2.0))
    out = []
    for i in range(days, -1, -1):
        blk = hex(head_blk - i * per_day)
        try:
            if supply_mode:
                tot = onchain._eth_call(url, contract, "0x18160ddd", blk) / (10 ** dec)
                held = supply_mode[1] - tot
            else:
                sink = 0
                for s_addr in onchain.BURN_SINKS:
                    sink += onchain.evm_balance_of(chain, contract, s_addr, blk, url=url)
                held = sink / (10 ** dec)
            out.append({"ms": (head_ts - i * 86400) * 1000, "held": held})
        except Exception:
            # Primary refused (rate limit / withdrawn demo key): rotate to the
            # next archive node and keep walking rather than losing the day.
            idx = urls.index(url) if url in urls else -1
            if idx + 1 < len(urls):
                url = urls[idx + 1]
            continue
        time.sleep(0.35)
    cid = {"CAKE": "pancakeswap-token", "ASTER": "aster-2",
           "WLFI": "world-liberty-financial", "UNI": "uniswap", "LIT": "lighter",
           "VVV": "venice-token"}.get(token)
    px = coingecko.price_history(cid, days) if cid else {}
    return _delta_to_usd(out, px, "held")


# ---------------------------------------------------------------- PUMP
def pump_series(days=180):
    from datasources import coingecko
    rows = coingecko.supply_history("pump-fun", days)
    out = []
    for a, b in zip(rows, rows[1:]):
        d = b["supply"] - a["supply"]
        if d >= 0 or (a["supply"] and abs(d) > 0.02 * a["supply"]):
            continue                        # rose, or a circulating revision
        out.append({"ms": b["ms"], "usd": -d * b["px"]})
    return out


def _delta_to_usd(bals, px_by_day, key):
    """Day-over-day increase in a balance, valued at that day's price."""
    out = []
    for a, b in zip(bals, bals[1:]):
        d = b[key] - a[key]
        if d <= 0:
            continue
        p = px_by_day.get(_day(b["ms"]))
        if p is None:
            continue
        usd = d * p
        if usd < 1.0:
            continue          # ASTER's 5-token dust burns rendered as "$0"
        out.append({"ms": b["ms"], "usd": usd, "tokens": d})
    return out


BUILDERS = {
    "HYPE": hype_series,
    "LIT": lambda: evm_series("LIT"),
    "UNI": lambda: evm_series("UNI"),
    "WLFI": lambda: evm_series("WLFI"),
    "JUP": jup_series,
    "PUMP": pump_series,
    "CAKE": lambda: evm_series("CAKE"),
    "ASTER": lambda: evm_series("ASTER"),
    "VVV": lambda: evm_series("VVV"),
}

# "bought" = tokens acquired on the open market (a real bid).
# "burned" = tokens destroyed, which for CAKE/ASTER/VVV/PUMP is fee revenue
# collected in kind, NOT market buying — the two must never be summed.
KIND = {"HYPE": "bought", "JUP": "bought", "LIT": "bought", "UNI": "bought", "WLFI": "bought",
        "PUMP": "burned", "CAKE": "burned", "ASTER": "burned", "VVV": "burned"}

# Batch burners fire weekly-ish; a per-day mean is still the right comparison
# but the label must not imply they spend every day.
def cadence(series):
    if len(series) < 3:
        return None
    span_d = (series[-1]["ms"] - series[0]["ms"]) / 86400000.0
    if span_d <= 0:
        return None
    every = span_d / (len(series) - 1)
    return {"events": len(series), "span_days": round(span_d, 1),
            "every_days": round(every, 1),
            "batch": every >= 2.5}


def meta(token):
    """{kind, cadence, writer fail} for the cached series, or {} if none."""
    rec = _load().get(token) or {}
    ser = rec.get("series") or []
    last_ms = ser[-1]["ms"] if ser else None
    return {"kind": rec.get("kind"), "cadence": rec.get("cadence"),
            "build_err": rec.get("build_err"),
            "build_failed_at": rec.get("build_failed_at"),
            "series_last_ms": last_ms, "at": rec.get("at")}


def last_event(series):
    """Most recent non-zero day. A zero-USD day is not an event."""
    for r in reversed(series or []):
        if (r.get("usd") or 0) > 0 or (r.get("tokens") or 0) > 0:
            return {"ms": r["ms"], "usd": r.get("usd"),
                    "tokens": r.get("tokens")}
    return None


def writer_status():
    """Clocks the BURN chip must read, plus any per-token build fail.

    `fresh.at` is in-memory; this file's mtime and each series' last ts are
    independent. A writer that stopped updating the file while the loop still
    stamped `at` is the failure the chip used to miss.
    """
    store = _load()
    rec = store.get(WRITER_KEY) or {}
    fails, series_last = [], None
    for tok, v in store.items():
        if not isinstance(v, dict) or str(tok).startswith("_"):
            continue
        if v.get("build_err"):
            fails.append({"token": tok, "err": v["build_err"],
                          "at": v.get("build_failed_at")})
        ser = v.get("series") or []
        if ser:
            ts = (ser[-1].get("ms") or 0) / 1000.0
            if ts and (series_last is None or ts > series_last):
                series_last = ts
    return {"writer": rec, "build_fails": fails,
            "series_last_ts": series_last, "mtime": store_mtime()}


def get(token):
    """Cached daily series; kicks off a background rebuild when stale."""
    store = _load()
    rec = store.get(token)
    fresh = rec and (time.time() - rec.get("at", 0)) < _rebuild_s(token)
    if not fresh and token in BUILDERS:
        with _LOCK:
            if token not in _BUILDING:
                _BUILDING.add(token)
                threading.Thread(target=_build, args=(token,), daemon=True).start()
    return (rec or {}).get("series") or []


def _build(token):
    err = None
    try:
        series = BUILDERS[token]()
        if series:
            with _LOCK:
                store = _load()
                prev = (store.get(token) or {}).get("series") or []
                merged = _merge(prev, series)
                store[token] = {"at": time.time(), "series": merged,
                                "kind": KIND.get(token, "bought"),
                                "cadence": cadence(merged),
                                "kept_from_prev": max(0, len(merged) - len(_normalize(series))),
                                "build_err": None,
                                "build_failed_at": None}
                _save(store)
        else:
            err = "empty series"
    except Exception as exc:
        err = "%s: %s" % (type(exc).__name__, str(exc)[:160])
    finally:
        with _LOCK:
            _BUILDING.discard(token)
    if err:
        try:
            with _LOCK:
                store = _load()
                rec = dict(store.get(token) or {})
                rec["build_err"] = err
                rec["build_failed_at"] = time.time()
                store[token] = rec
                _save(store)
        except Exception:
            pass


def stats(series, windows=(7, 30, 90)):
    """Average USD/day over trailing windows — the shape of the trend."""
    if not series:
        return {}
    now = time.time() * 1000
    # Drop today's partial bucket. HYPE's last entry reads $151,811 mid-day
    # against a ~$1.2M/day programme; leaving it in drags the 7d mean down and
    # would fire a "buyback slowing" alert every morning.
    today = int(now // 86400000) * 86400000
    series = [r for r in series if r["ms"] < today] or series
    first = series[0]["ms"]
    out = {}
    for w in windows:
        cut = now - w * 86400000
        vals = [r["usd"] for r in series if r["ms"] >= cut]
        if not vals:
            continue
        # Divide by the span actually covered, not the nominal window. A 42-day
        # series over a 90-day denominator reported $566k/day for a programme
        # genuinely running at ~$1.2M/day.
        covered = min(w, max(1.0, (now - max(first, cut)) / 86400000))
        if covered < w * 0.6:
            continue                       # too little of the window to name it
        out["d%d" % w] = sum(vals) / covered
    return out


# A single rate answers "how much"; the desk question is "which way".
# Bands are deliberately wide: HYPE's daily spend ranges roughly $0.4M-$2.5M,
# so anything inside +/-15% of the 30d mean is noise, not a change in policy.
TREND_BAND_PCT = 15.0


def trend(stats):
    """SLOWING / STEADY / INCREASING from the 7d vs 30d means.

    Returns None when there is not enough history to say — an unknown trend
    must not render as "steady", which is a claim.
    """
    recent, base = stats.get("d7"), stats.get("d30")
    if recent is None or base is None or base <= 0:
        return None
    chg = (recent - base) / base * 100.0
    if chg >= TREND_BAND_PCT:
        state = "increasing"
    elif chg <= -TREND_BAND_PCT:
        state = "slowing"
    else:
        state = "steady"
    long = stats.get("d90")
    # Three windows agreeing is a stronger statement than two.
    confirmed = (long is not None and
                 ((state == "slowing" and recent < base < long) or
                  (state == "increasing" and recent > base > long)))
    return {"state": state, "chg_pct": chg, "confirmed": confirmed,
            "d7": recent, "d30": base, "d90": long}
