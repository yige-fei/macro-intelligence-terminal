# Macro Intelligence Terminal

A local, Bloomberg-style research terminal for macroeconomic events and markets.

It's a static Next.js app with interactive financial charts, built on [OpenTerminal](https://github.com/ErTasselli/OpenTerminal)
and TradingView Lightweight Charts™. It adds:
- a release desk for official U.S. economic releases;
- a research results view;
- a small, security-conscious local server.

> **What is real and what is simulated**
> - **Real:** the release-desk metadata (schedules and publication status of CPI, Employment Situation and GDP Advance releases, from official BLS and BEA pages; no economic values).
> - **Simulated:** every market price, labelled **SIMULATED DATA — NOT REAL MARKET PRICES**. The instruments are fictional (`DEMO-A` to `DEMO-D`).
> - **Illustrative:** every research figure. These are random draws, not results.
>
> Nothing here is live, and nothing here is a trading signal.

## What works

| Area | Status in this repository |
|---|---|
| Home, navigation (`?ws=` deep links, browser Back), Settings & About | Working |
| **Market**: daily candlestick/bar/line/area charts, volume, SMA/EMA/Bollinger overlays, RSI and MACD panes, range presets, zoom and pan, command palette (Ctrl/⌘+K), layout saved in the browser | Working on **simulated** data. Panel drag and resize come from upstream; the automated checks don't exercise them. |
| **Macro**: release schedule and publication status for 38 events (CPI, Employment Situation, GDP Advance) | Working, real official metadata, **dated snapshot** collected 2026-10-16/17. Not refreshed. |
| **Event overlay** (Market → EVENT OVERLAY): markers for the 5 release events due by the 2026-10-17 snapshot (2 publication confirmed, 3 scheduled time passed but not confirmed), with official times and source links | Working: **real event dates and statuses on a separately simulated price set** (2025-01-02 to 2026-10-16). The alignment is illustrative; it shows no market reaction. |
| **Import local data** (Market → IMPORT LOCAL DATA): chart your own daily OHLCV `.csv` or `.json` file with all chart tools | Working, **in the browser only**: not uploaded or saved, and gone after a reload. Labelled **USER-IMPORTED DATA — LOCAL FILE**. Structure and numbers are checked; source, accuracy and rights are not. See [docs/IMPORT.md](docs/IMPORT.md). |
| **Research**: results view (labels, intervals, per-model AUCs) | Working, **illustrative random figures** |
| Point-in-time macro explorer (first releases, yields) | Panel exists; **no dataset included** (shows a "not included" notice) |
| Event studies (measured reactions), strategy backtesting, AI research assistant | **Not implemented** (planned) |

## Quick start

You need:
- **Node 22 or newer.** Developed and tested with Node 26.0.0 and npm 11.12.1; `.nvmrc` says 26.
- **Python 3.10 or newer.** Tested with 3.12.6.

**Tested platform:** macOS 14 only, with Node 26.0.0, Python 3.12.6 and Chrome 155 (the automated browser checks drive
Chrome).
- **Linux:** untested.
- **Windows:** untested, and `npm run build` won't run in cmd or PowerShell (the npm scripts set an environment
  variable POSIX-style).
- **Other browsers** (Safari, Firefox, Edge): untested.
- There's no installer or hosted version; you build and run it locally as below.

```bash
cd web
npm ci            # exact versions from package-lock.json
npm run build     # static export into web/out/
cd ..
python3 -m terminal_demo.serve        # http://127.0.0.1:8800/   (Ctrl-C to stop)
```

**Server options:**
- `--port N` picks the port;
- `--docroot DIR` and `--data-dir DIR` override `web/out` and `demo-data`.

**Behaviour:**
- It binds to **127.0.0.1 only**.
- It refuses to start if the frontend hasn't been built, or if any data file fails its checks (see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)).

**Builds and network access:** Next.js telemetry is disabled in the npm scripts. Neither the build nor the running app contacts any market-data provider.

## Tests

```bash
python3 -m unittest discover -s tests                     # generator, validator, server security, repository scan
node --test --disable-warning=MODULE_TYPELESS_PACKAGE_JSON tests/import/import.test.mjs   # local-import parser (Node >= 22.18)
node tests/browser/smoke.mjs                              # browser checks; needs `npm run build` first
CHROME_PATH=/path/to/chrome node tests/browser/smoke.mjs  # if Chrome/Chromium is not in a standard location
cd web && npm run typecheck
python3 -m terminal_demo.generate --check                 # demo-data/ equals a fresh generation
```

**Python tests** (standard library only) cover:
- deterministic generation;
- rejection of malformed bars and timestamps;
- the server's allowlist and path-traversal protections;
- fail-closed startup;
- a scan for personal paths, credentials, provider endpoints and third-party data.

**Browser checks** run headless Chrome over the DevTools protocol with no extra packages. They exercise the real UI:
- navigation;
- chart range, zoom, pan, indicators and chart type;
- instrument switching;
- layout persistence across reload;
- labels;
- network boundaries;
- missing-data and empty-data states.

## Data

| File | What it is |
|---|---|
| `demo-data/etf_prices.json` | 4 fictional instruments × 2,085 weekday bars (2016-01-04 to 2023-12-29), from a seeded random walk with volatility regimes. Every record is structurally valid (low ≤ open/close ≤ high, ordered UTC-midnight timestamps). It doesn't model real market behaviour. |
| `demo-data/event_overlay_prices.json` | A separate simulated set for the event overlay: the same 4 fictional instruments × 467 weekday bars (2025-01-02 to 2026-10-16), from its own seed. It ends at the release-desk snapshot, so there are no future prices, and it simulates no event effect. |
| `demo-data/research.json` | Illustrative figures: uniform random draws around AUC 0.5. No model was fitted. |
| `demo-data/manifest.json`, `ALLOWLIST.json` | Generator identity and SHA-256 of each served file |
| `web/public/intel/release_desk.v1.json` | Release metadata from official BLS/BEA pages. Schedule and status only; no economic values. |

Regenerate with `python3 -m terminal_demo.generate` (seed `20261020`). Details: [docs/DATA.md](docs/DATA.md).

**Rights:**
- This repository contains **no** third-party market data and **no** FRED/ALFRED or Cboe data.
- The project's MIT licence grants no rights in data from any provider; see [NOTICE.md](NOTICE.md).
- Optional adapters for official sources are planned, not implemented. You can already chart your own daily CSV/JSON file in the browser ([docs/IMPORT.md](docs/IMPORT.md)); it stays under its own terms.

## Research

The author maintains a separate, private research pipeline: point-in-time macro features, purged walk-forward validation and a frozen evaluation policy. **Its data and results aren't part of this repository**, and nothing here re-runs or reproduces it.

The Research page demonstrates the presentation layer with illustrative numbers. No forecasting edge is claimed. See [docs/RESEARCH.md](docs/RESEARCH.md).

## Architecture

The frontend is a static export (OpenTerminal workspace, Zustand store, react-grid-layout, Lightweight Charts). It reads only:
- same-origin `./data/*.json`, served by `terminal_demo.serve` from an allowlist;
- `./intel/*.json`, the release desk.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Roadmap (not implemented)

1. Optional adapters for official direct sources (BLS, BEA, Federal Reserve Board), labelled "revised" until point-in-time vintages are reconstructed.
2. Event-study views (the event overlay marks dates only; it measures nothing).
3. More import formats (for example intraday bars), if there's a need; daily CSV/JSON import exists (docs/IMPORT.md).
4. Strategy backtesting (a separate design).
5. An evidence-grounded AI research assistant.

## Provenance and licence

- **Provenance:** upstream, modified and original files are listed in [NOTICE.md](NOTICE.md). Third-party licence texts are in [LICENSES/](LICENSES/).
- **Licence:** this project's own code, documentation and generated fictional data are under the **MIT License**, Copyright (c) 2026 Samology ([LICENSE](LICENSE)).
  - Files adapted from OpenTerminal keep OpenTerminal's MIT notice.
  - Third-party libraries keep their own licences.
  - BLS/BEA release metadata keeps its public-domain source status.
  - Files you import are not covered.

  The boundaries are set out in [NOTICE.md](NOTICE.md).
