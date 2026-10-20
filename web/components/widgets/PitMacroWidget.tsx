"use client";

// New widget (replaces OpenTerminal's live MacroWidget, which polled /api/macro every second). Shows one
// exported macro series. First-release series are plotted as a step at each RELEASE date (the value a
// market participant could know from that day), with the REFERENCE period kept separate. Daily series are
// plain observations. Missing values stay missing (gaps and "—"), never zero.
// T1: the selected series and range are stored on the widget (persisted with the workspace).

import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid } from "recharts";
import { fmt, isNotIncluded, loadLocal, type MacroExport, type MacroSeries } from "../../lib/api";
import NotIncluded from "../NotIncluded";
import { useTerminal, type WidgetInstance } from "../../store/terminal";

const RANGES = { ALL: "0000-00-00", "2016–23": "2016-01-01", "5Y": "2019-01-01" } as const;
type RangeKey = keyof typeof RANGES;
type Row = { x: number; value: number | null; release?: string; reference?: string; date?: string };

function rowsFor(series: MacroSeries, start: string): Row[] {
  return series.points
    .map((p) => {
      const day = series.kind === "first_release" ? p.release! : p.date!;
      return { x: Date.parse(day + "T00:00:00Z"), value: p.value, release: p.release, reference: p.reference, date: p.date, day };
    })
    .filter((r) => r.day >= start)
    .map(({ day, ...r }) => r); // eslint-disable-line @typescript-eslint/no-unused-vars
}

function TipBody({ active, payload, series, digits }: { active?: boolean; payload?: Array<{ payload?: Row }>; series: MacroSeries; digits: number }) {
  const r = payload?.[0]?.payload;
  if (!active || !r) return null;
  return (
    <div className="pit-tip">
      <div className="amber">{fmt(r.value, digits)} <span className="dim">{series.units}</span></div>
      {series.kind === "first_release" ? (
        <>
          <div>known from release <b>{r.release}</b></div>
          <div className="dim">reference period {r.reference}</div>
        </>
      ) : (
        <div>observed <b>{r.date}</b></div>
      )}
    </div>
  );
}

export default function PitMacroWidget({ widget }: { widget: WidgetInstance }) {
  const { data, error } = useQuery({ queryKey: ["macro"], queryFn: () => loadLocal<MacroExport>("macro_series.json"), staleTime: Infinity });
  const setWidgetView = useTerminal((s) => s.setWidgetView);
  const seriesId = widget.view?.series ?? "CPIAUCSL";
  const range: RangeKey = widget.view?.range && widget.view.range in RANGES ? (widget.view.range as RangeKey) : "ALL";
  const setSeriesId = (series: string) => setWidgetView(widget.id, { series });
  const setRange = (r: RangeKey) => setWidgetView(widget.id, { range: r });

  const series = data?.series.find((s) => s.id === seriesId) ?? data?.series[0];
  const rows = useMemo(() => (series ? rowsFor(series, RANGES[range]) : []), [series, range]);
  const missing = rows.filter((r) => r.value === null).length;
  const ticks = useMemo(() => {
    if (rows.length === 0) return [];
    const y0 = new Date(rows[0].x).getUTCFullYear() + 1, y1 = new Date(rows[rows.length - 1].x).getUTCFullYear();
    const step = Math.max(1, Math.ceil((y1 - y0 + 1) / 8));
    const out: number[] = [];
    for (let y = y0; y <= y1; y += step) out.push(Date.UTC(y, 0, 1));
    return out;
  }, [rows]);
  const digits = series && (series.kind === "daily" || series.units === "Percent") ? 2 : 1;

  if (error) return isNotIncluded(error) ? <NotIncluded file={error.file} /> : <div className="p-2 down">Error: {(error as Error).message}</div>;
  if (!data || !series) return <div className="p-2 dim">Loading local export…</div>;

  const pit = series.kind === "first_release";
  return (
    <div className="flex flex-col h-full">
      <div className="flex gap-1 p-1 flex-wrap items-center shrink-0">
        <select
          aria-label="Macro series"
          value={series.id}
          onChange={(e) => setSeriesId(e.target.value)}
        >
          {data.series.map((s) => (
            <option key={s.id} value={s.id}>{s.name} — {s.kind === "first_release" ? "first release" : "daily"}</option>
          ))}
        </select>
        {(Object.keys(RANGES) as RangeKey[]).map((r) => (
          <button key={r} className={`term-btn ${range === r ? "active" : ""}`} onClick={() => setRange(r)}>{r}</button>
        ))}
        <span className="dim text-[10px] ml-1">{series.id} · {series.frequency} · {series.units}</span>
      </div>
      <div className="flex flex-1 min-h-0">
        <div className="flex-1 min-w-0 px-1" data-testid="pit-chart">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={rows} margin={{ top: 8, right: 12, bottom: 0, left: 4 }}>
              <CartesianGrid stroke="#1a1a1a" vertical={false} />
              <XAxis dataKey="x" type="number" scale="time" domain={["dataMin", "dataMax"]} ticks={ticks} stroke="#808080" fontSize={9}
                tickFormatter={(v: number) => new Date(v).getUTCFullYear().toString()} />
              <YAxis stroke="#808080" fontSize={9} domain={["auto", "auto"]} width={54}
                tickFormatter={(v: number) => (Math.abs(v) >= 1000 ? (v / 1000).toFixed(0) + "k" : v.toString())} />
              <Tooltip content={<TipBody series={series} digits={digits} />} />
              <Line type={pit ? "stepAfter" : "linear"} dataKey="value" stroke="#ff9900" strokeWidth={1.5} dot={false}
                isAnimationActive={false} connectNulls={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
        <div className="w-[290px] shrink-0 overflow-auto border-l border-[var(--border)]">
          <table className="data-table" data-testid="pit-table">
            <thead>
              <tr>{pit ? <><th>Released</th><th>Reference</th></> : <th>Date</th>}<th>Value</th></tr>
            </thead>
            <tbody>
              {rows.slice(-40).reverse().map((r) => (
                <tr key={(r.release ?? r.date) + (r.reference ?? "")}>
                  {pit ? <><td>{r.release}</td><td>{r.reference}</td></> : <td>{r.date}</td>}
                  <td>{fmt(r.value, digits)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div className="px-2 py-0.5 dim text-[10px] shrink-0">
        {pit
          ? "Point-in-time: each step is the value first published on its release date (first release), not today's revised history."
          : `Daily observations (retrieved as of ${series.asOf?.join(", ")}).`}{" "}
        Data to {data.bound}. {missing > 0 ? `${missing} missing observation(s) shown as gaps.` : "No missing observations in range."} Not live.
      </div>
    </div>
  );
}
