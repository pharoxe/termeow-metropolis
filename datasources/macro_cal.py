"""Macro event calendar: FOMC, CPI, NFP, OPEX.

FOMC decision days come from the Fed's published meeting schedule (announced
a year+ ahead). CPI dates come from the BLS published release schedule.
NFP (first Friday) and OPEX (third Friday) are rule-derived. All dates are
UTC calendar dates; times are not modeled.
"""

from datetime import date, timedelta

# Fed 2026 FOMC meetings (second day = decision day), published schedule.
FOMC_DECISION_DAYS = [
    "2026-01-28", "2026-03-18", "2026-04-29", "2026-06-17",
    "2026-07-29", "2026-09-16", "2026-10-28", "2026-12-09",
]

# BLS CPI release schedule 2026 (published; 08:30 ET release days).
CPI_RELEASE_DAYS = [
    "2026-01-13", "2026-02-11", "2026-03-11", "2026-04-10",
    "2026-05-12", "2026-06-10", "2026-07-14", "2026-08-12",
    "2026-09-11", "2026-10-13", "2026-11-10", "2026-12-10",
]


def _nth_weekday(year, month, weekday, n):
    """Date of the n-th `weekday` (0=Mon) of a month."""
    d = date(year, month, 1)
    offset = (weekday - d.weekday()) % 7
    return d + timedelta(days=offset + 7 * (n - 1))


def _first_friday(year, month):
    return _nth_weekday(year, month, 4, 1)


def _third_friday(year, month):
    return _nth_weekday(year, month, 4, 3)


def upcoming_macro_events(days_ahead=45, today=None):
    """All macro events within the window, sorted by date."""
    if today is None:
        # US calendar: bucket against the ET date, not the machine's IST
        # date — otherwise the FOMC decision "expires" 9.5h early.
        from signals import market_today
        today = market_today()
    horizon = today + timedelta(days=days_ahead)
    events = []

    for iso in FOMC_DECISION_DAYS:
        d = date.fromisoformat(iso)
        if today <= d <= horizon:
            events.append({"date": iso, "event_type": "fomc",
                           "label": "FOMC rate decision"})
    for iso in CPI_RELEASE_DAYS:
        d = date.fromisoformat(iso)
        if today <= d <= horizon:
            events.append({"date": iso, "event_type": "cpi",
                           "label": "US CPI release"})

    # Rule-derived events across the months the window touches.
    seen_months = set()
    cursor = today
    while cursor <= horizon:
        key = (cursor.year, cursor.month)
        if key not in seen_months:
            seen_months.add(key)
            nfp = _first_friday(*key)
            if today <= nfp <= horizon:
                events.append({"date": nfp.isoformat(), "event_type": "nfp",
                               "label": "US Nonfarm Payrolls"})
            opex = _third_friday(*key)
            if today <= opex <= horizon:
                quarterly = cursor.month in (3, 6, 9, 12)
                events.append({
                    "date": opex.isoformat(), "event_type": "opex",
                    "label": "Quad-witching OPEX" if quarterly else "Monthly OPEX",
                })
        # advance to the 1st of the next month
        cursor = (cursor.replace(day=28) + timedelta(days=4)).replace(day=1)

    events.sort(key=lambda e: e["date"])
    return events
