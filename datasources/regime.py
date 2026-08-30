"""Market-regime reads from keyless public APIs + HL universe breadth.

Sources (all free, no keys):
  - alternative.me  : crypto Fear & Greed index
  - CoinGecko       : total crypto mcap, 24h change, BTC dominance
  - DeFiLlama       : total stablecoin supply (7d delta = risk-appetite flow)
Breadth/aggregates are computed from the HL universe ctxs we already fetch.
"""

import json
import urllib.request

TIMEOUT = 10


def _get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "hl-terminal/1.0"})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        return json.loads(resp.read().decode())


def fear_greed():
    d = _get("https://api.alternative.me/fng/?limit=2")
    rows = d.get("data") or []
    if not rows:
        return None
    out = {"value": int(rows[0]["value"]), "label": rows[0]["value_classification"]}
    if len(rows) > 1:
        out["prev"] = int(rows[1]["value"])
    return out


def coingecko_global():
    d = (_get("https://api.coingecko.com/api/v3/global") or {}).get("data") or {}
    return {
        "total_mcap_usd": (d.get("total_market_cap") or {}).get("usd"),
        "mcap_chg_24h_pct": d.get("market_cap_change_percentage_24h_usd"),
        "btc_dominance_pct": (d.get("market_cap_percentage") or {}).get("btc"),
    }


def stablecoin_flow():
    rows = _get("https://stablecoins.llama.fi/stablecoincharts/all") or []
    if len(rows) < 8:
        return None
    def total(row):
        v = row.get("totalCirculatingUSD") or {}
        return sum(x for x in v.values() if isinstance(x, (int, float)))
    now, week_ago = total(rows[-1]), total(rows[-8])
    if not week_ago:
        return None
    return {
        "total_usd": now,
        "delta_7d_usd": now - week_ago,
        "delta_7d_pct": (now - week_ago) / week_ago * 100,
    }


def hl_breadth(ctxs):
    """% of liquid coins up on 24h + aggregate OI/volume, from data we already have."""
    up = dn = 0
    agg_oi = agg_vol = 0.0
    fundings = []
    for c in ctxs.values():
        mid, prev = c.get("mid_px"), c.get("prev_day_px")
        vol = c.get("day_volume") or 0
        if mid and prev and vol > 1e6:
            if mid >= prev:
                up += 1
            else:
                dn += 1
            if c.get("funding") is not None:
                fundings.append(c["funding"])
        agg_vol += vol
        oi, px = c.get("open_interest"), c.get("mid_px")
        if oi and px:
            agg_oi += oi * px
    n = up + dn
    return {
        "breadth_pct": round(up / n * 100, 1) if n else None,
        "advancers": up, "decliners": dn,
        "agg_oi_usd": agg_oi, "agg_vol_usd": agg_vol,
        "median_funding_8h_pct": (
            round(sorted(fundings)[len(fundings) // 2] * 8 * 100, 4)
            if fundings else None),
    }


def snapshot(crypto_ctxs):
    from concurrent.futures import ThreadPoolExecutor

    from datasources import etfflows, fedfutures, rates
    out = {}
    # The five sources are independent HTTP fetches that ran sequentially at
    # 15-18s cold; in parallel the wall time is the slowest source (fed_path
    # ~9.6s). fomc stays after the pool — it needs fed's EFFR.
    sources = (("fear_greed", fear_greed),
               ("global", coingecko_global),
               ("stables", stablecoin_flow),
               ("fed", rates.fed_path),
               ("etf", etfflows.flows))

    def safe(fn):
        try:
            return fn()
        except Exception:
            return None  # each source degrades independently

    with ThreadPoolExecutor(max_workers=5) as pool:
        futs = {key: pool.submit(safe, fn) for key, fn in sources}
    for key, fut in futs.items():
        out[key] = fut.result()
    try:
        effr_rate = ((out.get("fed") or {}).get("effr") or {}).get("rate")
        out["fomc"] = fedfutures.implied_meeting_odds(effr_rate)
    except Exception:
        out["fomc"] = None
    try:
        out["hl"] = hl_breadth(crypto_ctxs)
    except Exception:
        out["hl"] = None
    return out
