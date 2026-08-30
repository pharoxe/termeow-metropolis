"""Read-only bridge to the research pipeline's equity_intel.db."""

import json
import os
import sqlite3
from datetime import datetime, timezone

DB_PATH = os.path.expanduser("~/.hermes/trading_system/equity/equity_intel.db")


def _conn():
    # The pipeline runs the DB in WAL mode; a mode=ro URI open fails when the
    # -shm sidecar is absent. Open normally but hard-enforce read-only at the
    # connection level instead.
    conn = sqlite3.connect(DB_PATH, timeout=5)
    conn.execute("PRAGMA query_only=ON")
    conn.row_factory = sqlite3.Row
    return conn


# Newest-per-asset includes tombstones (invalidated ATR stops, ticker-mismatch
# no_trade). Those rows stay in intel_cards; they are not the live book.
CARDS_NOTE = (
    "current book is newest live desk per asset — invalidated and "
    "ticker-mismatch no_trade stay in intel_cards but are not shown as live"
)


def _is_live_desk(card):
    """False for desks that must not look like the current book."""
    state = (card.get("state") or "").strip().lower()
    if state == "invalidated":
        return False
    if state == "no_trade":
        blob = " ".join(
            str(card.get(k) or "") for k in ("thesis", "why_not")
        ).lower()
        if "mismatch" in blob or "unrelated to" in blob:
            return False
    return True


def latest_cards():
    """Most recent *live* intel card per asset (the current book of ideas).

    Newest-per-asset still includes invalidated / ticker-mismatch no_trade in
    the table; those are filtered here so the API/UI do not present them as
    the live desk. Rows are not deleted.
    """
    if not os.path.exists(DB_PATH):
        return []
    conn = _conn()
    try:
        rows = conn.execute(
            "SELECT ic.asset, ic.card_data, ic.created_at FROM intel_cards ic "
            "WHERE ic.created_at = (SELECT MAX(i2.created_at) FROM intel_cards i2 "
            "WHERE i2.asset = ic.asset) ORDER BY ic.created_at DESC"
        ).fetchall()
        out = []
        for r in rows:
            try:
                card = json.loads(r["card_data"]) if r["card_data"] else {}
            except (ValueError, TypeError):
                card = {}
            card["_created_at"] = r["created_at"]
            if _is_live_desk(card):
                out.append(card)
        return out
    finally:
        conn.close()


NEWS_LIMIT = 25
NEWS_LIMIT_MAX = 200

# Finnhub tags GOOG and GOOGL apart; they are one name on this desk.
_NEWS_ALIASES = {
    "GOOG": ("GOOG", "GOOGL"),
    "GOOGL": ("GOOG", "GOOGL"),
}


def news_symbols_for(coin):
    """Venue coin (`xyz:NVDA`, `BTC`) -> news_items.base_symbol values.

    None means unfiltered (ALL / TOP). A coin with no alias maps to its
    base symbol. Empty after stripping is treated as unfiltered.
    """
    if not coin:
        return None
    base = str(coin).split(":")[-1].strip().upper()
    if not base:
        return None
    return _NEWS_ALIASES.get(base, (base,))


def _clamp_limit(limit):
    try:
        n = int(limit)
    except (TypeError, ValueError):
        n = NEWS_LIMIT
    return max(1, min(NEWS_LIMIT_MAX, n))


def _since_iso(since):
    """ISO-8601 UTC or unix seconds/ms -> comparable published_at prefix."""
    if since is None:
        return None
    s = str(since).strip()
    if not s:
        return None
    if s.isdigit():
        n = int(s)
        if n > 10 ** 12:  # ms
            n = n / 1000.0
        return datetime.fromtimestamp(n, tz=timezone.utc).strftime(
            "%Y-%m-%dT%H:%M:%S")
    return s.replace(" ", "T")


def material_news(limit=NEWS_LIMIT, symbols=None, since=None):
    if not os.path.exists(DB_PATH):
        return []
    conn = _conn()
    try:
        sql = ("SELECT base_symbol, source, category, headline, url, published_at, "
               "created_at FROM news_items WHERE materiality='material'")
        args = []
        if symbols:
            ph = ",".join("?" * len(symbols))
            sql += " AND UPPER(base_symbol) IN (" + ph + ")"
            args.extend(symbols)
        iso = _since_iso(since)
        if iso:
            sql += " AND published_at >= ?"
            args.append(iso)
        sql += " ORDER BY id DESC LIMIT ?"
        args.append(_clamp_limit(limit))
        return [dict(r) for r in conn.execute(sql, args).fetchall()]
    finally:
        conn.close()


def material_counts(symbols=None):
    """How many material stories EXIST, next to the page material_news serves.

    The pane printed news.length + " MATERIAL", i.e. the SELECT's own LIMIT
    rendered as a total. Measured 2026-08-16: 984 rows carry
    materiality='material' (132 of them published in the last 7 days) and the
    pane said 25. `newest_published_at` travels too because the pane carries
    no age at all today while every headline in it was 1.7-3.3 days old.

    `symbols` scopes the counts to CN (one name). Unscoped is TOP / ALL.
    """
    if not os.path.exists(DB_PATH):
        return {"total": None, "last_7d": None, "newest_published_at": None,
                "note": "the pipeline DB is not readable from this host, so "
                        "no total exists — unknown, not zero"}
    conn = _conn()
    try:
        where = "materiality='material'"
        args = []
        if symbols:
            ph = ",".join("?" * len(symbols))
            where += " AND UPPER(base_symbol) IN (" + ph + ")"
            args.extend(symbols)
        total = conn.execute(
            "SELECT COUNT(*) FROM news_items WHERE " + where, args
        ).fetchone()[0]
        # published_at is stored as ISO-8601 UTC ('2026-08-14T12:36:49+00:00'),
        # so the cutoff must be built in the SAME shape — datetime() renders
        # '2026-08-09 12:00:00' and the space-vs-T at index 10 makes the
        # string compare wrong for rows on the boundary day. Verified against
        # the DB 2026-08-16: both forms answer 132 today, this one stays
        # right on the boundary.
        last7 = conn.execute(
            "SELECT COUNT(*) FROM news_items WHERE " + where +
            " AND published_at >= strftime('%Y-%m-%dT%H:%M:%S', 'now', "
            "'-7 days')", args).fetchone()[0]
        newest = conn.execute(
            "SELECT MAX(published_at) FROM news_items WHERE " + where,
            args).fetchone()[0]
        return {"total": total, "last_7d": last7,
                "newest_published_at": newest}
    finally:
        conn.close()


def pipeline_status():
    if not os.path.exists(DB_PATH):
        return {}
    conn = _conn()
    try:
        row = conn.execute(
            "SELECT cycle_id, timestamp, health_state FROM scan_cycles "
            "ORDER BY timestamp DESC LIMIT 1").fetchone()
        out = dict(row) if row else {}
        out["last_intel_card_at"] = conn.execute(
            "SELECT MAX(created_at) FROM intel_cards").fetchone()[0]
        fail = conn.execute(
            "SELECT created_at, failure_bucket, review FROM failure_reviews "
            "ORDER BY id DESC LIMIT 1").fetchone()
        if fail:
            out["last_failure_at"] = fail["created_at"]
            out["last_failure_bucket"] = fail["failure_bucket"]
            out["last_failure_review"] = fail["review"]
        else:
            out["last_failure_at"] = None
            out["last_failure_bucket"] = None
            out["last_failure_review"] = None
        out["last_enrichment_at"] = conn.execute(
            "SELECT MAX(created_at) FROM enrichments").fetchone()[0]
        out["cards_note"] = CARDS_NOTE
        return out
    finally:
        conn.close()
