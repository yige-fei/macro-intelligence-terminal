"""Security and fail-closed tests for terminal_demo.serve, using real server processes on loopback test ports.

The docroot and data directory are temporary copies, so these tests need neither a frontend build nor network access.
Run: python3 -m unittest discover -s tests"""

import hashlib
import http.client
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

from terminal_demo import generate

REPO = Path(__file__).resolve().parent.parent


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def request(port, path, method="GET", host="127.0.0.1"):
    c = http.client.HTTPConnection(host, port, timeout=5)
    c.putrequest(method, path, skip_accept_encoding=True)  # path sent exactly as given
    c.endheaders()
    r = c.getresponse()
    body = r.read()
    c.close()
    return r.status, dict((k.lower(), v) for k, v in r.getheaders()), body


def write_data(d: Path, files: dict, allow: dict | None = None):
    d.mkdir(parents=True, exist_ok=True)
    for n, b in files.items():
        (d / n).write_bytes(b)
    if allow is None:
        allow = {n: hashlib.sha256(b).hexdigest() for n, b in files.items()}
    (d / "ALLOWLIST.json").write_text(json.dumps({"version": 1, "files": allow}))


class Fixture:
    def __init__(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="mit-server-test-"))
        self.docroot = self.tmp / "docroot"
        (self.docroot / "intel").mkdir(parents=True)
        (self.docroot / "index.html").write_text("<!doctype html><title>demo</title>")
        (self.docroot / "intel" / "release_desk.v1.json").write_text("{}")
        self.secret = self.tmp / "outside-secret.txt"
        self.secret.write_text("OUTSIDE-THE-DOCROOT")
        g = generate.build()
        self.files = {n: g[n] for n in ("etf_prices.json", "research.json", "manifest.json")}
        self.data = self.tmp / "data"
        write_data(self.data, self.files)

    def start(self, data=None, docroot=None, port=None):
        port = port or free_port()
        p = subprocess.Popen([sys.executable, "-B", "-m", "terminal_demo.serve", "--port", str(port),
                              "--docroot", str(docroot or self.docroot), "--data-dir", str(data or self.data)],
                             cwd=REPO, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        for _ in range(50):
            if p.poll() is not None:
                return p, port
            try:
                with socket.create_connection(("127.0.0.1", port), timeout=0.2):
                    return p, port
            except OSError:
                time.sleep(0.1)
        return p, port

    def close(self):
        shutil.rmtree(self.tmp, ignore_errors=True)


class Serving(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.f = Fixture()
        (cls.f.docroot / "escape").symlink_to(cls.f.secret)
        (cls.f.docroot / "etcdir").symlink_to("/etc")
        cls.proc, cls.port = cls.f.start()

    @classmethod
    def tearDownClass(cls):
        cls.proc.terminate()
        cls.proc.wait(5)
        cls.f.close()

    def test_01_allowlisted_files_exact_bytes_and_headers(self):
        for name, body in self.f.files.items():
            st, h, b = request(self.port, f"/data/{name}")
            self.assertEqual((st, b), (200, body), name)
            self.assertEqual(h["content-type"], "application/json")
            self.assertEqual(h["cache-control"], "no-store")
            self.assertEqual(h["x-content-type-options"], "nosniff")
            st, h, b = request(self.port, f"/data/{name}", "HEAD")
            self.assertEqual((st, b), (200, b""))

    def test_02_everything_else_under_data_refused(self):
        for path in ["/data/macro_series.json", "/data/ALLOWLIST.json", "/data/", "/data", "/DATA/etf_prices.json",
                     "/data/%65tf_prices.json", "/data/etf_prices.json%00", "//data/macro_series.json", "///data/ALLOWLIST.json", "/./data/etf_prices.json",
                     "/intel/../data/etf_prices.json", "/intel/%2e%2e/data/etf_prices.json", "/data%2fetf_prices.json",
                     "/data\\etf_prices.json", "/x/data/etf_prices.json", "/data/../index.html"]:
            st, _, _ = request(self.port, path)
            self.assertEqual(st, 404, path)

    def test_02b_leading_slashes_reach_only_the_same_allowlisted_file(self):
        # Python's http.server collapses leading "//" to "/" before routing, so this is the allowlisted resource itself.
        st, _, b = request(self.port, "//data/etf_prices.json")
        self.assertEqual((st, b), (200, self.f.files["etf_prices.json"]))

    def test_03_no_escape_from_docroot(self):
        for path in ["/escape", "/etcdir/hosts", "/../../etc/hosts", "/%2e%2e/%2e%2e/etc/hosts", "/..%2f..%2fetc/hosts"]:
            st, _, b = request(self.port, path)
            self.assertEqual(st, 404, path)
            self.assertNotIn(b"OUTSIDE-THE-DOCROOT", b)

    def test_04_no_directory_listings(self):
        for path in ["/intel/", "/intel", "/etcdir/"]:
            self.assertEqual(request(self.port, path)[0], 404, path)
        self.assertEqual(request(self.port, "/")[0], 200)  # index.html
        self.assertEqual(request(self.port, "/intel/release_desk.v1.json")[0], 200)

    def test_05_only_get_and_head(self):
        for m in ("POST", "PUT", "DELETE", "OPTIONS", "PATCH"):
            self.assertGreaterEqual(request(self.port, "/data/etf_prices.json", m)[0], 400, m)

    def test_06_no_paths_leaked(self):
        for path in ["/missing", "/data/macro_series.json", "/escape"]:
            _, _, b = request(self.port, path)
            self.assertNotIn(str(self.f.tmp).encode(), b)
            self.assertNotIn(b"/Users/", b)
            self.assertNotIn(b"/home/", b)

    def test_07_loopback_only(self):
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
                s.connect(("192.0.2.1", 9))  # UDP connect sends nothing; it only selects the outbound interface
                addr = s.getsockname()[0]
        except OSError:
            self.skipTest("no non-loopback interface")
        if addr.startswith("127."):
            self.skipTest("no non-loopback interface")
        with self.assertRaises(OSError):
            socket.create_connection((addr, self.port), timeout=1).close()


class FailClosed(unittest.TestCase):
    """Every unsafe configuration stops the server before it listens."""

    def setUp(self):
        self.f = Fixture()

    def tearDown(self):
        self.f.close()

    def refused(self, code=3, **kw):
        p, port = self.f.start(**kw)
        try:
            out, _ = p.communicate(timeout=10)
        except subprocess.TimeoutExpired:
            p.kill()
            self.fail("server started although it should have refused")
        self.assertEqual(p.returncode, code, out)
        with self.assertRaises(OSError):
            socket.create_connection(("127.0.0.1", port), timeout=0.5).close()
        self.assertIn("refused", out)
        self.assertNotIn(str(self.f.tmp), out)  # no filesystem paths in the message
        return out

    def data_with(self, files=None, allow=None):
        d = self.f.tmp / "variant"
        write_data(d, files if files is not None else dict(self.f.files), allow)
        return d

    def test_missing_data_dir(self):
        self.refused(data=self.f.tmp / "nope")

    def test_missing_allowlist(self):
        (self.f.data / "ALLOWLIST.json").unlink()
        self.refused()

    def test_allowlist_not_json(self):
        (self.f.data / "ALLOWLIST.json").write_text("{not json")
        self.refused()

    def test_allowlist_symlink(self):
        real = self.f.tmp / "allow-elsewhere.json"
        (self.f.data / "ALLOWLIST.json").rename(real)
        (self.f.data / "ALLOWLIST.json").symlink_to(real)
        self.refused()

    def test_traversal_names(self):
        for bad in ("../outside-secret.txt", "/etc/hosts", "sub/etf_prices.json", "..", "ETF_PRICES.JSON"):
            with self.subTest(bad=bad):
                self.refused(data=self.data_with(allow={bad: "0" * 64}))

    def test_unknown_file_name(self):
        files = dict(self.f.files, **{"macro_series.json": b"{}"})
        self.refused(data=self.data_with(files))

    def test_bad_hash_format(self):
        self.refused(data=self.data_with(allow={"etf_prices.json": "abc"}))

    def test_hash_mismatch(self):
        allow = {n: hashlib.sha256(b).hexdigest() for n, b in self.f.files.items()}
        d = self.data_with(allow=allow)
        (d / "research.json").write_bytes(self.f.files["research.json"].replace(b"Model A", b"Model Z"))
        self.refused(data=d)

    def test_listed_file_missing(self):
        d = self.data_with()
        (d / "manifest.json").unlink()
        self.refused(data=d)

    def test_symlinked_data_file(self):
        d = self.data_with()
        real = self.f.tmp / "etf-elsewhere.json"
        (d / "etf_prices.json").rename(real)
        (d / "etf_prices.json").symlink_to(real)
        self.refused(data=d)

    def test_malformed_json(self):
        self.refused(data=self.data_with(dict(self.f.files, **{"manifest.json": b"{"})))

    def test_invalid_ohlc_with_matching_hash(self):
        etf = json.loads(self.f.files["etf_prices.json"])
        c = etf["candles"]["DEMO-B"][100]
        c["high"] = c["low"] - 1
        self.assertIn("high/low", self.refused(data=self.data_with(dict(self.f.files, **{"etf_prices.json": json.dumps(etf).encode()}))))

    def test_invalid_timestamp_with_matching_hash(self):
        etf = json.loads(self.f.files["etf_prices.json"])
        etf["candles"]["DEMO-C"][50]["time"] += 1
        self.refused(data=self.data_with(dict(self.f.files, **{"etf_prices.json": json.dumps(etf).encode()})))

    def test_unmarked_research_with_matching_hash(self):
        r = json.loads(self.f.files["research.json"])
        del r["synthetic"]
        self.assertIn("synthetic", self.refused(data=self.data_with(dict(self.f.files, **{"research.json": json.dumps(r).encode()}))))

    def test_docroot_not_built(self):
        empty = self.f.tmp / "empty-docroot"
        empty.mkdir()
        self.assertIn("npm run build", self.refused(code=2, docroot=empty))

    def test_docroot_with_data_dir(self):
        (self.f.docroot / "data").mkdir()
        self.refused(code=2)

    def test_port_in_use(self):
        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            s.listen()
            p, _ = self.f.start(port=s.getsockname()[1])
            out, _ = p.communicate(timeout=10)
            self.assertEqual(p.returncode, 4, out)


class RepositoryData(unittest.TestCase):
    def test_default_data_dir_is_valid(self):
        from terminal_demo.serve import load_allowlisted, DEFAULT_DATA_DIR
        self.assertEqual(set(load_allowlisted(DEFAULT_DATA_DIR)), {"/data/etf_prices.json", "/data/research.json", "/data/manifest.json"})
        self.assertEqual(DEFAULT_DATA_DIR, REPO / "demo-data")


if __name__ == "__main__":
    unittest.main()
