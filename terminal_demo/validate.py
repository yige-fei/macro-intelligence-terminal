"""Structural validation of the demo data files served to the frontend (the contracts in web/lib/api.ts).

Every validator raises Invalid with a short reason; the server refuses to start on any Invalid (fail closed).
These checks describe well-formed demonstration records, not realistic market behaviour.
"""

import math
import re
from datetime import date, datetime, timezone

SYMBOL_RE = re.compile(r"^[A-Z0-9][A-Z0-9.-]{0,11}$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


class Invalid(ValueError):
    pass


def _req(obj, key, typ, where):
    if not isinstance(obj, dict) or key not in obj:
        raise Invalid(f"{where}: missing {key}")
    v = obj[key]
    if typ is float:
        if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v):
            raise Invalid(f"{where}.{key}: not a finite number")
    elif typ is int:
        if isinstance(v, bool) or not isinstance(v, int):
            raise Invalid(f"{where}.{key}: not an integer")
    elif not isinstance(v, typ):
        raise Invalid(f"{where}.{key}: expected {typ.__name__}")
    return v


def _date(s, where) -> date:
    if not isinstance(s, str) or not DATE_RE.match(s):
        raise Invalid(f"{where}: date must be YYYY-MM-DD")
    try:
        return date.fromisoformat(s)
    except ValueError:
        raise Invalid(f"{where}: not a calendar date") from None


def utc_midnight(d: date) -> int:
    return int(datetime(d.year, d.month, d.day, tzinfo=timezone.utc).timestamp())


def _synthetic(obj, where):
    if obj.get("synthetic") is not True:
        raise Invalid(f"{where}: not marked synthetic; this demo serves only generated data")


def validate_etf(obj) -> None:
    """etf_prices.json: {bound, source, symbols, candles: {symbol: [Candle]}, synthetic: true, ...}."""
    w = "etf_prices"
    if not isinstance(obj, dict):
        raise Invalid(f"{w}: not an object")
    _synthetic(obj, w)
    bound = _date(_req(obj, "bound", str, w), f"{w}.bound")
    _req(obj, "source", str, w)
    symbols = _req(obj, "symbols", list, w)
    if not symbols or len(set(symbols)) != len(symbols) or not all(isinstance(s, str) and SYMBOL_RE.match(s) for s in symbols):
        raise Invalid(f"{w}.symbols: must be unique upper-case identifiers")
    candles = _req(obj, "candles", dict, w)
    if set(candles) != set(symbols):
        raise Invalid(f"{w}.candles: keys must equal symbols")
    for sym in symbols:
        rows = candles[sym]
        if not isinstance(rows, list):
            raise Invalid(f"{w}.candles.{sym}: not a list")
        prev = None
        for i, c in enumerate(rows):
            where = f"{w}.candles.{sym}[{i}]"
            d = _date(_req(c, "date", str, where), f"{where}.date")
            t = _req(c, "time", int, where)
            if t != utc_midnight(d):
                raise Invalid(f"{where}.time: must be the UTC-midnight timestamp of its date")
            if prev is not None and t <= prev:
                raise Invalid(f"{where}: timestamps must be strictly increasing")
            if d > bound:
                raise Invalid(f"{where}: after the declared bound")
            prev = t
            o, h, lo, cl, adj = (_req(c, k, float, where) for k in ("open", "high", "low", "close", "adjClose"))
            if min(o, h, lo, cl, adj) <= 0:
                raise Invalid(f"{where}: prices must be positive")
            if h < max(o, cl, lo) or lo > min(o, cl, h):
                raise Invalid(f"{where}: high/low inconsistent with open/close")
            if _req(c, "volume", int, where) < 0:
                raise Invalid(f"{where}.volume: negative")


def validate_research(obj) -> None:
    """research.json in the shape of the frontend's Research type, marked illustrative."""
    w = "research"
    if not isinstance(obj, dict):
        raise Invalid(f"{w}: not an object")
    _synthetic(obj, w)
    if obj.get("illustrative") is not True:
        raise Invalid(f"{w}: not marked illustrative")
    for k in ("policy_id", "policy_sha256", "approval_status", "evaluation_sha256", "run", "label_policy", "code_commit", "multiplicity"):
        _req(obj, k, str, w)
    review = _req(obj, "review", dict, w)
    for k in ("verdict", "file", "sha256"):
        _req(review, k, str, f"{w}.review")
    results = _req(obj, "results", dict, w)
    if not results:
        raise Invalid(f"{w}.results: empty")
    for key, r in results.items():
        where = f"{w}.results.{key}"
        _req(r, "label", str, where)
        _req(r, "estimate", float, where)
        iv = _req(r, "interval", list, where)
        if len(iv) != 2 or not all(isinstance(x, (int, float)) and not isinstance(x, bool) for x in iv) or iv[0] > iv[1]:
            raise Invalid(f"{where}.interval: must be [low, high]")
        level = _req(r, "ci_level", float, where)
        if not 0 < level < 1:
            raise Invalid(f"{where}.ci_level: must be in (0, 1)")
        for k in ("cells_eligible", "cells_total", "invalid_replicates", "replicates"):
            _req(r, k, int, where)
        algos = _req(r, "per_algorithm", dict, where)
        for name, a in algos.items():
            for k in ("auc_market_only", "auc_macro_enhanced", "delta_auc"):
                v = _req(a, k, float, f"{where}.per_algorithm.{name}")
                if k != "delta_auc" and not 0 <= v <= 1:
                    raise Invalid(f"{where}.per_algorithm.{name}.{k}: AUC outside [0, 1]")
        _req(r, "mean_delta_by_year", dict, where)


def validate_manifest(obj) -> None:
    """manifest.json in the shape of the frontend's Manifest type, marked synthetic."""
    w = "manifest"
    if not isinstance(obj, dict):
        raise Invalid(f"{w}: not an object")
    _synthetic(obj, w)
    for k in ("built_utc", "bound", "snapshot_id", "snapshot_end", "repository_head"):
        _req(obj, k, str, w)
    for k in ("raw_sha256", "evidence_sha256", "files_sha256"):
        _req(obj, k, dict, w)


VALIDATORS = {"etf_prices.json": validate_etf, "research.json": validate_research, "manifest.json": validate_manifest}
