"use client";

// Adapted from OpenTerminal web/components/Terminal.tsx (MIT, see LICENSES/OpenTerminal-MIT.txt in the repository root): same shell and keyboard model
// (Cmd/Ctrl+K palette, Alt+number adds a chart or shows the single macro/research/sources panel).

import { useEffect } from "react";
import TopBar from "./TopBar";
import Sidebar from "./Sidebar";
import Workspace from "./Workspace";
import CommandPalette from "./CommandPalette";
import { useTerminal } from "../store/terminal";

export default function Terminal() {
  const setCommandOpen = useTerminal((s) => s.setCommandOpen);
  const addWidget = useTerminal((s) => s.addWidget);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCommandOpen(true);
        return;
      }
      // Match the physical key: on macOS Option+1..4 reports key "¡ ™ £ ¢", only `code` carries the digit.
      // Ignored while typing in a field and while the palette is open.
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
      if (e.altKey && !e.ctrlKey && !e.metaKey && !typing && !useTerminal.getState().commandOpen) {
        const map: Record<string, () => void> = {
          Digit1: () => addWidget("chart"),
          Digit2: () => addWidget("macro"),
          Digit3: () => addWidget("research"),
          Digit4: () => addWidget("sources"),
        };
        const fn = map[e.code];
        if (fn) {
          e.preventDefault();
          fn();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setCommandOpen, addWidget]);

  return (
    <div className="flex flex-col h-screen">
      <TopBar />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar />
        <main className="flex-1 overflow-auto">
          <Workspace />
        </main>
      </div>
      <CommandPalette />
    </div>
  );
}
