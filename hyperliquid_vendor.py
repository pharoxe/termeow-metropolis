"""Hyperliquid price/indicator vendor for TradingAgents.

yfinance does not list HYPE, PUMP, or most of the HL tail — a deep dive on
them returns NO_DATA. Hyperliquid itself has the candles (HYPE: 622 daily bars,
measured), and the terminal already talks to that API in datasources/hl.py.

This registers `hyperliquid` into the upstream VENDOR_METHODS registry at
runtime, exactly as the Hermes news vendor does, so nothing in the
TradingAgents repo is modified and `git pull` stays clean.

Output format is byte-compatible with the yfinance vendor's, so the market
analyst sees the shape it was prompted for.

Point-in-time: bars after `end_date` are dropped, so a dated run cannot see
candles that had not printed yet.
"""

import os
import sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from datasources import hl

# HL quotes perps by bare coin; TradingAgents passes yfinance-style pairs.
_QUOTES = ("-USD", "-USDT", "-USDC", "USD", "USDT", "USDC")


def hl_coin(symbol):
    """'HYPE-USD' -> 'HYPE'. Venue-prefixed assets ('xyz:TSLA') pass through."""
    s = (symbol or "").strip().upper()
    if ":" in s:
        return s
    for q in _QUOTES:
        if s.endswith(q) and len(s) > len(q):
            return s[: -len(q)].rstrip("-")
    return s


def _rows(symbol, end_date=None):
    """Daily bars as dicts, truncated at end_date (inclusive)."""
    raw = hl.candles(hl_coin(symbol), "1d", 0) or []
    out = []
    for c in raw:
        day = datetime.fromtimestamp(int(c["t"]) / 1000, tz=timezone.utc).strftime("%Y-%m-%d")
        if end_date and day > end_date:
            continue
        out.append({
            "date": day, "open": float(c["o"]), "high": float(c["h"]),
            "low": float(c["l"]), "close": float(c["c"]), "volume": float(c["v"]),
        })
    return out


def _fall_through(symbol, why):
    """Hand the chain the one exception it treats as 'try the next vendor'."""
    try:
        from tradingagents.dataflows.errors import NoMarketDataError
        raise NoMarketDataError(symbol, symbol, why)
    except ImportError:
        raise ValueError("%s: %s" % (symbol, why))


def get_hl_stock_data(symbol, start_date, end_date):
    """OHLCV in the same layout the yfinance vendor emits."""
    # AN UPSTREAM FAULT MUST FALL THROUGH, NOT UNWIND THE WHOLE WORKUP.
    #
    # route_to_vendor only falls through on NoMarketDataError. hl.candles ->
    # hl._post is a bare urlopen by design — the terminal's caches and fault
    # attribution depend on its exceptions propagating, so it is NOT the place
    # to fix this — which means an HTTPError raised HERE escaped straight out
    # of graph.propagate() and killed the run. Measured: job 32 META died 45s
    # in on "HTTP Error 500" from api.hyperliquid.xyz, and HL is first in the
    # chain for EVERY symbol including equities, so this is a recurring class,
    # not a one-off.
    #
    # From the chain's point of view "HL does not list this" and "HL could not
    # be reached" have the SAME correct response: try the next vendor. They are
    # not the same fact, though, so the reason distinguishes them — a persistent
    # outage must never read as "not listed", or a fixable fault looks like a
    # permanent property of the symbol.
    try:
        rows = [r for r in _rows(symbol, end_date) if r["date"] >= start_date]
    except Exception as exc:
        _fall_through(symbol, "Hyperliquid unreachable (%s: %s) — this is an "
                              "UPSTREAM FAULT, not evidence that %s is unlisted"
                              % (type(exc).__name__, str(exc)[:120], symbol))
    if not rows:
        # RAISE, don't return a string: route_to_vendor treats any returned
        # value as success and stops the chain. Raising NoMarketDataError lets
        # it fall through to the next vendor -- which is what must happen for
        # equities, where HL has no listing.
        try:
            from tradingagents.dataflows.errors import NoMarketDataError
            raise NoMarketDataError(symbol, symbol, "no Hyperliquid candles")
        except ImportError:
            raise ValueError(f"no Hyperliquid candles for {symbol}")
    head = (
        f"# Stock data for {symbol} from {start_date} to {end_date}\n"
        f"# Total records: {len(rows)}\n"
        f"# Data retrieved on: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n"
        f"# Source: Hyperliquid perp candles (not an equity feed — no dividends "
        f"or splits apply)\n\n"
        f"Date,Open,High,Low,Close,Volume,Dividends,Stock Splits\n"
    )
    body = "\n".join(
        f"{r['date']},{r['open']},{r['high']},{r['low']},{r['close']},"
        f"{int(r['volume'])},0.0,0.0" for r in rows
    )
    return head + body


def get_hl_indicators(symbol, indicator, curr_date, look_back_days):
    """Indicators over HL bars, computed with the same stockstats the repo uses."""
    # Same guard, same reason as get_hl_stock_data above: this sibling was left
    # unguarded and an upstream fault here escapes graph.propagate() just as it
    # did there. Measured: job 94 NVDA died 41s in on "HTTP Error 500" from
    # api.hyperliquid.xyz on 2026-08-25 while get_stock_data's guard held.
    try:
        rows = _rows(symbol, curr_date)
    except Exception as exc:
        _fall_through(symbol, "Hyperliquid unreachable (%s: %s) — this is an "
                              "UPSTREAM FAULT, not evidence that %s is unlisted"
                              % (type(exc).__name__, str(exc)[:120], symbol))
    if len(rows) < 60:
        return (
            f"NO_DATA_AVAILABLE: Hyperliquid history for '{symbol}' is too short "
            f"({len(rows)} bars) to compute '{indicator}' at {curr_date}."
        )
    try:
        import pandas as pd
        from stockstats import wrap
    except ImportError:
        return "DATA_UNAVAILABLE: stockstats/pandas missing for indicator computation."

    df = wrap(pd.DataFrame(rows))
    try:
        series = df[indicator]
    except Exception:
        # stockstats raises a bare UserWarning (not KeyError) for an unparseable
        # column name, and a live run really did ask for 'macdhist'. Catch
        # broadly and hand back the valid list, matching how the upstream tool
        # boundary handles it -- an invalid name must not kill a 9-minute run.
        return (
            f"Indicator {indicator} is not supported. Please choose from: "
            f"['close_50_sma','close_200_sma','close_10_ema','macd','macds',"
            f"'macdh','rsi','boll','boll_ub','boll_lb','atr','vwma','mfi']"
        )
    tail = list(zip([r["date"] for r in rows], series))[-int(look_back_days or 30):]
    lines = "\n".join(
        f"{d}: {v:.4f}" for d, v in tail
        if v == v and isinstance(v, (int, float))
    )
    return (
        f"## {indicator} for {symbol} through {curr_date}\n"
        f"# Source: Hyperliquid perp candles\n\n{lines}\n"
    )


def register():
    """Insert the hyperliquid vendor into the upstream registry."""
    from tradingagents.dataflows import interface

    interface.VENDOR_METHODS["get_stock_data"]["hyperliquid"] = get_hl_stock_data
    interface.VENDOR_METHODS["get_indicators"]["hyperliquid"] = get_hl_indicators
    patch_load_ohlcv()
    return ["get_stock_data", "get_indicators", "load_ohlcv(patched)"]


# ---------------------------------------------------------------------------
# The market analyst's "Verified Market Snapshot" does NOT go through
# route_to_vendor: build_verified_market_snapshot() calls
# stockstats_utils.load_ohlcv(), which downloads from yfinance directly and
# caches to CSV. On an HL-only ticker that path returned stale 2024 rows,
# cached them, and every later run failed the staleness check regardless of
# which vendor the registry preferred.
#
# So load_ohlcv is wrapped rather than the registry alone: HL-only symbols are
# served from Hyperliquid candles in the frame shape the caller expects, and
# everything else falls through to the original function untouched.
# ---------------------------------------------------------------------------

def _hl_frame(symbol, curr_date):
    import pandas as pd

    rows = _rows(symbol, curr_date)
    if not rows:
        return None
    df = pd.DataFrame([{
        "Date": pd.Timestamp(r["date"]), "Open": r["open"], "High": r["high"],
        "Low": r["low"], "Close": r["close"], "Volume": r["volume"],
    } for r in rows])
    return df


def patch_load_ohlcv():
    """Serve HL-only tickers to the verified-snapshot path. Idempotent."""
    from tradingagents.dataflows import stockstats_utils as su

    if getattr(su.load_ohlcv, "_hl_wrapped", False):
        return False
    original = su.load_ohlcv

    def wrapped(symbol, curr_date):
        try:
            return original(symbol, curr_date)
        except Exception:
            frame = _hl_frame(symbol, curr_date)
            if frame is None or frame.empty:
                raise
            return frame

    def preferring_hl(symbol, curr_date):
        # Try yfinance first so equities and majors keep their richer history,
        # but verify it is not stale before accepting it -- yfinance "succeeds"
        # with years-old rows on delisted-looking crypto tickers.
        import pandas as pd
        try:
            df = original(symbol, curr_date)
            if not df.empty:
                newest = pd.to_datetime(df["Date"]).max()
                if (pd.Timestamp(curr_date) - newest).days <= 7:
                    return df
        except Exception:
            pass
        frame = _hl_frame(symbol, curr_date)
        if frame is not None and not frame.empty:
            return frame
        return wrapped(symbol, curr_date)

    preferring_hl._hl_wrapped = True
    # Keep a handle on the TRUE yfinance path: is_hl_only() must be able to ask
    # "can yfinance serve this?" without the HL fallback answering for it.
    preferring_hl.__wrapped_original__ = original
    su.load_ohlcv = preferring_hl
    # market_data_validator imported the symbol directly, so rebind there too.
    try:
        from tradingagents.dataflows import market_data_validator as mv
        if hasattr(mv, "load_ohlcv"):
            mv.load_ohlcv = preferring_hl
    except ImportError:
        pass
    return True


def is_hl_only(symbol, curr_date):
    """True when yfinance cannot serve this symbol but Hyperliquid can.

    Identity resolution, news and sentiment all key off the yfinance listing.
    For a ticker it does not carry, the framework resolves the WRONG company
    (HYPE-USD resolved as "Supreme Finance USD") and the news analyst, finding
    no coverage, substitutes unrelated macro -- a live run reasoned about a
    copper squeeze for a perps token. Those agents must not run on such symbols.
    """
    import pandas as pd
    try:
        from tradingagents.dataflows.stockstats_utils import load_ohlcv
    except ImportError:
        return False
    orig = getattr(load_ohlcv, "__wrapped_original__", None)
    try:
        df = (orig or load_ohlcv)(symbol, curr_date)
        if df is not None and not df.empty:
            newest = pd.to_datetime(df["Date"]).max()
            if (pd.Timestamp(curr_date) - newest).days <= 7:
                return False          # yfinance has it, and it is current
    except Exception:
        pass
    return _hl_frame(symbol, curr_date) is not None
