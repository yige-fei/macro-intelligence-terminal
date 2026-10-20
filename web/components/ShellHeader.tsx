"use client";

// T2-G1: header for the Home and Research views, styled like the Terminal TopBar. Same historical-data badge
// (from the local manifest); links switch workspaces through the URL. T3-I v1: MACRO link; optional badge text for
// views that are not historical (the Release Schedule).

// T4-P1: product name, SETTINGS link, and an honest badge and build stamp (see historicalBadge / buildLabel).

import { useQuery } from "@tanstack/react-query";
import { HISTORICAL_DATA, loadLocal, type Manifest } from "../lib/api";
import { buildLabel, PRODUCT_NAME } from "../lib/buildInfo";
import { hrefFor, navigate, type WorkspaceId } from "../lib/nav";

const LINKS: Array<{ ws: WorkspaceId; label: string }> = [
  { ws: "home", label: "HOME" },
  { ws: "macro", label: "MACRO" },
  { ws: "market", label: "MARKET" },
  { ws: "research", label: "RESEARCH" },
  { ws: "settings", label: "SETTINGS" },
];

/** Header badge for the historical views: never claims a data range the build does not contain. */
export function historicalBadge(manifest: Manifest | undefined): string {
  if (HISTORICAL_DATA === "excluded") return "HISTORICAL DATA NOT INCLUDED · NOT LIVE";
  return `DEMO · SIMULATED MARKET DATA TO ${manifest?.bound ?? "2023-12-29"} · NOT LIVE`;
}

export function NavLink({ ws, children, className = "", current = false }: { ws: WorkspaceId; children: React.ReactNode; className?: string; current?: boolean }) {
  return (
    <a
      href={hrefFor(ws)}
      aria-current={current ? "page" : undefined}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; // let the browser open a new tab/window
        e.preventDefault();
        navigate(ws);
      }}
      className={className}
    >
      {children}
    </a>
  );
}

/** T4-AFK: the one workspace navigation, shared by this header and the Market TopBar. */
export function WorkspaceNav({ current }: { current: WorkspaceId }) {
  return (
    <nav className="flex gap-1 shrink-0" aria-label="Workspaces">
      {LINKS.map((l) => (
        <NavLink
          key={l.ws}
          ws={l.ws}
          current={current === l.ws}
          className={`px-2 py-[1px] border whitespace-nowrap ${current === l.ws ? "border-[var(--amber)] text-[var(--amber)]" : "border-[var(--border)] text-[var(--text)] hover:border-[var(--amber)] hover:text-[var(--amber)]"}`}
        >
          {l.label}
        </NavLink>
      ))}
    </nav>
  );
}

/** T4-AFK: build stamp shared by both headers; truncates (full text on hover) rather than wrapping. */
export function BuildStamp() {
  const text = `local demo build · no feeds · ${buildLabel()}`;
  return <span className="dim ml-auto min-w-0 truncate" data-testid="build-stamp" title={text}>{text}</span>;
}

export default function ShellHeader({ current, badge }: { current: WorkspaceId; badge?: string }) {
  const { data: manifest } = useQuery({ queryKey: ["manifest"], queryFn: () => loadLocal<Manifest>("manifest.json"), staleTime: Infinity });
  return (
    <header className="flex items-center gap-4 px-3 h-8 bg-[var(--panel-2)] border-b border-[var(--border)] text-[11px] shrink-0">
      {/* T4-P1: one line at desktop widths — title, badge and links never wrap; the build stamp truncates instead. */}
      <NavLink ws="home" className="amber font-bold tracking-widest whitespace-nowrap shrink-0" current={current === "home"}>{PRODUCT_NAME.toUpperCase()}</NavLink>
      <span className="hist-badge whitespace-nowrap shrink-0" role="status">{badge ?? historicalBadge(manifest)}</span>
      <WorkspaceNav current={current} />
      <BuildStamp />
    </header>
  );
}
