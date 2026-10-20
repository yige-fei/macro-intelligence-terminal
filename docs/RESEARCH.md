# Research: what this repository does and does not contain

**The Research page is a presentation demo.** It shows the layout used for a macro-versus-market evaluation:
- per-horizon labels with intervals;
- per-model AUCs with and without a macro/risk feature block;
- provenance.

**Every figure is an illustrative random draw** from `terminal_demo/generate.py` (see [DATA.md](DATA.md)):
- No model is fitted, nothing is evaluated, and no statistical test is run.
- An interval that excludes zero is meaningless.
- The page, the panel and the data file all say "ILLUSTRATIVE".

**The author's private research isn't included.** The author maintains a separate research pipeline, outside this repository. Its methodology covers:
- point-in-time macro features using first-release vintages;
- open-to-open targets;
- purged expanding walk-forward validation;
- a frozen evaluation policy.

Its data, and the results derived from it, aren't part of this repository, for two reasons:
- the third-party data it used can't be redistributed;
- whether its results may be published is still open.

Nothing here re-runs, reproduces or summarises that evaluation.

**Limitations:**
- **No forecasting edge.** The demo establishes none and claims none.
- **No backtesting.** Interactive strategy backtesting isn't implemented. Nothing here is a backtest, a performance figure or a trading signal.
- **No point-in-time macro data.** No such dataset is bundled, so the point-in-time macro panel shows a "not included" notice.
- **No event-to-market analysis.** Event markers and event-study tools are planned, not implemented. Simulated prices around real release dates would say nothing about real market reactions, so they aren't combined.
