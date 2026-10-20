"""Generator and validator tests: determinism, independence from any input file, record validity and rejection of
malformed demo data. Run: python3 -m unittest discover -s tests"""

import builtins
import copy
import json
import math
import pathlib
import re
import unittest
from datetime import date
from unittest import mock

from terminal_demo import generate
from terminal_demo.validate import Invalid, utc_midnight, validate_etf, validate_manifest, validate_research

REPO = pathlib.Path(__file__).resolve().parent.parent


def demo():
    files = generate.build()
    return {k: json.loads(v) for k, v in files.items()}


class Determinism(unittest.TestCase):
    def test_same_seed_same_bytes(self):
        self.assertEqual(generate.build(), generate.build())

    def test_committed_demo_data_equals_generator(self):
        for name, body in generate.build().items():
            self.assertEqual((REPO / "demo-data" / name).read_bytes(), body, name)

    def test_other_seed_differs(self):
        self.assertNotEqual(generate.build(1)["etf_prices.json"], generate.build()["etf_prices.json"])

    def test_build_reads_no_files(self):
        def refuse(*a, **k):
            raise AssertionError("the generator must not read any file")
        with mock.patch.object(builtins, "open", refuse), mock.patch.object(pathlib.Path, "read_bytes", refuse), \
                mock.patch.object(pathlib.Path, "read_text", refuse):
            generate.build()


class Records(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.d = demo()

    def test_validators_accept_generated_files(self):
        validate_etf(self.d["etf_prices.json"])
        validate_research(self.d["research.json"])
        validate_manifest(self.d["manifest.json"])

    def test_instruments_match_frontend_list(self):
        src = (REPO / "web" / "lib" / "symbol.ts").read_text()
        listed = re.search(r"SYMBOLS = \[([^\]]*)\]", src).group(1)
        self.assertEqual(re.findall(r'"([^"]+)"', listed), self.d["etf_prices.json"]["symbols"])
        self.assertTrue(all(s.startswith("DEMO-") for s in self.d["etf_prices.json"]["symbols"]))

    def test_bars_are_well_formed(self):
        etf = self.d["etf_prices.json"]
        for sym, rows in etf["candles"].items():
            self.assertEqual(len(rows), 2085, sym)  # Mon-Fri, 2016-01-04 .. 2023-12-29
            for prev, c in zip([None] + rows[:-1], rows):
                d = date.fromisoformat(c["date"])
                self.assertLess(d.weekday(), 5)
                self.assertEqual(c["time"], utc_midnight(d))
                if prev:
                    self.assertGreater(c["time"], prev["time"])
                self.assertLessEqual(c["low"], min(c["open"], c["close"]))
                self.assertGreaterEqual(c["high"], max(c["open"], c["close"]))
                self.assertGreater(c["low"], 0)
                self.assertIsInstance(c["volume"], int)
                self.assertGreaterEqual(c["volume"], 0)
                self.assertEqual(c["adjClose"], c["close"])
                self.assertTrue(all(math.isfinite(c[k]) for k in ("open", "high", "low", "close")))

    def test_every_file_is_marked(self):
        for name in ("etf_prices.json", "research.json", "manifest.json"):
            self.assertIs(self.d[name]["synthetic"], True, name)
            self.assertIn("generator", self.d[name])
        self.assertIs(self.d["research.json"]["illustrative"], True)
        self.assertIn("SIMULATED", self.d["etf_prices.json"]["source"])

    def test_research_carries_no_study_identifiers(self):
        text = json.dumps(self.d["research.json"]) + json.dumps(self.d["manifest.json"])
        for marker in ("C5C", "C5c", "NO_EDGE", "Target_Up_Open", "P1E"):
            self.assertNotIn(marker, text)

    def test_allowlist_hashes_match(self):
        import hashlib
        files = generate.build()
        allow = json.loads(files["ALLOWLIST.json"])["files"]
        self.assertEqual(set(allow), {"etf_prices.json", "research.json", "manifest.json"})
        for name, sha in allow.items():
            self.assertEqual(hashlib.sha256(files[name]).hexdigest(), sha)


class Rejection(unittest.TestCase):
    """Malformed OHLCV records, timestamps and markers are refused."""

    @classmethod
    def setUpClass(cls):
        cls.etf = demo()["etf_prices.json"]
        cls.research = demo()["research.json"]

    def bad_etf(self, mutate):
        e = copy.deepcopy(self.etf)
        mutate(e)
        with self.assertRaises(Invalid):
            validate_etf(e)

    def c(self, e, i=10, sym="DEMO-A"):
        return e["candles"][sym][i]

    def test_high_below_low(self):
        self.bad_etf(lambda e: self.c(e).update(high=self.c(e)["low"] - 1))

    def test_high_below_close(self):
        self.bad_etf(lambda e: self.c(e).update(close=self.c(e)["high"] + 0.5))

    def test_low_above_open(self):
        self.bad_etf(lambda e: self.c(e).update(open=self.c(e)["low"] - 0.5))

    def test_non_positive_price(self):
        self.bad_etf(lambda e: self.c(e).update(low=0))

    def test_non_finite_price(self):
        self.bad_etf(lambda e: self.c(e).update(close=float("nan")))

    def test_negative_volume(self):
        self.bad_etf(lambda e: self.c(e).update(volume=-1))

    def test_fractional_volume(self):
        self.bad_etf(lambda e: self.c(e).update(volume=1.5))

    def test_impossible_date(self):
        self.bad_etf(lambda e: self.c(e).update(date="2023-02-30"))

    def test_unparseable_date(self):
        self.bad_etf(lambda e: self.c(e).update(date="20230105"))

    def test_time_not_matching_date(self):
        self.bad_etf(lambda e: self.c(e).update(time=self.c(e)["time"] + 3600))

    def test_out_of_order(self):
        def swap(e):
            rows = e["candles"]["DEMO-A"]
            rows[5], rows[6] = rows[6], rows[5]
        self.bad_etf(swap)

    def test_duplicate_bar(self):
        self.bad_etf(lambda e: e["candles"]["DEMO-A"].insert(6, copy.deepcopy(e["candles"]["DEMO-A"][5])))

    def test_after_bound(self):
        self.bad_etf(lambda e: e.update(bound="2020-01-01"))

    def test_missing_field(self):
        self.bad_etf(lambda e: self.c(e).pop("volume"))

    def test_symbols_and_candles_disagree(self):
        self.bad_etf(lambda e: e["candles"].pop("DEMO-D"))

    def test_not_marked_synthetic(self):
        self.bad_etf(lambda e: e.pop("synthetic"))

    def test_real_ticker_shape_still_needs_marker(self):
        self.bad_etf(lambda e: e.update(synthetic=False))

    def test_research_without_illustrative_marker(self):
        r = copy.deepcopy(self.research)
        r.pop("illustrative")
        with self.assertRaises(Invalid):
            validate_research(r)

    def test_research_auc_out_of_range(self):
        r = copy.deepcopy(self.research)
        r["results"]["illustrative_1d"]["per_algorithm"]["Model A"]["auc_market_only"] = 1.2
        with self.assertRaises(Invalid):
            validate_research(r)

    def test_research_reversed_interval(self):
        r = copy.deepcopy(self.research)
        r["results"]["illustrative_1d"]["interval"] = [0.1, -0.1]
        with self.assertRaises(Invalid):
            validate_research(r)

    def test_empty_instrument_is_valid(self):
        e = copy.deepcopy(self.etf)
        e["candles"]["DEMO-D"] = []
        validate_etf(e)  # an empty series is well-formed; the frontend shows its empty state


if __name__ == "__main__":
    unittest.main()
