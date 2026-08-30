"""CoinGecko price feed for tokens that are NOT on Hyperliquid.

Deliberately narrow in scope: the terminal's prices come from Hyperliquid so
they match what you can actually trade. This exists only for buyback/burn
programmes worth tracking that have no HL listing — their prices are marked
as off-venue in the UI so they are never mistaken for something tradeable
here (no book, no tape, no chart).

Free API, no key. Cached upstream so a fast UI poll cannot become a fast
upstream poll (CoinGecko's free tier is rate-limited).
"""

import json
import urllib.parse
import urllib.request

TIMEOUT = 12
BASE = "https://api.coingecko.com/api/v3"
UA = {"User-Agent": "hl-terminal research vish2030@gmail.com",
      "Accept": "application/json"}


def _get(path, params):
    url = "{}{}?{}".format(BASE, path, urllib.parse.urlencode(params))
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        return json.loads(resp.read().decode())


def simple_price(ids):
    """{coingecko_id: {usd, chg24h, vol24h, mcap, at}} for the given ids."""
    ids = [i for i in ids if i]
    if not ids:
        return {}
    raw = _get("/simple/price", {
        "ids": ",".join(sorted(set(ids))),
        "vs_currencies": "usd",
        "include_24hr_change": "true",
        "include_24hr_vol": "true",
        "include_market_cap": "true",
        "include_last_updated_at": "true",
    })
    out = {}
    for cid, d in (raw or {}).items():
        out[cid] = {
            "usd": d.get("usd"),
            "chg24h": d.get("usd_24h_change"),
            "vol24h": d.get("usd_24h_vol"),
            "mcap": d.get("usd_market_cap"),
            "at": d.get("last_updated_at"),
        }
    return out


def supplies(ids):
    """{coingecko_id: {total, circ, max, price}} — full-precision supply.

    Lets the same measured-burn method used for HL-spot tokens extend to every
    chain, without per-project burn dashboards or API keys.
    """
    ids = [i for i in ids if i]
    if not ids:
        return {}
    rows = _get("/coins/markets", {
        "vs_currency": "usd", "ids": ",".join(sorted(set(ids))),
        "per_page": 250, "page": 1, "sparkline": "false",
    })
    out = {}
    for d in rows or []:
        out[d.get("id")] = {
            "total": d.get("total_supply"),
            "circ": d.get("circulating_supply"),
            "max": d.get("max_supply"),
            "price": d.get("current_price"),
        }
    return out


def price_history(cid, days):
    """{day_index: usd} daily closes — used to value a token flow in dollars."""
    if not cid:
        return {}
    raw = _get("/coins/{}/market_chart".format(cid),
               {"vs_currency": "usd", "days": int(days), "interval": "daily"})
    return {int(t) // 86400000: v for t, v in (raw or {}).get("prices", [])}


def supply_history(cid, days):
    """[{ms, supply, px}] with supply reconstructed as market_cap / price.

    Only trustworthy where CoinGecko actually tracks the supply: validated for
    PUMP against the mint, but NOT for CAKE, whose circulating figure is
    effectively static and misses a real ~8.6M/day burn.
    """
    raw = _get("/coins/{}/market_chart".format(cid),
               {"vs_currency": "usd", "days": int(days), "interval": "daily"})
    px = {int(t): v for t, v in (raw or {}).get("prices", [])}
    mc = {int(t): v for t, v in (raw or {}).get("market_caps", [])}
    out = []
    for t in sorted(set(px) & set(mc)):
        if px[t]:
            out.append({"ms": t, "supply": mc[t] / px[t], "px": px[t]})
    return out
