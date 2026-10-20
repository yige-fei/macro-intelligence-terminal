"use client";

// T2-G1: thin application shell. Shows one workspace at a time, chosen by ?ws= (default Home):
//   home     — landing page (no workspace state is loaded or written)
//   market   — the existing Terminal, rendered unchanged (its store hydrates on first entry, as before)
//   research — read-only frozen research results and sources
//   macro    — T3-I v1 read-only Release Schedule (local release-desk export; no values)
// Leaving Market unmounts it; its persisted layout and widget settings come back from its own store, while
// ephemeral chart zoom/pan does not (not persisted in this gate).

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import Home from "./Home";
import { readWorkspace, takeIntent, WORKSPACE_EVENT, type WorkspaceId } from "../lib/nav";

const Terminal = dynamic(() => import("./Terminal"), { ssr: false });
const ResearchView = dynamic(() => import("./ResearchView"), { ssr: false });
const MacroView = dynamic(() => import("./MacroView"), { ssr: false });
// T4-P1: settings — read-only Settings & About page (nothing is stored or changed).
const SettingsView = dynamic(() => import("./SettingsView"), { ssr: false });

const TITLES: Record<WorkspaceId, string> = {
  home: "Macro Intelligence Terminal",
  macro: "Release Schedule · Macro Intelligence Terminal",
  market: "Market Intelligence · Macro Intelligence Terminal",
  research: "Backtesting & Research · Macro Intelligence Terminal",
  settings: "Settings & About · Macro Intelligence Terminal",
};

export default function AppShell() {
  const [ws, setWs] = useState<WorkspaceId>(() => readWorkspace());

  // T4-P1: tells the static load-failure notice in app/layout.tsx that the application started (it stays hidden).
  useEffect(() => {
    document.documentElement.dataset.appReady = "1";
  }, []);

  useEffect(() => {
    const sync = () => setWs(readWorkspace());
    window.addEventListener("popstate", sync);
    window.addEventListener(WORKSPACE_EVENT, sync);
    return () => {
      window.removeEventListener("popstate", sync);
      window.removeEventListener(WORKSPACE_EVENT, sync);
    };
  }, []);

  useEffect(() => {
    document.title = TITLES[ws];
    if (ws !== "market" || takeIntent() !== "focus-macro") return;
    // Same action as the sidebar's PIT MACRO entry: shows (or reopens) the macro panel. The store module is the
    // one the Terminal itself loads, so this adds no second hydration.
    let cancelled = false;
    import("../store/terminal").then((m) => { if (!cancelled) m.useTerminal.getState().addWidget("macro"); });
    return () => { cancelled = true; };
  }, [ws]);

  if (ws === "market") return <Terminal />;
  if (ws === "research") return <ResearchView />;
  if (ws === "macro") return <MacroView />;
  if (ws === "settings") return <SettingsView />;
  return <Home />;
}
