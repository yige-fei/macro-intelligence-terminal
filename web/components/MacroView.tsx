"use client";

// T3-I v1: Macro workspace. The Release Schedule is a new read-only subview; the historical point-in-time macro
// explorer stays where it was (the macro panel inside Market) and is one click away, unchanged.

import ShellHeader from "./ShellHeader";
import ReleaseSchedule from "./ReleaseSchedule";
import { hrefFor, navigate } from "../lib/nav";

export default function MacroView() {
  return (
    <div className="flex flex-col h-screen">
      <ShellHeader current="macro" badge="REAL OFFICIAL METADATA · SCHEDULE & STATUS ONLY · NO VALUES · NOT LIVE" />
      <main className="flex-1 overflow-auto">
        <div className="max-w-[1400px] mx-auto px-4 py-4 flex flex-col gap-3">
          <nav className="flex gap-1 text-[11px]" aria-label="Macro views">
            <span className="px-2 py-[1px] border border-[var(--amber)] text-[var(--amber)]" aria-current="page">RELEASE SCHEDULE</span>
            <a
              href={hrefFor("market")}
              data-testid="open-historical-explorer"
              onClick={(e) => {
                if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                e.preventDefault();
                navigate("market", "focus-macro");
              }}
              className="px-2 py-[1px] border border-[var(--border)] hover:border-[var(--amber)] hover:text-[var(--amber)]"
            >
              {"HISTORICAL EXPLORER (dataset not included) →"}
            </a>
          </nav>
          <ReleaseSchedule />
        </div>
      </main>
    </div>
  );
}
