// T3-I v1: read-only loader and formatting for the Macro Release Desk export.
// Reads exactly one fixed same-origin file, ./intel/release_desk.v1.json, written by the desk's explicit
// `publish` command. Separate from lib/api.ts (the historical-data loader is unchanged). Nothing here fetches
// from any source, schedules anything or writes browser storage.

export const RELEASE_DESK_PATH = "./intel/release_desk.v1.json";

export type DeskStatus =
  | "CANCELLED" | "CONFLICTING" | "CONFIRMED" | "VERIFICATION_FAILED" | "SOURCE_UNAVAILABLE" | "RESCHEDULED"
  | "SCHEDULED_UNVERIFIED" | "INSUFFICIENT_INFORMATION";
export type DataMode = "SYNTHETIC_DEMO" | "SOURCE_DERIVED";

export type ScheduleObs = {
  local_date: string; local_time: string | null; time_zone: string | null; source_tz_label: string | null;
  precision: "minute" | "date"; utc: string | null; source_kind: string; source_url: string;
};
export type DeskEvent = {
  event_id: string; family: "BLS_CPI" | "BLS_EMPSIT" | "BEA_GDP"; stage: string | null; family_label: string;
  authority_code: string; authority_name: string; release_name: string;
  reference_period: { kind: "month" | "quarter"; period: string };
  desk_status: DeskStatus; flags: string[];
  schedule: { status: string; current: ScheduleObs | null; original: ScheduleObs | null; history: ScheduleObs[] };
  publication: {
    status: string;
    official_release_time: { local_date: string; local_time: string | null; time_zone: string | null; source_tz_label: string | null; utc: string | null; basis: string } | null;
    observed_available_at_utc: string | null;
    verification: { state: string; last_attempt_at_utc: string | null; detail: string | null; page_event_id: string | null };
    evidence: Array<{ kind: string; document_id: string | null; excerpt: string | null; source_url: string; retrieved_at_utc: string | null }>;
  };
  retrieval: { state: string; last_attempt_at_utc: string | null; last_success_at_utc: string | null; last_error: string | null; stale_after: string };
  conflicts: Array<{ field: string; first_seen_at_utc: string; resolved: boolean; claims: Array<{ claim: string; source_url: string }> }>;
  notes: string[];
  sources: Array<{ url: string; publisher: string; kind: string; retrieved_at_utc: string | null }>;
  attribution: string[]; synthetic: boolean; record_version: number;
};
export type DeskExport = {
  export_contract: "release_desk_export"; export_version: string; data_mode: DataMode; values_policy: string;
  as_of_utc: string; generated_at_utc: string; clock: "SIMULATED" | "REAL"; record_contract: string;
  scope: Array<{ family: string; label: string; stage: string | null }>; attribution: string[]; events: DeskEvent[];
};
export type DeskLoad = { kind: "none" } | { kind: "ok"; data: DeskExport } | { kind: "invalid"; reason: string };

const OFFICIAL_URL = /^https:\/\/www\.(bls|bea)\.gov\//;

/** Missing file -> "none" (no verified data). Anything malformed -> "invalid" (nothing shown, reason given). */
export async function loadReleaseDesk(): Promise<DeskLoad> {
  let res: Response;
  try {
    res = await fetch(RELEASE_DESK_PATH, { cache: "no-store" });
  } catch {
    return { kind: "none" };
  }
  if (res.status === 404) return { kind: "none" };
  if (!res.ok) return { kind: "invalid", reason: `HTTP ${res.status}` };
  let d: DeskExport;
  try {
    d = await res.json();
  } catch {
    return { kind: "invalid", reason: "not JSON" };
  }
  if (d?.export_contract !== "release_desk_export" || !/^1\./.test(d.export_version ?? "")) return { kind: "invalid", reason: "unexpected export contract/version" };
  if (d.data_mode !== "SYNTHETIC_DEMO" && d.data_mode !== "SOURCE_DERIVED") return { kind: "invalid", reason: "unknown data mode" };
  if (d.values_policy !== "NO_ECONOMIC_VALUES") return { kind: "invalid", reason: "export does not declare the no-values policy" };
  if (!Array.isArray(d.events)) return { kind: "invalid", reason: "events missing" };
  const synth = d.data_mode === "SYNTHETIC_DEMO";
  for (const e of d.events) {
    if (e.synthetic !== synth) return { kind: "invalid", reason: "export mixes synthetic and real events" };
    const urls = [...e.sources.map((s) => s.url), ...e.publication.evidence.map((x) => x.source_url)];
    if (urls.some((u) => !OFFICIAL_URL.test(u))) return { kind: "invalid", reason: "non-official source URL" };
  }
  return { kind: "ok", data: d };
}

// T3-R2: optional preview manifest written next to the export by staging/t3_r2/build_r2_export.py. It binds the export
// to the verified dataset and carries a mechanically derived change summary. Missing or malformed -> not shown.
export const R2_MANIFEST_PATH = "./intel/release_desk_r2_manifest.json";
export type R2Manifest = {
  manifest: "t3_r2_release_desk_preview";
  dataset: { tree_sha256: string; events: number; versions: number };
  runs: Array<{ run_id: string; label: string; run_type: string | null; as_of_utc: string; documents: number; new_versions: string[] }>;
  export: { sha256: string; events_sha256: string; as_of_utc: string };
  change_summary: {
    compared_with: { label: string; as_of_utc: string; events: number };
    events_now: number; unchanged_records: number; changed_records: string[]; removed: string[];
    added: Array<{ event_id: string; desk_status: string; schedule_status: string; document_ids: Array<string | null> }>;
    retrieval_refreshed: number; display_status_changes: Array<{ event_id: string; from: string; to: string }>;
  };
};

export async function loadR2Manifest(): Promise<R2Manifest | null> {
  try {
    const res = await fetch(R2_MANIFEST_PATH, { cache: "no-store" });
    if (!res.ok) return null;
    const m = await res.json();
    return m?.manifest === "t3_r2_release_desk_preview" && m.change_summary && Array.isArray(m.runs) ? m : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------- time display
// IANA rules via Intl (never fixed offsets). Singapore time is derived here for display only.

function parts(utc: string, timeZone: string) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "short" })
      .formatToParts(new Date(utc)).map((x) => [x.type, x.value]),
  );
  return p as Record<string, string>;
}

/** 'Tue 10 Nov 2026 08:30 EST' */
export function fmtEastern(utc: string): string {
  const p = parts(utc, "America/New_York");
  return `${p.weekday} ${p.day} ${p.month} ${p.year} ${p.hour}:${p.minute} ${p.timeZoneName}`;
}

/** 'Tue 10 Nov 2026 21:30 SGT' */
export function fmtSingapore(utc: string): string {
  const p = parts(utc, "Asia/Singapore");
  return `${p.weekday} ${p.day} ${p.month} ${p.year} ${p.hour}:${p.minute} SGT`;
}

/** Calendar date without any zone conversion: 'Thu 28 Jan 2027'. */
export function fmtDate(isoDate: string): string {
  const p = parts(`${isoDate}T12:00:00Z`, "UTC");
  return `${p.weekday} ${p.day} ${p.month} ${p.year}`;
}

/** '16 October 2026' (UTC calendar date of the collection run). */
export function fmtCollectionDate(utc: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "numeric", month: "long", year: "numeric" }).format(new Date(utc));
}

export function fmtUtcShort(utc: string | null): string {
  return utc ? `${utc.slice(0, 10)} ${utc.slice(11, 16)}Z` : "never";
}

export type TimeCells = { eastern: string; singapore: string; note?: string };

export function scheduleCells(o: ScheduleObs | null): TimeCells {
  if (!o) return { eastern: "—", singapore: "—" };
  if (o.precision === "date") return { eastern: fmtDate(o.local_date), singapore: "—", note: "time not established" };
  if (!o.utc || !o.time_zone) return { eastern: `${fmtDate(o.local_date)} ${o.local_time ?? ""}`.trim(), singapore: "—", note: "zone not stated by source" };
  return { eastern: fmtEastern(o.utc), singapore: fmtSingapore(o.utc) };
}

export function periodLabel(rp: DeskEvent["reference_period"]): string {
  if (rp.kind === "quarter") return `${rp.period.slice(5)} ${rp.period.slice(0, 4)}`;
  const m = Number(rp.period.slice(5, 7));
  return `${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][m - 1]} ${rp.period.slice(0, 4)}`;
}

// ---------------------------------------------------------------------------------------------- status display

export type StatusView = { label: string; tone: "ok" | "warn" | "bad" | "dim" | "info"; detail?: string; stale?: string };

/** Display status (T3-V R1-R8). `now` is the export's simulated clock for synthetic data, the real clock otherwise.
 *  The clock can only move a record from "scheduled" to "due"; it can never make anything "released". */
export function statusView(e: DeskEvent, nowMs: number): StatusView {
  const cur = e.schedule.current;
  const dueByClock = e.publication.status === "NOT_YET_DUE" && !!cur?.utc && nowMs >= Date.parse(cur.utc);
  const due = e.publication.status === "DUE_UNCONFIRMED" || dueByClock;
  const lastOk = e.retrieval.last_success_at_utc ? Date.parse(e.retrieval.last_success_at_utc) : null;
  const staleDays = Number(e.retrieval.stale_after.replace(/[PD]/g, ""));
  const staleByClock = lastOk !== null && nowMs - lastOk > staleDays * 86_400_000;
  const terminal = e.desk_status === "CONFIRMED" || e.desk_status === "CANCELLED";
  const stale = !terminal && (e.retrieval.state === "STALE" || e.retrieval.state === "NEVER_RETRIEVED" || staleByClock)
    ? `information may be out of date (last checked ${fmtUtcShort(e.retrieval.last_success_at_utc)})` : undefined;
  const was = e.schedule.original ? scheduleCells(e.schedule.original).eastern : null;
  switch (e.desk_status) {
    case "CANCELLED":
      return { label: "Canceled by source", tone: "dim", detail: was ? `was scheduled ${was}` : undefined };
    case "CONFLICTING":
      return { label: "Schedule unclear — conflicting source information", tone: "bad", stale };
    case "CONFIRMED": {
      const o = e.publication.official_release_time;
      const t = o?.utc ? `${fmtEastern(o.utc)} (${fmtSingapore(o.utc).slice(-9)})` : o ? fmtDate(o.local_date) : "";
      return { label: "Released", tone: "ok", detail: `official time ${t} per embargo line` };
    }
    case "VERIFICATION_FAILED":
      return { label: "Due — release not confirmed", tone: "warn", detail: "official page check did not match this release (not evidence of non-publication)", stale };
    case "SOURCE_UNAVAILABLE":
      return { label: due ? "Due — release not confirmed" : "Scheduled — publication not verified", tone: "warn", detail: "source unavailable at last check", stale };
    case "RESCHEDULED":
      return { label: due ? "Due — release not yet confirmed" : "Scheduled — publication not verified", tone: due ? "warn" : "info", detail: was ? `rescheduled from ${was}` : "rescheduled", stale };
    case "SCHEDULED_UNVERIFIED":
      return { label: due ? "Due — release not yet confirmed" : "Scheduled — publication not verified", tone: due ? "warn" : "info",
               detail: due ? "scheduled time has passed; publication was not checked (not evidence of a missed release)" : undefined, stale };
    default:
      return { label: "Insufficient information", tone: "dim", stale };
  }
}

export const KIND_LABEL: Record<string, string> = {
  ICS_CALENDAR: "calendar", SCHEDULE_PAGE: "schedule", REVISED_DATES_NOTICE: "notice", NEWS_RELEASE: "release",
};
