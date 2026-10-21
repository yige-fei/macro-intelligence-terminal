# Architecture

```
 browser (static Next.js export, web/out)                    terminal_demo.serve  (127.0.0.1 only)
 ┌──────────────────────────────────────────────┐            ┌──────────────────────────────────────────┐
 │ AppShell  ?ws=home|macro|market|research|     │  GET       │ static files from web/out                │
 │           settings                            │ ─────────► │  · no listings, no symlink/path escape   │
 │ Market workspace (OpenTerminal-derived)       │            │  · GET/HEAD only, no-store, nosniff      │
 │   ChartWidget ── Lightweight Charts           │            │                                          │
 │   PitMacroWidget, ResearchWidget, Sources     │  GET       │ /data/<name> only if in ALLOWLIST.json:  │
 │ lib/api.ts loadLocal("./data/<file>")  ──────────────────► │  verified at startup (regular file,      │
 │   · only files allowed by the data mode       │            │  sha256, JSON, validator, synthetic      │
 │   · rejects files not marked synthetic        │            │  marker) and served from memory          │
 │ lib/releaseDesk.ts  "./intel/*.json"   ──────────────────► │ everything else under /data/ → 404       │
 │   · rejects non-official source URLs          │            └──────────────────────────────────────────┘
 └──────────────────────────────────────────────┘                              ▲
                                                                demo-data/  (terminal_demo.generate, seeded)
```

## Frontend (`web/`)

- **Shell.** A single static page. `AppShell` shows one workspace, chosen by `?ws=`, so refresh, deep links and Back/Forward work on any static host.
- **Market workspace.** OpenTerminal's react-grid-layout workspace, panel chrome, command palette and Zustand store.
  - The layout and each panel's view (range, chart type, indicators, instrument) persist in `localStorage` under `macro-research-workspace-v2`.
  - Stored state is sanitised on load.
- **Charts.** `ChartWidget` uses Lightweight Charts 5. Indicators are computed in the browser (`lib/indicators.ts`).
  - Each chart panel chooses a dataset (`view.dataset`): `demo` (2016–2023, the default) or `overlay` (the event-overlay set).
  - **Range presets are computed from the selected dataset's dates.** 1Y, 3Y and 5Y start on 1 January of the last bar's year, two years earlier and four years earlier. The span preset starts on 1 January of the first bar's year. For the 2016–2023 set these are exactly the earlier fixed values, and an older saved range `"2016–23"` still loads.
  - **Switching datasets** resets the range to 5Y and rebuilds the chart, so no range or marker carries over.
- **Event markers.** On the overlay dataset, `lib/eventMarkers.ts` maps the bundled release-desk events to bars (contract in [DATA.md](DATA.md)). The markers are attached with `createSeriesMarkers` as a series plugin, which leaves zoom and indicators untouched.
  - The panel shows a notice: real official event metadata, simulated prices, illustrative alignment.
  - It also shows an event list with official or scheduled times, document ids, source links and the reason for anything not drawn.
  - Zoom is by the +/− buttons or by dragging the time axis; pan is by dragging the plot.
  - The mouse wheel is left to the page.
- **Data mode.** The data mode is fixed at build time (`next.config.ts`, from `TERMINAL_DATA_MODE`):

  | Mode | Includes |
  |---|---|
  | `demo` (default) | Simulated bars, illustrative research figures and their manifest |
  | `excluded` | Release-desk metadata only |

  A panel whose file isn't in the mode shows a "not included" notice and never requests the file.
- **Honest states.** `loadLocal` refuses any file without `synthetic: true`, so real-looking values can't appear under the demo labels.
  - A missing file shows an explicit error.
  - An instrument with no bars shows an empty state.
  - A file that isn't JSON shows an error.
- **Release desk.** `lib/releaseDesk.ts` reads `./intel/release_desk.v1.json`. It rejects the export if:
  - the contract or version is wrong;
  - the no-values policy is missing;
  - real and synthetic events are mixed;
  - any source URL isn't `https://www.bls.gov/` or `https://www.bea.gov/`.

  The optional snapshot manifest adds a change summary.
- **Build identity.** The build id is the SHA-256 of the `web/` file hash list, excluding dependencies and build output. Identical sources give the same id in any clone.

## Local server (`terminal_demo/serve.py`)

- **Reach.** Python standard library only. Bound to 127.0.0.1, with no host option. Not a production server.
- **Startup checks.** It refuses to start (exit code 2, 3 or 4) when:
  - the docroot has no `index.html` (the frontend isn't built);
  - the docroot contains `data/`;
  - the allowlist is missing, malformed or a symlink;
  - an entry names a path, an unknown file or an invalid hash;
  - a listed file is missing, a symlink, outside the data directory, too large, a hash mismatch, not JSON, or fails `terminal_demo.validate`;
  - the port is taken.
- **Routing.** It serves exactly the exact, unencoded spelling of each allowlisted `/data/<name>`. Every other `/data/` spelling (case, percent-encoding, `..`, backslash, NUL) gets 404.
- **Origin.** It's adapted from the author's earlier private research-only launcher. The earlier launcher pinned two private files; this one takes a configurable allowlist.

## Demo data (`terminal_demo/generate.py`, `terminal_demo/validate.py`)

The generator is deterministic and reads no files (a test checks this). The validator enforces the frontend contracts:
- ordered UTC-midnight timestamps;
- valid OHLC ranges;
- non-negative integer volume;
- the synthetic and illustrative markers.

## Tests (`tests/`)

| File | Covers |
|---|---|
| `test_demo_data.py` | Determinism, record validity, rejection of malformed records |
| `test_server.py` | Real server processes: allowlisted bytes and headers, refused paths, symlink escapes, methods, no path leakage, loopback only, every fail-closed startup case |
| `test_repository_scan.py` | Tracked files contain no personal paths, emails, credentials, nested `.git`, provider endpoints or third-party data |
| `browser/smoke.mjs` | Headless Chrome over CDP against the built app, including missing-data scenarios |
