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
from terminal_demo.validate import Invalid, utc_midnight, validate_etf, validate_manifest, validate_overlay, validate_research

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
        # OS-P2A added the event-overlay file to the served set.
        self.assertEqual(set(allow), {"etf_prices.json", "event_overlay_prices.json", "research.json", "manifest.json"})
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


class Overlay(unittest.TestCase):
    """OS-P2A: the event-overlay dataset is separate, ends at the release-desk snapshot and leaves OS-P1 data unchanged."""

    # SHA-256 of the OS-P1 accepted files (tag os-p1-accepted, commit c04264dd); these bytes must never change.
    OS_P1 = {"etf_prices.json": "f14ce1aa783eba66e21a8d81798e47da350c6332ce1839a3471b7bfd2af54e5c",
             "research.json": "d84abb864ac55bfabed478925fecd63f26684b1cb2fddf06ca2d960a59147fb9"}

    @classmethod
    def setUpClass(cls):
        cls.files = generate.build()
        cls.o = json.loads(cls.files["event_overlay_prices.json"])
        cls.desk = json.loads((REPO / "web" / "public" / "intel" / "release_desk.v1.json").read_text())

    def test_os_p1_files_unchanged(self):
        import hashlib
        for name, sha in self.OS_P1.items():
            self.assertEqual(hashlib.sha256(self.files[name]).hexdigest(), sha, name)

    def test_datasets_are_independent(self):
        self.assertEqual(generate.build(overlay_seed=1)["etf_prices.json"], self.files["etf_prices.json"])
        self.assertEqual(generate.build(seed=1)["event_overlay_prices.json"], self.files["event_overlay_prices.json"])

    def test_calendar_ends_at_snapshot(self):
        self.assertEqual(self.o["event_snapshot"], "2026-10-17")  # a Saturday
        self.assertEqual(self.desk["as_of_utc"][:10], self.o["event_snapshot"])
        for sym, rows in self.o["candles"].items():
            self.assertEqual(rows[0]["date"], "2025-01-02", sym)
            self.assertEqual(rows[-1]["date"], "2026-10-16", sym)  # last weekday on or before the snapshot
            self.assertEqual(len(rows), 467, sym)
            self.assertFalse([c for c in rows if c["date"] > "2026-10-17"], sym)
        self.assertEqual(self.o["bound"], "2026-10-16")
        self.assertEqual(self.o["symbols"], json.loads(self.files["etf_prices.json"])["symbols"])
        validate_overlay(self.o)

    def test_every_due_event_has_a_bar(self):
        """Independent data-level check of the alignment contract (the frontend applies the same rules)."""
        dates = {c["date"] for c in self.o["candles"]["DEMO-A"]}
        due, later = [], 0
        for e in self.desk["events"]:
            st = e["publication"]["status"]
            if st == "CONFIRMED":
                due.append((e["event_id"], "confirmed", e["publication"]["official_release_time"]["local_date"]))
            elif st == "DUE_UNCONFIRMED":
                due.append((e["event_id"], "unconfirmed", e["schedule"]["current"]["local_date"]))
            else:
                self.assertEqual(st, "NOT_YET_DUE")
                self.assertGreater(e["schedule"]["current"]["local_date"], self.o["event_snapshot"])
                later += 1
        self.assertEqual(sorted(due, key=lambda x: x[2]), [
            ("BEA.GDP.ADVANCE.2025-Q4", "unconfirmed", "2026-02-20"), ("BEA.GDP.ADVANCE.2026-Q1", "unconfirmed", "2026-04-30"),
            ("BEA.GDP.ADVANCE.2026-Q2", "unconfirmed", "2026-07-30"), ("BLS.EMPSIT.2026-09", "confirmed", "2026-10-02"),
            ("BLS.CPI.2026-09", "confirmed", "2026-10-14")])
        self.assertEqual(later, 33)
        self.assertTrue(all(d in dates for _, _, d in due))

    def bad(self, mutate):
        o = copy.deepcopy(self.o)
        mutate(o)
        with self.assertRaises(Invalid):
            validate_overlay(o)

    def test_rejects_bars_after_snapshot(self):
        def late(o):
            o["bound"] = "2026-10-20"
            c = copy.deepcopy(o["candles"]["DEMO-A"][-1])
            c.update(date="2026-10-19", time=utc_midnight(date(2026, 10, 19)))
            o["candles"]["DEMO-A"].append(c)
        self.bad(late)

    def test_rejects_missing_markers(self):
        self.bad(lambda o: o.pop("overlay"))
        self.bad(lambda o: o.pop("event_snapshot"))
        self.bad(lambda o: o.update(event_snapshot="17/10/2026"))
        self.bad(lambda o: o.pop("synthetic"))


if __name__ == "__main__":
    unittest.main()
