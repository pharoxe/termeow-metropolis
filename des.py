#!/usr/bin/env python3
"""Bloomberg-style DES: four cited lines for the charted name.

The slot is the existing #news-ctx CONTEXT card, upgraded. The server
gathers a bundle already on the desk — last from cached candles, funding
from the universe snapshot, book/whale/depth lean if those stores are
warm, the next dated event, up to four material CN headlines from the
pipeline DB — and a local LLM (the same model equity synthesis uses)
writes at most four lines. Each line MUST cite a provided field name or
a headline URL. No causation. No invented funding/book/whale numbers.

On timeout or a dead ollama the deterministic cite assembly ships, with
an honest fail note. Cache is coin + hash of the rounded inputs so a
selectCoin / poll loop does not re-call the model. No new crawl, no FA,
no 10-Ks, no extra agent.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime
from typing import Any, Dict, List, Optional
from zoneinfo import ZoneInfo

import research
from cache import CACHE

# Match equity/synthesis.py — native /api/chat so think=false actually binds.
OLLAMA_CHAT_URL = "http://127.0.0.1:11434/api/chat"
DEFAULT_MODEL = "qwen3.6:latest"
DES_TIMEOUT_S = 30
_CAUSATION = re.compile(
    r"\b(because|due to|on the back of|driven by|owing to|caused by)\b",
    re.I,
)

SYSTEM_PROMPT = """You write a Bloomberg DES note for ONE listed name.
Up to FOUR lines. One sentence per line. Each line MUST cite exactly one
provided field name or one provided headline URL via the "cite" key.

Rules:
- Ground every claim in the provided facts. If a fact is absent, omit it.
- Never write causation (no "because", "due to", "on the back of").
- Never invent funding, book, whale, or headline numbers or URLs.
- If there are no headlines, do not invent any. Speak tape / funding / whales / book only.
- Do not recommend a trade. Do not predict.
- Never call the ±25bps depth band a spread. Band = the ±25bps sleeve of
  resting notional around mid. Spread = bid/ask of the book.
- If last.interval is "1h", write "1h close", never "last" as a live print.

Reply with ONLY a JSON array, no other text:
[{"text":"<one sentence>","cite":"<field or url>"}, ...]
"""

_LOCK = threading.Lock()
# coin -> latest completed or in-flight record
_CACHE: Dict[str, Dict[str, Any]] = {}
_JOBS: Dict[str, Dict[str, Any]] = {}


def _model() -> str:
    return os.environ.get("EQUITY_SYNTHESIS_MODEL", DEFAULT_MODEL)


def _fmt_px(x) -> str:
    try:
        v = float(x)
    except (TypeError, ValueError):
        return ""
    if v >= 10000:
        return "{:,.0f}".format(v)
    if v >= 100:
        return "{:.2f}".format(v)
    if v >= 1:
        return "{:.3f}".format(v)
    return "{:.4g}".format(v)


def _fmt_big(x) -> str:
    try:
        v = float(x)
    except (TypeError, ValueError):
        return ""
    av = abs(v)
    if av >= 1e9:
        return "{:.2f}B".format(v / 1e9)
    if av >= 1e6:
        return "{:.1f}M".format(v / 1e6)
    if av >= 1e3:
        return "{:.1f}K".format(v / 1e3)
    return "{:.0f}".format(v)


def _round_px(x):
    try:
        v = float(x)
    except (TypeError, ValueError):
        return None
    if v >= 10000:
        return int(round(v))
    if v >= 100:
        return round(v, 2)
    if v >= 1:
        return round(v, 3)
    return float("{:.4g}".format(v))


def _base(coin: str) -> str:
    s = str(coin or "")
    return s.split(":")[-1].strip().upper() if s else ""


def _candle_last(coin: str, iv: str):
    val, _fresh = CACHE.get_stale("candles:%s:%s" % (coin, iv))
    if not val:
        return None
    rows = val if isinstance(val, list) else None
    if not rows:
        return None
    last = rows[-1] if isinstance(rows[-1], dict) else None
    if not last:
        return None
    c = last.get("c")
    if c is None:
        return None
    try:
        return {"value": float(c), "interval": iv, "field": "candles.c",
                "display": _fmt_px(c)}
    except (TypeError, ValueError):
        return None


def _book_mid(coin: str):
    """Book mid already in CACHE. Never fetches."""
    for sig in (5, 4, 3):
        val, _fresh = CACHE.get_stale("book:%s:%s" % (coin, sig))
        if not isinstance(val, dict):
            continue
        if val.get("mid") is not None:
            try:
                mid = float(val["mid"])
            except (TypeError, ValueError):
                mid = None
            if mid and mid > 0:
                return {"value": mid, "interval": "book", "field": "book.mid",
                        "display": _fmt_px(mid)}
        levels = val.get("levels") or [[], []]
        if not isinstance(levels, (list, tuple)) or len(levels) < 2:
            continue
        bids, asks = levels[0], levels[1]
        if not bids or not asks:
            continue
        b0 = bids[0] if isinstance(bids[0], dict) else None
        a0 = asks[0] if isinstance(asks[0], dict) else None
        if not b0 or not a0:
            continue
        try:
            bp, ap = float(b0["px"]), float(a0["px"])
        except (TypeError, ValueError, KeyError):
            continue
        if bp <= 0 or ap <= 0:
            continue
        mid = (bp + ap) / 2.0
        return {"value": mid, "interval": "book", "field": "book.mid",
                "display": _fmt_px(mid)}
    return None


def _cached_candles(coin: str):
    """Last from 1m, else book mid, else other candle intervals. Never fetches."""
    got = _candle_last(coin, "1m")
    if got:
        return got
    mid = _book_mid(coin)
    if mid:
        return mid
    for iv in ("15m", "5m", "1h", "4h", "1d", "30m"):
        got = _candle_last(coin, iv)
        if got:
            return got
    return None


def _universe_ctx(coin: str) -> dict:
    val, _ = CACHE.get_stale("universe")
    if not isinstance(val, dict):
        return {}
    ctxs = dict(val.get("crypto") or {})
    ctxs.update(val.get("equity") or {})
    return ctxs.get(coin) or {}


def _funding(coin: str, ctx: dict):
    fr = (ctx or {}).get("funding")
    if fr is None:
        return None
    try:
        hourly = float(fr)
    except (TypeError, ValueError):
        return None
    pct_8h = hourly * 8 * 100.0
    sign = "+" if pct_8h >= 0 else ""
    return {
        "hourly": hourly,
        "pct_8h": round(pct_8h, 4),
        "field": "universe.funding",
        "display": "%s%.4f%%" % (sign, pct_8h),
    }


def _whale_lean(coin: str):
    val, _ = CACHE.get_stale("whale_coin:" + coin)
    if not isinstance(val, dict):
        return None
    L, S = val.get("long_ntl"), val.get("short_ntl")
    n = val.get("n_positions")
    try:
        Lf, Sf = float(L or 0), float(S or 0)
    except (TypeError, ValueError):
        return None
    if n is None or (Lf + Sf) <= 0:
        return None
    pct = Lf / (Lf + Sf) * 100.0
    return {
        "kind": "whales",
        "pct_long": int(round(pct)),
        "long_ntl": Lf,
        "short_ntl": Sf,
        "n_positions": n,
        "field": "whaleCoin.long_ntl",
        "fields": ["whaleCoin.long_ntl", "whaleCoin.short_ntl"],
        "display": "whales %d%% long · $%s / $%s" % (
            int(round(pct)), _fmt_big(Lf), _fmt_big(Sf)),
    }


def _depth_lean(coin: str):
    try:
        from datasources import depth_history
        row = (depth_history.metrics() or {}).get(coin) or {}
    except Exception:
        return None
    if row.get("depth_stale") or row.get("depth_imb") is None:
        return None
    try:
        imb = float(row["depth_imb"])
    except (TypeError, ValueError):
        return None
    bid = (1 + imb) / 2 * 100.0
    band = row.get("depth_band_bps")
    return {
        "kind": "book",
        "pct_bid": int(round(bid)),
        "imb": imb,
        "band_bps": band,
        "field": "depth.imb",
        "fields": ["depth.imb"],
        "display": "book %d%% bid ±%sbps" % (int(round(bid)), band if band is not None else "?"),
    }


def _next_event(coin: str):
    val, _ = CACHE.get_stale("events")
    rows = val if isinstance(val, list) else []
    if not rows:
        return None
    today = datetime.now(ZoneInfo("America/New_York")).strftime("%Y-%m-%d")
    base = _base(coin)
    for e in rows:
        if not isinstance(e, dict):
            continue
        if (e.get("expected_move_pct") is None) or (e.get("date") or "") < today:
            continue
        if e.get("hl_coin") == coin or e.get("symbol") == base or e.get("proxy") == base:
            mv = e.get("expected_move_pct")
            lab = ((e.get("date") or "") + " " + (e.get("label") or e.get("event_type") or "")).strip()
            extra = (" ±%.2f%%" % float(mv)) if mv is not None else ""
            return {
                "date": e.get("date"),
                "label": e.get("label") or e.get("event_type"),
                "expected_move_pct": mv,
                "field": "events",
                "display": lab + extra,
            }
    return None


def _headlines(coin: str) -> List[dict]:
    symbols = research.news_symbols_for(coin)
    try:
        rows = research.material_news(limit=4, symbols=symbols)
    except Exception:
        return []
    out = []
    for r in rows or []:
        url = (r.get("url") or "").strip()
        hl = (r.get("headline") or "").strip()
        if not hl:
            continue
        out.append({
            "headline": hl,
            "url": url or None,
            "published_at": r.get("published_at"),
            "base_symbol": r.get("base_symbol"),
            "field": url or "news_items.headline",
        })
    return out[:4]


def gather_bundle(coin: str) -> dict:
    coin = str(coin or "BTC")
    ctx = _universe_ctx(coin)
    last = _cached_candles(coin)
    fund = _funding(coin, ctx)
    lean = _whale_lean(coin) or _depth_lean(coin)
    ev = _next_event(coin)
    heads = _headlines(coin)
    return {
        "coin": coin,
        "base": _base(coin) or coin,
        "last": last,
        "funding": fund,
        "lean": lean,
        "event": ev,
        "headlines": heads,
    }


def hash_bundle(bundle: dict) -> str:
    """Material hash: rounded last/funding/lean, event identity, headline urls."""
    last = bundle.get("last") or {}
    fund = bundle.get("funding") or {}
    lean = bundle.get("lean") or {}
    ev = bundle.get("event") or {}
    heads = bundle.get("headlines") or []
    material = {
        "coin": bundle.get("coin"),
        "last": _round_px(last.get("value")) if last else None,
        "pct_8h": fund.get("pct_8h") if fund else None,
        "lean_kind": lean.get("kind") if lean else None,
        "lean_pct": lean.get("pct_long") if lean and lean.get("kind") == "whales"
                    else lean.get("pct_bid") if lean else None,
        "event": (ev.get("date"), ev.get("label")) if ev else None,
        "heads": [(h.get("url"), h.get("published_at")) for h in heads],
    }
    blob = json.dumps(material, sort_keys=True, default=str, separators=(",", ":"))
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()[:16]


def allowed_cites(bundle: dict) -> List[str]:
    out = []
    if bundle.get("last"):
        out.append(bundle["last"].get("field") or "candles.c")
    if bundle.get("funding"):
        out.append("universe.funding")
    lean = bundle.get("lean") or {}
    for f in lean.get("fields") or ([lean["field"]] if lean.get("field") else []):
        if f not in out:
            out.append(f)
    if bundle.get("event"):
        out.append("events")
    for h in bundle.get("headlines") or []:
        if h.get("url"):
            out.append(h["url"])
        else:
            if "news_items.headline" not in out:
                out.append("news_items.headline")
    return out


def cite_lines(bundle: dict) -> List[dict]:
    """Deterministic CONTEXT assembly — no LLM. Each row cites a field or URL."""
    lines = []
    last = bundle.get("last")
    fund = bundle.get("funding")
    if last:
        field = last.get("field") or "candles.c"
        iv = last.get("interval")
        if iv == "1h":
            v = "1h close " + last["display"]
            tip = "1h close of the loaded candle series (candles.c)"
        elif field == "book.mid":
            v = "last " + last["display"]
            tip = "book mid (book.mid)"
        else:
            v = "last " + last["display"]
            tip = "last close of the loaded candle series (candles.c)"
        if fund:
            v += " · fund/8h " + fund["display"]
            tip += " · universe.funding is the HL 1h rate, shown x8 as FUND/8H"
        lines.append({
            "k": "TAPE", "v": v, "cite": field,
            "href": None, "extra": None, "title": tip,
        })
        if fund and len(lines) < 4:
            # Tape already cites candles.c and mentions funding; a dedicated
            # funding line only appears when there is no last (should not).
            pass
    elif fund:
        lines.append({
            "k": "TAPE", "v": "fund/8h " + fund["display"],
            "cite": "universe.funding", "href": None, "extra": None,
            "title": "universe.funding is the HL 1h rate, shown x8 as FUND/8H",
        })

    lean = bundle.get("lean")
    if lean and len(lines) < 4:
        lines.append({
            "k": "LEAN", "v": lean["display"], "cite": lean["field"],
            "href": None, "extra": None,
            "title": lean["field"],
        })

    ev = bundle.get("event")
    if ev and len(lines) < 4:
        lines.append({
            "k": "NEXT", "v": ev["display"], "cite": "events",
            "href": None, "extra": None,
            "title": "next dated row in events for this symbol (event radar)",
        })

    heads = bundle.get("headlines") or []
    if heads and len(lines) < 4:
        hn = heads[0]
        extra = None
        pub = hn.get("published_at")
        if pub:
            extra = str(pub)
        lines.append({
            "k": "HEADLINE", "v": hn.get("headline") or "",
            "cite": hn.get("url") or "news_items.headline",
            "href": hn.get("url"), "extra": extra,
            "title": "newest material headline for this name (not the ALL river)",
        })
    return lines[:4]


def _extract_json_array(text: str) -> Optional[list]:
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", (text or "").strip(),
                  flags=re.MULTILINE).strip()
    match = re.search(r"\[.*\]", text, re.DOTALL)
    if not match:
        return None
    try:
        parsed = json.loads(match.group(0))
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, list) else None


def filter_llm_lines(raw: list, bundle: dict) -> List[dict]:
    """Keep at most four lines whose cite is a provided field or headline URL."""
    allowed = set(allowed_cites(bundle))
    url_of = {(h.get("url") or ""): h for h in (bundle.get("headlines") or [])}
    out = []
    for item in raw or []:
        if len(out) >= 4:
            break
        if not isinstance(item, dict):
            continue
        text = str(item.get("text") or "").strip()
        cite = str(item.get("cite") or "").strip()
        if not text or not cite:
            continue
        if cite not in allowed:
            continue
        if _CAUSATION.search(text):
            continue
        href = cite if cite in url_of else None
        out.append({"text": text[:280], "cite": cite, "href": href})
    return out


def _chat(messages: List[dict], timeout: int = DES_TIMEOUT_S) -> str:
    payload = json.dumps({
        "model": _model(),
        "messages": messages,
        "think": False,
        "stream": False,
        "options": {"temperature": 0.2, "num_predict": 400},
    }).encode("utf-8")
    req = urllib.request.Request(
        OLLAMA_CHAT_URL, data=payload,
        headers={"Content-Type": "application/json"}, method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.load(resp)["message"]["content"]


def synthesize(bundle: dict) -> List[dict]:
    facts = {
        "symbol": bundle.get("base"),
        "coin": bundle.get("coin"),
        "last": bundle.get("last"),
        "funding": bundle.get("funding"),
        "lean": bundle.get("lean"),
        "event": bundle.get("event"),
        "headlines": bundle.get("headlines"),
        "cite_only_these": allowed_cites(bundle),
    }
    raw = _chat([
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": json.dumps(facts, default=str)},
    ])
    parsed = _extract_json_array(raw)
    if not parsed:
        return []
    return filter_llm_lines(parsed, bundle)


def _public_bundle(bundle: dict) -> dict:
    """Small echo the UI can show tags from; never a dump of stores."""
    return {
        "last": bundle.get("last"),
        "funding": bundle.get("funding"),
        "lean": bundle.get("lean"),
        "event": bundle.get("event"),
        "headlines": [
            {"headline": h.get("headline"), "url": h.get("url"),
             "published_at": h.get("published_at")}
            for h in (bundle.get("headlines") or [])
        ],
    }


def _payload(coin, bundle, h, status, mode, lines, cites, fail, at, cached):
    now = time.time()
    return {
        "coin": coin,
        "base": bundle.get("base"),
        "hash": h,
        "status": status,
        "mode": mode,
        "lines": lines or [],
        "cites": cites,
        "fail": fail,
        "at": at,
        "age_s": round(now - at, 1) if at else None,
        "cached": cached,
        "model": _model(),
        "fields": allowed_cites(bundle),
        "bundle": _public_bundle(bundle),
    }


def _run_llm(coin: str, h: str, bundle: dict, cites: list) -> None:
    fail = None
    lines: List[dict] = []
    mode = "cites"
    status = "fail"
    try:
        lines = synthesize(bundle)
        if lines:
            mode = "llm"
            status = "llm"
            fail = None
        else:
            fail = "DES failed / using cites only"
    except (urllib.error.HTTPError, urllib.error.URLError, OSError,
            KeyError, json.JSONDecodeError, TimeoutError, ValueError) as e:
        fail = "DES failed / using cites only"
        lines = []
        # Keep the class name so a log can say WHO broke; the UI only sees fail.
        _ = "%s: %s" % (type(e).__name__, e)
    now = time.time()
    with _LOCK:
        rec = _CACHE.get(coin)
        if not rec or rec.get("hash") != h:
            _JOBS.pop(coin, None)
            return
        rec.update({
            "status": status, "mode": mode, "lines": lines,
            "cites": cites, "fail": fail, "at": now,
        })
        _JOBS.pop(coin, None)


def api_des(q=None) -> dict:
    """GET /api/des?coin= — cites immediately; LLM in the background, cached."""
    q = q or {}
    coin = (q.get("coin") or ["BTC"])[0]
    bundle = gather_bundle(coin)
    h = hash_bundle(bundle)
    cites = cite_lines(bundle)
    now = time.time()
    with _LOCK:
        rec = _CACHE.get(coin)
        if rec and rec.get("hash") == h and rec.get("status") in ("llm", "fail"):
            return _payload(coin, bundle, h, rec["status"], rec["mode"],
                            rec.get("lines"), cites, rec.get("fail"),
                            rec.get("at") or now, True)
        job = _JOBS.get(coin)
        if rec and rec.get("hash") == h and rec.get("status") == "pending":
            started = (job or {}).get("started") or rec.get("at") or now
            if now - started > DES_TIMEOUT_S + 2:
                rec.update({
                    "status": "fail", "mode": "cites",
                    "fail": "DES failed / using cites only", "at": now,
                })
                _JOBS.pop(coin, None)
                return _payload(coin, bundle, h, "fail", "cites", [],
                                cites, rec["fail"], now, True)
            return _payload(coin, bundle, h, "pending", "cites", [],
                            cites, None, rec.get("at") or now, False)
        rec = {
            "coin": coin, "hash": h, "status": "pending", "mode": "cites",
            "lines": [], "cites": cites, "fail": None, "at": now,
        }
        _CACHE[coin] = rec
        _JOBS[coin] = {"hash": h, "started": now}
        t = threading.Thread(target=_run_llm, args=(coin, h, bundle, cites),
                             daemon=True)
        t.start()
    return _payload(coin, bundle, h, "pending", "cites", [], cites,
                    None, now, False)


def reset_cache() -> None:
    """Tests only."""
    with _LOCK:
        _CACHE.clear()
        _JOBS.clear()
