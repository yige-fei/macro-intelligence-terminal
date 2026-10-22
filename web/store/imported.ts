"use client";

// OS-P2B: the user-imported dataset, held in memory for this browser tab only. This store is deliberately NOT persisted
// (no localStorage, IndexedDB, cookies or server): a reload returns every chart to its saved built-in dataset.
// While a chart panel shows imported data, its view settings (range, chart type, indicators) live here as an in-memory
// override, so the saved workspace layout in store/terminal.ts is never changed by imported data.

import { create } from "zustand";
import type { Candle } from "../lib/api";
import type { ImportIssue } from "../lib/importData";
import type { WidgetView } from "./terminal";

export type ImportedSet = { name: string; size: number; format: "csv" | "json"; candles: Candle[]; first: string; last: string; warnings: string[] };
export type ImportNotice =
  | { ok: true; widgetId: string; name: string; rows: number; first: string; last: string; warnings: string[] }
  | { ok: false; widgetId: string; name: string; issues: ImportIssue[]; truncated: boolean };

type ImportState = {
  set: ImportedSet | null;
  notice: ImportNotice | null;
  active: Record<string, boolean>;       // chart panels currently showing the imported data
  views: Record<string, WidgetView>;     // their in-memory view settings
  accept: (set: ImportedSet, widgetId: string, initialView: WidgetView) => void;
  reject: (notice: Extract<ImportNotice, { ok: false }>) => void;
  show: (widgetId: string, initialView: WidgetView) => void;
  hide: (widgetId: string) => void;
  setView: (widgetId: string, patch: WidgetView) => void;
  dismiss: () => void;
};

export const useImported = create<ImportState>()((set) => ({
  set: null,
  notice: null,
  active: {},
  views: {},
  // A newly accepted file replaces the previous one everywhere it is shown.
  accept: (s, widgetId, initialView) =>
    set((st) => ({
      set: s,
      notice: { ok: true, widgetId, name: s.name, rows: s.candles.length, first: s.first, last: s.last, warnings: s.warnings },
      active: { ...st.active, [widgetId]: true },
      views: { ...st.views, [widgetId]: st.active[widgetId] ? { ...st.views[widgetId], range: "ALL" } : initialView },
    })),
  // A rejected file changes nothing but the message: the previous imported data (if any) stays as it was.
  reject: (notice) => set({ notice }),
  show: (widgetId, initialView) =>
    set((st) => ({ active: { ...st.active, [widgetId]: true }, views: { ...st.views, [widgetId]: st.views[widgetId] ?? initialView } })),
  hide: (widgetId) => set((st) => ({ active: { ...st.active, [widgetId]: false } })),
  setView: (widgetId, patch) => set((st) => ({ views: { ...st.views, [widgetId]: { ...st.views[widgetId], ...patch } } })),
  dismiss: () => set({ notice: null }),
}));
