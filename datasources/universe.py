"""Volume-ranked collector universe — one selector instead of six hand-lists.

WHY THIS EXISTS. Every websocket collector here needed a list of coins, and
each one grew its own: the trade collector took the chart watchlist plus the
fourteen token-buyback programmes, the depth collector took the chart
watchlist alone. Neither list mentions a single market on `xyz`, the HIP-3
venue that measured $4.22B/24h against core Hyperliquid's $2.90B on
2026-08-14 — so the larger of the two sleeves had flow on 0 of 109 markets
and depth on 1. The lists were not wrong when written; they ossified. A
venue went from nothing to 109 markets and no list knew.

`oi_history` never had this problem because it was never told which coins to
watch — it snapshots the merged universe above a volume floor, and covers
99.8% of xyz volume as a result. This module is that idea extracted so the
socket collectors can share it, subject to the subscription caps they have
and OI does not.

ZERO ADDED REST. `refresh()` takes asset contexts the caller ALREADY has —
server.py's 120s-cached `universe` fetch, which the OI snapshot, the
screener and half the API surface read anyway. This module never calls
upstream. That matters because the whale sweep already runs ~400 requests
per 15 minutes and venues.py needed pacing plus retries before six of ten
venues stopped silently vanishing.

SELECTION IS PER-SLEEVE, AND SO IS COVERAGE. The two sleeves have very
different shapes: crypto is a barbell where the top 6 markets are 92.2% of
volume, while xyz is flat enough that the top 12 are only 79.8%. One global
top-N would hand almost every slot to BTC/ETH and their neighbours and cover
the venue the owner actually trades with real size not at all. So each
sleeve gets its own quota, and `coverage()` reports each separately: a pane
must be able to say "depth on 12 of 109 xyz markets" and never imply that
because the crypto side looks full, the book is covered.

WHAT IS PINNED AND WHY NOTHING IS EVICTED MID-RUN. Depth cannot be
backfilled and flow only accrues forward, so dropping a subscription
destroys history that no request can recover. `select()` therefore takes
`pinned` (must be present — the chart watchlist, the buyback programmes the
BURN tab reads) and `keep` (already collecting, kept while slots remain,
ranked below the fresh volume picks). Re-ranking on the hourly timer only
ADDS; a market that falls out of the top N keeps its stream until the next
process restart. That is a deliberate ratchet: it bounds churn to zero and
its cost is that the caps fill over days, which `select()` reports as
`dropped` rather than swallowing.
"""

import threading
import time

CRYPTO = "crypto"
EQUITY = "equity"

# Same floor as oi_history: below a million dollars a day the book is too
# thin for a depth or flow reading to describe anything but the market maker.
MIN_VOLUME_USD = 1_000_000

_LOCK = threading.Lock()
_SNAP = {"at": 0.0, "sleeves": {}}      # sleeve -> {"vol": {coin: usd}, "total": usd}

# Above this the ranking is reported stale rather than used silently. The
# refresher runs every 55 minutes, so two consecutive misses are anomalous.
STALE_S = 3 * 3600


def sleeve_of(coin):
    """`xyz:SNDK` is equity, `BTC` is crypto. The dex prefix is the only
    marker Hyperliquid gives, and it travels with the coin name everywhere in
    this codebase, so the test is the same one the API uses."""
    return EQUITY if ":" in (coin or "") else CRYPTO


def refresh(ctxs_by_sleeve):
    """Store a ranked snapshot from asset contexts the caller already holds.

    Deliberately not a fetch. Returns per-sleeve counts so a caller that logs
    this cannot mistake an empty upstream response for an empty market.
    """
    sleeves = {}
    for sleeve, ctx in (ctxs_by_sleeve or {}).items():
        vol = {}
        for coin, row in (ctx or {}).items():
            try:
                vol[coin] = float((row or {}).get("day_volume") or 0.0)
            except (TypeError, ValueError):
                vol[coin] = 0.0
        sleeves[sleeve] = {"vol": vol, "total": sum(vol.values())}
    if not sleeves:
        return {}
    with _LOCK:
        _SNAP["sleeves"] = sleeves
        _SNAP["at"] = time.time()
    return {s: len(d["vol"]) for s, d in sleeves.items()}


def age_s():
    with _LOCK:
        at = _SNAP["at"]
    return None if not at else round(time.time() - at, 1)


def ready():
    with _LOCK:
        return bool(_SNAP["sleeves"])


def _snap():
    with _LOCK:
        return dict(_SNAP["sleeves"]), _SNAP["at"]


def ranked(sleeve, n=None, min_volume_usd=MIN_VOLUME_USD):
    """Coins in `sleeve`, richest first, above the floor. [] if never
    refreshed — the caller decides what a missing ranking means, because a
    collector that silently seeds nothing looks identical to one that seeded
    a healthy market with no volume in it."""
    sleeves, _ = _snap()
    vol = (sleeves.get(sleeve) or {}).get("vol") or {}
    out = sorted((c for c, v in vol.items() if v >= min_volume_usd),
                 key=lambda c: -vol[c])
    return out[:n] if n else out


def select(per_sleeve, pinned=(), keep=(), cap=None,
           min_volume_usd=MIN_VOLUME_USD):
    """Build a collector seed list.

    `per_sleeve` is {sleeve: n}. Order of precedence, and the reason for it:
      1. `pinned`     — never dropped. These are the streams something else
                        already depends on (chart watchlist, BURN's token
                        programmes); losing them is a visible regression.
      2. volume picks — the point of the module, taken per sleeve so the
                        flatter venue is not crowded out by the barbell one.
      3. `keep`       — already collecting, and history that would be
                        destroyed by unsubscribing. Ranked last because a
                        market that has fallen out of the top N is the right
                        thing to lose FIRST when slots run short.
    Anything that does not fit `cap` is returned in `dropped`, never dropped
    quietly.
    """
    picked = []
    seen = set()

    def add(coin):
        if coin and coin not in seen:
            seen.add(coin)
            picked.append(coin)

    for c in pinned:
        add(c)
    for sleeve, n in (per_sleeve or {}).items():
        for c in ranked(sleeve, n, min_volume_usd):
            add(c)
    for c in keep:
        add(c)

    dropped = []
    if cap is not None and len(picked) > cap:
        dropped = picked[cap:]
        picked = picked[:cap]
    return {"coins": picked, "n": len(picked), "dropped": dropped,
            "cap": cap, "ranked": ready(), "rank_age_s": age_s(),
            "note": ("ranking never refreshed — seeded from pinned list only"
                     if not ready() else
                     "volume-ranked per sleeve; pinned first, already-"
                     "collecting kept last")}


def coverage(coins, label="collected"):
    """Per-sleeve coverage of `coins` against the live universe.

    Reports market COUNT and share of 24h VOLUME separately, because they say
    different things: 12 of 109 xyz markets is 11% by count and ~80% by
    volume, and a pane that quotes only the flattering one is lying by
    selection. Coins held but absent from the universe snapshot (delisted, or
    charted before a refresh) are reported under `unknown`, not discarded —
    the failure mode this codebase keeps hitting is a dropped row that reads
    as a zero.
    """
    sleeves, at = _snap()
    held = set(coins or [])
    if not sleeves:
        return {"stale": True, "sleeves": {},
                "note": "universe ranking not loaded — coverage unknown, "
                        "not zero"}
    out = {}
    known = set()
    for sleeve, d in sleeves.items():
        vol = d["vol"]
        total = d["total"]
        mine = [c for c in held if c in vol]
        known.update(mine)
        cov = sum(vol[c] for c in mine)
        pct = round(100.0 * cov / total, 1) if total else None
        out[sleeve] = {
            "n": len(mine), "n_universe": len(vol),
            "vol_usd": round(cov, 0), "vol_universe_usd": round(total, 0),
            "vol_pct": pct,
            "label": "%s on %d of %d %s markets (%s of %s 24h volume)" % (
                label, len(mine), len(vol),
                "xyz" if sleeve == EQUITY else "core HL",
                "%.0f%%" % pct if pct is not None else "n/a",
                "xyz" if sleeve == EQUITY else "core HL"),
            "coins": sorted(mine)}
    unknown = sorted(held - known)
    age = None if not at else round(time.time() - at, 1)
    return {"stale": bool(age is None or age > STALE_S),
            "rank_age_s": age, "sleeves": out,
            "unknown": unknown, "n_unknown": len(unknown),
            "unknown_note": ("held but absent from the current universe "
                             "snapshot — counted nowhere above"
                             if unknown else ""),
            "note": "count and volume share reported separately; neither "
                    "alone describes coverage"}
