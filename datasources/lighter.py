"""Lighter (zkLighter L2) — the protocol buyback account, read live.

Buybacks run as daily 24h TWAPs from **Account #0** on the LIT/USDC pair,
funded by trading fees, then burned to 0xdEaD on Ethereum in quarterly
batches (first: 15,638,702 LIT on 2026-07-10, verified on-chain).

Mainnet forensics established why L1 cannot show the live bid: the burn's
executor (0x3dd7…) and the treasury (0xe554…, 234M LIT) both sit static
between quarters — accumulation happens on the L2. Account #0's `LIT`
balance IS the running Q3 buyback, and its locked USDC is the TWAP order
currently working. Verified against the timeline: ~1.10M LIT accumulated in
the 29 days since the burn ≈ fee revenue over the period at market price.
"""

import json
import urllib.request

BASE = "https://mainnet.zklighter.elliot.ai"
TIMEOUT = 30
UA = {"User-Agent": "hl-terminal research", "Accept": "application/json"}


def account0():
    """{lit_balance, usdc_locked, usdc_balance} for the protocol account."""
    req = urllib.request.Request(
        BASE + "/api/v1/account?by=index&value=0", headers=UA)
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        d = json.loads(resp.read().decode())
    accounts = d.get("accounts") or []
    if not accounts:
        return None
    out = {"src": "zklighter:account0"}
    for a in accounts[0].get("assets") or []:
        if a.get("symbol") == "LIT":
            out["lit_balance"] = float(a.get("balance") or 0)
        elif a.get("symbol") == "USDC":
            out["usdc_locked"] = float(a.get("locked_balance") or 0)
            out["usdc_balance"] = float(a.get("balance") or 0)
    return out if "lit_balance" in out else None
