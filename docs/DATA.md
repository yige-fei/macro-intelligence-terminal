# Data

## Simulated market bars (`demo-data/etf_prices.json`)

**Generator:** `terminal_demo.generate v1`, seed `20261020`. It is deterministic and uses Python's `random.Random`. It reads no input files.

| Instrument | Start | Annual drift | Annual volatility | Base volume | Description |
|---|---|---|---|---|---|
| DEMO-A | 100 | 7% | 16% | 60 M | simulated broad index-like instrument |
| DEMO-B | 80 | 10% | 24% | 40 M | simulated higher-volatility growth-like instrument |
| DEMO-C | 150 | 5% | 14% | 4 M | simulated lower-volatility instrument |
| DEMO-D | 60 | 4% | 28% | 25 M | simulated small-cap-like instrument |

**Calendar.** Every Monday–Friday from 2016-01-04 to 2023-12-29: 2,085 bars per instrument. Exchange holidays aren't modelled.

**Process, per instrument:**
- **Returns:** a geometric random walk with a two-state volatility regime.
  - Calm regime: volatility × 0.8, and a 1% daily chance of switching.
  - Stressed regime: volatility × 2.2, and a 5% daily chance of switching.
- **Prices:**
  - open = previous close × an overnight gap;
  - close = open × the day's return;
  - high and low extend beyond max/min(open, close) by half-normal amounts;
  - all prices are rounded to cents, then high and low are re-checked.
- **Volume:** the base volume × a log-normal factor × (1 + 25 × |return|).
- **Dividends:** none, so `adjClose` equals `close`.

**What it guarantees:**
- structurally valid records: low ≤ open, close ≤ high; positive prices; integer volume ≥ 0; strictly increasing UTC-midnight `time` matching `date`;
- byte-identical output for the same seed.

**What it doesn't attempt:** realistic market microstructure, cross-asset correlation, or any resemblance to a real security. Charts label the data "SIMULATED DATA — NOT REAL MARKET PRICES".

## Illustrative research figures (`demo-data/research.json`)

These are drawn from the same seeded generator. They aren't an evaluation.

| Figure | How it's drawn |
|---|---|
| Market-only AUC, each of 3 models and 2 horizons | 0.5 + U(−0.03, 0.03) |
| Macro-enhanced AUC | The market-only value + U(−0.02, 0.02) |
| Headline estimate | The mean of the three differences |
| Interval | The estimate ± U(0.01, 0.03) |

The labels say `ILLUSTRATIVE`, and the policy id is `DEMO_ILLUSTRATIVE_v1`. An interval that excludes zero means nothing here.

## Allowlist (`demo-data/ALLOWLIST.json`)

`{"files": {"<name>.json": "<sha256>"}}`. The server serves only the listed files, and only if each hash matches and the file passes `terminal_demo.validate`.

Supported names:
- `etf_prices.json`;
- `research.json`;
- `manifest.json`.

Every served file must carry `"synthetic": true`. Research files must also carry `"illustrative": true`.

`python3 -m terminal_demo.generate` writes the allowlist; `--check` verifies that the committed files equal a fresh generation.

## Release-desk metadata (`web/public/intel/`)

`release_desk.v1.json` is export contract `release_desk_export 1.0.0`, record contract `macro_release_event 0.2.0`.

- **Content:** 38 events: CPI (15), Employment Situation (15), GDP Advance (8).
- **Fields:** reference period, official schedule with time zone, publication status, official source links, document ids, and when each was last checked.
- **Values:** `values_policy: NO_ECONOMIC_VALUES`. No economic numbers are included.

**Provenance:**
- Collected from official BLS and BEA web pages by the author's supervised collector, in manual runs on 2026-10-16 and 2026-10-17 (export as of 2026-10-17T14:15:09Z).
- Two releases are confirmed from their official news releases. The rest are scheduled but not yet verified.
- The snapshot isn't refreshed, and the page shows each row's check age.

**Reuse:**
- BLS: "everything that we publish … is in the public domain"; please cite BLS.
- BEA: "Unless stated otherwise … public domain and may be used or reproduced without specific permission"; please cite BEA.
- Agency logos aren't used.

**Citation:** Source: U.S. Bureau of Labor Statistics. Source: U.S. Bureau of Economic Analysis.

**The snapshot manifest.** `release_desk_r2_manifest.json` binds the export to the private collection dataset by SHA-256 and gives a mechanical change summary. Labels and evidence locations from the private collection are omitted.

**The collector isn't in this repository.** It needs an approval file and a contact identity for its requests, and packaging it is a separate, later task. This repository never fetches from BLS or BEA.

## Not included

- Market prices from any provider.
- FRED/ALFRED series.
- Cboe VIX.
- Point-in-time macro observations.
- The author's private research data and results.

An open-source licence wouldn't grant rights in such data. Its use depends on each provider's terms.
