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
import { BuildStamp, historicalBadge, NavLink, WorkspaceNav } from "./ShellHeader";

export default function TopBar() {
  const setCommandOpen = useTerminal((s) => s.setCommandOpen);
  const activeSymbol = useTerminal((s) => s.activeSymbol);
  const { data: manifest } = useQuery({ queryKey: ["manifest"], queryFn: () => loadLocal<Manifest>("manifest.json"), staleTime: Infinity });

  return (
    <header className="flex items-center gap-4 px-3 h-8 bg-[var(--panel-2)] border-b border-[var(--border)] text-[11px] shrink-0">
      <NavLink ws="home" className="amber font-bold tracking-widest whitespace-nowrap shrink-0">{PRODUCT_NAME.toUpperCase()}</NavLink>
      <span className="hist-badge whitespace-nowrap shrink-0" role="status">{historicalBadge(manifest)}</span>
      <WorkspaceNav current="market" />
      <button className="term-btn flex-1 min-w-[90px] max-w-md text-left dim flex items-center gap-2" onClick={() => setCommandOpen(true)}>
        <span className="truncate min-w-0">{activeSymbol} — search ETF or macro series…</span><span className="ml-auto shrink-0">⌘K</span>
      </button>
      <BuildStamp />
    </header>
  );
}
