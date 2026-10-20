"use client";

// Shown instead of a panel's content when its dataset is not included in this build. Not an error: the panel is unchanged and would render with its dataset.

import { HISTORICAL_DATA, type DataFile } from "../lib/api";
import { NavLink } from "./ShellHeader";

const WHAT: Record<DataFile, string> = {
  "etf_prices.json": "simulated daily market bars",
  "macro_series.json": "point-in-time macro series (first releases, yields, volatility)",
  "research.json": "illustrative research figures",
  "manifest.json": "the provenance record of the demo data",
};

export default function NotIncluded({ file }: { file: DataFile }) {
  return (
    <div className="p-3 text-[12px] flex flex-col gap-1 max-w-[640px]" role="status" data-testid="not-included" data-file={file}>
      <b className="amber">Not included in this build</b>
      <span>
        This panel shows {WHAT[file]}. This build contains official release-desk metadata
        {HISTORICAL_DATA === "demo" ? ", simulated market bars and illustrative research figures only" : " only"}, so that dataset is
        absent and nothing is shown. The panel itself is unchanged.
      </span>
      <span className="dim">
        {file === "macro_series.json" ? "No lawfully redistributable point-in-time macro dataset is bundled yet." : "Build with the demo data mode to include it."}{" "}
        <NavLink ws="settings" className="underline decoration-dotted hover:text-[var(--amber)]">Settings → Data</NavLink>
      </span>
    </div>
  );
}
