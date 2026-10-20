// Adapted from OpenTerminal web/lib/api.ts (MIT, see LICENSES/OpenTerminal-MIT.txt in the repository root). The upstream
// HTTP API client (/api/* proxied to market-data providers) is removed: this build reads only static JSON files from
// the same origin, ./data/<name>, which the local server (`python3 -m terminal_demo.serve`) serves from demo-data/.

const DATA_FILES = ["etf_prices.json", "macro_series.json", "research.json", "manifest.json"] as const;
export type DataFile = (typeof DATA_FILES)[number];

// Build-time data mode (next.config.ts). Files outside the mode are never requested; their panels show an explicit
// "not included" state instead of an error.
//   demo     — simulated market bars, illustrative research figures and their manifest (no macro series);
//   excluded — official release-desk metadata only.
export type DataMode = "demo" | "excluded";
const MODE = process.env.NEXT_PUBLIC_HISTORICAL_DATA;
export const HISTORICAL_DATA: DataMode = MODE === "excluded" ? "excluded" : "demo";
const DEMO_FILES: readonly DataFile[] = ["etf_prices.json", "research.json", "manifest.json"];

/** Whether this build may request the given data file at all. */
export function dataIncluded(name: DataFile): boolean {
  return HISTORICAL_DATA === "demo" && DEMO_FILES.includes(name);
}

export class NotIncludedError extends Error {
  constructor(public readonly file: DataFile) {
    super(`${file} is not included in this build`);
    this.name = "NotIncludedError";
  }
}

export function isNotIncluded(e: unknown): e is NotIncludedError {
  return e instanceof NotIncludedError;
}

/**
 * Same-origin static JSON only; any other path is refused. A demo build displays only generated data: a file without
 * the `synthetic: true` marker is rejected, so real-looking values can never appear under the demo labels.
 */
export async function loadLocal<T>(name: DataFile): Promise<T> {
  if (!DATA_FILES.includes(name)) throw new Error(`Refused data path: ${name}`);
  if (!dataIncluded(name)) throw new NotIncludedError(name);
  const res = await fetch(`./data/${name}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`Missing local data file ${name} (HTTP ${res.status})`);
  const body = await res.json();
  if (body?.synthetic !== true) throw new Error(`Refused ${name}: not marked as generated demo data`);
  return body as T;
}

/** Generator identity carried by every demo file. */
export type GeneratorInfo = { name: string; seed: number; calendar: string; start: string; end: string };

export type Candle = {
  date: string; time: number; open: number; high: number; low: number; close: number; adjClose: number; volume: number;
};
export type EtfExport = {
  bound: string; source: string; symbols: string[]; candles: Record<string, Candle[]>;
  synthetic?: boolean; notice?: string; generator?: GeneratorInfo; names?: Record<string, string>;
};

export type MacroPoint = { release?: string; reference?: string; date?: string; value: number | null };
export type MacroSeries = {
  id: string; name: string; units: string; frequency: string; kind: "first_release" | "daily"; asOf?: string[]; points: MacroPoint[];
};
export type MacroExport = { bound: string; series: MacroSeries[] };

export type HorizonResult = {
  label: string; estimate: number; interval: [number, number]; ci_level: number; cells_eligible: number; cells_total: number;
  invalid_replicates: number; replicates: number;
  per_algorithm: Record<string, { auc_market_only: number; auc_macro_enhanced: number; delta_auc: number }>;
  mean_delta_by_year: Record<string, number>;
};
export type Research = {
  policy_id: string; policy_sha256: string; approval_status: string; evaluation_sha256: string; run: string; label_policy: string;
  code_commit: string; multiplicity: string; review: { verdict: string; file: string; sha256: string };
  results: Record<string, HorizonResult>;
  synthetic?: boolean; illustrative?: boolean; notice?: string; generator?: GeneratorInfo;
};
export type Manifest = {
  built_utc: string; bound: string; snapshot_id: string; snapshot_end: string; repository_head: string;
  raw_sha256: Record<string, string>; evidence_sha256: Record<string, string>; files_sha256: Record<string, string>;
  synthetic?: boolean; notice?: string; generator?: GeneratorInfo;
};

export function fmt(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || !isFinite(n)) return "—";
  return n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function fmtBig(n: number | null | undefined): string {
  if (n === null || n === undefined || !isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1e12) return (n / 1e12).toFixed(2) + "T";
  if (abs >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (abs >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (abs >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(n);
}

export function signed(n: number, digits = 4): string {
  return (n >= 0 ? "+" : "−") + Math.abs(n).toFixed(digits);
}
