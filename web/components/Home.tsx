"use client";

// T2-G1: landing page. Four product areas with an honest status each; nothing here loads or writes the
// Market workspace state. Macro opens the existing historical macro panel inside Market.
// T3-I v1: the Macro card also opens the read-only Release Schedule (secondary action keeps the explorer).

// Demo: the cards say which data is real (release metadata) and which is simulated or illustrative.

import ShellHeader from "./ShellHeader";
import { HISTORICAL_DATA } from "../lib/api";
import { PRODUCT_NAME } from "../lib/buildInfo";
import { hrefFor, navigate, type NavIntent, type WorkspaceId } from "../lib/nav";

type Card = {
  title: string;
  status: string;
  statusTone: "ok" | "partial" | "planned";
  now: string;
  notYet: string;
  action?: { label: string; ws: WorkspaceId; intent?: NavIntent };
  secondary?: { label: string; ws: WorkspaceId; intent?: NavIntent };
};

const CARDS: Card[] = [
  {
    title: "Macro News & Events",
    status: "RELEASE DESK · REAL METADATA",
    statusTone: "ok",
    now: "Release schedule for CPI, Employment Situation and GDP Advance: official schedule and publication status from BLS and BEA pages, as a dated snapshot.",
    notYet: "No economic values, live feed or news; nothing is fetched automatically. The point-in-time macro explorer's dataset is not included.",
    action: { label: "Open release schedule", ws: "macro" },
  },
  {
    title: "Market Intelligence",
    status: "SIMULATED DATA",
    statusTone: "partial",
    now: "Your saved workspace: interactive daily charts with indicators, zoom, pan and saved layouts, on four simulated instruments (DEMO-A to DEMO-D).",
    notYet: "Simulated bars, not real market prices; no live or intraday data.",
    action: { label: "Open workspace", ws: "market" },
  },
  {
    title: "Backtesting & Research",
    status: "ILLUSTRATIVE DEMO",
    statusTone: "partial",
    now: "The research results view, filled with randomly generated illustrative figures. The author's private historical evaluation is not included in this repository.",
    notYet: "Executable backtesting is not built.",
    action: { label: "View research page", ws: "research" },
  },
  {
    title: "AI Research Assistant",
    status: "PLANNED",
    statusTone: "planned",
    now: "Planned: questions answered from approved evidence, with citations.",
    notYet: "Not available — no AI service is connected.",
  },
];

const NOT_INCLUDED: Record<string, Partial<Card>> = {
  "Market Intelligence": {
    status: "DATASET NOT INCLUDED",
    now: "Your saved workspace layout: daily chart panels with indicators, the point-in-time macro panel and sources.",
    notYet: "This build contains release-desk metadata only, so the panels show a notice instead of data.",
  },
  "Backtesting & Research": {
    status: "NOT INCLUDED",
    now: "The research results view.",
    notYet: "This build contains release-desk metadata only. Executable backtesting is not built.",
  },
};
const SHOWN: Card[] = HISTORICAL_DATA === "excluded" ? CARDS.map((c) => ({ ...c, ...NOT_INCLUDED[c.title] })) : CARDS;

const TONE: Record<Card["statusTone"], string> = {
  ok: "border-[var(--up)] text-[var(--up)]",
  partial: "border-[var(--amber)] text-[var(--amber)]",
  planned: "border-[var(--text-dim)] text-[var(--text-dim)]",
};

function CardLink({ a }: { a: NonNullable<Card["secondary"]> }) {
  return (
    <a
      href={hrefFor(a.ws)}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        navigate(a.ws, a.intent);
      }}
      className="inline-block px-3 py-1 border border-[var(--border)] hover:border-[var(--amber)] hover:text-[var(--amber)] focus-visible:border-[var(--amber)] focus-visible:text-[var(--amber)] outline-none"
    >
      {a.label} →
    </a>
  );
}

export default function Home() {
  return (
    <div className="flex flex-col h-screen">
      <ShellHeader current="home" />
      <main className="flex-1 overflow-auto">
        <div className="max-w-[1040px] mx-auto px-6 py-8 flex flex-col gap-6">
          <div className="flex flex-col gap-1">
            <h1 className="amber font-bold tracking-widest text-[15px]">{PRODUCT_NAME.toUpperCase()}</h1>
            <p className="dim text-[12px]" data-testid="home-intro">
              {HISTORICAL_DATA === "excluded"
                ? "Local terminal. This build contains official release-desk metadata only. Nothing here is live, and nothing here is a trading signal."
                : "Local portfolio demo. The release metadata (BLS, BEA) is real; the market prices and research figures are simulated. Nothing here is live, and nothing here is a trading signal."}
            </p>
          </div>
          <ul className="grid grid-cols-1 md:grid-cols-2 gap-4" aria-label="Product areas">
            {SHOWN.map((c) => (
              <li key={c.title} className={`terminal-panel !h-auto ${c.action ? "" : "opacity-70"}`} aria-disabled={c.action ? undefined : true}>
                <div className="panel-title !cursor-default">
                  <span>{c.title}</span>
                  <span className={`border px-1.5 text-[9px] tracking-wider ${TONE[c.statusTone]}`}>{c.status}</span>
                </div>
                <div className="p-3 flex flex-col gap-2 text-[12px] flex-1">
                  <p>{c.now}</p>
                  <p className="dim">{c.notYet}</p>
                  <div className="mt-auto pt-2 flex flex-wrap gap-2">
                    {c.action ? (
                      <a
                        href={hrefFor(c.action.ws)}
                        onClick={(e) => {
                          if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                          e.preventDefault();
                          navigate(c.action!.ws, c.action!.intent);
                        }}
                        className="inline-block px-3 py-1 border border-[var(--border)] hover:border-[var(--amber)] hover:text-[var(--amber)] focus-visible:border-[var(--amber)] focus-visible:text-[var(--amber)] outline-none"
                      >
                        {c.action.label} →
                      </a>
                    ) : (
                      <span className="inline-block px-3 py-1 border border-[var(--border)] dim" aria-disabled="true">Not available</span>
                    )}
                    {c.secondary && <CardLink a={c.secondary} />}
                  </div>
                </div>
              </li>
            ))}
          </ul>
          <p className="dim text-[11px]">
            Release desk: Source: U.S. Bureau of Labor Statistics · Source: U.S. Bureau of Economic Analysis (official pages).
            {HISTORICAL_DATA === "demo" ? " Market bars and research figures are generated by this repository and are not real." : ""} Data, sources and
            licences under Settings.
          </p>
        </div>
      </main>
    </div>
  );
}
