"use client";

// T3-I v1: read-only Release Schedule. Shows the locally published release-desk export (schedule and
// publication status only, no economic values). Never triggers collection; the only request is the fixed
// same-origin export file. Synthetic demonstration data is labelled on every row.

import { useQuery } from "@tanstack/react-query";
import {
  KIND_LABEL, fmtCollectionDate, fmtUtcShort, loadR2Manifest, loadReleaseDesk, periodLabel, scheduleCells, statusView,
  type DeskEvent, type DeskExport, type R2Manifest, type StatusView,
} from "../lib/releaseDesk";
import { buildLabel } from "../lib/buildInfo";

// T4-P1: freshness wording. A static snapshot never shows a permanent "fresh": the age of each row's last check is
// computed against the viewer's clock and the row's own check window (stale_after, e.g. P7D).
function checkAge(e: DeskEvent, nowMs: number): string {
  const last = e.retrieval.last_success_at_utc;
  if (!last) return "never checked";
  const days = Math.floor((nowMs - Date.parse(last)) / 86_400_000);
  const win = Number(e.retrieval.stale_after.replace(/[PD]/g, ""));
  const ago = days <= 0 ? "today" : days === 1 ? "1 day ago" : `${days} days ago`;
  return days <= win ? `${ago} · within the ${win}-day check window` : `${ago} · older than the ${win}-day check window`;
}

// T4-P1: the four separate facts behind this view, each from its own source.
function SnapshotFacts({ data, m }: { data: DeskExport; m: R2Manifest | null | undefined }) {
  const checked = data.events.filter((e) => e.publication.verification.state !== "NOT_ATTEMPTED");
  const lastCheck = checked.map((e) => e.publication.verification.last_attempt_at_utc).filter(Boolean).sort().pop() ?? null;
  const confirmed = data.events.filter((e) => e.publication.status === "CONFIRMED").length;
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5 text-[11px] border border-[var(--border)] px-3 py-2" data-testid="snapshot-facts">
      <dt className="dim">Data retrieved</dt>
      <dd data-testid="fact-retrieved">latest manual run {fmtUtcShort(data.as_of_utc)} (official BLS and BEA pages; nothing refreshes automatically)</dd>
      <dt className="dim">Publication evidence</dt>
      <dd data-testid="fact-publication">{confirmed} release{confirmed === 1 ? "" : "s"} confirmed from official release pages; latest page check {fmtUtcShort(lastCheck)}</dd>
      <dt className="dim">Snapshot identity</dt>
      <dd data-testid="fact-snapshot">{m ? `export ${m.export.sha256.slice(0, 12)} · dataset ${m.dataset.tree_sha256.slice(0, 12)}` : "snapshot manifest not available"}</dd>
      <dt className="dim">Frontend</dt>
      <dd data-testid="fact-build">{buildLabel()} (when this page was built, not when data was retrieved)</dd>
    </dl>
  );
}

const FAMILIES: Array<{ family: DeskEvent["family"]; title: string; authority: string }> = [
  { family: "BLS_CPI", title: "Consumer Price Index", authority: "BLS" },
  { family: "BLS_EMPSIT", title: "Employment Situation", authority: "BLS" },
  { family: "BEA_GDP", title: "GDP Advance Estimate", authority: "BEA" },
];

const TONE: Record<StatusView["tone"], string> = {
  ok: "text-[var(--up)] border-[var(--up)]",
  warn: "text-[var(--amber)] border-[var(--amber)]",
  bad: "text-[var(--down)] border-[var(--down)]",
  info: "text-[var(--text)] border-[var(--border)]",
  dim: "text-[var(--text-dim)] border-[var(--text-dim)]",
};

function Link({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="underline decoration-dotted hover:text-[var(--amber)]">
      {children}
    </a>
  );
}

function ModeBanner({ data }: { data: DeskExport | null }) {
  if (!data)
    return (
      <div className="note text-[12px]" role="status" data-testid="desk-mode" data-mode="NONE">
        <b className="amber">No verified data available.</b> No release-desk export has been published to this local candidate.
      </div>
    );
  if (data.data_mode === "SYNTHETIC_DEMO")
    return (
      <div className="border border-[var(--amber)] px-3 py-2 text-[12px]" role="status" data-testid="desk-mode" data-mode="SYNTHETIC_DEMO"
        style={{ background: "repeating-linear-gradient(135deg, #1a1200 0 10px, #0a0a0a 10px 20px)" }}>
        <b className="amber">SYNTHETIC DEMONSTRATION DATA — not real releases, not a live feed.</b>{" "}
        Produced offline from synthetic fixtures on a simulated clock ({fmtUtcShort(data.as_of_utc)}). Document ids and
        statuses are fictional; source links point to the real official pages for orientation only.
      </div>
    );
  return (
    <div className="border border-[var(--up)] px-3 py-2 text-[12px]" role="status" data-testid="desk-mode" data-mode="SOURCE_DERIVED">
      {/* T3-RUI: real-source snapshot banner. Every figure below is derived from the export, nothing is hard-coded. */}
      <b className="text-[var(--up)]" data-testid="snapshot-title">REAL OFFICIAL METADATA · OFFICIAL-SOURCE SNAPSHOT</b>{" · "}
      <span data-testid="snapshot-date">Collection date: {fmtCollectionDate(data.as_of_utc)}</span>{" · "}
      <b className="amber" data-testid="snapshot-caveat">Not continuously updated. Publication verification is incomplete.</b>
      <div className="dim mt-1" data-testid="snapshot-coverage">
        Schedule and publication-status metadata retrieved from official BLS and BEA pages by separately approved
        manual runs (latest {fmtUtcShort(data.as_of_utc)}); nothing refreshes automatically. An official release page was checked for{" "}
        {data.events.filter((e) => e.publication.verification.state !== "NOT_ATTEMPTED").length} of {data.events.length} events;
        every other row is a published schedule, not a confirmed release. Calendar entries whose source states no
        reference month (for example, past BLS releases) are not shown as events. Times without a stated zone are
        shown without UTC or Singapore conversion. No economic values.
      </div>
    </div>
  );
}

// T3-R2: change summary, read from the preview manifest (derived mechanically at export time, nothing hard-coded here).
function ChangeSummary({ m }: { m: R2Manifest | null | undefined }) {
  if (!m) return null;
  const c = m.change_summary;
  return (
    <div className="border border-[var(--border)] px-3 py-2 text-[12px]" role="status" data-testid="change-summary">
      <b>What changed since the accepted preview of {fmtUtcShort(c.compared_with.as_of_utc)}</b>{" "}
      <span className="dim">({c.compared_with.events} events)</span>
      <div data-testid="change-counts">
        {c.events_now} events now: {c.unchanged_records} unchanged, {c.changed_records.length} changed,{" "}
        {c.added.length} added, {c.removed.length} removed.
      </div>
      {c.added.map((a) => (
        <div key={a.event_id} data-testid="change-added">
          Added: {a.event_id} — {a.desk_status === "CONFIRMED" ? "publication confirmed from the official release page" : a.desk_status.toLowerCase()}
          {a.document_ids.filter(Boolean).length > 0 && <> ({a.document_ids.filter(Boolean).join(", ")})</>}
          {a.schedule_status === "UNKNOWN" && <>; its scheduled time is not in the collected sources</>}.
        </div>
      ))}
      <div className="dim" data-testid="change-refresh">
        Retrieval times refreshed for {c.retrieval_refreshed} unchanged events (a calendar re-check, not a content change);
        {" "}{c.display_status_changes.length === 0 ? "no displayed status changed" : `${c.display_status_changes.length} displayed status(es) changed`}.
      </div>
      <div className="dim" data-testid="change-runs">
        Runs: {m.runs.map((r) => `${r.label} ${fmtUtcShort(r.as_of_utc)} (${r.documents} ${r.documents === 1 ? "page" : "pages"})`).join(" · ")}
        {" "}· dataset {m.dataset.tree_sha256.slice(0, 12)} · export {m.export.sha256.slice(0, 12)}
      </div>
    </div>
  );
}

function EventRow({ e, nowMs }: { e: DeskEvent; nowMs: number }) {
  const sv = statusView(e, nowMs);
  const t = scheduleCells(e.schedule.current);
  // T3-RUI: a confirmed release whose schedule was not in the collected sources keeps an empty schedule (never invented).
  const noSchedule = !e.schedule.current && e.conflicts.every((c) => c.resolved) ? "no schedule in collected sources" : undefined;
  const open = e.conflicts.filter((c) => !c.resolved);
  const ev = e.publication.evidence.find((x) => x.kind === "NEWS_RELEASE_EMBARGO_LINE");
  return (
    <tr data-testid="desk-row" data-event={e.event_id} data-status={e.desk_status} className="align-top">
      <td className="!text-left">
        {periodLabel(e.reference_period)}
        {e.synthetic && <div><span className="border border-[var(--amber)] text-[var(--amber)] px-1 text-[9px]" data-testid="synthetic-tag">SYNTHETIC</span></div>}
      </td>
      <td className="!text-left !whitespace-normal min-w-[180px]">{e.release_name}</td>
      <td className="!text-left" data-testid="cell-et">
        {t.eastern}{(t.note ?? noSchedule) && <div className="dim">{t.note ?? noSchedule}</div>}
      </td>
      <td className="!text-left" data-testid="cell-sgt">{t.singapore}</td>
      <td className="!text-left !whitespace-normal min-w-[220px]" data-testid="cell-status">
        {/* T4-AFK: inline-block keeps the status border a single box when the label wraps in a narrow column. */}
        <span className={`inline-block border px-1 text-[10px] ${TONE[sv.tone]}`}>{sv.label}</span>
        {sv.detail && <div className="dim mt-0.5">{sv.detail}</div>}
        {open.length > 0 && (
          <div className="mt-0.5" data-testid="conflict">
            {open.map((c, i) => (
              <div key={i} className="text-[var(--down)]">
                {c.field.replace("schedule.", "")}: {c.claims.map((x, j) => (
                  <span key={j}>{j > 0 && " vs "}{x.claim} (<Link href={x.source_url}>{KIND_LABEL[x.source_url.endsWith(".ics") ? "ICS_CALENDAR" : "SCHEDULE_PAGE"]}</Link>)</span>
                ))}
              </div>
            ))}
          </div>
        )}
        {sv.stale && <div className="text-[var(--amber)] mt-0.5" data-testid="stale">{sv.stale}</div>}
      </td>
      <td className="!text-left !whitespace-normal min-w-[150px]">
        <div className="whitespace-nowrap">{fmtUtcShort(e.retrieval.last_success_at_utc)}</div>
        <div className="dim" data-testid="cell-checked">{checkAge(e, nowMs)}</div>
      </td>
      <td className="!text-left !whitespace-normal min-w-[150px]">
        <div className="flex flex-wrap gap-x-2">
          {e.sources.map((s, i) => <Link key={i} href={s.url}>{s.publisher} {KIND_LABEL[s.kind] ?? s.kind}</Link>)}
        </div>
        <details className="mt-0.5">
          <summary className="dim cursor-pointer">details</summary>
          <div className="text-[11px] flex flex-col gap-1 py-1 max-w-[420px]">
            <div><span className="dim">event id</span> {e.event_id} <span className="dim">· record v{e.record_version}</span></div>
            {ev && <div><span className="dim">evidence</span> {ev.document_id} — “{ev.excerpt}”</div>}
            {e.publication.observed_available_at_utc && (
              <div><span className="dim">first seen by this desk</span> {fmtUtcShort(e.publication.observed_available_at_utc)} (our retrieval, not the official time)</div>
            )}
            {e.publication.verification.state !== "NOT_ATTEMPTED" && (
              <div><span className="dim">last page check</span> {e.publication.verification.state.toLowerCase().replace("_", " ")} at {fmtUtcShort(e.publication.verification.last_attempt_at_utc)}{e.publication.verification.detail ? ` — ${e.publication.verification.detail}` : ""}</div>
            )}
            {e.schedule.history.length > 0 && (
              <div>
                <span className="dim">schedule history</span>
                <ol className="list-decimal ml-5">
                  {e.schedule.history.map((h, i) => {
                    const c = scheduleCells(h);
                    return <li key={i}>{c.eastern}{c.note ? ` (${c.note})` : ""} — {KIND_LABEL[h.source_kind] ?? h.source_kind}</li>;
                  })}
                </ol>
              </div>
            )}
            {e.conflicts.filter((c) => c.resolved).map((c, i) => (
              <div key={i} className="dim">resolved conflict on {c.field}: {c.claims.map((x) => x.claim).join(" vs ")}</div>
            ))}
            {e.notes.map((n, i) => <div key={i} className="dim">note: {n}</div>)}
            {e.retrieval.last_error && <div className="dim">last error: {e.retrieval.last_error}</div>}
          </div>
        </details>
      </td>
    </tr>
  );
}

export default function ReleaseSchedule() {
  const { data: load, isLoading } = useQuery({ queryKey: ["release-desk"], queryFn: loadReleaseDesk, staleTime: Infinity, retry: false });
  const { data: r2 } = useQuery({ queryKey: ["release-desk-r2-manifest"], queryFn: loadR2Manifest, staleTime: Infinity, retry: false });
  if (isLoading || !load) return <div className="dim p-3">Loading local release-desk export…</div>;
  if (load.kind === "invalid")
    return (
      <div className="note text-[12px]" role="alert" data-testid="desk-invalid">
        <b className="text-[var(--down)]">The local release-desk export could not be used ({load.reason}).</b> Nothing is shown rather than unverified data.
      </div>
    );
  const data = load.kind === "ok" ? load.data : null;
  const nowMs = data?.clock === "SIMULATED" ? Date.parse(data.as_of_utc) : Date.now();
  return (
    <div className="flex flex-col gap-3" data-testid="release-schedule">
      <ModeBanner data={data} />
      {data?.data_mode === "SOURCE_DERIVED" && <SnapshotFacts data={data} m={r2} />}
      {data?.data_mode === "SOURCE_DERIVED" && <ChangeSummary m={r2} />}
      {FAMILIES.map((f) => {
        const rows = (data?.events ?? []).filter((e) => e.family === f.family && (f.family !== "BEA_GDP" || e.stage === "ADVANCE"));
        return (
          <section key={f.family} className="terminal-panel !h-auto" aria-label={f.title} data-testid={`family-${f.family}`}>
            <div className="panel-title !cursor-default">
              <span>{f.title}</span>
              <span className="dim font-normal">{f.authority} · {rows.length} {rows.length === 1 ? "event" : "events"}</span>
            </div>
            {rows.length === 0 ? (
              <div className="p-3 dim text-[12px]">No verified data available for this release family.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Ref. period</th><th className="!text-left">Official release</th><th className="!text-left">Official schedule (US Eastern)</th>
                      <th className="!text-left">Singapore</th><th className="!text-left">Publication status</th><th className="!text-left">Last checked by desk (UTC)</th>
                      <th className="!text-left">Sources</th>
                    </tr>
                  </thead>
                  <tbody>{rows.map((e) => <EventRow key={e.event_id} e={e} nowMs={nowMs} />)}</tbody>
                </table>
              </div>
            )}
          </section>
        );
      })}
      <div className="dim text-[11px] flex flex-col gap-1">
        <p>
          Status meanings: <b>Released</b> only when the official news release&apos;s embargo line for this exact release was seen (official
          stated time, not a measured posting time). A passed scheduled time, a missing page or a failed check never counts as released
          or as not released. Times use IANA rules (America/New_York → UTC → Asia/Singapore).
        </p>
        <p>
          {(data?.attribution ?? ["Source: U.S. Bureau of Labor Statistics", "Source: U.S. Bureau of Economic Analysis"]).join(" · ")}.
          {" "}No economic values are shown in this view. Not affiliated with or endorsed by BLS or BEA.
          {data && <> Export generated {fmtUtcShort(data.generated_at_utc)} · {data.record_contract}.</>}
        </p>
      </div>
    </div>
  );
}
