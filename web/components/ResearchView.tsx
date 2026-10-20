"use client";

// T2-G1: read-only view of the research result panel and its sources. Renders new instances of the existing
// ResearchWidget and SourcesWidget (they read only research.json / manifest.json and never touch the workspace
// store), so the Market workspace and its own Research panels are unaffected.

import ShellHeader from "./ShellHeader";
import { HISTORICAL_DATA } from "../lib/api";
import ResearchWidget from "./widgets/ResearchWidget";
import SourcesWidget from "./widgets/SourcesWidget";

export default function ResearchView() {
  return (
    <div className="flex flex-col h-screen">
      <ShellHeader current="research" />
      <main className="flex-1 overflow-auto">
        <div className="max-w-[1280px] mx-auto px-4 py-4 flex flex-col gap-3">
          <div className="note text-[12px]" role="note" data-testid="research-disclaimer">
            <b className="amber">These are evaluation results, not a backtest and not a trading signal.</b>{" "}
            Executable backtesting is not built.
          </div>
          {HISTORICAL_DATA === "demo" && (
            <div className="note text-[12px]" role="note" data-testid="research-scope">
              <b className="amber">Demo figures.</b> This page shows randomly generated, illustrative figures so that the research
              presentation can be explored without private data. They are not the result of any evaluation. The author&apos;s private
              historical evaluation and its data are not part of this repository; see docs/RESEARCH.md.
            </div>
          )}
          <div className="grid grid-cols-1 lg:grid-cols-[3fr_2fr] gap-3 items-start">
            <section className="terminal-panel !h-auto" aria-label="Research result">
              <div className="panel-title !cursor-default"><span>{HISTORICAL_DATA === "demo" ? "Research Result (illustrative demo)" : "Research Result"}</span></div>
              <ResearchWidget />
            </section>
            <section className="terminal-panel !h-auto" aria-label="Sources and licences">
              <div className="panel-title !cursor-default"><span>Sources &amp; Licences</span></div>
              <SourcesWidget />
            </section>
          </div>
        </div>
      </main>
    </div>
  );
}
