"""Extended (x10) — a StarkNet perp DEX, added as a first-class venue.

WHY IT IS HERE: the 2026-08-15 landscape survey measured Extended at roughly
half a billion dollars of daily perp volume against ~$185M of open interest,
and the terminal did not aggregate a dollar of it. It also lists ~100 equity,
metal and FX perps, which makes it one of very few venues here carrying the
kind of instrument market.xyz lists.

ONE CALL, EVERYTHING: GET /info/markets returns every market with volume,
open interest, funding, mark, index and top-of-book in a single keyless
request — no per-symbol fan-out, no auth, no key material. This module makes
exactly one outbound request per snapshot, which is why its open interest is
a CENSUS and not, like Aster's, a sampling problem.

THE HOST IS PART OF THE FACT: it is api.starknet.extended.exchange. The bare
api.extended.exchange host answers 404 (re-measured 2026-08-15) — a mistake
that presents as "the venue is down" rather than "you called the wrong host".

── UNITS: THE 63,000x TRAP, PROVEN RATHER THAN ASSUMED ────────────────────
marketStats carries BOTH `openInterest` and `openInterestBase`, and picking
the wrong one is a silent four-order-of-magnitude error that would still
look like a plausible number on screen. Measured 2026-08-15 across the 269
markets with both fields non-zero:

    openInterest / (openInterestBase * markPrice)
      median 1.000000, min 0.9954, max 1.0040, ZERO markets outside +/-5%

    BTC-USD: openInterest       59,533,874.76
             openInterestBase          945.44  x markPrice 62,855.73
                                = 59,426,434.74      ratio 1.0018

So `openInterest` is USD and `openInterestBase` is contracts. Reading the
base field as dollars would have published Extended's BTC open interest as
$945 instead of $59.5M. The same test on volume (dailyVolume vs
dailyVolumeBase * markPrice, n=245) gives median 0.9981 — dailyVolume is USD
too; its wider spread (0.81-1.32) is 24h of volume being priced against one
instantaneous mark, not a unit ambiguity. Both raw fields are carried
through anyway so the check is repeatable against live data, not just here.

── FUNDING IS ALREADY HOURLY, AND THAT WAS MEASURED ───────────────────────
Every funding rate in this terminal is an HOURLY decimal (HL's native basis;
xvenue divides Lighter's 8h feed by 8 for exactly this reason, and Aster's
own book mixes 1h/4h/8h markets). Extended publishes no interval field at
all, so the interval was measured directly rather than assumed: 30
consecutive settlements from /info/{market}/funding on BTC-USD, ETH-USD and
XAU-USD gave 29 deltas each, every one of them 1.000h (+/-0.7s of clock
jitter). Corroborated by `nextFundingRate`, which is the next top-of-hour on
341 of 344 rows. `fundingRate` is therefore emitted AS-IS — this is the one
venue here needing no conversion, and the ABSENCE of a conversion is a
measurement, not an oversight.

── THE UNIVERSE IS 281, NOT 344 ───────────────────────────────────────────
/info/markets returns 344 rows and it is tempting to call that the market
count. Measured breakdown (2026-08-15):

    PERPETUAL / ACTIVE        281   $484.7M vol   $185.3M OI   <- the venue
    PERPETUAL / DELISTED       58        $0 vol    $7,808.91 OI
    PERPETUAL / REDUCE_ONLY     2        $0 vol       $11.65 OI
    SPOT      / ACTIVE          3     $121.86 vol       $0 OI

The 3 SPOT rows are not perps and this is a perp aggregation; the 60 dead
perps trade nothing. Counting all 344 would overstate the tradable market
count by 22%. But the delisted and reduce-only books still hold $7,820 of
OPEN RISK, so they are excluded from the headline and REPORTED in `excluded`
rather than deleted — a position does not stop existing because its market
stopped trading.

── SYMBOLS: THE VENUE'S OWN DECLARATION, PASSED THROUGH UNTOUCHED ─────────
`base` is `assetName` verbatim, which is what cross_venue's doctrine asks a
venue adapter for: the venue naming its own underlying is evidence, whereas
a mapping written in this file would be a guess. `assetName` is authoritative
(name == assetName + "-" + collateralAssetName on 343 of 344 rows) and unique
across all 281 live perps.

THE BLIND SPOT THIS LEAVES, STATED RATHER THAN SMOOTHED OVER: 25 RWA markets
declare a `_24_5` trading-hours suffix inside the base itself — TSLA_24_5,
NVDA_24_5, MSTR_24_5 and so on. They will NOT match HL's xyz:TSLA in the
cross-listing index, so an equity perp with a real second book here can still
read as SOLE. Stripping the suffix was measured to be collision-free today
(25 strips, 0 collisions across the 281 live bases) and is deliberately still
NOT done: a 24/5 contract and a continuous one are not self-evidently the
same instrument, and cross_venue is explicit that this judgement is not one
a venue adapter may make unilaterally. The count is published as
`session_suffixed_markets` so the gap is visible and sizeable, not silent.

STRICTLY READ-ONLY. /user/* is auth-gated, is never called, and nothing here
places, cancels, signs, routes or holds key material.
"""

import json
import urllib.request

BASE = "https://api.starknet.extended.exchange/api/v1"
TIMEOUT = 30
UA = {"Accept": "application/json", "User-Agent": "hl-terminal read-only"}

# The only rows that are a tradable perpetual on this venue.
LIVE_TYPE = "PERPETUAL"
LIVE_STATUS = "ACTIVE"

# Venue-side trading-hours tag carried inside the declared base. Counted and
# reported, never stripped — see the header.
SESSION_SUFFIX = "_24_5"


def _f(x, d=0.0):
    try:
        return float(x)
    except (TypeError, ValueError):
        return d


def _get(path):
    req = urllib.request.Request(BASE + path, headers=UA)
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        return json.loads(resp.read().decode())


def markets():
    """Raw /info/markets rows. Raises on transport or API-level failure."""
    d = _get("/info/markets")
    if isinstance(d, dict) and d.get("status") not in (None, "OK"):
        raise RuntimeError("extended /info/markets status=%r" % d.get("status"))
    rows = d.get("data") if isinstance(d, dict) else d
    if not rows:
        # An empty list behind a 200 is indistinguishable downstream from
        # "this venue has no markets", and that is never true. Fail loudly so
        # venues.snapshot() files it under `failed` with a stated impact.
        raise RuntimeError("extended /info/markets returned no rows")
    return rows


def venue():
    """One venue record in the shape venues.snapshot() consumes.

    Cost: exactly one HTTP request. Everything below is arithmetic on that
    payload — there is no per-symbol fan-out here and therefore no
    partial-coverage question. `oi_usd` is a census of every live market,
    which `oi_partial=False` states out loud so it cannot be read as the same
    kind of number as a sampled one.
    """
    rows = markets()
    live, excl = [], {}
    for m in rows:
        if m.get("type") == LIVE_TYPE and m.get("status") == LIVE_STATUS:
            live.append(m)
            continue
        # Everything not live is BUCKETED with its residual size, not dropped.
        s = m.get("marketStats") or {}
        key = ("spot" if m.get("type") != LIVE_TYPE
               else str(m.get("status") or "unknown").lower())
        b = excl.setdefault(key, {"markets": 0, "vol_24h": 0.0, "oi_usd": 0.0})
        b["markets"] += 1
        b["vol_24h"] += _f(s.get("dailyVolume"))
        b["oi_usd"] += _f(s.get("openInterest"))

    mkts, vol, oi, suffixed = [], 0.0, 0.0, 0
    for m in live:
        s = m.get("marketStats") or {}
        base = (m.get("assetName") or "").strip()
        if base.endswith(SESSION_SUFFIX):
            suffixed += 1
        v = _f(s.get("dailyVolume"))
        # PROVEN USD, see the header. Never openInterestBase.
        o = _f(s.get("openInterest"))
        vol += v
        oi += o
        mkts.append({
            "sym": m.get("name"),
            # The venue's own declaration, verbatim — cross_venue.build_index
            # keys on this rather than on a split of `sym`, which would give
            # the useless "BTC-USD".
            "base": base or None,
            "px": _f(s.get("markPrice")) or None,
            "vol": v,
            "oi": o,
            # Already hourly — measured, see header. No division.
            "funding": _f(s.get("fundingRate"), None),
            # Kept so the USD-vs-contracts proof above stays re-runnable
            # against live data instead of living only in this docstring.
            "oi_base": _f(s.get("openInterestBase"), None),
            "vol_base": _f(s.get("dailyVolumeBase"), None),
            "category": m.get("category"),
            # An equity perp outside its cash session still quotes and still
            # holds OI. The flag exists so a WEEKDAYS market shut for the
            # night is not read as an illiquid or dying one.
            "off_hours": bool(m.get("isOffHours")),
            "trading_hours": m.get("tradingHours"),
        })
    mkts.sort(key=lambda m: -m["vol"])

    n_excl = sum(b["markets"] for b in excl.values())
    oi_excl = sum(b["oi_usd"] for b in excl.values())
    rec = {
        "markets": len(mkts),
        "vol_24h": vol,
        "oi_usd": oi,
        # Extended needs no per-symbol sweep, so its coverage is total. These
        # exist so an Aster row (sampled) and an Extended row (a census)
        # cannot be mistaken for the same kind of measurement.
        "oi_partial": False,
        # Declared, not inferred from the figure being present — see
        # venues._oi_missing_state. If a future fetch failure ever leaves
        # oi_usd null here, this states that the null is an unmeasured
        # census, never a venue that withholds open interest.
        "oi_publishes": True,
        "oi_markets_measured": len(mkts),
        "oi_markets_total": len(mkts),
        "oi_coverage_pct": 100.0 if mkts else None,
        "oi_note": ("census — every one of the %d live markets carries its "
                    "own open interest in the same single call" % len(mkts)),
        "funding_basis": "hourly, venue native (measured 1.000h between "
                         "settlements on BTC/ETH/XAU; not assumed)",
        "rows_returned": len(rows),
        "excluded": excl or None,
        "excluded_note": ("%d of the %d rows returned are not live perps "
                          "(%s) and sit outside every total above; they still "
                          "hold $%.2f of open interest, reported here rather "
                          "than dropped"
                          % (n_excl, len(rows),
                             ", ".join("%d %s" % (b["markets"], k)
                                       for k, b in sorted(excl.items())),
                             oi_excl)) if excl else None,
        "session_suffixed_markets": suffixed,
        "cross_listing_note": (
            "%d market(s) declare a '%s' trading-hours suffix in their own "
            "base name (TSLA_24_5, NVDA_24_5, ...). It is passed through "
            "unstripped, so those will NOT match an unsuffixed listing such "
            "as xyz:TSLA and may read as SOLE when a second book exists here"
            % (suffixed, SESSION_SUFFIX)) if suffixed else None,
        "top": mkts[:5],
        "_all": mkts,
    }
    return rec
