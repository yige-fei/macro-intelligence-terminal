"""Serve the built frontend and the demo data on the loopback interface (Python standard library only).

    python3 -m terminal_demo.serve                    # http://127.0.0.1:8800/   (stop with Ctrl-C)
    python3 -m terminal_demo.serve --port 8811 --docroot web/out --data-dir demo-data

Adapted from the project's earlier research-only launcher; the same safeguards, with the data contract made
configurable instead of pinned to private files:
 - static files come only from the docroot (web/out by default): no directory listings, nothing outside the docroot
   (including through symlinks), GET and HEAD only, Cache-Control: no-store and X-Content-Type-Options: nosniff;
 - data is served only at /data/<name> for the names listed in <data-dir>/ALLOWLIST.json with their SHA-256. At
   startup each listed file must be a regular file (not a symlink) directly inside the data directory, match its
   hash, parse as JSON and pass terminal_demo.validate (which also requires the synthetic marker). The verified bytes
   are held in memory, so a file changed afterwards is never served. Anything wrong stops the server before it
   listens (fail closed). Every other /data/ path, under any spelling or encoding, returns 404;
 - the docroot must not contain a data/ directory, so data can only come through the allowlist;
 - bound to 127.0.0.1 only (there is no host option); listen backlog 128. Not a production server.
"""

import argparse
import functools
import hashlib
import http.server
import json
import os
import posixpath
import re
import stat
import sys
from pathlib import Path
from urllib.parse import unquote, urlsplit

from .validate import VALIDATORS, Invalid

REPO = Path(__file__).resolve().parent.parent
DEFAULT_DOCROOT = REPO / "web" / "out"
DEFAULT_DATA_DIR = REPO / "demo-data"
DEFAULT_PORT = 8800
NAME_RE = re.compile(r"^[a-z0-9_]+\.json$")
MAX_BYTES = 20 * 1024 * 1024
SHA_RE = re.compile(r"^[0-9a-f]{64}$")


class Refused(Exception):
    pass


def _regular_file_in(directory: Path, name: str) -> Path:
    p = directory / name
    try:
        st = os.lstat(p)
    except FileNotFoundError:
        raise Refused(f"{name} is missing") from None
    if stat.S_ISLNK(st.st_mode) or not stat.S_ISREG(st.st_mode):
        raise Refused(f"{name} is not a regular file")
    if p.resolve().parent != directory.resolve():
        raise Refused(f"{name} is not directly inside the data directory")
    if st.st_size > MAX_BYTES:
        raise Refused(f"{name} is larger than {MAX_BYTES} bytes")
    return p


def load_allowlisted(data_dir: Path) -> dict:
    """{'/data/<name>': verified bytes} for every allowlisted file, or Refused."""
    if not data_dir.is_dir():
        raise Refused("the data directory does not exist")
    try:
        allow = json.loads(_regular_file_in(data_dir, "ALLOWLIST.json").read_bytes())
    except json.JSONDecodeError:
        raise Refused("ALLOWLIST.json is not valid JSON") from None
    files = allow.get("files") if isinstance(allow, dict) else None
    if not isinstance(files, dict) or not files:
        raise Refused("ALLOWLIST.json lists no files")
    out = {}
    for name, sha in files.items():
        if not isinstance(name, str) or not NAME_RE.match(name) or name == "allowlist.json":
            raise Refused(f"ALLOWLIST.json names an invalid file: {name!r}")
        if name not in VALIDATORS:
            raise Refused(f"{name} has no validator in this demo and cannot be served")
        if not isinstance(sha, str) or not SHA_RE.match(sha):
            raise Refused(f"ALLOWLIST.json has no valid SHA-256 for {name}")
        body = _regular_file_in(data_dir, name).read_bytes()
        if hashlib.sha256(body).hexdigest() != sha:
            raise Refused(f"{name} does not match its SHA-256 in ALLOWLIST.json")
        try:
            VALIDATORS[name](json.loads(body))
        except json.JSONDecodeError:
            raise Refused(f"{name} is not valid JSON") from None
        except Invalid as e:
            raise Refused(f"{name} failed validation: {e}") from None
        out[f"/data/{name}"] = body
    return out


class Handler(http.server.SimpleHTTPRequestHandler):
    approved: dict = {}

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()

    def _route(self, head: bool):
        raw = urlsplit(self.path).path
        decoded = unquote(raw)
        norm = posixpath.normpath(decoded)
        if raw in self.approved:  # exact, unencoded spelling only
            body = self.approved[raw]
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            if not head:
                self.wfile.write(body)
            return
        for p in (raw.lower(), decoded.lower(), norm.lower()):
            if p == "/data" or p.startswith("/data/") or "/data/" in p or "\\" in p or "\x00" in p:
                self.send_error(404)  # nothing else under /data/, under any spelling
                return
        target = Path(self.translate_path(raw))
        root = Path(self.directory).resolve()
        try:
            real = target.resolve(strict=True)
        except (FileNotFoundError, RuntimeError, OSError):
            self.send_error(404)
            return
        if root != real and root not in real.parents:  # symlink or traversal outside the docroot
            self.send_error(404)
            return
        if real.is_dir() and not (real / "index.html").is_file():
            self.send_error(404)  # no directory listings
            return
        super().do_HEAD() if head else super().do_GET()

    def do_GET(self):
        self._route(head=False)

    def do_HEAD(self):
        self._route(head=True)

    def list_directory(self, path):
        self.send_error(404)
        return None

    def log_message(self, fmt, *args):  # request line and status only; no filesystem paths
        sys.stderr.write("%s %s\n" % (self.log_date_time_string(), fmt % args))


class LocalServer(http.server.ThreadingHTTPServer):
    request_queue_size = 128
    daemon_threads = True


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Serve the Macro Intelligence Terminal demo on 127.0.0.1 only.")
    ap.add_argument("--docroot", type=Path, default=DEFAULT_DOCROOT, help="built frontend (default: web/out)")
    ap.add_argument("--data-dir", type=Path, default=DEFAULT_DATA_DIR, help="directory with ALLOWLIST.json (default: demo-data)")
    ap.add_argument("--port", type=int, default=DEFAULT_PORT)
    a = ap.parse_args(argv)
    root = a.docroot.resolve()
    if not (root / "index.html").is_file():
        print("refused: the docroot has no index.html. Build the frontend first: cd web && npm ci && npm run build")
        return 2
    if (root / "data").exists():
        print("refused: the docroot must not contain a data/ directory (data is served only through ALLOWLIST.json)")
        return 2
    try:
        approved = load_allowlisted(a.data_dir)
    except Refused as e:
        print(f"refused: {e}; the server did not start")
        return 3
    handler = functools.partial(type("H", (Handler,), {"approved": approved}), directory=str(root))
    try:
        httpd = LocalServer(("127.0.0.1", a.port), handler)
    except OSError as e:
        print(f"refused: cannot listen on 127.0.0.1:{a.port} ({e.strerror})")
        return 4
    with httpd:
        print(f"serving http://127.0.0.1:{a.port}/ (loopback only); verified data: "
              + ", ".join(f"{p.rsplit('/', 1)[1]} {hashlib.sha256(b).hexdigest()[:12]}" for p, b in approved.items()) + "; Ctrl-C to stop",
              flush=True)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
