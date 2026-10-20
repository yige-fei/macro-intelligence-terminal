"use client";

// Adapted from OpenTerminal web/components/Sidebar.tsx (MIT, see LICENSES/OpenTerminal-MIT.txt in the repository root): only research widgets are offered.
// T1: macro/research/sources are single panels, so their entries show (or reopen) that panel and mark it open;
// ETF CHART adds another chart. Either way the panel is scrolled into view.

import { SINGLETON, useTerminal, type WidgetType } from "../store/terminal";

const ITEMS: Array<{ type: WidgetType; label: string; key: string }> = [
  { type: "chart", label: "CHART", key: "⌥1" },
  { type: "macro", label: "PIT MACRO", key: "⌥2" },
  { type: "research", label: "RESEARCH", key: "⌥3" },
  { type: "sources", label: "SOURCES", key: "⌥4" },
];

export default function Sidebar() {
  const addWidget = useTerminal((s) => s.addWidget);
  const resetWorkspace = useTerminal((s) => s.resetWorkspace);
  const open = useTerminal((s) => s.widgets.map((w) => w.type).join(","));

  return (
    <nav className="w-32 bg-[var(--panel)] border-r border-[var(--border)] flex flex-col shrink-0" aria-label="Panels">
      <div className="dim px-2 py-1 text-[10px] uppercase tracking-wider border-b border-[var(--border)]">Panels</div>
      {ITEMS.map((item) => {
        const single = SINGLETON.has(item.type);
        const isOpen = open.split(",").includes(item.type);
        return (
          <button
            key={item.type}
            onClick={() => addWidget(item.type)}
            title={single ? (isOpen ? `Show the ${item.label} panel` : `Reopen the ${item.label} panel`) : "Add another chart"}
            data-open={isOpen}
            className="text-left px-2 py-1.5 text-[11px] hover:bg-[#1a1a1a] hover:text-[var(--amber)] flex justify-between items-center"
          >
            <span>
              <span className={`inline-block w-2 ${isOpen ? "amber" : "dim"}`}>{single ? (isOpen ? "●" : "○") : "+"}</span> {item.label}
            </span>
            <span className="dim text-[9px]">{item.key}</span>
          </button>
        );
      })}
      <div className="mt-auto border-t border-[var(--border)]">
        <button
          onClick={resetWorkspace}
          title="Restore the default panels, layout and panel settings"
          className="w-full text-left px-2 py-1.5 text-[11px] dim hover:text-[var(--down)]"
        >
          RESET LAYOUT
        </button>
      </div>
    </nav>
  );
}
