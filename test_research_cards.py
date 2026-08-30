"""Live-desk filter: invalidated / ticker-mismatch no_trade are not the book."""
import unittest

from research import _is_live_desk


class TestLiveDesk(unittest.TestCase):
    def test_invalidated_is_not_live(self):
        self.assertFalse(_is_live_desk({
            "asset": "xyz:BE", "state": "invalidated",
            "thesis": "invalidated: short stop 205.9 vs mark 217.92",
        }))

    def test_ticker_mismatch_no_trade_is_not_live(self):
        self.assertFalse(_is_live_desk({
            "asset": "ostium:GOOG", "state": "no_trade",
            "thesis": "thesis admits ticker mismatch",
            "why_not": "ticker mismatch: headline is about MRVL, not GOOG",
        }))

    def test_watch_stays(self):
        self.assertTrue(_is_live_desk({
            "asset": "xyz:NVDA", "state": "watch",
            "thesis": "Nvidia's fundamental strength is confirmed by earnings beats",
        }))

    def test_setup_forming_stays(self):
        self.assertTrue(_is_live_desk({
            "asset": "xyz:META", "state": "setup_forming", "thesis": "settlement",
        }))


if __name__ == "__main__":
    unittest.main()
