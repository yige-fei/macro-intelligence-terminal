"use client";

// Adapted from OpenTerminal web/store/terminal.ts (MIT, see LICENSES/OpenTerminal-MIT.txt in the repository root): same Zustand workspace model
// (widgets + react-grid-layout positions, persisted locally), reduced to the research widgets.
// T1: per-widget view state is persisted with the workspace, and adding a macro/research/sources panel focuses
// an existing one instead of creating another. Stored state is sanitised on every load.
// T1 migration repair: this build persists under its own key (STORAGE_KEY). The pre-T1 workspace key
// (LEGACY_STORAGE_KEY) is only ever READ, once, to import a workspace when this build has none of its own; it is
// never written or removed, so the previous build still finds its workspace unchanged. Imported workspaces keep
// every widget instance (including several macro/research/sources panels saved by the previous build) and their
// layout exactly; only entries this build cannot render or place are left out (they stay in the legacy key).

import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import { normalizeSymbol, SYMBOLS } from "../lib/symbol";

export const STORAGE_KEY = "macro-research-workspace-v2";
export const LEGACY_STORAGE_KEY = "macro-research-workspace-v1";
/** An unparseable STORAGE_KEY value is copied here once before this build replaces it. */
export const UNREADABLE_BACKUP_KEY = "macro-research-workspace-v2-unreadable";

export type WidgetType = "chart" | "macro" | "research" | "sources";

/** Chart: dataset / range / chart type / indicators. Macro: series / range. Widgets ignore values they don't know. */
export type WidgetView = {
  dataset?: string;
  range?: string;
  chartType?: string;
  indicators?: string[];
  series?: string;
};

export type WidgetInstance = {
  id: string;
  type: WidgetType;
  symbol?: string;
  linked: boolean; // follows the globally active symbol
  view?: WidgetView;
};

export type LayoutItem = { i: string; x: number; y: number; w: number; h: number };

type TerminalState = {
  activeSymbol: string;
  widgets: WidgetInstance[];
  layout: LayoutItem[];
  commandOpen: boolean;
  focus: { id: string; n: number } | null; // transient: scroll to and highlight a panel
  setActiveSymbol: (s: string) => void;
  setCommandOpen: (open: boolean) => void;
  addWidget: (type: WidgetType, symbol?: string) => string;
  removeWidget: (id: string) => void;
  setWidgetSymbol: (id: string, symbol: string) => void;
  toggleLinked: (id: string) => void;
  setWidgetView: (id: string, patch: WidgetView) => void;
  setLayout: (layout: LayoutItem[]) => void;
  resetWorkspace: () => void;
};

/** Adding one of these again focuses the existing panel (saved extra instances are kept and still render). */
export const SINGLETON: ReadonlySet<WidgetType> = new Set(["macro", "research", "sources"]);
const TYPES: ReadonlySet<string> = new Set(["chart", "macro", "research", "sources"]);

/** Rows that fill one screen; Workspace derives the row height from the visible height. */
export const SCREEN_ROWS = 24;

const DEFAULT_WIDGETS: WidgetInstance[] = [
  { id: "w-chart", type: "chart", linked: true },
  { id: "w-research", type: "research", linked: false },
  { id: "w-macro", type: "macro", linked: false },
  { id: "w-sources", type: "sources", linked: false },
];

const DEFAULT_LAYOUT: LayoutItem[] = [
  { i: "w-chart", x: 0, y: 0, w: 8, h: 14 },
  { i: "w-research", x: 8, y: 0, w: 4, h: 16 },
  { i: "w-macro", x: 0, y: 14, w: 8, h: 10 },
  { i: "w-sources", x: 8, y: 16, w: 4, h: 8 },
];

const SIZE_BY_TYPE: Record<WidgetType, { w: number; h: number }> = {
  chart: { w: 8, h: 14 },
  macro: { w: 8, h: 10 },
  research: { w: 4, h: 16 },
  sources: { w: 4, h: 8 },
};

const int = (v: unknown, min: number, max: number) => typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;

/**
 * Makes stored state renderable without discarding user work: keeps every widget instance of a known type
 * (several macro/research/sources panels included) and its saved layout, drops only entries this build cannot
 * render (unknown type, repeated id) or place (out-of-grid layout values, which get a fresh slot), and adopts the
 * pre-T1 macro series key. A saved empty workspace stays empty; the default workspace is used only when no
 * widget list was stored or none of its entries is usable.
 */
function sanitize(widgetsIn: unknown, layoutIn: unknown): { widgets: WidgetInstance[]; layout: LayoutItem[] } {
  const seenIds = new Set<string>();
  const widgets: WidgetInstance[] = [];
  for (const w of Array.isArray(widgetsIn) ? widgetsIn : []) {
    if (!w || typeof w.id !== "string" || !TYPES.has(w.type) || seenIds.has(w.id)) continue;
    seenIds.add(w.id);
    widgets.push({
      id: w.id,
      type: w.type,
      symbol: typeof w.symbol === "string" ? normalizeSymbol(w.symbol) ?? undefined : undefined,
      linked: typeof w.linked === "boolean" ? w.linked : w.type === "chart",
      view: w.view && typeof w.view === "object" ? { ...(w.view as WidgetView) } : undefined,
    });
  }
  const savedEmpty = Array.isArray(widgetsIn) && widgetsIn.length === 0;
  if (widgets.length === 0 && !savedEmpty) return { widgets: DEFAULT_WIDGETS, layout: DEFAULT_LAYOUT };

  const stored = (Array.isArray(layoutIn) ? layoutIn : []).filter(
    (l): l is LayoutItem => !!l && typeof l.i === "string" && int(l.x, 0, 11) && int(l.y, 0, 10_000) && int(l.w, 1, 12) && int(l.h, 1, 200) && l.x + l.w <= 12
  );
  const layout: LayoutItem[] = [];
  for (const w of widgets) {
    const l = stored.find((s) => s.i === w.id);
    if (l) layout.push({ i: l.i, x: l.x, y: l.y, w: l.w, h: l.h });
  }
  let bottom = layout.reduce((m, l) => Math.max(m, l.y + l.h), 0);
  for (const w of widgets) {
    if (layout.some((l) => l.i === w.id)) continue;
    layout.push({ i: w.id, x: 0, y: bottom, ...SIZE_BY_TYPE[w.type] });
    bottom += SIZE_BY_TYPE[w.type].h;
  }

  const macro = widgets.find((w) => w.type === "macro");
  if (macro && !macro.view?.series) {
    try {
      const legacy = window.localStorage.getItem("macro-research-series");
      if (legacy) macro.view = { ...macro.view, series: legacy };
    } catch { /* storage unavailable */ }
  }
  return { widgets, layout };
}

const parses = (raw: string | null): raw is string => {
  if (raw === null) return false;
  try { JSON.parse(raw); return true; } catch { return false; }
};

/**
 * localStorage adapter. Reads this build's key; when it is absent (first run of this build) it reads the legacy
 * key instead, so the legacy workspace is imported and then saved under STORAGE_KEY. Writes only ever go to
 * STORAGE_KEY. An unreadable STORAGE_KEY value is kept once under UNREADABLE_BACKUP_KEY; unreadable values are
 * reported as absent so the workspace still loads.
 */
const workspaceStorage: StateStorage = {
  getItem: (name) => {
    try {
      const own = window.localStorage.getItem(name);
      if (parses(own)) return own;
      if (own !== null && window.localStorage.getItem(UNREADABLE_BACKUP_KEY) === null) window.localStorage.setItem(UNREADABLE_BACKUP_KEY, own);
      const legacy = window.localStorage.getItem(LEGACY_STORAGE_KEY);
      return parses(legacy) ? legacy : null;
    } catch {
      return null; // storage unavailable
    }
  },
  setItem: (name, value) => {
    try { window.localStorage.setItem(name, value); } catch { /* storage unavailable or full */ }
  },
  removeItem: (name) => {
    try { window.localStorage.removeItem(name); } catch { /* storage unavailable */ }
  },
};

export const useTerminal = create<TerminalState>()(
  persist(
    (set, get) => ({
      activeSymbol: SYMBOLS[0],
      widgets: DEFAULT_WIDGETS,
      layout: DEFAULT_LAYOUT,
      commandOpen: false,
      focus: null,
      setActiveSymbol: (s) => {
        const sym = normalizeSymbol(s);
        if (sym) set({ activeSymbol: sym });
      },
      setCommandOpen: (open) => set({ commandOpen: open }),
      addWidget: (type, symbol) => {
        const st = get();
        const n = (st.focus?.n ?? 0) + 1;
        const existing = SINGLETON.has(type) ? st.widgets.find((w) => w.type === type) : undefined;
        if (existing) {
          set({ focus: { id: existing.id, n } });
          return existing.id;
        }
        const id = `w-${type}-${Date.now()}`;
        const maxY = st.layout.reduce((m, l) => Math.max(m, l.y + l.h), 0);
        set({
          widgets: [...st.widgets, { id, type, symbol, linked: !symbol }],
          layout: [...st.layout, { i: id, x: 0, y: maxY, ...SIZE_BY_TYPE[type] }],
          focus: { id, n },
        });
        return id;
      },
      removeWidget: (id) =>
        set((st) => ({
          widgets: st.widgets.filter((w) => w.id !== id),
          layout: st.layout.filter((l) => l.i !== id),
        })),
      setWidgetSymbol: (id, symbol) => {
        const sym = normalizeSymbol(symbol);
        if (!sym) return;
        set((st) => ({
          widgets: st.widgets.map((w) => (w.id === id ? { ...w, symbol: sym, linked: false } : w)),
        }));
      },
      toggleLinked: (id) =>
        set((st) => ({
          widgets: st.widgets.map((w) => (w.id === id ? { ...w, linked: !w.linked } : w)),
        })),
      setWidgetView: (id, patch) =>
        set((st) => ({
          widgets: st.widgets.map((w) => (w.id === id ? { ...w, view: { ...w.view, ...patch } } : w)),
        })),
      setLayout: (layout) => set({ layout }),
      resetWorkspace: () => set({ widgets: DEFAULT_WIDGETS, layout: DEFAULT_LAYOUT, focus: null }),
    }),
    {
      name: STORAGE_KEY,
      version: 2,
      storage: createJSONStorage(() => workspaceStorage),
      // Only the workspace is persisted; the palette state and focus requests are per session.
      partialize: (st) => ({ activeSymbol: st.activeSymbol, widgets: st.widgets, layout: st.layout }),
      // Stored state of any earlier version is passed through; `merge` sanitises it.
      migrate: (persisted) => persisted as Pick<TerminalState, "activeSymbol" | "widgets" | "layout">,
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<TerminalState>;
        return {
          ...current,
          activeSymbol: normalizeSymbol(String(p.activeSymbol ?? "")) ?? current.activeSymbol,
          ...sanitize(p.widgets ?? current.widgets, p.layout ?? current.layout),
        };
      },
    }
  )
);

/** Symbol a widget should display: its own, or the active one when linked. */
export function useWidgetSymbol(widget: WidgetInstance): string {
  const active = useTerminal((s) => s.activeSymbol);
  return widget.linked ? active : widget.symbol ?? active;
}
