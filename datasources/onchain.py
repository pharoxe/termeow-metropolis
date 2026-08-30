"""On-chain totalSupply reads — the issuer's own contract, not an aggregator.

Burn is a supply fact, and the authoritative place to read it is the token
contract itself. Aggregators disagree (CoinGecko reports HYPE totalSupply
~955.31M against Hyperliquid's own ~999.08M), so where a public RPC can be
read directly, that is preferred and the source is recorded per data point.

Keyless public RPCs only. Every read carries its chain + contract so a value
can always be traced back to what produced it.
"""

import json
import time
import urllib.request

TIMEOUT = 15
UA = {"User-Agent": "hl-terminal research", "Content-Type": "application/json"}

# Chain-official endpoints first, then archive-capable public fallbacks.
# Historical reads need archive state, which pruned official nodes refuse.
EVM_RPCS = {
    "ethereum": ["https://eth.drpc.org", "https://ethereum-rpc.publicnode.com",
                 "https://eth.llamarpc.com"],
    "binance-smart-chain": ["https://bsc-dataseed.bnbchain.org",
                            "https://bsc-mainnet.public.blastapi.io",
                            "https://bsc.drpc.org"],
    "base": ["https://mainnet.base.org", "https://base.drpc.org",
             "https://base-rpc.publicnode.com"],
}
# Ordered fallback pools. The BSC primary is NodeReal's shared DEMO endpoint —
# it can be withdrawn or rate-gated any day, and losing it silently would stall
# every CAKE/ASTER history rebuild. Each URL here has been verified to answer a
# historical eth_call. archive_url() hands out the first URL that works and the
# walkers advance to the next on repeated failure.
EVM_ARCHIVE_POOL = {
    "ethereum": ["https://eth.drpc.org", "https://eth.merkle.io",
                 "https://rpc.mevblocker.io",
                 "https://gateway.tenderly.co/public/mainnet"],
    "binance-smart-chain": [
        "https://bsc-mainnet.nodereal.io/v1/64a9df0874fb4a93b9d0a3849de012d3",
        "https://bsc-mainnet.public.blastapi.io"],
    "base": ["https://mainnet.base.org", "https://base.drpc.org",
             "https://base.llamarpc.com"],
}


def archive_urls(chain):
    """Every archive URL for a chain, primary first."""
    pool = list(EVM_ARCHIVE_POOL.get(chain) or [])
    primary = EVM_ARCHIVE.get(chain)
    if primary and primary not in pool:
        pool.insert(0, primary)
    return pool


def archive_balance_of(chain, contract, holder, block="latest"):
    """balanceOf at a block, walking the archive pool until one node answers."""
    last = None
    for url in archive_urls(chain):
        try:
            return evm_balance_of(chain, contract, holder, block, url=url)
        except Exception as exc:
            last = exc
    raise last if last else RuntimeError("no archive for " + str(chain))


EVM_ARCHIVE = {          # primary per chain; see EVM_ARCHIVE_POOL for fallbacks
    "ethereum": "https://eth.drpc.org",
    "binance-smart-chain": "https://bsc-mainnet.public.blastapi.io",
    "base": "https://mainnet.base.org",
}


def _endpoints(chain):
    return EVM_RPCS.get(chain) or []
SOLANA_RPC = "https://api.mainnet-beta.solana.com"
COSMOS_LCD = {"dydx": "https://dydx-rest.publicnode.com"}
# Serves historical state via the x-cosmos-block-height header
COSMOS_LCD_HIST = {"dydx": "https://rest.cosmos.directory/dydx"}

SEL_TOTAL_SUPPLY = "0x18160ddd"   # totalSupply()
SEL_DECIMALS = "0x313ce567"       # decimals()
SEL_BALANCE_OF = "0x70a08231"     # balanceOf(address)

# Many teams "burn" by transferring to an unspendable address rather than
# calling _burn. totalSupply() then never moves, and the only on-chain record
# of the burn is the balance parked at these sinks — which is also a clean
# cumulative counter, unlike a supply delta.
BURN_SINKS = [
    "0x000000000000000000000000000000000000dEaD",
    "0x0000000000000000000000000000000000000000",
]


def _rpc(url, payload):
    req = urllib.request.Request(url, data=json.dumps(payload).encode(), headers=UA)
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        return json.loads(resp.read().decode())


def _eth_call(url, to, selector, block="latest"):
    r = _rpc(url, {"jsonrpc": "2.0", "id": 1, "method": "eth_call",
                   "params": [{"to": to, "data": selector}, block]})
    if "error" in r:
        raise RuntimeError(r["error"].get("message", "eth_call failed"))
    raw = r.get("result")
    if not raw or raw == "0x":
        raise RuntimeError("empty result")
    return int(raw, 16)


def _first_ok(chain, fn):
    """Try each endpoint for a chain until one answers."""
    err = None
    for url in _endpoints(chain):
        try:
            return fn(url)
        except Exception as exc:
            err = exc
    raise err or RuntimeError("no endpoint answered for " + str(chain))


def evm_balance_of(chain, contract, holder, block="latest", url=None):
    data = SEL_BALANCE_OF + holder.lower().replace("0x", "").rjust(64, "0")
    if url:
        return _eth_call(url, contract, data, block)
    return _first_ok(chain, lambda u: _eth_call(u, contract, data, block))


def _block_ts(url, block):
    r = _rpc(url, {"jsonrpc": "2.0", "id": 1, "method": "eth_getBlockByNumber",
                   "params": [block if isinstance(block, str) else hex(block), False]})
    b = (r or {}).get("result") or {}
    return int(b["timestamp"], 16), int(b["number"], 16)


def block_at_seconds_ago(url, seconds):
    """Block nearest to now-`seconds`, found by real timestamps.

    Assuming a fixed block time is how you get a burn rate wrong by 4x: BSC
    now produces blocks every ~0.45s, not the 3s that older docs imply.
    """
    t_head, n_head = _block_ts(url, "latest")
    target = t_head - seconds
    t_old, n_old = _block_ts(url, max(1, n_head - 5000))
    rate = (t_head - t_old) / max(1, n_head - n_old) or 1.0
    guess = max(1, int(n_head - seconds / max(rate, 1e-6)))
    lo, hi = max(1, guess - 250000), min(n_head, guess + 250000)
    for _ in range(26):
        if lo >= hi:
            break
        mid = (lo + hi) // 2
        tm, _n = _block_ts(url, mid)
        if tm < target:
            lo = mid + 1
        else:
            hi = mid
    return lo


def evm_burn_rate(chain, contract, decimals, windows=(1, 7, 30)):
    """Burn over each window, straight from historical sink balances."""
    url = EVM_ARCHIVE.get(chain)
    if not url:
        return {}
    def sink_total(block):
        tot = 0
        for sink in BURN_SINKS:
            try:
                tot += evm_balance_of(chain, contract, sink, block, url=url)
            except Exception:
                pass
        return tot / (10 ** decimals)
    now = sink_total("latest")
    out = {}
    for d in windows:
        try:
            blk = block_at_seconds_ago(url, d * 86400)
            past = sink_total(hex(blk))
            out["d%d" % d] = {"burned": max(0.0, now - past), "per_day": max(0.0, (now - past) / d)}
        except Exception:
            pass
    return out


def evm_supply_burn_rate(chain, contract, decimals, genesis, windows=(1, 7, 30)):
    """Burn windows for tokens that _burn (supply declines, no sink balance).

    Same shape as evm_burn_rate, but the counter is genesis - totalSupply(blk)
    instead of a sink balance — for tokens like WLFI where the destroyed
    tokens exist nowhere and the supply curve is the only record.
    """
    # Walk the fallback pool: the free primaries rate-limit (drpc 429s) and a
    # single-URL read silently returns {} — which reads as "windows unknown"
    # forever on a token whose only instrument is the supply curve.
    for url in archive_urls(chain):
        def burned_at(block):
            tot = _eth_call(url, contract, "0x18160ddd", block) / (10 ** decimals)
            return max(0.0, genesis - tot)
        try:
            now = burned_at("latest")
        except Exception:
            continue
        out = {}
        for d in windows:
            try:
                blk = block_at_seconds_ago(url, d * 86400)
                past = burned_at(hex(blk))
                out["d%d" % d] = {"burned": max(0.0, now - past),
                                  "per_day": max(0.0, (now - past) / d)}
            except Exception:
                pass
        if out:
            return out
    return {}


def evm_burned(chain, contract, decimals):
    """Total sitting in known burn sinks — the on-chain cumulative burn."""
    total = 0
    hit = []
    for sink in BURN_SINKS:
        try:
            raw = evm_balance_of(chain, contract, sink)
        except Exception:
            continue
        if raw > 0:
            total += raw
            hit.append(sink)
    return {"burned": total / (10 ** decimals), "sinks": hit}


def evm_total_supply(chain, contract):
    """ERC-20 totalSupply, decimals-adjusted, straight from the contract."""
    raw = _first_ok(chain, lambda u: _eth_call(u, contract, SEL_TOTAL_SUPPLY))
    try:
        dec = _first_ok(chain, lambda u: _eth_call(u, contract, SEL_DECIMALS))
    except Exception:
        dec = 18
    out = {"total": raw / (10 ** dec), "decimals": dec,
           "src": "onchain:" + chain, "contract": contract}
    try:
        b = evm_burned(chain, contract, dec)
        out["burned_to_sink"] = b["burned"]
        out["sinks"] = b["sinks"]
        # Supply that can still move. For sink-burners this is the number that
        # actually falls; for _burn() tokens it equals totalSupply.
        out["effective"] = out["total"] - b["burned"]
    except Exception:
        out["effective"] = out["total"]
    return out


def evm_native_burned(chain):
    """Native coin parked at the burn sinks — for gas coins with no ERC-20.

    BNB is the BSC gas coin, so there is no totalSupply() to call. BEP-95
    sends a slice of every gas fee to the burn address, making that balance a
    live on-chain burn counter. It does NOT include the pre-BSC Beacon Chain
    burns, so it is a rate source, not a lifetime total.
    """
    url = (_endpoints(chain) or [None])[0]
    if not url:
        raise RuntimeError("no public RPC configured for " + str(chain))
    total = 0
    hit = []
    for sink in BURN_SINKS:
        r = _rpc(url, {"jsonrpc": "2.0", "id": 1, "method": "eth_getBalance",
                       "params": [sink, "latest"]})
        if "error" in r or not r.get("result"):
            continue
        v = int(r["result"], 16)
        if v > 0:
            total += v
            hit.append(sink)
    return {"burned": total / 1e18, "sinks": hit,
            "src": "onchain:" + chain, "contract": "native"}


def evm_native_burn_rate(chain, windows=(1, 7)):
    """Native-coin burn over real windows (BNB's BEP-95 gas burn)."""
    url = EVM_ARCHIVE.get(chain)
    if not url:
        return {}
    def sink_total(block):
        tot = 0
        for sink in BURN_SINKS:
            r = _rpc(url, {"jsonrpc": "2.0", "id": 1, "method": "eth_getBalance",
                           "params": [sink, block]})
            if r.get("result"):
                tot += int(r["result"], 16)
        return tot / 1e18
    now = sink_total("latest")
    out = {}
    for d in windows:
        try:
            blk = block_at_seconds_ago(url, d * 86400)
            past = sink_total(hex(blk))
            out["d%d" % d] = {"burned": max(0.0, now - past),
                              "per_day": max(0.0, (now - past) / d)}
        except Exception:
            pass
    return out


def evm_supply_history(chain, contract, decimals, days=30, points=10):
    """Series of {ts, total, sink, effective} sampled back over `days`.

    Gross burn on its own can badly mislead: CAKE burns ~58.7M weekly, which
    looks like ~900%/yr deflation against its float — until you notice it is
    minting at the same time. Only effective supply (total - sink) shows the
    net scarcity effect, so both are captured at every point.
    """
    url = EVM_ARCHIVE.get(chain)
    if not url:
        return []
    step = max(1, days // max(1, points - 1))
    marks = list(range(days, -1, -step))
    if marks and marks[-1] != 0:
        marks.append(0)
    series = []
    for d in marks:
        try:
            if d == 0:
                blk, ts = "latest", _block_ts(url, "latest")[0]
            else:
                n = block_at_seconds_ago(url, d * 86400)
                ts = _block_ts(url, n)[0]
                blk = hex(n)
            total = _eth_call(url, contract, SEL_TOTAL_SUPPLY, blk) / (10 ** decimals)
            # A partial sink read silently understates cumulative burn, and
            # `effective = total - sink` then jumps by a whole burn event. Both
            # legs must come from the same block or the point is worthless.
            sink = 0
            for s_addr in BURN_SINKS:
                sink += evm_balance_of(chain, contract, s_addr, blk, url=url)
            sink /= (10 ** decimals)
            series.append({"days_ago": d, "ts": ts, "total": total,
                           "sink": sink, "effective": total - sink})
        except Exception:
            continue
    series.sort(key=lambda r: r["ts"])
    return series


def solana_total_supply(mint):
    """SPL mint supply via getTokenSupply."""
    r = _rpc(SOLANA_RPC, {"jsonrpc": "2.0", "id": 1, "method": "getTokenSupply",
                          "params": [mint]})
    if "error" in r:
        raise RuntimeError(r["error"].get("message", "getTokenSupply failed"))
    v = (r.get("result") or {}).get("value") or {}
    if v.get("uiAmountString") is None:
        raise RuntimeError("no supply in response")
    return {"total": float(v["uiAmountString"]), "decimals": v.get("decimals"),
            "src": "onchain:solana", "contract": mint}


def cosmos_total_supply(network, denom, exponent):
    """Cosmos bank module supply — dYdX and friends are not EVM."""
    base = COSMOS_LCD.get(network)
    if not base:
        raise RuntimeError("no LCD configured for " + str(network))
    url = "{}/cosmos/bank/v1beta1/supply/by_denom?denom={}".format(base, denom)
    req = urllib.request.Request(url, headers={"User-Agent": UA["User-Agent"]})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        d = json.loads(resp.read().decode())
    amt = ((d or {}).get("amount") or {}).get("amount")
    if amt is None:
        raise RuntimeError("no amount in response")
    return {"total": int(amt) / (10 ** exponent), "decimals": exponent,
            "src": "onchain:" + network, "contract": denom}


def read(spec):
    """Dispatch one on-chain supply read from a token's `onchain` spec."""
    kind = spec.get("kind")
    if kind == "evm":
        return evm_total_supply(spec["chain"], spec["contract"])
    if kind == "evm_native":
        b = evm_native_burned(spec["chain"])
        # no callable supply for a gas coin; the sink balance is the signal
        return {"total": 0.0, "burned_to_sink": b["burned"], "effective": 0.0,
                "sinks": b["sinks"], "src": b["src"], "contract": "native",
                "supply_unavailable": True}
    if kind == "solana":
        return solana_total_supply(spec["mint"])
    if kind == "cosmos":
        return cosmos_total_supply(spec["network"], spec["denom"], spec["exponent"])
    raise RuntimeError("unknown on-chain spec: " + str(kind))


HYPURRSCAN = "https://api.hypurrscan.io"
# Hyperliquid's Assistance Fund — where the 97%-of-fees buyback accumulates.
# It is a HOLD, not a burn: float is removed, supply is not destroyed.
HL_ASSISTANCE_FUND = "0xfefefefefefefefefefefefefefefefefefefefe"


def hl_assistance_fund(token="HYPE"):
    """HYPE held by the Assistance Fund, from Hyperliquid's own explorer."""
    req = urllib.request.Request("{}/holders/{}".format(HYPURRSCAN, token),
                                 headers={"User-Agent": UA["User-Agent"],
                                          "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        d = json.loads(resp.read().decode())
    holders = d.get("holders") or {}
    val = holders.get(HL_ASSISTANCE_FUND)
    if val is None:
        return None
    return {"held": float(val), "src": "hypurrscan:hyperliquid",
            "contract": HL_ASSISTANCE_FUND, "last_update": d.get("lastUpdate")}


def cosmos_supply_at(network, denom, exponent, height=None):
    """Cosmos supply, optionally at a past height (LCD honours the header)."""
    base = COSMOS_LCD_HIST.get(network) or COSMOS_LCD.get(network)
    if not base:
        raise RuntimeError("no LCD for " + str(network))
    url = "{}/cosmos/bank/v1beta1/supply/by_denom?denom={}".format(base, denom)
    hdr = {"User-Agent": UA["User-Agent"], "Accept": "application/json"}
    if height:
        hdr["x-cosmos-block-height"] = str(height)
    req = urllib.request.Request(url, headers=hdr)
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        d = json.loads(resp.read().decode())
    return int(((d or {}).get("amount") or {}).get("amount")) / (10 ** exponent)


SOLANA_RPC = "https://api.mainnet-beta.solana.com"


def solana_token_balance(owner, mint):
    """Tokens of `mint` held by `owner`, summed across its token accounts."""
    body = {"jsonrpc": "2.0", "id": 1, "method": "getTokenAccountsByOwner",
            "params": [owner, {"mint": mint}, {"encoding": "jsonParsed"}]}
    req = urllib.request.Request(SOLANA_RPC, json.dumps(body).encode(),
                                 {"content-type": "application/json",
                                  "User-Agent": UA["User-Agent"]})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        d = json.loads(resp.read().decode())
    accts = ((d.get("result") or {}).get("value")) or []
    if not accts:
        return None
    return sum(float(a["account"]["data"]["parsed"]["info"]["tokenAmount"]
                     ["uiAmountString"]) for a in accts)


def cosmos_staked(network, address, exponent=18):
    """Tokens `address` has delegated to validators (a buyback that stakes)."""
    base = COSMOS_LCD_HIST.get(network) or COSMOS_LCD.get(network)
    url = "{}/cosmos/staking/v1beta1/delegations/{}".format(base, address)
    req = urllib.request.Request(url, headers={"User-Agent": UA["User-Agent"],
                                               "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        d = json.loads(resp.read().decode())
    rows = d.get("delegation_responses") or []
    if not rows:
        return None
    total = sum(int(r["balance"]["amount"]) for r in rows)
    return {"staked": total / (10 ** exponent), "validators": len(rows)}


def cosmos_staked_at(network, address, height=None, exponent=18):
    """Delegated balance, optionally at a past height."""
    base = COSMOS_LCD_HIST.get(network) or COSMOS_LCD.get(network)
    url = "{}/cosmos/staking/v1beta1/delegations/{}".format(base, address)
    hdr = {"User-Agent": UA["User-Agent"], "Accept": "application/json"}
    if height:
        hdr["x-cosmos-block-height"] = str(height)
    req = urllib.request.Request(url, headers=hdr)
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        d = json.loads(resp.read().decode())
    rows = d.get("delegation_responses") or []
    if not rows:
        return None
    return sum(int(r["balance"]["amount"]) for r in rows) / (10 ** exponent)


def cosmos_height(network):
    base = COSMOS_LCD_HIST.get(network) or COSMOS_LCD.get(network)
    req = urllib.request.Request(
        base + "/cosmos/base/tendermint/v1beta1/blocks/latest",
        headers={"User-Agent": UA["User-Agent"], "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        d = json.loads(resp.read().decode())
    return int(d["block"]["header"]["height"])


def _solana_rpc(method, params):
    body = {"jsonrpc": "2.0", "id": 1, "method": method, "params": params}
    req = urllib.request.Request(SOLANA_RPC, json.dumps(body).encode(),
                                 {"content-type": "application/json",
                                  "User-Agent": UA["User-Agent"]})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        d = json.loads(resp.read().decode())
    if "result" not in d:
        raise RuntimeError(str((d.get("error") or {}).get("message"))[:80])
    return d["result"]


def solana_token_account(owner, mint):
    v = _solana_rpc("getTokenAccountsByOwner",
                    [owner, {"mint": mint}, {"encoding": "jsonParsed"}]).get("value")
    return v[0]["pubkey"] if v else None


def solana_balance_days_ago(token_account, days=7):
    """Balance ~`days` ago, from the post-balance of an old transaction.

    Solana's public RPCs cannot serve historical account state, but every
    transaction records `postTokenBalances` -- the balance right after it. One
    page of signatures reaches back about a week on an active account, so two
    calls give a real rate instead of waiting days for snapshots to accumulate.
    """
    cutoff = time.time() - days * 86400
    sigs = _solana_rpc("getSignaturesForAddress",
                       [token_account, {"limit": 1000}]) or []
    older = [s for s in sigs
             if s.get("blockTime") and s["blockTime"] <= cutoff and not s.get("err")]
    pick = max(older, key=lambda s: s["blockTime"]) if older else None
    if pick is None:
        # Page did not reach back far enough; use the oldest we did see and
        # report the span actually covered rather than pretending it was `days`.
        cand = [s for s in sigs if s.get("blockTime") and not s.get("err")]
        if not cand:
            return None
        pick = min(cand, key=lambda s: s["blockTime"])
    tx = _solana_rpc("getTransaction",
                     [pick["signature"], {"maxSupportedTransactionVersion": 0,
                                          "encoding": "jsonParsed"}])
    if not tx:
        return None
    meta = tx.get("meta") or {}
    keys = ((tx.get("transaction") or {}).get("message") or {}).get("accountKeys") or []
    idx = None
    for i, k in enumerate(keys):
        pk = k.get("pubkey") if isinstance(k, dict) else k
        if pk == token_account:
            idx = i
            break
    for b in meta.get("postTokenBalances") or []:
        if b.get("accountIndex") == idx:
            return {"held": float(b["uiTokenAmount"]["uiAmountString"]),
                    "ts": pick["blockTime"]}
    return None


# Measured, not assumed. BSC is 0.450s -- taking the documented 3s put a
# "30 days ago" read about 200 days back.
CHAIN_BLOCK_S = {"ethereum": 12.05, "binance-smart-chain": 0.450, "base": 2.0}


def solana_signatures(token_account, before=None, limit=1000):
    opts = {"limit": limit}
    if before:
        opts["before"] = before
    return _solana_rpc("getSignaturesForAddress", [token_account, opts]) or []


def solana_post_balance(token_account, signature):
    """Balance right after `signature` — how Solana history is recovered."""
    tx = _solana_rpc("getTransaction",
                     [signature, {"maxSupportedTransactionVersion": 0,
                                  "encoding": "jsonParsed"}])
    if not tx:
        return None
    meta = tx.get("meta") or {}
    keys = ((tx.get("transaction") or {}).get("message") or {}).get("accountKeys") or []
    idx = None
    for i, k in enumerate(keys):
        pk = k.get("pubkey") if isinstance(k, dict) else k
        if pk == token_account:
            idx = i
            break
    for b in meta.get("postTokenBalances") or []:
        if b.get("accountIndex") == idx:
            return float(b["uiTokenAmount"]["uiAmountString"])
    return None
