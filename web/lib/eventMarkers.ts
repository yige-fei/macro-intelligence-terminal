// OS-P2A: maps official release-desk events onto the bars of the simulated event-overlay dataset.
//
// Contract (docs/ARCHITECTURE.md, "Event markers"):
//  - Source: the bundled release-desk export only (real official BLS/BEA metadata, no economic values). Its as-of date
//    must equal the overlay dataset's declared event_snapshot; otherwise nothing is drawn.
//  - Eligible: events whose publication status is
//      CONFIRMED        -> "confirmed":   date and time from the official release time (news-release embargo line);
//      DUE_UNCONFIRMED  -> "unconfirmed": date and time from the current official schedule. A passed scheduled time is
//                                         NOT treated as publication.
//    NOT_YET_DUE events after the snapshot are counted and left to the Release Desk (no future prices are simulated).
//    Any other status, a missing date, or a date after the snapshot is listed as omitted, with the reason.
//  - Alignment: the marker goes on the daily bar whose date equals the event's US Eastern calendar date. There is no
//    shifting: if the dataset has no bar on that date, the event is listed as omitted, with the reason. The marker
//    marks a calendar date; it does not measure anything about the bar.

import type { Candle } from "./api";
import type { DeskEvent, DeskExport } from "./releaseDesk";

export type EventMarkStatus = "confirmed" | "unconfirmed";

export type EventMark = {
  eventId: string;
  family: DeskEvent["family"];
  short: string;               // e.g. "CPI"
  title: string;               // e.g. "Consumer Price Index · Sep 2026"
  status: EventMarkStatus;
  date: string;                // US Eastern calendar date (YYYY-MM-DD), never shifted
  localTime: string | null;    // e.g. "08:30"
  timeZone: string | null;     // e.g. "America/New_York"
  utc: string | null;          // official or scheduled time in UTC
  basis: string;               // what the date/time is
  documentIds: string[];       // news-release ids from the official evidence
  sources: Array<{ url: string; publisher: string }>;
  barTime: number | null;      // time of the bar with the same date, if any
};

export type EventPlan =
  | { kind: "error"; reason: string }
  | { kind: "ok"; snapshot: string; marks: EventMark[]; omitted: Array<{ mark: EventMark | null; eventId: string; reason: string }>; later: number };

const SHORT: Record<DeskEvent["family"], string> = { BLS_CPI: "CPI", BLS_EMPSIT: "Jobs", BEA_GDP: "GDP" };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function period(e: DeskEvent): string {
  const p = e.reference_period.period;
  if (e.reference_period.kind === "month") {
    const [y, m] = p.split("-");
    return `${MONTHS[Number(m) - 1] ?? m} ${y}`;
  }
  return p; // e.g. 2026-Q2
}

/** Plans the markers for one overlay dataset. Pure: no I/O, no clock. */
export function planEventMarkers(desk: DeskExport, candles: Candle[], eventSnapshot: string | undefined): EventPlan {
  if (desk.data_mode !== "SOURCE_DERIVED") return { kind: "error", reason: "the release-desk export is not official-source data" };
  if (!eventSnapshot) return { kind: "error", reason: "the chart data declares no event snapshot date" };
  const deskDate = desk.as_of_utc.slice(0, 10);
  if (deskDate !== eventSnapshot)
    return { kind: "error", reason: `release-desk snapshot ${deskDate} does not match the chart data's snapshot ${eventSnapshot}` };

  const barByDate = new Map(candles.map((c) => [c.date, c.time]));
  const first = candles[0]?.date, last = candles.at(-1)?.date;
  const marks: EventMark[] = [];
  const omitted: Array<{ mark: EventMark | null; eventId: string; reason: string }> = [];
  let later = 0;

  for (const e of desk.events) {
    const st = e.publication.status;
    let status: EventMarkStatus;
    let t: { local_date: string; local_time: string | null; time_zone: string | null; utc: string | null } | null;
    let basis: string;
    if (st === "CONFIRMED") {
      status = "confirmed";
      t = e.publication.official_release_time;
      basis = "official release time stated in the news release (embargo line)";
    } else if (st === "DUE_UNCONFIRMED") {
      status = "unconfirmed";
      t = e.schedule.current;
      basis = "scheduled time from the official schedule; publication not confirmed";
    } else if (st === "NOT_YET_DUE") {
      const d = e.schedule.current?.local_date;
      if (d && d > eventSnapshot) { later++; continue; }
      omitted.push({ mark: null, eventId: e.event_id, reason: `status ${st} although dated ${d ?? "(no date)"} on or before the snapshot` });
      continue;
    } else {
      omitted.push({ mark: null, eventId: e.event_id, reason: `status ${st} has no marker mapping` });
      continue;
    }
    if (!t?.local_date) {
      omitted.push({ mark: null, eventId: e.event_id, reason: "no official or scheduled date in the export" });
      continue;
    }
    const mark: EventMark = {
      eventId: e.event_id,
      family: e.family,
      short: SHORT[e.family] ?? e.family,
      title: `${e.release_name} · ${period(e)}`,
      status,
      date: t.local_date,
      localTime: t.local_time,
      timeZone: t.time_zone,
      utc: t.utc,
      basis,
      documentIds: e.publication.evidence.map((x) => x.document_id).filter((x): x is string => !!x),
      sources: e.sources.map((s) => ({ url: s.url, publisher: s.publisher })),
      barTime: barByDate.get(t.local_date) ?? null,
    };
    if (mark.date > eventSnapshot) omitted.push({ mark, eventId: e.event_id, reason: "dated after the snapshot" });
    else if (mark.barTime === null)
      omitted.push({
        mark, eventId: e.event_id,
        reason: !first || mark.date < first ? `before the first bar (${first ?? "none"})`
          : last && mark.date > last ? `after the last bar (${last})`
          : `no bar on ${mark.date} in this dataset (not moved to another day)`,
      });
    else marks.push(mark);
  }
  marks.sort((a, b) => a.date.localeCompare(b.date));
  return { kind: "ok", snapshot: eventSnapshot, marks, omitted, later };
}

export const MARK_STYLE: Record<EventMarkStatus, { color: string; shape: "circle" | "square"; label: string }> = {
  confirmed: { color: "#00c853", shape: "circle", label: "publication confirmed" },
  unconfirmed: { color: "#b0b0b0", shape: "square", label: "scheduled time passed — publication not confirmed" },
};

/** "Wed 14 Oct 2026 08:30 ET (12:30Z)" style text for a mark, from the export's own fields. */
export function markTime(m: EventMark): string {
  const tz = m.timeZone === "America/New_York" ? "ET" : m.timeZone ?? "";
  const utc = m.utc ? ` (${m.utc.slice(11, 16)}Z)` : "";
  return `${m.date}${m.localTime ? ` ${m.localTime} ${tz}` : ""}${utc}`;
}
