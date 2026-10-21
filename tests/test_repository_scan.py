"""Repository content scan: what is tracked (or, outside Git, present) must contain no personal paths, contact
addresses, credentials, nested Git metadata, third-party market data or market-data provider endpoints.
Run: python3 -m unittest discover -s tests"""

import json
import re
import subprocess
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SKIP_DIRS = {".git", "node_modules", ".next", "out", "__pycache__"}

# Patterns are assembled at run time so that this file does not match itself.
HOME_PATH = re.compile("/" + "Users/[A-Za-z0-9._-]+|/" + "home/[a-z0-9._-]+/|[A-Za-z]:\\\\" + "Users\\\\")
EMAIL = re.compile(r"[A-Za-z0-9._%+-]+" + "@" + r"[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
PROVIDER_HOSTS = re.compile("|".join(re.escape(h) for h in (
    "finance." + "yahoo.com", "query1.finance." + "yahoo", "query2.finance." + "yahoo", "api.stlouisfed" + ".org",
    "fred.stlouisfed" + ".org", "alfred.stlouisfed" + ".org", "cboe" + ".com", "api.tiingo" + ".com")))
KEY_ASSIGN = re.compile(r"(?i)(api[_-]?key|secret|token|password)\s*[:=]\s*['\"][A-Za-z0-9_\-]{16,}['\"]")
ALLOWED_EMAILS = set()  # none: the repository names no contact address
DOC_SUFFIXES = {".md"}


def tracked_files():
    try:
        out = subprocess.run(["git", "ls-files", "-z"], cwd=REPO, capture_output=True, check=True).stdout
        files = [REPO / p for p in out.decode().split("\0") if p]
        if files:
            return files
    except (OSError, subprocess.CalledProcessError):
        pass
    return [p for p in REPO.rglob("*") if p.is_file() and not (set(p.relative_to(REPO).parts) & SKIP_DIRS)]


class Scan(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.files = tracked_files()
        cls.text = {}
        for p in cls.files:
            try:
                cls.text[p] = p.read_text(encoding="utf-8")
            except UnicodeDecodeError:
                cls.text[p] = None

    def rel(self, p):
        return p.relative_to(REPO).as_posix()

    def test_no_personal_paths(self):
        hits = [self.rel(p) for p, t in self.text.items() if t and HOME_PATH.search(t)]
        self.assertEqual(hits, [])

    def test_no_email_addresses(self):
        hits = [(self.rel(p), m) for p, t in self.text.items() if t for m in EMAIL.findall(t) if m not in ALLOWED_EMAILS]
        self.assertEqual(hits, [])

    def test_no_credentials_or_env_files(self):
        names = [self.rel(p) for p in self.files if p.name.startswith(".env") or p.suffix in {".pem", ".key", ".p12"}]
        self.assertEqual(names, [])
        hits = [self.rel(p) for p, t in self.text.items() if t and KEY_ASSIGN.search(t)]
        self.assertEqual(hits, [])

    def test_no_nested_git_metadata(self):
        nested = [self.rel(p) for p in REPO.rglob(".git") if p != REPO / ".git" and "node_modules" not in p.parts]
        self.assertEqual(nested, [])

    def test_no_binary_or_oversized_files(self):
        self.assertEqual([self.rel(p) for p, t in self.text.items() if t is None], [])
        big = [self.rel(p) for p in self.files if p.stat().st_size > 2_000_000]
        self.assertEqual(big, [])

    def test_no_market_data_provider_endpoints_in_code(self):
        hits = [self.rel(p) for p, t in self.text.items() if t and p.suffix not in DOC_SUFFIXES and PROVIDER_HOSTS.search(t)]
        self.assertEqual(hits, [])

    def test_only_generated_market_data(self):
        data_like = [p for p in self.files if p.suffix == ".json" and re.search(r"(etf|price|macro|series|vix|fred|alfred)", p.name, re.I)]
        # OS-P2A added the second generated price file (event overlay).
        self.assertEqual(sorted(self.rel(p) for p in data_like), ["demo-data/etf_prices.json", "demo-data/event_overlay_prices.json"])
        for name in ("etf_prices.json", "event_overlay_prices.json"):
            etf = json.loads((REPO / "demo-data" / name).read_text())
            self.assertIs(etf["synthetic"], True, name)
            self.assertTrue(all(s.startswith("DEMO-") for s in etf["symbols"]), name)

    def test_every_served_data_file_is_marked(self):
        for p in sorted((REPO / "demo-data").glob("*.json")):
            if p.name != "ALLOWLIST.json":
                self.assertIs(json.loads(p.read_text())["synthetic"], True, p.name)

    def test_release_desk_export_links_only_official_pages(self):
        d = json.loads((REPO / "web" / "public" / "intel" / "release_desk.v1.json").read_text())
        self.assertEqual(d["values_policy"], "NO_ECONOMIC_VALUES")
        self.assertEqual(len(d["events"]), 38)
        hosts = set(re.findall(r"https?://([^/\"]+)", json.dumps(d)))
        self.assertEqual(hosts, {"www.bls.gov", "www.bea.gov"})


if __name__ == "__main__":
    unittest.main()
