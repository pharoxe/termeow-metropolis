"""Persisted L2 depth — the one live-only input in this terminal.

Every other signal here accrues to disk: flow, OI, funding dislocation,
whale positions, supply. Depth did not. `l2_book` was fetched, rendered
and thrown away, and the browser heatmap accumulated a five-minute window
that died with the tab. So the single most valuable depth question —
*did the book thin out BEFORE the move, and on which side?* — was
unanswerable, and permanently so for any hour nobody recorded.

THERE IS NO BACKFILL. Hyperliquid publishes no book archive: an hour that
is not written here is gone for good. That is the argument for collecting
now rather than later, and it is why `coverage()` reports hours actually
accrued and every consumer must say "Nh of 48h collected" rather than
render an empty pane that reads as "nothing is happening".

WHAT IS STORED, AND WHY NOT THE BOOK ITSELF
Raw levels are ~2.8KB per snapshot across both resolutions; at one sample
a minute for nine coins that is 72 MB/day, and 78-82% of the level detail
is market-maker re-quoting that aggregation removes for free. What is
stored instead is the cumulative depth curve: notional resting within
+/-[5,10,25,50,100,250] bps of mid, per side. That vector answers the
motivating question at 1/350th the size.

TRANSPORT: `l2Book` is subscribable over the websocket and accepts
`nSigFigs`, so this costs ZERO added REST requests against the budget the
whale sweep already strains. Measured live on ten coins: both resolutions
for a coin arrive stamped with an IDENTICAL exchange `time`, so a two-book
snapshot is coherent and the stitched band vector is a single instant of
one book. REST polling could never promise that. The REST path survives
only as `snapshot()`, the gap-filler for when the socket is down.

WHY TWO RESOLUTIONS. Reach is not a fixed window; it is a function of the
price's leading digit. With 20 levels a side, tick(sig) = 10^(5-sig) *
10^floor(log10 mid) / mid and reach = 20*tick, so tick4 lands in (1,10]
bps and tick3 in (10,100]. A band is resolvable at a resolution only when
tick <= band <= reach. Measured across the watchlist: sig=4 reaches
+/-30.8bps on BTC but +/-193.4 on XRP, and neither resolution alone covers
the useful range. Their union leaves the core grid [10,25,50,100]
uncovered on zero coins. That is why there are exactly two subscriptions.

DEPTH IS A LEVEL, NOT A FLOW. The flow collector sums its buckets. Summing
depth is the bug waiting to happen here: a summed band grows with the
sampling rate and means nothing. Every regroup — minute to hour, minute to
chart bar — goes through `_merge()`, which is the only place the rule
lives: bands and mid take a MEDIAN, the air-pocket minima take a MIN, the
worst spread takes a MAX, and `k` is the sole field that sums.

WHAT THIS IS NOT. Resting depth is displayed, not executable: it is
cancellable, and a wall that vanishes on approach was never liquidity. The
resting ORDER COUNT is stored alongside the notional as the partial
defence — one $50M order and five thousand small ones read identically in
dollars and behave nothing alike. And depth has no validated edge in this
terminal: treat it as description of what the book looked like, never as
forecast, until it has been through the standard block-bootstrap and
edge-minus-matched-control stack.
"""

import asyncio
import json
import math
import os
import statistics
import tempfile
import threading
import time

WS_URL = "wss://api.hyperliquid.xyz/ws"
_DATA = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                     "data")
STORE = os.path.join(_DATA, "depth_minute.json")
STORE_HOURLY = os.path.join(_DATA, "depth_hourly.json")

# Bands in bps from mid, per side. The core [10,25,50,100] is resolvable for
# every coin at every price under the union of the two resolutions; +/-5 lands
# for ~44% of price mantissas (BTC/SOL/HYPE/DOGE/AVAX yes, ETH/VVV/XRP no) and
# +/-250 for ~97% (LINK's wide book reaches only 221.7bps). The ends are stored
# when resolvable and NULL — never zero — when they are not.
GRID = [5, 10, 25, 50, 100, 250]
REF = 2                     # index of the +/-25bps reference band
REF_BPS = GRID[REF]
SIG_NEAR, SIG_WIDE = 4, 3

BUCKET_S = 60
HOUR_S = 3600
RETAIN_H = 48               # matches the flow collector, so a 48h chart does
MAX_BUCKETS = int(RETAIN_H * 3600 / BUCKET_S)   # not show CVD full width and
RETAIN_HOURLY_D = 400                           # depth across half of it
MAX_HOURLY = RETAIN_HOURLY_D * 24

# Deliberately slower than the flow collector's 60s. Its minute tier must be
# saved often because a lost trade is unrecoverable flow; depth is a LEVEL
# re-sampled ~11x a minute, so a crash costs a bounded <=5min gap that `k`
# already describes, and no reconciliation pass is needed.
SAVE_EVERY_S = 300
# The hourly tier is DERIVED from the minute tier and rebuilt on load for every
# hour the minute tier still covers, so any cadence under RETAIN_H is lossless
# and this is purely an IO trade. Measured, the hourly file is the larger one
# (19.6 MB at nine coins, 52 MB at the cap); halving its write rate from the
# flow collector's 1800s saves ~1.25 GB/day of rewrite at the cap for nothing.
# Sizing note after the cap moved 24 -> 36: the hourly file scales ~2.2 MB per
# coin at full 400d retention, so the ceiling moves 52 -> ~78 MB rewritten once
# an hour. The minute file is unaffected in shape (48h x 60 rows/coin).
SAVE_HOURLY_EVERY_S = 3600

# 36 coins x 2 resolutions = 72 open l2Book subscriptions on one socket; HL
# allows 1000, so this is a courtesy cap sized to the seed, not a protocol
# limit. Raised from 24 when the seed stopped being nine crypto names: the
# volume-ranked seed is ~13 crypto + 12 xyz = 25, and the remaining slots are
# left free for the on-demand ensure() path so charting an unseeded market
# still starts its book. Measured cost of the added xyz coverage: 14 xyz
# markets pushed 19.2 KB/s across BOTH resolutions plus trades, and ZERO REST
# requests — nSigFigs is a subscription parameter, not a query string.
#
# REVIEWED AND KEPT, 2026-08-16. An audit flagged "the depth collector is
# starving UNI and xyz:MINIMAX". Re-checked: both are SUBSCRIBED and hold 94
# and 637 buckets respectively — they are collecting, just later-seeded than
# the volume-ranked head of the list. This cap is a DECLARED OPERATIONAL
# LIMIT that status() publishes (max_coins / slots_free / subs_open), not a
# silent drop, so a market outside it is visibly outside it. No defect; do
# not re-open. Raise the number if the seed grows, not because a coin is
# missing from it.
MAX_COINS = 36
# Coins not in the live seed whose last sample is older than this are
# dropped from the minute/hourly stores. Add-only filled 45 keys against
# 36 live slots (UNI/ACE/GOOGL leftovers 9-11d). History older than this
# is already outside the minute retention window.
STALE_EVICT_S = 7 * 86400
PINNED = {"BTC", "ETH", "SOL", "HYPE", "VVV", "DOGE", "XRP", "AVAX", "LINK"}
PARTNER_GRACE_S = 12        # emit a one-resolution sample if its partner
                            # stream has gone quiet for longer than this
STALE_WS_S = 90             # above this the socket is presumed dead and the
                            # REST gap-filler is allowed to run
# Above this age a stored level stops being reported as the current book. Five
# minutes is ~55 missed pushes at the venue's 5.4s ceiling, so it cannot fire
# on ordinary jitter; below it, a coin whose stream died still reads as live.
FRESH_S = 300

# --- SOCKET LIVENESS -------------------------------------------------------
# The venue can hold a socket OPEN and send nothing at all. `async for raw in
# ws:` waits on that forever, and ping_interval/ping_timeout did NOT rescue the
# sibling trade-flow collector when exactly this happened live on 2026-08-14:
# the transport's send failures were logged by asyncio instead of raising into
# this coroutine, so the reconnect path never ran, collection stopped for 24
# minutes, and `running: true` sat on screen the whole time. The recv is
# therefore bounded, and a DATA-staleness watchdog — not the protocol ping — is
# what forces the reconnect.
RECV_TIMEOUT_S = 15         # bound the wait so a silent socket still ticks
# And bound the SENDS for the same reason — see _subscribe(). A subscribe
# frame is ~110 bytes; if that has not cleared the socket buffer in 15s the
# peer has stopped reading, which is the wedge, not slowness.
SEND_TIMEOUT_S = 15
# Silence across ALL subscriptions before the socket is declared deaf.
#
# DELIBERATELY GLOBAL, AND THIS IS THE WHOLE DESIGN. Measured on this store's
# own 48h of rows: the 16 xyz equity books went simultaneously silent for 76
# minutes (21:36-22:52 IST 2026-08-14) while all 20 crypto books recorded 75 of
# those 76 minutes at k~=29 samples/min. The socket was emphatically alive.
# xyz:TSLA alone was quiet for 314 minutes. A per-coin rule would have torn
# down a healthy socket 16 times over, and a per-sleeve rule once — so only
# TOTAL silence is diagnostic of the collector rather than of the market.
#
# Sizing: 36 coins x 2 resolutions = 72 open subscriptions, and the k histogram
# across the whole store is bimodal at k=11 and k=29 samples/minute/coin
# (~5.5s and ~2.1s per coin), so in steady state a frame lands every ~0.08s.
# Every multi-minute all-coin gap in the 48h store matches a RESTART MARKER in
# the service log; none is an in-flight silence. 120s of nothing on all 72 has
# never been observed while the socket was up.
WATCHDOG_S = 120
# Per-coin REPORTING threshold, never a trigger. One bucket: a coin that has
# not pushed inside a full minute contributed nothing to the minute being
# folded, which is the fact a consumer needs — not a reason to reconnect.
QUIET_S = BUCKET_S
# NOTE the ordering STALE_WS_S (90) < WATCHDOG_S (120): server.py's depth timer
# starts the paced REST gap-filler on `ws_stale` BEFORE the watchdog tears the
# socket down. That is intentional — depth has no backfill, so the degraded
# path engages while the watchdog is still deciding, and neither preempts the
# other. Changing either constant must preserve that order.

# venues.PACE_S is the in-house spacing for anything fired in a burst at this
# venue ("6 of 10 venues failed when fired back-to-back"). A reconnect sends 72
# subscribes; pacing them costs ~10.8s ONCE against a subscription set that
# then runs for hours, and an unpaced burst is the shape that gets shed.
try:
    from datasources.venues import PACE_S as SUB_PACE_S
except Exception:           # importable standalone, e.g. from a test harness
    SUB_PACE_S = 0.15

_LOCK = threading.Lock()
_MIN = {}                   # coin -> {minute_ms: ROW}
_HOUR = {}                  # coin -> {hour_ms: ROW}
_SAMP = {}                  # coin -> {minute_ms: [sample, ...]}  (in flight)
_PEND = {}                  # (coin, exchange_ms) -> {sig: view, "at": mono}
_SUBBED = set()
_PENDING = set()
_STARTED = threading.Event()
_LAST_MSG = {"ts": 0.0}
# coin -> wall clock of the last l2Book frame that arrived FOR THAT COIN.
# Recorded at the MESSAGE, not at the stored sample, so a book that arrives but
# fails `_view()` still counts as a living subscription: "this stream is dead"
# and "this book is unusable" are different faults and must not share a symptom.
# A coin absent from this dict has NEVER delivered on this process — reported
# separately from "delivered, then went quiet", because those are not the same
# claim and neither is "measured zero".
_LAST_COIN = {}
# Reconnects forced by the watchdog, counted apart from ordinary reconnects so
# a consumer can tell a flapping socket from a stable one.
_WEDGE = {"n": 0, "at": 0.0, "silent_s": None}
_LAST_HOURLY_SAVE = [0.0]
_REST_CALLS = [0]


# ---------------------------------------------------------------- parsing

def _view(d):
    """One l2Book payload -> per-resolution band view, or None if unusable.

    Bands are assigned by the level's reported price. Aggregated buckets are
    labelled at the FAR edge on BOTH sides (a bid label sits at or below the
    true best bid, an ask label at or above the true best ask), so the
    under-count is symmetric and imbalance derived from these bands carries no
    systematic tilt. Had it been one-sided every imbalance number would have
    been quietly wrong.
    """
    levels = d.get("levels") or []
    if len(levels) < 2:
        return None
    bids, asks = levels[0] or [], levels[1] or []
    if not bids or not asks:
        return None
    try:
        mid = (float(bids[0]["px"]) + float(asks[0]["px"])) / 2.0
    except (KeyError, TypeError, ValueError):
        return None
    if mid <= 0 or len(bids) < 2:
        return None
    try:
        tick = abs(float(bids[0]["px"]) - float(bids[1]["px"]))
    except (KeyError, TypeError, ValueError):
        return None
    if tick <= 0:
        return None
    tick_bps = tick / mid * 1e4
    try:
        reach_bps = min((mid - float(bids[-1]["px"])) / mid * 1e4,
                        (float(asks[-1]["px"]) - mid) / mid * 1e4)
    except (KeyError, TypeError, ValueError):
        return None
    if reach_bps <= 0:
        return None

    def side(rows):
        ntl = [None] * len(GRID)
        cnt = [None] * len(GRID)
        for i, g in enumerate(GRID):
            if not (tick_bps <= g <= reach_bps):
                continue        # finer than the tick, or past the last level
            s = 0.0
            c = 0
            for r in rows:
                try:
                    px = float(r["px"])
                    sz = float(r["sz"])
                except (KeyError, TypeError, ValueError):
                    continue
                if abs(px - mid) / mid * 1e4 <= g:
                    s += px * sz
                    c += int(r.get("n") or 0)
            ntl[i] = s
            cnt[i] = c
        return ntl, cnt

    bn, bc = side(bids)
    an, ac = side(asks)
    # `spread` is the TRUE full-precision spread at every nSigFigs — verified
    # identical across both resolutions on all ten watchlist coins — so the
    # coarse stream gives an exact spread for free and no third subscription
    # at nSigFigs=5 is needed to obtain one.
    try:
        sp = float(d.get("spread"))
    except (TypeError, ValueError):
        sp = float(asks[0]["px"]) - float(bids[0]["px"])
    return {"t": int(d.get("time") or 0), "mid": mid,
            "tick_bps": tick_bps, "reach_bps": reach_bps,
            "spread_bps": sp / mid * 1e4,
            "b": bn, "a": an, "bo": bc, "ao": ac}


def _stitch(near, wide):
    """Merge the two resolutions into one sample. Finer book wins per band."""
    src = near or wide
    if src is None:
        return None
    out = {"t": src["t"], "mid": src["mid"], "spread_bps": src["spread_bps"],
           "tick_bps": (near or wide)["tick_bps"],
           "reach_bps": (wide or near)["reach_bps"],
           "b": [None] * len(GRID), "a": [None] * len(GRID),
           "bo": None, "ao": None}
    for i in range(len(GRID)):
        for v in (near, wide):
            if v is None:
                continue
            if out["b"][i] is None and v["b"][i] is not None:
                out["b"][i] = v["b"][i]
                if i == REF:
                    out["bo"] = v["bo"][i]
            if out["a"][i] is None and v["a"][i] is not None:
                out["a"][i] = v["a"][i]
                if i == REF:
                    out["ao"] = v["ao"][i]
    return out


# ---------------------------------------------------------------- folding

def _g4(v):
    """4 significant figures as an int. Float noise costs 74% more on disk
    (flow's own store carries values like 7543400.698090001) and every digit
    past the fourth is below the resolution of anything being asked."""
    if v is None:
        return None
    try:
        return int(float("%.4g" % v))
    except (TypeError, ValueError, OverflowError):
        return None


def _containment(b, a):
    """Drop every band that is SMALLER than a band it must contain.

    +/-50bps is a strict superset of +/-25bps, so its notional cannot be the
    lower of the two. It was, in 13 of 57,992 stored values (ZEC 11, XRP 1,
    xyz:GOLD 1) — because `_stitch` sources ADJACENT bands from DIFFERENT
    resolutions. ZEC resolves [5,10,25] on the fine book (reach ~40bps) and
    [25,50,100,250] on the coarse one, so +/-25 is measured at a 1bp tick and
    +/-50 at a 25bp tick, and the coarse bucket edges can place size outside a
    band the fine book counted inside it.

    A number that contradicts its own definition is not a measurement, so it
    is removed and the reason recorded — NOT clamped up to its neighbour,
    which would publish a lower bound as a reading. Later bands are then
    compared against the last band that survived, so one bad value cannot
    cascade. Mutates both lists in place; returns [[side, band_bps], ...].
    """
    dropped = []
    for arr, side in ((b, "bid"), (a, "ask")):
        prev = None
        for i in range(len(GRID)):
            v = arr[i] if i < len(arr) else None
            if v is None:
                continue
            if prev is not None and v < prev:
                arr[i] = None
                dropped.append([side, GRID[i]])
                continue
            prev = v
    return dropped


def _row_from_samples(samples):
    """Fold the ~11 samples of one minute into a stored row.

    MEDIAN, not last and not mean: a single sample lands on whatever a market
    maker's quote happened to be at that instant, and the mean is dragged by
    the same transient. Measured on this venue, last-vs-median differs by 14%
    on BTC and 42% on HYPE; mean-vs-median is 0.6% on BTC but still 14% on
    HYPE. The minimum at the reference band is kept separately BECAUSE the
    median smooths away exactly the ten-second hole that precedes a move.
    """
    if not samples:
        return None
    med = lambda xs: statistics.median(xs) if xs else None
    row = {"m": float("%.8g" % med([s["mid"] for s in samples])),
           "sp": round(med([s["spread_bps"] for s in samples]), 3),
           "sx": round(max(s["spread_bps"] for s in samples), 3),
           "k": len(samples),
           "t": round(med([s["tick_bps"] for s in samples]), 3),
           "r": round(med([s["reach_bps"] for s in samples]), 1)}
    b, a, kb, ka = [], [], [], []
    for i in range(len(GRID)):
        bs = [s["b"][i] for s in samples if s["b"][i] is not None]
        as_ = [s["a"][i] for s in samples if s["a"][i] is not None]
        b.append(_g4(med(bs)))
        a.append(_g4(med(as_)))
        kb.append(len(bs))
        ka.append(len(as_))
    row["b"] = b
    row["a"] = a
    # PER-BAND support, not just the row's `k`. Every band is a median over
    # only the samples that RESOLVED that band, and that subset varies wildly:
    # measured on the live store, xyz:CL carries +/-250bps in 4% of minutes and
    # xyz:SP500 in 18%, while `k` advertised 11-12 samples for the whole row.
    # A band held up by one sample in eleven is not the same measurement as
    # one held up by all eleven, and nothing said which it was.
    row["kb"], row["ka"] = kb, ka
    cv = _containment(b, a)
    if cv:
        row["cv"] = cv
    bl = [s["b"][REF] for s in samples if s["b"][REF] is not None]
    al = [s["a"][REF] for s in samples if s["a"][REF] is not None]
    row["bl"] = _g4(min(bl)) if bl else None
    row["al"] = _g4(min(al)) if al else None
    bo = [s["bo"] for s in samples if s["bo"] is not None]
    ao = [s["ao"] for s in samples if s["ao"] is not None]
    row["bo"] = int(med(bo)) if bo else None
    row["ao"] = int(med(ao)) if ao else None
    return row


def _merge(rows):
    """Regroup already-stored rows. THE ONLY PLACE THE ROLL-UP RULE LIVES.

    bands / mid / spread / order counts -> MEDIAN
    air-pocket minima                   -> MIN
    worst spread                        -> MAX
    k                                   -> SUM  (the only field that sums)

    Summing a level produces a number proportional to the sampling rate, which
    is the most likely bug in anything built on this store; keeping the rule in
    one function is the defence.
    """
    rows = [r for r in rows if r]
    if not rows:
        return None
    med = lambda xs: statistics.median(xs) if xs else None
    pick = lambda f: [r[f] for r in rows if r.get(f) is not None]
    out = {"m": float("%.8g" % med(pick("m"))) if pick("m") else None,
           "sp": round(med(pick("sp")), 3) if pick("sp") else None,
           "sx": round(max(pick("sx")), 3) if pick("sx") else None,
           "k": sum(r.get("k") or 0 for r in rows),
           "t": round(med(pick("t")), 3) if pick("t") else None,
           "r": round(med(pick("r")), 1) if pick("r") else None}
    b, a = [], []
    for i in range(len(GRID)):
        bs = [r["b"][i] for r in rows if (r.get("b") or [None] * len(GRID))[i] is not None]
        as_ = [r["a"][i] for r in rows if (r.get("a") or [None] * len(GRID))[i] is not None]
        b.append(_g4(med(bs)))
        a.append(_g4(med(as_)))
    out["b"] = b
    out["a"] = a
    # Support SUMS with k — it is a sample count, and it is the second field
    # that sums, so it is named here beside the first.
    for f in ("kb", "ka"):
        out[f] = [sum((r.get(f) or [0] * len(GRID))[i] for r in rows)
                  for i in range(len(GRID))]
    cv = _containment(out["b"], out["a"])
    if cv:
        out["cv"] = cv
    out["bl"] = min(pick("bl")) if pick("bl") else None
    out["al"] = min(pick("al")) if pick("al") else None
    out["bo"] = int(med(pick("bo"))) if pick("bo") else None
    out["ao"] = int(med(pick("ao"))) if pick("ao") else None
    return out


def _record(coin, sample):
    """Buffer one stitched sample under its minute."""
    if not sample or not sample.get("t"):
        return
    mk = (sample["t"] // (BUCKET_S * 1000)) * BUCKET_S * 1000
    _SAMP.setdefault(coin, {}).setdefault(mk, []).append(sample)


def _close_minutes(now_ms=None):
    """Materialise every minute that has finished. Caller holds _LOCK."""
    if now_ms is None:
        now_ms = int(time.time() * 1000)
    cur = (now_ms // (BUCKET_S * 1000)) * BUCKET_S * 1000
    touched = set()
    for coin, mins in _SAMP.items():
        for mk in sorted(mins):
            if mk >= cur:
                continue
            row = _row_from_samples(mins.pop(mk))
            if row is None or not row.get("k"):
                continue        # k=0 emits NO ROW rather than a row of zeros
            _MIN.setdefault(coin, {})[mk] = row
            touched.add((coin, (mk // (HOUR_S * 1000)) * (HOUR_S * 1000)))
    for coin, hk in touched:
        _recompute_hour(coin, hk)
    for coin in list(_MIN):
        _trim(coin)
    return len(touched)


def _recompute_hour(coin, hour_ms):
    """Rebuild one hourly row from the minute rows it contains.

    The hourly tier is DERIVED, never accumulated independently: a median is
    not associative, so there is no incremental update that stays honest. It is
    written at ingest rather than on expiry because the flow collector already
    paid for that lesson — rolling only on expiry meant hourly depth grew one
    hour per hour of uptime, and a 90-day tier needed 90 days of uptime.
    """
    mins = _MIN.get(coin) or {}
    rows = [v for k, v in mins.items()
            if hour_ms <= k < hour_ms + HOUR_S * 1000]
    row = _merge(rows)
    if row is None:
        return
    _HOUR.setdefault(coin, {})[hour_ms] = row
    hrs = _HOUR[coin]
    if len(hrs) > MAX_HOURLY:
        for k in sorted(hrs)[:len(hrs) - MAX_HOURLY]:
            hrs.pop(k, None)


def _trim(coin):
    rows = _MIN.get(coin) or {}
    if len(rows) > MAX_BUCKETS:
        for k in sorted(rows)[:len(rows) - MAX_BUCKETS]:
            rows.pop(k, None)


# ---------------------------------------------------------------- storage

def _load():
    try:
        with open(STORE) as fh:
            d = json.load(fh)
        mins = {c: {int(k): v for k, v in rows.items()}
                for c, rows in ((d or {}).get("minute") or {}).items()}
    except (OSError, ValueError, AttributeError):
        mins = {}
    try:
        with open(STORE_HOURLY) as fh:
            d = json.load(fh)
        hrs = {c: {int(k): v for k, v in rows.items()}
               for c, rows in ((d or {}).get("hourly") or {}).items()}
    except (OSError, ValueError, AttributeError):
        hrs = {}
    # Reconcile: rebuild every hour the surviving minute rows fully cover, so
    # a crash between hourly saves costs nothing. The boundary hour is only
    # PARTLY covered — its earlier minutes have already aged out — so it is
    # filled in rather than overwritten, or a complete stored hour would be
    # replaced by a median over its last few surviving minutes.
    for c, rows in mins.items():
        if not rows:
            continue
        oldest = min(rows)
        by_hour = {}
        for k, v in rows.items():
            by_hour.setdefault((k // (HOUR_S * 1000)) * (HOUR_S * 1000), []).append(v)
        dst = hrs.setdefault(c, {})
        for hk, rs in by_hour.items():
            merged = _merge(rs)
            if merged is None:
                continue
            if hk >= oldest:
                dst[hk] = merged
            else:
                dst.setdefault(hk, merged)
    return mins, hrs


def _atomic(path, payload):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), suffix=".tmp")
    replaced = False
    try:
        with os.fdopen(fd, "w") as fh:
            json.dump(payload, fh, separators=(",", ":"))
        os.replace(tmp, path)
        replaced = True
    finally:
        if not replaced:
            try:
                os.unlink(tmp)
            except OSError:
                pass


def _save():
    with _LOCK:
        _close_minutes()
        snap = {"_v": 1, "minute": {c: {str(k): v for k, v in rows.items()}
                                    for c, rows in _MIN.items() if rows}}
    _atomic(STORE, snap)


def _save_hourly():
    with _LOCK:
        snap = {"_v": 1, "hourly": {c: {str(k): v for k, v in rows.items()}
                                    for c, rows in _HOUR.items() if rows}}
    _atomic(STORE_HOURLY, snap)


# ---------------------------------------------------------------- ingest

def _base(coin):
    return (coin or "").split(":")[-1]


def _oldest_evictable():
    """Oldest non-pinned subscribed coin. Frees a slot without touching BTC."""
    held = _SUBBED | _PENDING
    best, best_last = None, None
    for c in held:
        if _base(c) in PINNED:
            continue
        rows = _MIN.get(c) or {}
        last = max(rows) if rows else 0
        if best is None or last < best_last:
            best, best_last = c, last
    return best


def _prune_stale(keep):
    """Drop store keys that are not live and have gone quiet for a week."""
    keep = {c for c in keep}
    cutoff = int(time.time() * 1000) - STALE_EVICT_S * 1000
    dropped = []
    for store in (_MIN, _HOUR):
        for c in list(store):
            if c in keep or _base(c) in PINNED:
                continue
            rows = store[c] or {}
            last = max(rows) if rows else 0
            if last < cutoff:
                store.pop(c, None)
                dropped.append(c)
    return dropped


def ensure(coin):
    """Subscribe to `coin` if we are not already. Charting a coin is the
    signal its book matters, and depth cannot be backfilled, so the pane
    fills from that moment rather than staying permanently blank.

    Equity perps are accepted and, since 2026-08-14, SEEDED. The old note
    here said `xyz:` coins have no trade stream and that depth was the only
    microstructure signal they could ever have; that was wrong on both counts
    and the flow collector now subscribes them too. What is true is that
    l2Book serves them normally: measured across the top 14 xyz markets by
    volume, all 14 acked both resolutions, all 14 pushed books at the same
    ~5s cadence as BTC, and the two resolutions paired on an identical
    exchange `time` exactly as they do on core coins (15 paired snapshots per
    coin in 75s). The core band grid [10,25,50,100]bps resolved on all 14;
    only the optional ends dropped — +/-5 on the $1200-1600 names whose tick
    is 5.9-8.4bps, +/-250 on SP500/MU/CL/BRENTOIL whose 20 levels reach only
    199-250bps — and those are stored NULL, never zero.

    They are not seeded during out-of-hours thinness in any special way: an
    equity book that thins overnight is a fact about the book, and hiding it
    by not collecting would make the one question depth exists to answer
    ("was it thinner BEFORE the move?") unanswerable for the sleeve the owner
    actually trades.
    """
    if not coin:
        return False
    with _LOCK:
        if coin in _SUBBED or coin in _PENDING:
            return False
        if len(_SUBBED | _PENDING) >= MAX_COINS:
            victim = _oldest_evictable()
            if victim is None:
                return False
            _SUBBED.discard(victim)
            _PENDING.discard(victim)
        _PENDING.add(coin)
    return True


def subscribed():
    """(subscribed, pending) — what the collector ACTUALLY holds.

    `ensure()` returns False both when the coin is already in and when
    MAX_COINS is full, so its return value cannot distinguish "already
    covered" from "refused". Any surface that tells the reader a coin is being
    recorded must ask this instead: a full cap now evicts the oldest
    non-pinned name, so False still cannot distinguish "already in" from
    "nothing evictable".
    """
    with _LOCK:
        return sorted(_SUBBED), sorted(_PENDING)


def collected(limit=None):
    """Coins that already have persisted history, most rows first.

    Read straight off the store file, because start() has not loaded it yet
    when the seed is being built. It exists so a restart cannot silently
    unsubscribe a market that already holds hours nobody can refetch — Hyperliquid publishes no L2 book archive:
    the seed passes this as `keep`, ranked below the fresh volume picks, so
    what gets lost first when slots run short is what has fallen out of the
    top N — not what has the deepest record.
    """
    try:
        with open(STORE) as fh:
            d = json.load(fh)
    except (OSError, ValueError):
        return []
    rows = d.get("minute") if isinstance(d, dict) and "minute" in d else d
    if not isinstance(rows, dict):
        return []
    counts = {}
    for c, v in rows.items():
        if not c.startswith("_") and isinstance(v, dict):
            counts[c] = len(v)
    out = sorted(counts, key=lambda c: -counts[c])
    return out[:limit] if limit else out


def _rank(views):
    """Order views finest-first. Which is which is decided by the delivered
    tick, never by a threshold on it.

    A threshold looks tempting because tick(4) lands in (1,10] bps and tick(3)
    in (10,100] — but both endpoints are attainable. A coin priced just above a
    power of ten has tick(4) == 10.0 bps exactly, and one priced just below has
    tick(3) == 10.0 bps exactly, so the two resolutions are indistinguishable
    by tick alone precisely at the decade boundaries every coin eventually
    crosses. Ranking the pair against each other has no boundary to be wrong
    at.
    """
    vs = sorted([v for v in views if v], key=lambda v: v["tick_bps"])
    if len(vs) >= 2 and vs[0]["tick_bps"] == vs[1]["tick_bps"]:
        vs = vs[:1]                     # same book delivered twice
    return (vs[0] if vs else None, vs[1] if len(vs) > 1 else None)


def _ingest(d):
    """One l2Book message. Pairs the two resolutions on exchange `time`."""
    coin = d.get("coin")
    if not coin:
        return
    v = _view(d)
    now = time.time()
    with _LOCK:
        # Subscription liveness is stamped BEFORE the book is judged usable and
        # regardless of the verdict: an unusable book still proves the stream
        # is delivering, and conflating the two would let a parsing fault
        # masquerade as a dead socket.
        _LAST_COIN[coin] = now
        if v is None:
            return
        key = (coin, v["t"])
        slot = _PEND.get(key)
        if slot is None:
            slot = _PEND[key] = {"at": time.monotonic(), "v": []}
        slot["v"].append(v)
        if len(slot["v"]) >= 2:
            _PEND.pop(key, None)
            _record(coin, _stitch(*_rank(slot["v"])))
        _sweep_pending()


def _sweep_pending():
    """Emit half-paired snapshots whose partner stream has gone quiet.

    Both resolutions for a coin are stamped with an identical exchange `time`
    (measured: ten of ten coins, both books, same millisecond), so pairing on
    it is exact. But a dropped or lagging subscription must not silently stop
    collection for that coin — after the grace period the sample is emitted
    with whatever arrived, and the bands the missing book would have supplied
    stay NULL. Caller holds _LOCK.
    """
    if not _PEND:
        return
    now = time.monotonic()
    for key in [k for k, s in _PEND.items() if now - s["at"] > PARTNER_GRACE_S]:
        slot = _PEND.pop(key)
        _record(key[0], _stitch(*_rank(slot["v"])))


# ---------------------------------------------------------------- REST path

def snapshot(coins=None, pace_s=0.15):
    """Take one depth sample per coin over REST. Returns coins sampled.

    This is the gap-filler, not the collector: the websocket carries both
    resolutions for zero added request weight, so in steady state this never
    runs and the added REST rate is 0.00 req/s. It exists for the window when
    the socket is down, and it is deliberately single-threaded and paced — the
    whale sweep's ThreadPoolExecutor fan-out is what produces the burst shape
    that gets shed, and this must not add to it. Two calls per coin (one per
    resolution); at nine coins a full pass is 18 calls spread over ~3s.

    A shed depth fetch is self-describing — the minute simply carries a lower
    `k` — so unlike the whale sweep there is no retry pass. A missing sample
    can never be misread as "no liquidity"; a stale one could.
    """
    from datasources import hl
    if coins is None:
        with _LOCK:
            coins = sorted(_SUBBED | _PENDING)
    done = []
    for coin in coins:
        views = {}
        for sig in (SIG_NEAR, SIG_WIDE):
            try:
                d = hl.l2_book(coin, sig)
                _REST_CALLS[0] += 1
                v = _view(d)
                if v is not None:
                    views[sig] = v
            except Exception:
                pass
            time.sleep(pace_s)
        if not views:
            continue
        # REST cannot promise the cross-resolution coherence the socket gives
        # for free, so the pair is stamped with the EARLIER exchange time and
        # only accepted when the two books are within one push interval.
        near, wide = _rank(list(views.values()))
        if near and wide and abs(near["t"] - wide["t"]) > 6000:
            wide = None
        s = _stitch(near, wide)
        if s is None:
            continue
        with _LOCK:
            _record(coin, s)
        done.append(coin)
    with _LOCK:
        _close_minutes()
    return done


# ---------------------------------------------------------------- readers

def _imb(b, a):
    if b is None or a is None or (b + a) <= 0:
        return None
    return round((b - a) / (b + a), 4)


def _band_val(i, side):
    """Stored row -> notional resting within GRID[i], for one side or both."""
    def val(r):
        b = (r.get("b") or [None] * len(GRID))[i]
        a = (r.get("a") or [None] * len(GRID))[i]
        if side == "bid":
            return b
        if side == "ask":
            return a
        if b is None or a is None:
            return None
        return b + a
    return val


def _imb_val(i):
    def val(r):
        b = (r.get("b") or [None] * len(GRID))[i]
        a = (r.get("a") or [None] * len(GRID))[i]
        return _imb(b, a)
    return val


def _rows_for(coins, include_open=True, include_hourly=True):
    """coin -> {ms: row}: minute tier as ground truth, hourly filling behind.

    ONE lock acquisition for the whole set, because the screener asks about the
    entire universe at once and the per-coin form would copy the minute tier
    once per coin per horizon. The open (unfinished) minute is folded in the
    same way `series()` does it, so the three readers — series, delta, metrics —
    all end their line at the same sample. They used to disagree by up to a
    minute: series drew a bar that delta refused to see.
    """
    with _LOCK:
        _close_minutes()
        want = list(coins) if coins is not None else sorted(set(_MIN) | set(_HOUR))
        mins = {c: dict(_MIN.get(c) or {}) for c in want}
        hrs = ({c: dict(_HOUR.get(c) or {}) for c in want}
               if include_hourly else {})
        opens = ({c: {mk: list(ss) for mk, ss in (_SAMP.get(c) or {}).items() if ss}
                  for c in want} if include_open else {})
    out = {}
    for c in want:
        rows = mins.get(c) or {}
        for mk, ss in (opens.get(c) or {}).items():
            if mk in rows:
                continue
            r = _row_from_samples(ss)
            if r:
                rows[mk] = r
        for hk, hv in (hrs.get(c) or {}).items():
            rows.setdefault(hk, hv)
        out[c] = rows
    return out


def _anchor(keys, now_k, hours):
    """The sample to measure `hours` back from, or None if not covered.

    THE ONLY PLACE THE ANCHOR RULE LIVES. Both change readers come through
    here, so a screen can never be answered by a rule that `readiness()` did
    not advertise.

    Nearest sample on EITHER side of the target, then require the span it
    actually delivers to be within 25% of the one asked for. Demanding an
    anchor at or before the target is off by one bucket — N samples span N-1
    intervals — and the oi_history store spent its whole life returning None
    to every delta() call for exactly that reason while coverage() reported
    itself ready. That failure is invisible: it reads as "nothing happening".

    The tolerance floor is ONE BUCKET, and the bucket here is a minute — not
    oi_history's literal `max(1, ...)`, which is one bucket only because its
    buckets are hours. Transplanted unchanged it grants sixty buckets of slack,
    and this store answered delta(1h) = -0.85% off six minutes of data: a
    plausible-looking number for a question it could not answer. That is the
    more dangerous half of the same bug — a wrong answer rather than a
    permanent None, and nothing on screen would say so.
    """
    if len(keys) < 2:
        return None
    target = now_k - hours * 3600 * 1000
    anchor = min(keys, key=lambda k: abs(k - target))
    span_h = (now_k - anchor) / 3600000.0
    if span_h <= 0 or abs(span_h - hours) > _tol_h(hours):
        return None
    return anchor


def _tol_h(hours):
    return max(BUCKET_S / 3600.0, hours * 0.25)


def _chg(rows, hours, val, diff=False):
    """Change in `val` over `hours`: percent by default, absolute if `diff`.

    Imbalance is the reason `diff` exists — it is already a ratio in [-1, 1],
    and a percent change of a ratio that crosses zero is arithmetic noise
    dressed as a signal (bid-heavy 0.02 -> ask-heavy -0.02 is "-200%").
    """
    keys = sorted(k for k in rows if val(rows[k]) is not None)
    if len(keys) < 2:
        return None
    now_k = keys[-1]
    anchor = _anchor(keys, now_k, hours)
    if anchor is None:
        return None
    v0, v1 = val(rows[anchor]), val(rows[now_k])
    if v0 is None or v1 is None:
        return None
    if diff:
        return v1 - v0
    if not v0:
        return None
    return (v1 - v0) / v0 * 100.0


def _out(ms, row):
    """Stored row -> API row. Imbalance is DERIVED here, never stored: it is a
    pure function of two stored numbers, and persisting it invites the stored
    value and the recomputed one to drift apart."""
    b, a = row.get("b") or [], row.get("a") or []
    return {"ms": ms, "mid": row.get("m"),
            "spread_bps": row.get("sp"), "spread_max_bps": row.get("sx"),
            "k": row.get("k"), "bands_bps": GRID,
            # Per-band sample support and any band removed for violating
            # cumulative containment. Both travel with the numbers; a band
            # resolved in 4% of the minute must not read like one resolved in
            # 100%, and a dropped band must not read like an absent book.
            "k_bid_band": row.get("kb"), "k_ask_band": row.get("ka"),
            "containment_dropped": row.get("cv"),
            "bid": b, "ask": a,
            "imb": [_imb(b[i] if i < len(b) else None,
                         a[i] if i < len(a) else None) for i in range(len(GRID))],
            "bid_min": row.get("bl"), "ask_min": row.get("al"),
            "bid_orders": row.get("bo"), "ask_orders": row.get("ao"),
            "ref_bps": REF_BPS,
            "tick_bps": row.get("t"), "reach_bps": row.get("r")}


def series(coin, hours=24, bucket_s=BUCKET_S, include_open=True):
    """[{ms, mid, bid[6], ask[6], imb[6], ...}] oldest first.

    The two tiers overlap fully (hourly is derived from minute rows), so minute
    data is ground truth wherever it exists and hourly only fills in behind it.
    An hourly row can only serve a request whose own bucket is at least an
    hour: handing an hour of book state to a five-minute bar would be a lie
    about resolution, not a rounding error.
    """
    with _LOCK:
        _close_minutes()
        rows = dict(_MIN.get(coin) or {})
        hrs = dict(_HOUR.get(coin) or {})
        open_samp = {}
        if include_open:
            for mk, ss in (_SAMP.get(coin) or {}).items():
                if ss:
                    open_samp[mk] = list(ss)
    cutoff = (time.time() - hours * 3600) * 1000
    if include_open:
        for mk, ss in open_samp.items():
            r = _row_from_samples(ss)
            if r:
                rows.setdefault(mk, r)
    if hrs and bucket_s >= HOUR_S:
        covered = {(k // (HOUR_S * 1000)) * (HOUR_S * 1000) for k in rows}
        for hk, hv in hrs.items():
            if hk < cutoff or hk in covered:
                continue
            rows[hk] = hv
    if not rows:
        return []
    group = max(1, int(bucket_s // BUCKET_S)) * BUCKET_S * 1000
    buckets = {}
    for k in sorted(rows):
        if k < cutoff:
            continue
        buckets.setdefault((k // group) * group, []).append(rows[k])
    out = []
    for gk in sorted(buckets):
        m = _merge(buckets[gk])
        if m:
            out.append(_out(gk, m))
    return out


def delta(coin, hours, band_bps=REF_BPS, side="both"):
    """Percent change in resting depth within +/-band over `hours`, or None.

    None means NOT COVERED, and the caller must render it as such rather than
    as zero change. There is no backfill: before enough hours have accrued the
    honest answer is that the question cannot be asked yet.
    """
    try:
        i = GRID.index(band_bps)
    except ValueError:
        return None
    rows = _rows_for([coin]).get(coin) or {}
    return _chg(rows, hours, _band_val(i, side))


def _imb_stability(rows, i):
    """How much of this band's imbalance survives one minute.

    Lag-1 Pearson autocorrelation over ADJACENT minutes only (a gap ends the
    run, so a 5-minute hole never becomes a lag-1 pair), plus the per-minute
    sign-flip rate.

    Measured across the live store this spans 0.01 to 0.93 — xyz:SP500 +0.93,
    HYPE +0.91, BTC +0.62 at one end; xyz:BRENTOIL +0.01, xyz:CL +0.07,
    xyz:MU +0.10 at the other, with xyz:MU flipping sign in 48% of minutes
    against BTC's 0.4%. It is NOT a size threshold and cannot be inferred:
    xyz:CL carries an $8.5M book at rho 0.07 while VVV carries $41k at 0.54.

    It has to travel with the number because `one-sided-book` SORTS on
    imbalance, and the most extreme values come from exactly the books whose
    split is closest to a coin flip. Returns (rho, flip_pct, n_pairs).
    """
    step = BUCKET_S * 1000
    xs, ys, flips = [], [], 0
    prev_k = prev_v = None
    for k in sorted(rows):
        r = rows[k]
        bb = (r.get("b") or [None] * len(GRID))
        aa = (r.get("a") or [None] * len(GRID))
        v = _imb(bb[i] if i < len(bb) else None, aa[i] if i < len(aa) else None)
        if v is None:
            prev_k = prev_v = None
            continue
        if prev_v is not None and k - prev_k == step:
            xs.append(prev_v)
            ys.append(v)
            if prev_v and v and (v > 0) != (prev_v > 0):
                flips += 1
        prev_k, prev_v = k, v
    n = len(xs)
    if n < 30:
        return None, None, n          # too few pairs to state, NOT zero
    mx, my = sum(xs) / n, sum(ys) / n
    sxx = sum((x - mx) ** 2 for x in xs)
    syy = sum((y - my) ** 2 for y in ys)
    if sxx <= 0 or syy <= 0:
        return None, None, n
    sxy = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    rho = sxy / math.sqrt(sxx * syy)
    return (round(max(-1.0, min(1.0, rho)), 3),
            round(flips / float(n) * 100.0, 1), n)


IMB_NOISE_RHO = 0.3


def metrics(coins=None, band_bps=REF_BPS):
    """coin -> the depth row a cross-sectional screen needs. One lock, one pass.

    Levels AND changes, because only the change needs the store and the change
    is the whole point of having built it: "the book is $4M deep" is a fact the
    live l2Book already answers, while "the book is $4M deep and that is 40%
    thinner than an hour ago" is the question that was unanswerable before
    anything was written to disk.

    STALENESS NULLS EVERYTHING. If the newest sample for a coin is older than
    FRESH_S the whole row goes None with `depth_age_s` set, rather than
    reporting an hours-old book beside live price and volume. A stale level is
    the obvious half; the subtle half is that `_chg` anchors on the newest
    sample, so a "1h change" off a stale tail is a real 1h change that ended
    three hours ago — correct arithmetic, wrong question, and nothing in the
    number itself says so.
    """
    try:
        i = GRID.index(band_bps)
    except ValueError:
        i = REF
    by_coin = _rows_for(coins)
    now_ms = time.time() * 1000
    out = {}
    for c, rows in by_coin.items():
        if not rows:
            continue
        keys = sorted(rows)
        last_k = keys[-1]
        # Measured from the bucket's START, so a just-closed minute reads up to
        # 60s old. FRESH_S is far enough above BUCKET_S that this cannot alone
        # trip the gate.
        age_s = round((now_ms - last_k) / 1000.0, 1)
        span_h = round(((last_k - keys[0]) / 60000.0 + 1) / 60.0, 2)
        cur = rows[last_k]
        row = {"depth_band_bps": GRID[i], "depth_h": span_h,
               "depth_age_s": age_s, "depth_stale": age_s > FRESH_S,
               "depth_k": cur.get("k"),
               "depth_usd": None, "depth_bid_usd": None, "depth_ask_usd": None,
               "depth_imb": None, "depth_ord_usd": None, "depth_air_pct": None,
               "depth_chg_1h": None, "depth_chg_24h": None,
               "depth_bid_chg_1h": None, "depth_ask_chg_1h": None,
               "depth_imb_chg_1h": None,
               "depth_imb_rho": None, "depth_imb_flip_pct": None,
               "depth_imb_n": None, "depth_imb_noisy": None}
        if row["depth_stale"]:
            out[c] = row
            continue
        b = (cur.get("b") or [None] * len(GRID))[i]
        a = (cur.get("a") or [None] * len(GRID))[i]
        row["depth_bid_usd"] = b
        row["depth_ask_usd"] = a
        row["depth_usd"] = (b + a) if (b is not None and a is not None) else None
        row["depth_imb"] = _imb(b, a)
        # Resting order size at the reference band. One $50M order and five
        # thousand small ones are the same dollars and nothing alike; this is
        # the only column in the terminal that tells them apart.
        bo, ao = cur.get("bo"), cur.get("ao")
        bref = (cur.get("b") or [None] * len(GRID))[REF]
        aref = (cur.get("a") or [None] * len(GRID))[REF]
        if bo and ao and bref is not None and aref is not None:
            row["depth_ord_usd"] = round((bref + aref) / float(bo + ao))
        # Air pocket: the deepest one-side dip below that side's own median
        # inside the last minute. Per side deliberately — summing the two
        # minima would compare instants that never co-occurred.
        air = []
        for med, lo in ((bref, cur.get("bl")), (aref, cur.get("al"))):
            if med and lo is not None:
                air.append((lo - med) / med * 100.0)
        if air:
            row["depth_air_pct"] = round(min(air), 1)
        row["depth_chg_1h"] = _chg(rows, 1, _band_val(i, "both"))
        row["depth_chg_24h"] = _chg(rows, 24, _band_val(i, "both"))
        row["depth_bid_chg_1h"] = _chg(rows, 1, _band_val(i, "bid"))
        row["depth_ask_chg_1h"] = _chg(rows, 1, _band_val(i, "ask"))
        row["depth_imb_chg_1h"] = _chg(rows, 1, _imb_val(i), diff=True)
        rho, flip, npair = _imb_stability(rows, i)
        row["depth_imb_rho"] = rho
        row["depth_imb_flip_pct"] = flip
        row["depth_imb_n"] = npair
        # None when unmeasured — "not enough history to say" is not "stable".
        row["depth_imb_noisy"] = None if rho is None else rho < IMB_NOISE_RHO
        out[c] = row
    return out


def readiness(hours=1):
    """Which collected coins can answer a change over `hours`, and how many.

    Derived from `_tol_h` — the same tolerance `_anchor` enforces — so a pane
    can never advertise a screen as ready that `_chg` will then refuse. The two
    drifting apart is precisely the oi_history failure: coverage() said 24h and
    ready, delta() returned None to every call, and the screens sat empty
    looking exactly like a quiet market.

    A depth screen is ALSO scoped, not just gated: it can only ever see the
    coins the collector is subscribed to, so `n_collected` travels with the
    answer and every consumer must say which universe it just screened.
    """
    with _LOCK:
        _close_minutes()
        spans = {}
        for c, rows in _MIN.items():
            if not rows:
                continue
            ks = sorted(rows)
            spans[c] = ((ks[-1] - ks[0]) / 60000.0 + 1) / 60.0
        n_sub = len(_SUBBED | _PENDING)
    need = hours - _tol_h(hours)
    ok = sorted(c for c, h in spans.items() if h >= need)
    return {"hours": hours, "min_span_h": round(need, 2),
            "coins": ok, "n": len(ok), "ready": bool(ok),
            "n_collected": len(spans), "n_subscribed": n_sub,
            "max_span_h": round(max(spans.values()), 2) if spans else 0.0,
            "retain_h": RETAIN_H, "backfill": False}


def coverage(coin=None):
    """Hours actually accrued, per coin. Honest from the very first request.

    Hyperliquid publishes no book archive, so this can only ever count what
    this process recorded. `hours` is wall-clock span from oldest to newest
    sample; `filled` is the fraction of minutes inside that span that actually
    hold a row. A pane must say "Nh of 48h collected" until `ready`, and must
    never render an empty result that reads as "the book is empty".
    """
    with _LOCK:
        _close_minutes()
        mins = {c: dict(r) for c, r in _MIN.items()}
        hrs = {c: len(r) for c, r in _HOUR.items()}
        subbed = sorted(_SUBBED)
        pending = sorted(_PENDING)

    def one(c):
        rows = mins.get(c) or {}
        if not rows:
            return {"coin": c, "minutes": 0, "hours": 0.0, "filled": 0.0,
                    "hourly_rows": hrs.get(c, 0), "ready": False,
                    "note": "no depth recorded yet for %s — collection starts "
                            "when the coin is subscribed and cannot be "
                            "backfilled" % c}
        ks = sorted(rows)
        span_min = (ks[-1] - ks[0]) / 60000.0 + 1
        return {"coin": c, "minutes": len(rows),
                "hours": round(span_min / 60.0, 2),
                "filled": round(len(rows) / span_min, 3) if span_min else 0.0,
                "hourly_rows": hrs.get(c, 0),
                "ready": span_min / 60.0 >= RETAIN_H,
                "note": "%.1fh of %dh collected" % (span_min / 60.0, RETAIN_H)}

    if coin:
        return one(coin)
    coins = sorted(set(mins) | set(subbed) | set(pending))
    try:
        from datasources import universe
        by_sleeve = universe.coverage(coins, label="depth")
    except Exception as exc:
        by_sleeve = {"stale": True, "sleeves": {},
                     "note": "sleeve coverage unavailable: %s" % str(exc)[:80]}
    return {"backfill": False,
            "by_sleeve": by_sleeve,
            "backfill_note": "Hyperliquid publishes no L2 book archive: every "
                             "hour not recorded here is permanently "
                             "unanswerable.",
            "retain_h": RETAIN_H, "retain_hourly_d": RETAIN_HOURLY_D,
            "bands_bps": GRID, "ref_bps": REF_BPS,
            "sample_ceiling_s": 5.4,
            "sample_note": "Hyperliquid throttles l2Book pushes to ~5.4s, so "
                           "genuine sub-5s liquidity withdrawal is invisible "
                           "to this record.",
            "coins": [one(c) for c in coins]}


def flush():
    """Materialise finished minute buckets. Cheap, idempotent, no upstream
    calls — the timer thread calls this so a quiet socket still rolls the
    tiers forward instead of leaving samples stranded in memory."""
    with _LOCK:
        _sweep_pending()
        return _close_minutes()


def _liveness(subbed, last_coin, age, now):
    """Split subscription silence into DEAF vs NOT-CHANGING. Returns a dict.

    This exists because the two look identical from the outside and are opposite
    facts. A deaf collector reports every coin's last-known book as if it were
    current; a quiet book IS current and simply is not moving. The 2026-08-14
    trade-flow wedge was invisible for 24 minutes precisely because nothing
    distinguished them — `running: true` and a coin list were all a consumer
    had, and both stay true while the socket is dead.

    The split is three-way, not two, because "never delivered" is not "went
    quiet": a coin subscribed twenty seconds ago that has not pushed yet has NOT
    been measured silent, and reporting it as quiet would be inventing an
    observation. Absent from `last_coin` means exactly that, and it is named.
    """
    if not subbed:
        return {"subs_live": None, "subs_quiet": None, "subs_never": None,
                "quiet_coins": None, "never_coins": None, "wedged": None,
                "wedge_note": "no l2Book subscriptions are open — subscription "
                              "liveness is NOT MEASURED, which is not the same "
                              "as measured silence"}
    if age is None:
        return {"subs_live": None, "subs_quiet": None, "subs_never": None,
                "quiet_coins": None, "never_coins": sorted(subbed),
                "wedged": None,
                "wedge_note": "no l2Book frame has arrived on this socket yet "
                              "(%d subscriptions open) — liveness is NOT "
                              "MEASURED, not measured silence" % len(subbed)}
    never = sorted(c for c in subbed if c not in last_coin)
    quiet = sorted(c for c in subbed
                   if c in last_coin and now - last_coin[c] > QUIET_S)
    live = len(subbed) - len(never) - len(quiet)
    wedged = age > WATCHDOG_S
    if wedged:
        note = ("DEAF: nothing has arrived on ANY of the %d open subscriptions "
                "for %.0fs. This is a collector fault, not a quiet market — "
                "every depth level being served is a stale reading, not a "
                "current book. The watchdog forces a reconnect at %ds."
                % (len(subbed) * 2, age, WATCHDOG_S))
    elif quiet or never:
        note = ("socket is ALIVE (last frame %.1fs ago); %d of %d coins pushed "
                "within %ds, %d quiet, %d not yet heard from. A quiet coin here "
                "is a book that is not changing, NOT a dead collector — xyz "
                "equity books legitimately go silent for over an hour outside "
                "their session (measured: 16 xyz markets silent 76min on "
                "2026-08-14 while all 20 crypto books kept recording)."
                % (age, live, len(subbed), QUIET_S, len(quiet), len(never)))
    else:
        note = ("socket is ALIVE and all %d subscribed coins pushed within %ds "
                "(last frame %.1fs ago)" % (len(subbed), QUIET_S, age))
    return {"subs_live": live, "subs_quiet": len(quiet),
            "subs_never": len(never), "quiet_coins": quiet,
            "never_coins": never, "wedged": wedged, "wedge_note": note}


def status():
    with _LOCK:
        _sweep_pending()
        coins = {c: len(r) for c, r in _MIN.items()}
        hourly = {c: len(r) for c, r in _HOUR.items()}
        n_sub, n_pend = len(_SUBBED), len(_PENDING)
        pend_pairs = len(_PEND)
        subbed = set(_SUBBED)
        last_coin = dict(_LAST_COIN)
        wedge = dict(_WEDGE)
    now = time.time()
    age = round(now - _LAST_MSG["ts"], 1) if _LAST_MSG["ts"] else None
    live = _liveness(subbed, last_coin, age, now)
    # Per sleeve, always. A single "11 coins" number let depth read as covered
    # while xyz sat at 1 of 109 markets.
    try:
        from datasources import universe
        cov = universe.coverage(sorted(coins), label="depth")
    except Exception as exc:
        cov = {"stale": True, "sleeves": {},
               "note": "sleeve coverage unavailable: %s" % str(exc)[:80]}
    return {"running": _STARTED.is_set(), "coins": coins,
            "coverage_by_sleeve": cov,
            "hourly_coins": len(hourly),
            "hourly_max_rows": max(hourly.values()) if hourly else 0,
            "subscribed": n_sub, "pending_subs": n_pend,
            "unpaired_snapshots": pend_pairs,
            "subs_open": n_sub * 2, "max_coins": MAX_COINS,
            # Courtesy cap (HL allows 1000). Stale non-pinned coins older
            # than STALE_EVICT_S are dropped; a new chart can take a slot
            # from the oldest non-pinned name. PINNED names never evict.
            "slots_free": max(0, MAX_COINS - (n_sub + n_pend)),
            "slots_note": (
                "%d of %d coin slots used. Stale non-pinned names older "
                "than 7d are evicted; a newly charted market can take the "
                "oldest non-pinned slot. Pinned names (CRYPTO_WATCH) stay. "
                "Raise MAX_COINS to widen — cost is bandwidth (~629 B/s "
                "per market), not REST budget." % (n_sub + n_pend, MAX_COINS)),
            "slots_pressure": (n_sub + n_pend) >= MAX_COINS - 3,
            "last_msg_age_s": age,
            # UNCHANGED SEMANTICS: server.py's depth timer drives its paced REST
            # gap-filler off this flag at STALE_WS_S (90s), below WATCHDOG_S
            # (120s), so REST keeps depth accruing during the window before the
            # socket is torn down. `wedged` below is the stronger, additive
            # claim and does not replace this one.
            "ws_stale": age is None or age > STALE_WS_S,
            # --- is the collector DEAF, or is the book simply not changing? ---
            # Without this a wedge is indistinguishable from a calm market: both
            # show running:true, a full coin list, and unchanging depth numbers.
            "wedged": live["wedged"],
            "wedge_note": live["wedge_note"],
            "subs_live": live["subs_live"],
            "subs_quiet": live["subs_quiet"],
            "subs_never_heard": live["subs_never"],
            "quiet_coins": live["quiet_coins"],
            "never_heard_coins": live["never_coins"],
            "quiet_after_s": QUIET_S,
            "watchdog_s": WATCHDOG_S,
            "recv_timeout_s": RECV_TIMEOUT_S,
            "sub_pace_s": SUB_PACE_S,
            # Forced reconnects are counted apart from ordinary ones: a rising
            # count with a healthy socket right now means the socket is
            # FLAPPING, which no instantaneous field can show.
            "forced_reconnects": wedge["n"],
            "last_forced_reconnect_age_s": (round(now - wedge["at"], 1)
                                            if wedge["at"] else None),
            "last_wedge_silent_s": wedge["silent_s"],
            "rest_calls_total": _REST_CALLS[0],
            "added_rest_req_s": 0.0,
            "bucket_s": BUCKET_S, "retain_h": RETAIN_H,
            "sig_figs": [SIG_NEAR, SIG_WIDE], "bands_bps": GRID,
            "displayed_depth_only": True,
            "caveat": "displayed resting depth, not executable liquidity — "
                      "resting orders are cancellable"}


# ---------------------------------------------------------------- collector

async def _subscribe(ws, want):
    """Open both resolutions for each coin in `want`. Caller leaves them in
    _PENDING; each is moved to _SUBBED only once BOTH of its subscribes are on
    the wire.

    DURABILITY IS THE POINT, and the old shape did not have it. It read the
    pending set, CLEARED it, then subscribed in a loop whose except re-added
    only the coin that raised. Every coin queued behind that one had already
    been removed from _PENDING and had never reached _SUBBED, so it existed in
    neither set — and the reconnect rebuilds its want-list from exactly
    `set(coins) | _SUBBED | _PENDING`. An on-demand coin lost that way is never
    resubscribed. With no backfill and an add-only slot ratchet, that loss is
    permanent, and nothing on any surface would say so. Ownership here is
    transferred only on confirmation, so a raise anywhere leaves EVERY
    unconfirmed coin still owed, not just the one that failed.

    Paced at venues.PACE_S — see SUB_PACE_S.
    """
    done = []
    try:
        for c in want:
            for sig in (SIG_NEAR, SIG_WIDE):
                # BOUNDED send, mirroring the bounded recv below and
                # flow_collector's identical fix. This is the 2026-08-14 wedge
                # with the await moved one call down: a peer that holds the
                # socket open but stops READING parks ws.send() on a drain
                # waiter with no timeout, and the watchdog that exists to
                # escape it lives further down the SAME coroutine — below the
                # hung await, so it can never run. Time it out into the same
                # ConnectionError the watchdog raises, so a stuck send takes
                # the one abort -> save -> backoff -> resubscribe path.
                try:
                    await asyncio.wait_for(
                        ws.send(json.dumps({
                            "method": "subscribe",
                            "subscription": {"type": "l2Book", "coin": c,
                                             "nSigFigs": sig}})),
                        timeout=SEND_TIMEOUT_S)
                except asyncio.TimeoutError:
                    raise ConnectionError(
                        "depth ws subscribe(%s nSigFigs=%d) did not complete "
                        "in %.0fs — the peer has stopped reading"
                        % (c, sig, SEND_TIMEOUT_S))
                await asyncio.sleep(SUB_PACE_S)
            done.append(c)
    finally:
        # Runs on the raise path too: confirmed coins graduate, the rest stay
        # in _PENDING exactly as they were, and the slot accounting that
        # ensure() reads off `_SUBBED | _PENDING` never double-counts or drops.
        with _LOCK:
            _SUBBED.update(done)
            _PENDING.difference_update(done)
    return len(done)


def _abort(ws):
    """Drop the socket without a closing handshake. Never raises.

    MEASURED against websockets 15.0.1: `async with websockets.connect(...)`
    exits through client.connect.__aexit__ -> `await self.connection.close()`,
    and close() routes through send_context() -> drain(), which parks on a
    waiter with NO timeout (asyncio/connection.py). Against a peer that has
    stopped reading, that waiter is released only by resume_writing() or
    connection_lost() — neither of which ever comes.

    So the watchdog raising inside the `async with` was raising INTO the very
    hang it exists to escape: __aexit__ would block on drain() and swallow the
    ConnectionError, leaving the collector deaf with its own rescue path stuck.
    transport.abort() forces connection_lost, which also releases every drain
    waiter. The venue sees a TCP reset instead of a close frame — which is what
    close() falls back to after its own timeout anyway.

    This mirrors flow_collector._abort(); the two collectors share the failure
    mode and must share the escape.
    """
    if ws is None:
        return
    try:
        ws.transport.abort()
    except Exception:
        pass


async def _run(coins):
    import websockets
    backoff = 1
    while True:
        try:
            ws = await websockets.connect(WS_URL, ping_interval=20,
                                          ping_timeout=20,
                                          max_queue=None)
            try:
                # Re-subscribing on reconnect must include everything asked for
                # while the previous socket was up, or a coin silently stops
                # collecting after any network blip. Everything starts OWED (in
                # _PENDING) and is promoted by _subscribe as each ack goes out,
                # so a failure part-way through leaves the remainder recoverable
                # instead of stranded between the two sets.
                with _LOCK:
                    want = sorted(set(coins) | _SUBBED | _PENDING)
                    _SUBBED.clear()
                    _PENDING.clear()
                    _PENDING.update(want)
                    _PEND.clear()
                await _subscribe(ws, want)
                # BACKOFF IS RESET BY DATA, NOT BY AN ACK — same defect and
                # same fix as flow_collector. A subscribe ack is not evidence
                # the peer will ever speak: connect -> subscribe -> silence ->
                # watchdog -> sleep(1) -> reconnect resets the counter every
                # cycle, so min(backoff*2, 60) could never exceed 2 and a
                # permanently dead peer was reconnect-hammered at ~1Hz while
                # looking, in every log and in status(), exactly like a peer
                # that was merely flapping.
                _STARTED.set()
                last_save = time.time()
                # The watchdog clock starts when the book set is fully on the
                # wire, never at connect: the paced subscribe alone takes ~10.8s
                # at 36 coins, and no frame can arrive for a coin that has not
                # been asked for yet. Starting it at connect would make the
                # watchdog fire on its own subscribe phase.
                last_rx = time.time()
                while True:
                    # BOUNDED recv, not `async for`. The unbounded form is the
                    # wedge: a peer that holds the socket open and sends nothing
                    # parks this coroutine forever with no exception to catch.
                    # The timeout is not an error path — it is the tick that
                    # lets the watchdog, the pending drain and the periodic
                    # saves keep running while the socket is silent.
                    try:
                        raw = await asyncio.wait_for(ws.recv(),
                                                     timeout=RECV_TIMEOUT_S)
                    except asyncio.TimeoutError:
                        raw = None
                    now = time.time()
                    if raw is None:
                        silent = now - last_rx
                        if silent > WATCHDOG_S:
                            with _LOCK:
                                n_subs = len(_SUBBED) * 2
                                _WEDGE["n"] += 1
                                _WEDGE["at"] = now
                                _WEDGE["silent_s"] = round(silent, 1)
                            # Raise into the reconnect path so a wedge takes
                            # the same save-then-backoff-then-resubscribe route
                            # as a dropped connection. One recovery path, not
                            # two. The `finally` below aborts the transport on
                            # the way out — raising alone is NOT enough, since
                            # the context manager would otherwise close() and
                            # hang on drain(). See _abort().
                            raise ConnectionError(
                                "depth ws silent across all %d subscriptions "
                                "for %.0fs" % (n_subs, silent))
                    else:
                        last_rx = now
                        _LAST_MSG["ts"] = now
                        # The backoff reset used to live here, on ANY frame —
                        # including the subscriptionResponse acks this
                        # coroutine itself provoked, which is precisely the
                        # ack the comment above forbids resetting on. Moved
                        # below, where the frame has been parsed. last_rx
                        # still moves on any frame: that is the WATCHDOG's
                        # clock and it must not fire during our own paced
                        # subscribe, which alone takes ~10.8s at 36 coins.
                    # Drain on-demand subscribes on EVERY tick, message or not.
                    # Under `async for` this ran only when a frame arrived, so
                    # ensure() on a quiet socket took effect only if the socket
                    # spoke first — the case where charting a new market matters
                    # most is exactly the case it did not work.
                    with _LOCK:
                        newly = sorted(_PENDING)
                    if newly:
                        await _subscribe(ws, newly)
                    if raw is not None:
                        try:
                            msg = json.loads(raw)
                        except ValueError:
                            msg = None
                        # The evidence the peer is alive, and it is everything
                        # EXCEPT the ack for a subscribe we just sent. Books,
                        # pongs, an unparseable frame — all of them are the
                        # endpoint volunteering something, which is the claim
                        # being tested; a still book must not read as a dead
                        # peer, and an ack must not read as a live one.
                        if msg is None or msg.get("channel") != "subscriptionResponse":
                            backoff = 1
                        if msg is not None and msg.get("channel") == "l2Book":
                            data = msg.get("data")
                            if data:
                                _ingest(data)
                    if now - last_save > SAVE_EVERY_S:
                        _save()
                        last_save = now
                    if now - _LAST_HOURLY_SAVE[0] > SAVE_HOURLY_EVERY_S:
                        _save_hourly()
                        _LAST_HOURLY_SAVE[0] = now
            finally:
                # Runs on EVERY exit — watchdog raise, recv error, cancellation.
                # See _abort(): the polite close this replaces can hang exactly
                # as hard as the wedge, so the escape must not depend on it.
                _abort(ws)
        except Exception:
            _STARTED.clear()
            try:
                _save()
                _save_hourly()
            except Exception:
                pass
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 60)


def start(coins):
    """Launch the depth collector on its own loop in a daemon thread.

    Its own socket, deliberately: folding these subscriptions into the flow
    collector would put the CVD store — the more valuable, already-working
    asset — at risk of a depth-side bug, and the two want different save
    cadences.
    """
    global _MIN, _HOUR
    _MIN, _HOUR = _load()
    _prune_stale(coins)
    _save_hourly()
    _LAST_HOURLY_SAVE[0] = time.time()

    def _thread():
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            loop.run_until_complete(_run(list(coins)))
        except Exception:
            pass

    threading.Thread(target=_thread, daemon=True, name="depth-collector").start()
