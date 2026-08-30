"""US spot ETF daily net flows (BTC + ETH) from SoSoValue's open endpoint.

The historicalInflowChart endpoint answers unauthenticated POSTs — no key,
no bot-wall. Values are daily aggregates across all US spot ETFs:
totalNetInflow / totalValueTraded / totalNetAssets / cumNetInflow (USD).
Polled gently and cached upstream (regime cycle, 30 min).
"""

import json
import urllib.request

TIMEOUT = 12
URL = "https://api.sosovalue.xyz/openapi/v2/etf/historicalInflowChart"
UA = {"User-Agent": "hl-terminal research vish2030@gmail.com",
      "Content-Type": "application/json"}


def _fetch(etf_type):
    req = urllib.request.Request(
        URL, data=json.dumps({"type": etf_type}).encode(), headers=UA,
        method="POST")
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        d = json.loads(resp.read().decode())
    if d.get("code") != 0:
        raise RuntimeError("sosovalue: {}".format(d.get("msg")))
    return d.get("data") or []


def _summarize(rows):
    """rows arrive newest-first; produce chip-ready aggregates."""
    if not rows:
        return None
    rows = sorted(rows, key=lambda r: r["date"], reverse=True)[:10]
    daily = [{"date": r["date"], "flow_usd": r.get("totalNetInflow")}
             for r in rows if r.get("totalNetInflow") is not None]
    if not daily:
        return None
    flows5 = [d["flow_usd"] for d in daily[:5]]
    streak = 0
    for d in daily:
        if d["flow_usd"] == 0:
            break
        sign = 1 if d["flow_usd"] > 0 else -1
        if streak == 0 or (sign > 0) == (streak > 0):
            streak += sign
        else:
            break
    latest = rows[0]
    return {
        "last_date": daily[0]["date"],
        "last_flow_usd": daily[0]["flow_usd"],
        "sum5_usd": sum(flows5),
        "streak_days": streak,               # +n consecutive inflow, -n outflow
        "aum_usd": latest.get("totalNetAssets"),
        "cum_inflow_usd": latest.get("cumNetInflow"),
        "recent": daily[:5],
    }


def flows():
    out = {}
    for key, etf_type in (("btc", "us-btc-spot"), ("eth", "us-eth-spot")):
        try:
            out[key] = _summarize(_fetch(etf_type))
        except Exception:
            out[key] = None                  # degrade per-asset
    return out if (out.get("btc") or out.get("eth")) else None
