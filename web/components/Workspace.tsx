"use client";

// Adapted from OpenTerminal web/components/Workspace.tsx (MIT, see LICENSES/OpenTerminal-MIT.txt in the repository root): same react-grid-layout
// workspace, panel chrome, per-widget ticker tag and link toggle; widget registry reduced to research widgets.
// T1: the row height is derived from the visible workspace height so the default layout fills one screen
// (no clipped bottom row on a laptop, no empty band on a large display); focused panels scroll into view.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import GridLayout, { WidthProvider } from "react-grid-layout";
import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";
import { normalizeSymbol } from "../lib/symbol";
import { SCREEN_ROWS, useTerminal, type WidgetInstance } from "../store/terminal";
import { useImported } from "../store/imported";
import ChartWidget from "./widgets/ChartWidget";
import PitMacroWidget from "./widgets/PitMacroWidget";
import ResearchWidget from "./widgets/ResearchWidget";
import SourcesWidget from "./widgets/SourcesWidget";
import WidgetErrorBoundary from "./WidgetErrorBoundary";

const Grid = WidthProvider(GridLayout);
const MARGIN = 4;
const MIN_ROW_HEIGHT = 16; // below this panels would be crushed; the workspace scrolls instead

function WidgetBody({ widget }: { widget: WidgetInstance }) {
  switch (widget.type) {
    case "chart": return <ChartWidget widget={widget} />;
    case "macro": return <PitMacroWidget widget={widget} />;
    case "research": return <ResearchWidget />;
    case "sources": return <SourcesWidget />;
  }
}

function SymbolTag({ widget, activeSymbol }: { widget: WidgetInstance; activeSymbol: string }) {
  const setWidgetSymbol = useTerminal((s) => s.setWidgetSymbol);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [invalid, setInvalid] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const shown = widget.linked ? activeSymbol : widget.symbol ?? activeSymbol;

  useEffect(() => {
    if (!editing) return;
    setDraft(shown);
    setInvalid(false);
    requestAnimationFrame(() => inputRef.current?.select());
  }, [editing]); // eslint-disable-line react-hooks/exhaustive-deps

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={draft}
        aria-label="Instrument (DEMO-A, DEMO-B, DEMO-C or DEMO-D)"
        aria-invalid={invalid}
        title={invalid ? "Only DEMO-A, DEMO-B, DEMO-C or DEMO-D are in the demo data" : undefined}
        onChange={(e) => { setDraft(e.target.value.toUpperCase()); setInvalid(false); }}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            const v = normalizeSymbol(draft);
            if (!v) { setInvalid(true); return; }
            setWidgetSymbol(widget.id, v);
            setEditing(false);
          }
          if (e.key === "Escape") setEditing(false);
        }}
        onBlur={() => setEditing(false)}
        className={`ml-2 w-16 !border-0 !border-b bg-transparent text-[var(--text)] px-0 py-0 text-[13px] leading-none ${invalid ? "!border-[var(--down)]" : "!border-[var(--amber-dim)]"}`}
      />
    );
  }

  return (
    <span
      className="ml-2 text-[var(--text)] cursor-pointer hover:text-[var(--amber)]"
      title="Click to set this widget's instrument (DEMO-A to DEMO-D)"
      onMouseDown={(e) => e.stopPropagation()}
      onClick={() => setEditing(true)}
    >
      {shown}
    </span>
  );
}

const TITLES: Record<string, string> = {
  chart: "Price History (simulated)", macro: "Point-in-Time Macro", research: "Research Result (illustrative)", sources: "Sources & Licences",
};

export default function Workspace() {
  const widgets = useTerminal((s) => s.widgets);
  const layout = useTerminal((s) => s.layout);
  const setLayout = useTerminal((s) => s.setLayout);
  const removeWidget = useTerminal((s) => s.removeWidget);
  const toggleLinked = useTerminal((s) => s.toggleLinked);
  const activeSymbol = useTerminal((s) => s.activeSymbol);
  const focus = useTerminal((s) => s.focus);
  const importedActive = useImported((s) => s.active);
  const hasImport = useImported((s) => s.set !== null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [viewH, setViewH] = useState<number | null>(null);

  // Visible height of the scrolling <main> that holds the grid.
  useLayoutEffect(() => {
    const host = wrapRef.current?.parentElement;
    if (!host) return;
    const measure = () => setViewH(host.clientHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(host);
    return () => ro.disconnect();
  }, []);

  // Scroll a newly added / re-requested panel into view and flash its border.
  useEffect(() => {
    if (!focus) return;
    const raf = requestAnimationFrame(() => {
      const el = document.querySelector<HTMLElement>(`[data-widget-id="${focus.id}"]`);
      if (!el) return;
      el.scrollIntoView({ block: "nearest" });
      el.classList.remove("panel-flash");
      void el.offsetWidth; // restart the animation
      el.classList.add("panel-flash");
    });
    return () => cancelAnimationFrame(raf);
  }, [focus]);

  const symbolAware = new Set(["chart"]);
  const rowHeight = viewH === null ? null : Math.max(MIN_ROW_HEIGHT, (viewH - MARGIN * 2 - MARGIN * (SCREEN_ROWS - 1)) / SCREEN_ROWS);

  return (
    <div ref={wrapRef}>
    {rowHeight !== null && (
    <Grid
      className="layout"
      layout={layout}
      cols={12}
      rowHeight={rowHeight}
      margin={[MARGIN, MARGIN]}
      draggableHandle=".panel-title"
      onLayoutChange={(l) => setLayout(l.map(({ i, x, y, w, h }) => ({ i, x, y, w, h })))}
    >
      {widgets.map((w) => (
        <div key={w.id} data-widget={w.type} data-widget-id={w.id}>
          <div className="terminal-panel">
            <div className="panel-title">
              <span>
                {/* OS-P2B: a chart showing an imported file is titled as such, without a demo instrument tag. */}
                {w.type === "chart" && importedActive[w.id] && hasImport ? "Price History (imported file)" : TITLES[w.type]}
                {symbolAware.has(w.type) && !(w.type === "chart" && importedActive[w.id] && hasImport) && <SymbolTag widget={w} activeSymbol={activeSymbol} />}
              </span>
              <span className="flex gap-2 items-center">
                {symbolAware.has(w.type) && (
                  <button
                    title={w.linked ? "Linked to active symbol (click to unlink)" : "Unlinked (click to link)"}
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={() => toggleLinked(w.id)}
                    className={w.linked ? "text-[var(--amber)]" : "dim"}
                  >
                    ⛓
                  </button>
                )}
                <button
                  aria-label={`Close ${TITLES[w.type]}`}
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={() => removeWidget(w.id)}
                  className="dim hover:text-[var(--down)]"
                >
                  ✕
                </button>
              </span>
            </div>
            <div className="flex-1 overflow-auto min-h-0">
              <WidgetErrorBoundary name={TITLES[w.type]}>
                <WidgetBody widget={w} />
              </WidgetErrorBoundary>
            </div>
          </div>
        </div>
      ))}
    </Grid>
    )}
    </div>
  );
}
