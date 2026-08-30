"""Hyperliquid public info API (free, no key).

Covers the main dex (crypto perps) and the xyz builder dex (equity/commodity
perps). All calls are POST https://api.hyperliquid.xyz/info with a JSON body.
"""

import json
import urllib.request

INFO_URL = "https://api.hyperliquid.xyz/info"
TIMEOUT = 10


def _post(payload):
    req = urllib.request.Request(
        INFO_URL,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        return json.loads(resp.read().decode())


def meta(dex=""):
    """Universe metadata. dex='' = main (crypto), dex='xyz' = equity perps."""
    payload = {"type": "meta"}
    if dex:
        payload["dex"] = dex
    return _post(payload)


def all_mids(dex=""):
    """Current mid price per asset for a dex."""
    payload = {"type": "allMids"}
    if dex:
        payload["dex"] = dex
    return _post(payload)


def asset_ctxs(dex=""):
    """Per-asset context: funding, open interest, day volume, prev day px."""
    payload = {"type": "metaAndAssetCtxs"}
    if dex:
        payload["dex"] = dex
    universe_meta, ctxs = _post(payload)
    universe = universe_meta.get("universe", [])
    out = {}
    for asset, ctx in zip(universe, ctxs):
        name = asset["name"]
        rec = {
            "funding": _f(ctx.get("funding")),
            "open_interest": _f(ctx.get("openInterest")),
            "day_volume": _f(ctx.get("dayNtlVlm")),
            "prev_day_px": _f(ctx.get("prevDayPx")),
            "mark_px": _f(ctx.get("markPx")),
            "mid_px": _f(ctx.get("midPx")),
            # Basis comes free from the venue: `premium` is (mark-oracle)/oracle
            # against HL's own spot index, which is a better reference than
            # stitching together HL spot pairs (many perps have no spot pair).
            "premium": _f(ctx.get("premium")),
            "oracle_px": _f(ctx.get("oraclePx")),
            "impact_pxs": [_f(x) for x in (ctx.get("impactPxs") or [])] or None,
        }
        # A dead/delisted perp still ships funding: "0". That is not a 0%
        # carry rate — there is no book. 56/232 names were mid_px null with
        # funding 0.0 (MATIC/FTM/TON). Null, not zero.
        if rec["mid_px"] is None or asset.get("isDelisted"):
            rec["funding"] = None
        out[name] = rec
    return out


def spot_meta():
    """Spot token metadata (supply queries need the tokenId)."""
    return _post({"type": "spotMeta"})


def token_details(token_id):
    """Per-token supply detail: maxSupply / totalSupply / circulatingSupply."""
    return _post({"type": "tokenDetails", "tokenId": token_id})


def l2_book(coin, n_sig_figs=None):
    """Order book. `n_sig_figs` (3|4|5) aggregates levels into coarser price
    buckets — the full-precision book spans only ~0.07% of price, far too
    narrow to plot against a chart, while 3 sig figs spans ~6%."""
    req = {"type": "l2Book", "coin": coin}
    if n_sig_figs:
        req["nSigFigs"] = int(n_sig_figs)
    return _post(req)


def candles(coin, interval="1d", start_time=0):
    """Candle history for a coin ('BTC' or 'xyz:TSLA'). Returns raw list."""
    return _post({
        "type": "candleSnapshot",
        "req": {"coin": coin, "interval": interval, "startTime": start_time},
    })


def daily_closes(coin, limit=400):
    """(timestamp_ms, close) pairs for the last `limit` daily candles."""
    rows = candles(coin, "1d", 0)
    out = [(int(c["t"]), float(c["c"])) for c in rows[-limit:]]
    return out


def daily_moves(coin, limit=400):
    """Absolute daily % moves keyed by UTC date string, plus closes.

    Used for historical event-vol: look up the move on past event dates.
    """
    from datetime import datetime, timezone

    rows = candles(coin, "1d", 0)[-(limit + 1):]
    moves = {}
    prev_close = None
    for c in rows:
        close = float(c["c"])
        day = datetime.fromtimestamp(int(c["t"]) / 1000, tz=timezone.utc).strftime("%Y-%m-%d")
        if prev_close and prev_close > 0:
            moves[day] = (close - prev_close) / prev_close * 100.0
        prev_close = close
    return moves


def _f(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


def user_fills_by_time(user, start_ms, end_ms=None):
    """Every fill for an address since start_ms (2000-row page cap upstream)."""
    req = {"type": "userFillsByTime", "user": user, "startTime": int(start_ms)}
    if end_ms:
        req["endTime"] = int(end_ms)
    return _post(req)
