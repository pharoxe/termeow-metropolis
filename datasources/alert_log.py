"""Durable record of every alert this terminal has fired.

Until now an alert existed only as a Telegram message: once sent, nothing in
the terminal could tell you what had fired, when, or why. If the phone was
face-down you simply missed it. This is the log behind the ALERTS tab —
append-only, capped, and written by every path that notifies (server-side
buyback checks and browser-side burn/price alerts alike, since those post
through /api/notify).
"""

import json
import os
import tempfile
import threading
import time

STORE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                     "data", "alert_log.json")
KEEP = 200
_LOCK = threading.Lock()


def _load():
    try:
        with open(STORE) as fh:
            d = json.load(fh)
        return d if isinstance(d, list) else []
    except (OSError, ValueError):
        return []


def record(text, kind="alert", token=None, delivered=True):
    """Append one fired alert. Never raises — logging must not break sending."""
    try:
        row = {"at": time.time(), "kind": kind, "text": str(text)[:400],
               "token": token, "delivered": bool(delivered)}
        with _LOCK:
            rows = _load()
            rows.append(row)
            rows = rows[-KEEP:]
            os.makedirs(os.path.dirname(STORE), exist_ok=True)
            fd, tmp = tempfile.mkstemp(dir=os.path.dirname(STORE), suffix=".tmp")
            try:
                with os.fdopen(fd, "w") as fh:
                    json.dump(rows, fh)
                os.replace(tmp, STORE)
            except OSError:
                try:
                    os.unlink(tmp)
                except OSError:
                    pass
        return row
    except Exception:
        return None


def recent(limit=40):
    return list(reversed(_load()))[:limit]
