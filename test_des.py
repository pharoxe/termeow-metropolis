#!/usr/bin/env python3
"""DES: citations, hash cache, fail-closed LLM filter. No ollama required."""
import os
import sys
import time
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import des
from cache import CACHE


def _bundle(**kw):
    b = {
        "coin": "xyz:NVDA",
        "base": "NVDA",
        "last": {"value": 220.83, "interval": "1h", "field": "candles.c",
                 "display": "220.83"},
        "funding": None,
        "lean": None,
        "event": None,
        "headlines": [
            {"headline": "Nvidia Beats Again",
             "url": "https://finnhub.io/api/news?id=abc",
             "published_at": "2026-08-28T09:31:48+00:00",
             "field": "https://finnhub.io/api/news?id=abc"},
        ],
    }
    b.update(kw)
    return b


class TestHash(unittest.TestCase):
    def test_stable(self):
        a, b = _bundle(), _bundle()
        self.assertEqual(des.hash_bundle(a), des.hash_bundle(b))

    def test_headline_url_busts(self):
        a = _bundle()
        b = _bundle(headlines=[{
            "headline": "Nvidia Beats Again",
            "url": "https://finnhub.io/api/news?id=OTHER",
            "published_at": "2026-08-28T09:31:48+00:00",
        }])
        self.assertNotEqual(des.hash_bundle(a), des.hash_bundle(b))

    def test_tiny_last_wiggle_same_round(self):
        a = _bundle(last={"value": 220.831, "interval": "1h", "field": "candles.c",
                          "display": "220.83"})
        b = _bundle(last={"value": 220.834, "interval": "1h", "field": "candles.c",
                          "display": "220.83"})
        self.assertEqual(des.hash_bundle(a), des.hash_bundle(b))

    def test_material_last_busts(self):
        a = _bundle()
        b = _bundle(last={"value": 221.50, "interval": "1h", "field": "candles.c",
                          "display": "221.50"})
        self.assertNotEqual(des.hash_bundle(a), des.hash_bundle(b))


class TestCiteLines(unittest.TestCase):
    def test_nvda_tape_and_headline(self):
        lines = des.cite_lines(_bundle())
        self.assertTrue(any(x["k"] == "TAPE" and x["cite"] == "candles.c" for x in lines))
        self.assertTrue(any(x["k"] == "HEADLINE" and x["href"] for x in lines))
        self.assertLessEqual(len(lines), 4)

    def test_btc_no_fake_headlines(self):
        b = _bundle(coin="BTC", base="BTC", headlines=[],
                    funding={"hourly": 1e-5, "pct_8h": 0.008, "field": "universe.funding",
                             "display": "+0.0080%"},
                    lean={"kind": "whales", "pct_long": 72, "field": "whaleCoin.long_ntl",
                          "fields": ["whaleCoin.long_ntl", "whaleCoin.short_ntl"],
                          "display": "whales 72% long · $478.6M / $189.6M"})
        lines = des.cite_lines(b)
        self.assertTrue(any(x["k"] == "TAPE" for x in lines))
        self.assertTrue(any(x["k"] == "LEAN" for x in lines))
        self.assertFalse(any(x["k"] == "HEADLINE" for x in lines))
        self.assertNotIn("https://", " ".join(x.get("href") or "" for x in lines))

    def test_each_line_cites(self):
        lines = des.cite_lines(_bundle())
        for ln in lines:
            self.assertTrue(ln.get("cite"))


class TestFilter(unittest.TestCase):
    def test_drops_uncited(self):
        raw = [
            {"text": "Last 220.83.", "cite": "candles.c"},
            {"text": "A whale dumped.", "cite": "invented.field"},
        ]
        out = des.filter_llm_lines(raw, _bundle())
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["cite"], "candles.c")

    def test_drops_causation(self):
        raw = [{"text": "Last 220.83 because guidance.", "cite": "candles.c"}]
        self.assertEqual(des.filter_llm_lines(raw, _bundle()), [])

    def test_max_four(self):
        url = "https://finnhub.io/api/news?id=abc"
        raw = [{"text": "x %d" % i, "cite": "candles.c"} for i in range(6)]
        raw[1]["cite"] = url
        out = des.filter_llm_lines(raw, _bundle())
        self.assertLessEqual(len(out), 4)

    def test_keeps_headline_url(self):
        url = "https://finnhub.io/api/news?id=abc"
        raw = [{"text": "Hugging Face bid reported.", "cite": url}]
        out = des.filter_llm_lines(raw, _bundle())
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["href"], url)

    def test_btc_cannot_cite_fake_url(self):
        b = _bundle(coin="BTC", base="BTC", headlines=[])
        raw = [{"text": "ETF inflows hit $1B.", "cite": "https://example.com/fake"}]
        self.assertEqual(des.filter_llm_lines(raw, b), [])
        self.assertNotIn("https://example.com/fake", des.allowed_cites(b))


class TestApiCache(unittest.TestCase):
    def setUp(self):
        des.reset_cache()

    def test_ollama_down_cites_and_fail_note(self):
        b = _bundle()
        with mock.patch.object(des, "gather_bundle", return_value=b), \
             mock.patch.object(des, "synthesize", side_effect=OSError("down")):
            first = des.api_des({"coin": ["xyz:NVDA"]})
            self.assertEqual(first["status"], "pending")
            self.assertEqual(first["mode"], "cites")
            self.assertTrue(any(x["k"] == "TAPE" for x in first["cites"]))
            # let the background thread land
            for _ in range(50):
                time.sleep(0.02)
                rec = des.api_des({"coin": ["xyz:NVDA"]})
                if rec["status"] != "pending":
                    break
            self.assertEqual(rec["status"], "fail")
            self.assertEqual(rec["mode"], "cites")
            self.assertIn("DES failed", rec["fail"] or "")
            self.assertTrue(rec["cached"])
            self.assertTrue(any(x["k"] == "HEADLINE" for x in rec["cites"]))

    def test_same_hash_does_not_relaunch(self):
        b = _bundle()
        calls = []

        def slow_synth(bundle):
            calls.append(1)
            time.sleep(0.05)
            return [{"text": "Last 220.83 on the 1h series.", "cite": "candles.c"}]

        with mock.patch.object(des, "gather_bundle", return_value=b), \
             mock.patch.object(des, "synthesize", side_effect=slow_synth):
            a = des.api_des({"coin": ["xyz:NVDA"]})
            b2 = des.api_des({"coin": ["xyz:NVDA"]})
            self.assertEqual(a["hash"], b2["hash"])
            self.assertEqual(a["status"], "pending")
            self.assertEqual(b2["status"], "pending")
            for _ in range(80):
                time.sleep(0.02)
                rec = des.api_des({"coin": ["xyz:NVDA"]})
                if rec["status"] == "llm":
                    break
            self.assertEqual(rec["status"], "llm")
            self.assertEqual(len(calls), 1)
            # cached hit
            again = des.api_des({"coin": ["xyz:NVDA"]})
            self.assertTrue(again["cached"])
            self.assertEqual(len(calls), 1)


class TestPrompt(unittest.TestCase):
    def test_band_is_not_spread(self):
        p = des.SYSTEM_PROMPT.lower()
        self.assertIn("spread", p)
        self.assertIn("band", p)
        self.assertIn("25", p)
        self.assertIn("bid/ask", p.replace(" ", ""))

    def test_1h_close_in_cite(self):
        tape = [x for x in des.cite_lines(_bundle()) if x["k"] == "TAPE"][0]
        self.assertIn("1h close", tape["v"])


class TestGatherNoFetch(unittest.TestCase):
    def test_uses_cached_candles_only(self):
        CACHE.set("candles:xyz:NVDA:1h", [
            {"t": 1, "o": 1, "h": 1, "l": 1, "c": 220.83, "v": 1},
        ], 60)
        last = des._cached_candles("xyz:NVDA")
        self.assertEqual(last["value"], 220.83)
        self.assertEqual(last["field"], "candles.c")
        self.assertEqual(last["interval"], "1h")
        self.assertIsNone(des._cached_candles("NO-SUCH-COIN"))

    def test_prefers_1m_over_1h(self):
        CACHE.set("candles:BTC:1h", [
            {"t": 1, "o": 1, "h": 1, "l": 1, "c": 100, "v": 1},
        ], 60)
        CACHE.set("candles:BTC:1m", [
            {"t": 2, "o": 1, "h": 1, "l": 1, "c": 111, "v": 1},
        ], 60)
        last = des._cached_candles("BTC")
        self.assertEqual(last["value"], 111)
        self.assertEqual(last["interval"], "1m")

    def test_prefers_book_mid_over_1h(self):
        CACHE.set("candles:AAA:1h", [
            {"t": 1, "o": 1, "h": 1, "l": 1, "c": 100, "v": 1},
        ], 60)
        CACHE.set("book:AAA:4", {
            "levels": [[{"px": "110", "sz": "1"}], [{"px": "112", "sz": "1"}]],
        }, 60)
        last = des._cached_candles("AAA")
        self.assertEqual(last["value"], 111.0)
        self.assertEqual(last["field"], "book.mid")


if __name__ == "__main__":
    unittest.main()
