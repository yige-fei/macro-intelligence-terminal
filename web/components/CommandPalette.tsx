"use client";

// Adapted from OpenTerminal web/components/CommandPalette.tsx (MIT, see LICENSES/OpenTerminal-MIT.txt in the repository root). The remote /api/search
// lookup is replaced by a local index of the demo instruments and, when included, the macro series.

import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { loadLocal, type MacroExport } from "../lib/api";
import { SYMBOL_NAMES, SYMBOLS } from "../lib/symbol";
import { useTerminal } from "../store/terminal";

type Entry = { kind: "SIM" | "MACRO"; id: string; name: string; detail: string };

export default function CommandPalette() {
  const open = useTerminal((s) => s.commandOpen);
  const setOpen = useTerminal((s) => s.setCommandOpen);
  const setActiveSymbol = useTerminal((s) => s.setActiveSymbol);
  const addWidget = useTerminal((s) => s.addWidget);
  const setWidgetView = useTerminal((s) => s.setWidgetView);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const { data: macro } = useQuery({ queryKey: ["macro"], queryFn: () => loadLocal<MacroExport>("macro_series.json"), staleTime: Infinity, enabled: open });

  const index: Entry[] = useMemo(() => [
    ...SYMBOLS.map((s) => ({ kind: "SIM" as const, id: s, name: SYMBOL_NAMES[s], detail: "simulated daily, 2016–2023" })),
    ...(macro?.series ?? []).map((s) => ({ kind: "MACRO" as const, id: s.id, name: s.name, detail: s.kind === "first_release" ? "first release" : "daily" })),
  ], [macro]);
  const q = query.trim().toLowerCase();
  const results = q ? index.filter((e) => e.id.toLowerCase().includes(q) || e.name.toLowerCase().includes(q)) : index;

  useEffect(() => {
    if (open) {
      setQuery("");
      setSelected(0);
      setTimeout(() => inputRef.current?.focus(), 30);
    }
  }, [open]);

  useEffect(() => setSelected(0), [results.length]);

  if (!open) return null;

  const pick = (e: Entry) => {
    if (e.kind === "SIM") setActiveSymbol(e.id);
    else setWidgetView(addWidget("macro"), { series: e.id }); // the single macro panel (reopened if closed)
    setOpen(false);
  };

  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex items-start justify-center pt-24" onClick={() => setOpen(false)}>
      <div className="w-[560px] max-w-[92vw] bg-[var(--panel)] border border-[var(--amber-dim)]" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          value={query}
          aria-label="Search instruments and macro series"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setOpen(false);
            if (e.key === "ArrowDown") setSelected((s) => Math.min(s + 1, results.length - 1));
            if (e.key === "ArrowUp") setSelected((s) => Math.max(s - 1, 0));
            if (e.key === "Enter" && results[selected]) pick(results[selected]);
          }}
          placeholder="DEMO-A, DEMO-B, DEMO-C or DEMO-D (simulated instruments)"
          className="w-full !border-0 !border-b !border-[var(--border)] px-3 py-2 text-[13px]"
        />
        <div className="max-h-80 overflow-auto" role="listbox">
          {results.map((r, i) => (
            <div
              key={r.kind + r.id}
              role="option"
              aria-selected={i === selected}
              onClick={() => pick(r)}
              className={`px-3 py-1.5 flex gap-3 cursor-pointer ${i === selected ? "bg-[#1f1a10] text-[var(--amber)]" : "hover:bg-[#161616]"}`}
            >
              <span className="w-24 font-bold">{r.id}</span>
              <span className="flex-1 truncate">{r.name}</span>
              <span className="dim">{r.detail}</span>
              <span className="dim w-14 text-right">{r.kind}</span>
            </div>
          ))}
          {query && results.length === 0 && <div className="px-3 py-3 dim">No local match for “{query}”</div>}
        </div>
      </div>
    </div>
  );
}
