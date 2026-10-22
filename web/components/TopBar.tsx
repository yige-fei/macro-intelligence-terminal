"use client";

// Adapted from OpenTerminal web/components/TopBar.tsx (MIT, see LICENSES/OpenTerminal-MIT.txt in the repository root). Removed on purpose: the live
// world clocks, the "NYSE OPEN/CLOSED" state, the /api/status feed health and the AI indicator, all of which
// would imply live data. In their place: a permanent historical-data badge built from the local manifest.
// T2-G1: a HOME link and the title both return to the Home page (?ws= navigation; no storage involved).

// T4-P1: product name, honest badge and build stamp (shared with ShellHeader).
// T4-AFK: the same workspace links as every other page (the lone ⌂ HOME link is replaced by them); title, badge and
// links stay on one line, the search button and build stamp shrink instead (the bar wrapped and clipped at 1024 px).

import { useQuery } from "@tanstack/react-query";
import { loadLocal, type Manifest } from "../lib/api";
import { PRODUCT_NAME } from "../lib/buildInfo";
import { useTerminal } from "../store/terminal";
import { useImported } from "../store/imported";
import { BuildStamp, historicalBadge, NavLink, WorkspaceNav } from "./ShellHeader";

export default function TopBar() {
  const setCommandOpen = useTerminal((s) => s.setCommandOpen);
  const activeSymbol = useTerminal((s) => s.activeSymbol);
  const importedContext = useImportedContext();
  const { data: manifest } = useQuery({ queryKey: ["manifest"], queryFn: () => loadLocal<Manifest>("manifest.json"), staleTime: Infinity });

  return (
    <header className="flex items-center gap-4 px-3 h-8 bg-[var(--panel-2)] border-b border-[var(--border)] text-[11px] shrink-0">
      <NavLink ws="home" className="amber font-bold tracking-widest whitespace-nowrap shrink-0">{PRODUCT_NAME.toUpperCase()}</NavLink>
      <span className="hist-badge whitespace-nowrap shrink-0" role="status">{historicalBadge(manifest)}</span>
      <WorkspaceNav current="market" />
      {/* OS-P2 UX-3: the picker sets the built-in instrument. When every chart that follows it shows an imported file, it
          says so instead of naming a demo instrument as if it were on screen; the built-in choice is kept and shown. */}
      <button className="term-btn flex-1 min-w-[90px] max-w-md text-left dim flex items-center gap-2" onClick={() => setCommandOpen(true)}
        data-testid="instrument-picker" data-context={importedContext ? "imported" : "built-in"}
        title={importedContext
          ? `The chart shows your imported file. Search to set the built-in instrument (now ${activeSymbol}) used by DEMO SET and EVENT OVERLAY.`
          : "Search the built-in instruments"}>
        <span className="truncate min-w-0">
          {importedContext ? <><span className="text-[#4fc3f7]">IMPORTED FILE</span> · built-in: {activeSymbol} — search…</> : <>{activeSymbol} — search instruments…</>}
        </span>
        <span className="ml-auto shrink-0">⌘K</span>
      </button>
      <BuildStamp />
    </header>
  );
}

/** True when at least one chart follows the active instrument and every such chart is showing the imported file. */
export function useImportedContext(): boolean {
  const widgets = useTerminal((s) => s.widgets);
  const active = useImported((s) => s.active);
  const hasSet = useImported((s) => s.set !== null);
  const linkedCharts = widgets.filter((w) => w.type === "chart" && w.linked);
  return hasSet && linkedCharts.length > 0 && linkedCharts.every((w) => active[w.id]);
}
