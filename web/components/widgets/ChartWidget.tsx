"use client";

// Adapted from OpenTerminal web/components/widgets/ChartWidget.tsx (MIT, see LICENSES/OpenTerminal-MIT.txt in the repository root). Kept: the
// Lightweight Charts setup (candles/bars/line/area, volume pane, indicator overlays and panes, crosshair
// legend). Changed: data come from the local static data file (no /api/history, no refetch),
// ranges are anchored to the 2023-12-29 data boundary, VWAP is dropped (meaningless as a cumulative
// over daily bars), and the TradingView attribution logo is enabled as the library licence requires.
// T1: range / chart type / indicators are stored on the widget (persisted with the workspace); toggling an
// indicator adds or removes only its series instead of rebuilding the chart (keeps the zoom, avoids the
// measured 50-180 ms rebuild).
// T1-final: the wheel / trackpad is left to the page again (LWC calls preventDefault on any wheel event it handles,
// so vertical scrolling over the chart was swallowed); zoom stays available by dragging the time axis. The right
// price axis has a fixed minimum width: adding an RSI/MACD pane changed the axis labels' width (62 -> 58 px), which
// widened the plot and shifted the visible window.
// T1-closure: + / − toolbar buttons zoom the time axis around the centre of the visible window (setVisibleLogicalRange),
// kept inside the loaded bars; no wheel capture, nothing persisted (same as drag-pan and axis zoom).
// Demo: the bars are simulated (terminal_demo.generate); a fixed label above the chart and the caption say so, and a
// range without bars shows an explicit empty state.
// OS-P2A: two simulated datasets per chart panel (view.dataset): the 2016–2023 demo set (default, unchanged) and the
// event-overlay set, which ends at the official release-desk snapshot and carries markers for the release events that
// were due by then (lib/eventMarkers.ts). Range presets are computed from the selected dataset's own dates; for the
// demo set they equal the earlier fixed values. Switching datasets resets the range and rebuilds chart and markers.
// OS-P2B: a third source, a CSV/JSON file the user imports (lib/importData.ts, store/imported.ts). It is held in
// memory only; while a panel shows it, its view settings are an in-memory override, so the saved layout never changes.
// Imported data gets its own label, no event markers, and a reload returns the panel to its saved built-in dataset.

import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  createChart,
  CandlestickSeries,
  LineSeries,
  HistogramSeries,
  AreaSeries,
  BarSeries,
  createSeriesMarkers,
  type IChartApi,
  type ISeriesApi,
  type SeriesMarker,
  type SeriesType,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import { fmt, fmtBig, isNotIncluded, loadLocal, type Candle, type DataFile, type EtfExport } from "../../lib/api";
import { loadReleaseDesk } from "../../lib/releaseDesk";
import { MARK_STYLE, markTime, planEventMarkers, type EventMark, type EventPlan } from "../../lib/eventMarkers";
import { describeIssue, importFile, IMPORT_LIMITS } from "../../lib/importData";
import { useImported } from "../../store/imported";
import NotIncluded from "../NotIncluded";
import { sma, ema, rsi, macd, bollinger, type Point } from "../../lib/indicators";
import { useTerminal, useWidgetSymbol, type WidgetInstance } from "../../store/terminal";

const RANGES = ["1Y", "3Y", "5Y", "SPAN", "ALL"] as const;
const DEFAULT_RANGE = "5Y";
const LEGACY_RANGE: Record<string, (typeof RANGES)[number]> = { "2016–23": "SPAN" }; // OS-P1 saved layouts stored the label

const DATASETS = ["demo", "overlay"] as const;
type Dataset = (typeof DATASETS)[number];
const DATASET_FILE: Record<Dataset, DataFile> = { demo: "etf_prices.json", overlay: "event_overlay_prices.json" };
const DATASET_LABEL: Record<Dataset, string> = { demo: "DEMO SET", overlay: "EVENT OVERLAY" };
type Source = Dataset | "imported";

// Fewest bars for which each indicator produces a value (lib/indicators.ts); below that it is reported, not drawn.
const MIN_BARS: Record<Indicator, number> = { SMA20: 20, SMA50: 50, SMA200: 200, EMA20: 20, BOLL: 20, RSI: 15, MACD: 26 };
const CHART_TYPES = ["candles", "bars", "line", "area"] as const;
const INDICATORS = ["SMA20", "SMA50", "SMA200", "EMA20", "BOLL", "RSI", "MACD"] as const;

type Range = (typeof RANGES)[number];
type ChartType = (typeof CHART_TYPES)[number];
type Indicator = (typeof INDICATORS)[number];

const ts = (t: number) => t as UTCTimestamp;
const toMap = (pts: Point[]) => new Map(pts.map((p) => [p.time, p.value]));
// Range starts relative to the selected dataset: calendar-year anchored to the year of its last bar (1Y = 1 January of
// that year, 3Y = two years earlier, 5Y = four years earlier), SPAN = 1 January of its first bar's year. For the
// 2016–2023 demo set this is exactly the earlier 2023-01-01 / 2021-01-01 / 2019-01-01 / 2016-01-01.
function rangeStart(r: Range, first: string | undefined, last: string | undefined): string {
  if (r === "ALL" || !first || !last) return "0000-00-00";
  const y = Number(last.slice(0, 4));
  if (r === "SPAN") return `${first.slice(0, 4)}-01-01`;
  return `${y - ({ "1Y": 0, "3Y": 2, "5Y": 4 } as const)[r]}-01-01`;
}
function rangeLabel(r: Range, first: string | undefined, last: string | undefined): string {
  if (r !== "SPAN") return r;
  return first && last ? `${first.slice(0, 4)}–${last.slice(2, 4)}` : "SPAN";
}

const INDICATOR_COLOR: Record<string, string> = {
  SMA20: "#ffd966", SMA50: "#4fc3f7", SMA200: "#ba68c8", EMA20: "#ff8a65", RSI: "#ff9900", BOLL: "#ff9900", MACD: "#4fc3f7",
};

const DEFAULT_INDICATORS: Indicator[] = ["SMA50"];
const ZOOM_STEP = 1.5;     // visible span is divided (+) or multiplied (−) by this per click
const MIN_ZOOM_BARS = 20;  // narrowest window, about one trading month

export default function ChartWidget({ widget }: { widget: WidgetInstance }) {
  const symbol = useWidgetSymbol(widget);
  const setWidgetView = useTerminal((s) => s.setWidgetView);
  const imp = useImported();
  const imported = imp.active[widget.id] && imp.set ? imp.set : null;
  const source: Source = imported ? "imported" : widget.view?.dataset === "overlay" ? "overlay" : "demo";
  const dataset: Dataset = widget.view?.dataset === "overlay" ? "overlay" : "demo"; // the saved built-in dataset
  const v = imported ? imp.views[widget.id] : widget.view;
  // While imported data is shown, view changes stay in memory and never reach the saved layout.
  const patchView = (patch: { range?: string; chartType?: string; indicators?: string[] }) =>
    imported ? imp.setView(widget.id, patch) : setWidgetView(widget.id, patch);
  const storedRange = LEGACY_RANGE[v?.range ?? ""] ?? v?.range;
  const range: Range = (RANGES as readonly string[]).includes(storedRange ?? "") ? (storedRange as Range) : DEFAULT_RANGE;
  const chartType: ChartType = (CHART_TYPES as readonly string[]).includes(v?.chartType ?? "") ? (v!.chartType as ChartType) : "candles";
  const storedIndicators = v?.indicators;
  const active = useMemo(
    () => new Set<Indicator>(storedIndicators ? storedIndicators.filter((i): i is Indicator => (INDICATORS as readonly string[]).includes(i)) : DEFAULT_INDICATORS),
    [storedIndicators]
  );
  const setRange = (r: Range) => patchView({ range: r });
  const setChartType = (t: ChartType) => patchView({ chartType: t });
  // A range chosen for one dataset is not carried over to the other. Leaving imported data restores the saved view.
  const setDataset = (d: Dataset) => {
    if (imported) imp.hide(widget.id);
    if (d !== dataset) setWidgetView(widget.id, { dataset: d, range: DEFAULT_RANGE });
  };
  const fileRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const startView = () => ({ range: "ALL", chartType: widget.view?.chartType, indicators: widget.view?.indicators });
  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    // FileList is live: read the count and the file before clearing the input (which lets the same file be chosen again).
    const count = e.target.files?.length ?? 0;
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    if (count !== 1) {
      imp.reject({ ok: false, widgetId: widget.id, name: `${count} files`, issues: [{ row: null, message: "choose exactly one file" }], truncated: false });
      return;
    }
    setImporting(true);
    try {
      const r = await importFile(f);
      if (r.ok) imp.accept({ name: f.name, size: f.size, format: r.format, candles: r.candles, first: r.first, last: r.last, warnings: r.warnings }, widget.id, startView());
      else imp.reject({ ok: false, widgetId: widget.id, name: f.name, issues: r.issues, truncated: r.truncated });
    } catch {
      imp.reject({ ok: false, widgetId: widget.id, name: f.name, issues: [{ row: null, message: "the file could not be read" }], truncated: false });
    } finally {
      setImporting(false);
    }
  };
  const [legend, setLegend] = useState<Candle | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const mainRef = useRef<ISeriesApi<SeriesType> | null>(null);
  const [chart, setChart] = useState<IChartApi | null>(null);
  const [markerCount, setMarkerCount] = useState(0);

  const { data: etf, error } = useQuery({
    queryKey: ["etf", DATASET_FILE[dataset]],
    queryFn: () => loadLocal<EtfExport>(DATASET_FILE[dataset]),
    staleTime: Infinity,
  });
  const all = useMemo(() => (imported ? imported.candles : etf?.candles[symbol] ?? []), [imported, etf, symbol]);
  const first = all[0]?.date, last = all.at(-1)?.date;
  const candles = useMemo(() => all.filter((c) => c.date >= rangeStart(range, first, last)), [all, range, first, last]);

  // Release-desk events: plotted on the event-overlay dataset only, and only when it is what was loaded.
  const { data: desk } = useQuery({ queryKey: ["release-desk"], queryFn: loadReleaseDesk, staleTime: Infinity, retry: false });
  const plan: EventPlan | null = useMemo(() => {
    if (source !== "overlay" || !etf || !desk) return null;
    if (etf.overlay !== true) return { kind: "error", reason: "the loaded chart data is not the event-overlay dataset" };
    if (desk.kind === "none") return { kind: "error", reason: "the release-desk export is not available" };
    if (desk.kind === "invalid") return { kind: "error", reason: `the release-desk export is invalid (${desk.reason})` };
    return planEventMarkers(desk.data, all, etf.event_snapshot);
  }, [source, etf, desk, all]);
  // Demo set: report honestly how many release-desk events fall within its dates (markers are overlay-only).
  const eventsInDemoDates = useMemo(() => {
    if (source !== "demo" || desk?.kind !== "ok" || !first || !last) return null;
    return desk.data.events.filter((e) => {
      const d = e.publication.official_release_time?.local_date ?? e.schedule.current?.local_date;
      return !!d && d >= first && d <= last;
    }).length;
  }, [source, desk, first, last]);

  const byTime = useMemo(() => {
    const m = new Map<number, Candle>();
    for (const c of candles) m.set(c.time, c);
    return m;
  }, [candles]);

  // Markers for the aligned events whose bar is inside the selected range.
  const inView: EventMark[] = useMemo(
    () => (plan?.kind === "ok" ? plan.marks.filter((m) => m.barTime !== null && byTime.has(m.barTime)) : []),
    [plan, byTime]
  );
  const seriesMarkers: SeriesMarker<Time>[] = useMemo(
    () => inView.map((m) => ({
      time: ts(m.barTime!), position: "aboveBar" as const, shape: MARK_STYLE[m.status].shape, color: MARK_STYLE[m.status].color,
      text: `${m.short} ${m.status === "confirmed" ? "✓" : "?"}`, id: m.eventId,
    })),
    [inView]
  );
  const eventsByTime = useMemo(() => {
    const m = new Map<number, EventMark[]>();
    for (const e of inView) m.set(e.barTime!, [...(m.get(e.barTime!) ?? []), e]);
    return m;
  }, [inView]);

  const indicatorData = useMemo(() => {
    if (candles.length === 0) return null;
    return {
      SMA20: active.has("SMA20") ? sma(candles, 20) : null,
      SMA50: active.has("SMA50") ? sma(candles, 50) : null,
      SMA200: active.has("SMA200") ? sma(candles, 200) : null,
      EMA20: active.has("EMA20") ? ema(candles, 20) : null,
      RSI: active.has("RSI") ? rsi(candles) : null,
      BOLL: active.has("BOLL") ? bollinger(candles) : null,
      MACD: active.has("MACD") ? macd(candles) : null,
    };
  }, [candles, active]);

  const indicatorMaps = useMemo(() => {
    const maps: Record<string, Map<number, number>> = {};
    if (!indicatorData) return maps;
    if (indicatorData.SMA20) maps.SMA20 = toMap(indicatorData.SMA20);
    if (indicatorData.SMA50) maps.SMA50 = toMap(indicatorData.SMA50);
    if (indicatorData.SMA200) maps.SMA200 = toMap(indicatorData.SMA200);
    if (indicatorData.EMA20) maps.EMA20 = toMap(indicatorData.EMA20);
    if (indicatorData.RSI) maps.RSI = toMap(indicatorData.RSI);
    if (indicatorData.BOLL) {
      maps.BOLL_U = toMap(indicatorData.BOLL.upper);
      maps.BOLL_M = toMap(indicatorData.BOLL.middle);
      maps.BOLL_L = toMap(indicatorData.BOLL.lower);
    }
    if (indicatorData.MACD) {
      maps.MACD_M = toMap(indicatorData.MACD.macd);
      maps.MACD_S = toMap(indicatorData.MACD.signal);
      maps.MACD_H = toMap(indicatorData.MACD.histogram);
    }
    return maps;
  }, [indicatorData]);

  const indicatorRows = useMemo(() => {
    if (!legend) return [];
    const t = legend.time;
    const get = (key: string) => indicatorMaps[key]?.get(t);
    const rows: Array<{ label: string; value: string; color: string }> = [];
    for (const key of ["SMA20", "SMA50", "SMA200", "EMA20"] as const) {
      const v = get(key);
      if (v !== undefined) rows.push({ label: key, value: fmt(v), color: INDICATOR_COLOR[key] });
    }
    const rsiV = get("RSI");
    if (rsiV !== undefined) rows.push({ label: "RSI", value: fmt(rsiV, 1), color: INDICATOR_COLOR.RSI });
    const bollM = get("BOLL_M");
    if (bollM !== undefined) {
      rows.push({ label: "BOLL", value: `${fmt(get("BOLL_U"))} / ${fmt(bollM)} / ${fmt(get("BOLL_L"))}`, color: INDICATOR_COLOR.BOLL });
    }
    const macdM = get("MACD_M");
    if (macdM !== undefined) {
      rows.push({ label: "MACD", value: `${fmt(macdM, 2)} / ${fmt(get("MACD_S"), 2)} / ${fmt(get("MACD_H"), 2)}`, color: INDICATOR_COLOR.MACD });
    }
    return rows;
  }, [legend, indicatorMaps]);

  useEffect(() => {
    setLegend(candles.length > 0 ? candles[candles.length - 1] : null);
  }, [candles]);

  // Chart + price/volume series: rebuilt only when the bars (symbol, range) or the chart type change.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || candles.length === 0) return;

    const chart = createChart(el, {
      layout: { background: { color: "#0a0a0a" }, textColor: "#808080", fontSize: 10, attributionLogo: true },
      grid: { vertLines: { color: "#1a1a1a" }, horzLines: { color: "#1a1a1a" } },
      crosshair: { mode: 0 },
      timeScale: { borderColor: "#262626", timeVisible: false },
      // 62 px = widest natural axis measured over all tickers, ranges, indicator panes and viewports (54-62 px)
      rightPriceScale: { borderColor: "#262626", minimumWidth: 62 },
      autoSize: true,
      handleScroll: { mouseWheel: false, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: true },
      handleScale: { mouseWheel: false, pinch: true, axisPressedMouseMove: true },
    });

    const upColor = "#00c853";
    const downColor = "#ff3d3d";

    let main: ISeriesApi<SeriesType>;
    if (chartType === "candles") {
      main = chart.addSeries(CandlestickSeries, { upColor, downColor, borderUpColor: upColor, borderDownColor: downColor, wickUpColor: upColor, wickDownColor: downColor });
      main.setData(candles.map((c) => ({ time: ts(c.time), open: c.open, high: c.high, low: c.low, close: c.close })));
    } else if (chartType === "bars") {
      main = chart.addSeries(BarSeries, { upColor, downColor });
      main.setData(candles.map((c) => ({ time: ts(c.time), open: c.open, high: c.high, low: c.low, close: c.close })));
    } else if (chartType === "line") {
      main = chart.addSeries(LineSeries, { color: "#ff9900", lineWidth: 1 });
      main.setData(candles.map((c) => ({ time: ts(c.time), value: c.close })));
    } else {
      main = chart.addSeries(AreaSeries, { lineColor: "#ff9900", topColor: "rgba(255,153,0,0.25)", bottomColor: "rgba(255,153,0,0)" });
      main.setData(candles.map((c) => ({ time: ts(c.time), value: c.close })));
    }
    mainRef.current = main;

    const vol = chart.addSeries(HistogramSeries, { priceScaleId: "vol", priceFormat: { type: "volume" } });
    vol.priceScale().applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } });
    vol.setData(candles.map((c) => ({ time: ts(c.time), value: c.volume, color: c.close >= c.open ? "rgba(0,200,83,0.4)" : "rgba(255,61,61,0.4)" })));

    chart.subscribeCrosshairMove((param) => {
      if (!param.time) {
        setLegend(candles[candles.length - 1]);
        return;
      }
      const hit = byTime.get(param.time as number);
      if (hit) setLegend(hit);
    });

    chart.timeScale().fitContent();
    chartRef.current = chart;
    setChart(chart);
    return () => {
      chartRef.current = null;
      mainRef.current = null;
      chart.remove();
    };
  }, [candles, chartType, byTime]);

  // Event markers on the live chart's price series (a plugin: attaching them does not rebuild the chart or reset zoom).
  // Every rebuild (dataset, symbol, range or chart type) starts from a new chart, so no marker is carried over.
  useEffect(() => {
    const series = mainRef.current;
    if (!chart || chartRef.current !== chart || !series || seriesMarkers.length === 0) {
      setMarkerCount(0);
      return;
    }
    const plugin = createSeriesMarkers(series, seriesMarkers);
    setMarkerCount(plugin.markers().length);
    return () => {
      if (chartRef.current === chart) plugin.detach();
    };
  }, [chart, seriesMarkers]);

  // Indicator series on the live chart; only these are replaced when an indicator is toggled.
  useEffect(() => {
    if (!chart || chartRef.current !== chart || !indicatorData) return;
    const added: ISeriesApi<SeriesType>[] = [];
    const overlay = (points: Point[], color: string) => {
      const s = chart.addSeries(LineSeries, { color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
      s.setData(points.map((p) => ({ time: ts(p.time), value: p.value })));
      added.push(s);
    };

    if (indicatorData.SMA20) overlay(indicatorData.SMA20, INDICATOR_COLOR.SMA20);
    if (indicatorData.SMA50) overlay(indicatorData.SMA50, INDICATOR_COLOR.SMA50);
    if (indicatorData.SMA200) overlay(indicatorData.SMA200, INDICATOR_COLOR.SMA200);
    if (indicatorData.EMA20) overlay(indicatorData.EMA20, INDICATOR_COLOR.EMA20);
    if (indicatorData.BOLL) {
      overlay(indicatorData.BOLL.upper, "rgba(255,153,0,0.5)");
      overlay(indicatorData.BOLL.middle, "rgba(255,153,0,0.8)");
      overlay(indicatorData.BOLL.lower, "rgba(255,153,0,0.5)");
    }

    let paneIdx = 1;
    if (indicatorData.RSI) {
      const s = chart.addSeries(LineSeries, { color: INDICATOR_COLOR.RSI, lineWidth: 1 }, paneIdx++);
      s.setData(indicatorData.RSI.map((p) => ({ time: ts(p.time), value: p.value })));
      added.push(s);
    }
    if (indicatorData.MACD) {
      const m = indicatorData.MACD;
      const pane = paneIdx++;
      const h = chart.addSeries(HistogramSeries, { color: "#4fc3f7" }, pane);
      h.setData(m.histogram.map((p) => ({ time: ts(p.time), value: p.value, color: p.value >= 0 ? "rgba(0,200,83,0.6)" : "rgba(255,61,61,0.6)" })));
      const l = chart.addSeries(LineSeries, { color: "#ff9900", lineWidth: 1 }, pane);
      l.setData(m.macd.map((p) => ({ time: ts(p.time), value: p.value })));
      const s = chart.addSeries(LineSeries, { color: "#ffffff", lineWidth: 1 }, pane);
      s.setData(m.signal.map((p) => ({ time: ts(p.time), value: p.value })));
      added.push(h, l, s);
    }

    return () => {
      if (chartRef.current !== chart) return; // chart already removed with all its series
      for (const s of added) chart.removeSeries(s);
      for (let i = chart.panes().length - 1; i >= 1; i--) chart.removePane(i);
    };
  }, [chart, indicatorData]);

  const toggleIndicator = (ind: Indicator) => {
    const next = new Set(active);
    if (next.has(ind)) next.delete(ind);
    else next.add(ind);
    patchView({ indicators: INDICATORS.filter((i) => next.has(i)) });
  };

  // Scale the visible window around its centre; the span stays within [MIN_ZOOM_BARS, all loaded bars] and the
  // window is shifted, not cut, when it would extend past the first or last bar.
  const zoom = (factor: number) => {
    const timeScale = chartRef.current?.timeScale();
    const visible = timeScale?.getVisibleLogicalRange();
    const last = candles.length - 1;
    if (!timeScale || !visible || last < 1) return;
    const span = Math.min(Math.max((visible.to - visible.from) * factor, Math.min(MIN_ZOOM_BARS, last)), last);
    const centre = Math.min(Math.max((visible.from + visible.to) / 2, span / 2), last - span / 2);
    timeScale.setVisibleLogicalRange({ from: centre - span / 2, to: centre + span / 2 });
  };

  const shownConfirmed = inView.filter((m) => m.status === "confirmed").length;
  const insufficient = INDICATORS.filter((i) => active.has(i) && candles.length > 0 && candles.length < MIN_BARS[i]);
  const shortName = (n: string) => (n.length > 80 ? n.slice(0, 77) + "…" : n);
  const notice = imp.notice && imp.notice.widgetId === widget.id ? imp.notice : null;
  const outOfRange = plan?.kind === "ok" ? plan.marks.length - inView.length : 0;

  return (
    <div className="flex flex-col h-full" data-testid="chart-root" data-dataset={source} data-first-bar={candles[0]?.date ?? ""}
      data-last-bar={candles.at(-1)?.date ?? ""} data-bars={candles.length} data-markers={markerCount}>
      <div className="flex gap-1 p-1 flex-wrap shrink-0">
        {DATASETS.map((d) => (
          <button key={d} className={`term-btn ${source === d ? "active" : ""}`} data-testid={`dataset-${d}`} onClick={() => setDataset(d)}
            title={d === "demo" ? "Simulated 2016–2023 demo bars" : "Simulated bars ending at the release-desk snapshot, with official release-event markers"}>
            {DATASET_LABEL[d]}
          </button>
        ))}
        {imp.set && (
          <button className={`term-btn ${source === "imported" ? "active" : ""}`} data-testid="dataset-imported" title={`Imported file: ${imp.set.name}`}
            onClick={() => imp.show(widget.id, startView())}>
            IMPORTED FILE
          </button>
        )}
        <button className="term-btn" data-testid="import-button" disabled={importing} onClick={() => fileRef.current?.click()}
          title="Chart a daily OHLCV .csv or .json file from this computer (read in this tab only; nothing is uploaded or saved)">
          {importing ? "READING…" : "IMPORT LOCAL DATA"}
        </button>
        <input ref={fileRef} type="file" accept=".csv,.json,text/csv,application/json" className="hidden" data-testid="import-input" onChange={onFile} />
        <span className="w-2" />
        {RANGES.map((r) => (
          <button key={r} className={`term-btn ${range === r ? "active" : ""}`} data-range={r} onClick={() => setRange(r)}>{rangeLabel(r, first, last)}</button>
        ))}
        <button className="term-btn" title="Zoom in" aria-label="Zoom in" onClick={() => zoom(1 / ZOOM_STEP)}>+</button>
        <button className="term-btn" title="Zoom out" aria-label="Zoom out" onClick={() => zoom(ZOOM_STEP)}>−</button>
        <span className="w-2" />
        {CHART_TYPES.map((t) => (
          <button key={t} className={`term-btn ${chartType === t ? "active" : ""}`} onClick={() => setChartType(t)}>{t.toUpperCase()}</button>
        ))}
        <span className="w-2" />
        {INDICATORS.map((ind) => (
          <button key={ind} className={`term-btn ${active.has(ind) ? "active" : ""}`} onClick={() => toggleIndicator(ind)}>{ind}</button>
        ))}
      </div>
      {notice && (notice.ok ? (
        <div className="mx-1 mb-1 px-2 py-px border border-[var(--up)] text-[10px] leading-tight shrink-0 flex gap-2" role="status" data-testid="import-ok">
          <span>Imported &ldquo;{shortName(notice.name)}&rdquo;: {notice.rows} daily bars, {notice.first} to {notice.last}.{notice.warnings.length ? ` Note: ${notice.warnings.join("; ")}.` : ""}</span>
          <button className="ml-auto underline decoration-dotted" onClick={imp.dismiss}>dismiss</button>
        </div>
      ) : (
        <div className="mx-1 mb-1 px-2 py-1 border border-[var(--down)] text-[10px] leading-tight shrink-0 max-h-24 overflow-auto" role="alert" data-testid="import-error">
          <div className="flex gap-2">
            <b className="down">Import failed: &ldquo;{shortName(notice.name)}&rdquo; was not loaded. Nothing else was changed.</b>
            <button className="ml-auto underline decoration-dotted" onClick={imp.dismiss}>dismiss</button>
          </div>
          <ul>{notice.issues.map((i, k) => <li key={k} data-testid="import-issue">{describeIssue(i)}</li>)}</ul>
          {notice.truncated && <div className="dim">Only the first {IMPORT_LIMITS.maxIssues} problems are listed.</div>}
          <div className="dim">Expected: one .csv or .json file with the columns date, open, high, low, close, volume (see docs/IMPORT.md).</div>
        </div>
      ))}
      {source !== "imported" && error && (isNotIncluded(error) ? <NotIncluded file={error.file} /> : <div className="p-2 down">Error: {(error as Error).message}</div>)}
      {source !== "imported" && !etf && !error && <div className="p-2 dim">Loading local data…</div>}
      {source === "imported" && imported && (
        <>
          <div className="mx-1 mb-1 px-2 py-0.5 border border-[#4fc3f7] text-[#4fc3f7] text-[11px] font-bold tracking-wider shrink-0" role="note" data-testid="imported-label">
            USER-IMPORTED DATA — LOCAL FILE
          </div>
          <div className="mx-1 mb-1 px-2 text-[10px] leading-tight shrink-0 dim" role="note" data-testid="imported-notice">
            &ldquo;{shortName(imported.name)}&rdquo;, supplied by you. The terminal checked its structure and numbers only; it has not verified its
            source, accuracy, authenticity or your right to use or share it. Read in this browser tab only: not uploaded, not saved, gone after a
            reload. Event markers are not shown on imported data.
          </div>
        </>
      )}
      {source !== "imported" && etf?.synthetic && (
        <div className="mx-1 mb-1 px-2 py-0.5 border border-[var(--amber)] text-[var(--amber)] text-[11px] font-bold tracking-wider shrink-0" role="note" data-testid="simulated-label">
          SIMULATED DATA — NOT REAL MARKET PRICES
        </div>
      )}
      {source === "overlay" && etf?.synthetic && (
        <div className="mx-1 mb-1 px-2 py-px border border-[var(--up)] text-[10px] leading-tight shrink-0" role="note" data-testid="overlay-notice">
          <b className="text-[var(--up)]">REAL OFFICIAL EVENT METADATA</b> (BLS/BEA{plan?.kind === "ok" ? `, snapshot ${plan.snapshot}` : ""}) on{" "}
          <b className="amber">SIMULATED PRICES</b> · illustrative alignment: no market reaction, trading edge or causal link is shown ·{" "}
          <span style={{ color: MARK_STYLE.confirmed.color }}>●✓</span> publication confirmed{" "}
          <span style={{ color: MARK_STYLE.unconfirmed.color }}>■?</span> scheduled time passed, not confirmed
        </div>
      )}
      {etf && candles.length === 0 && (
        <div className="p-2 dim" role="status" data-testid="chart-empty">No bars for {symbol} in this range. Nothing is drawn rather than an empty chart.</div>
      )}
      <div className="relative flex-1 min-h-0">
        {legend && (
          <div className="absolute top-1 left-2 z-10 flex flex-col gap-0.5 text-[11px] pointer-events-none bg-[rgba(10,10,10,0.7)] px-2 py-1 rounded max-w-[95%]" data-testid="chart-legend">
            <div className="flex gap-3 flex-wrap">
              <span className="amber">{source === "imported" ? "IMPORTED" : symbol}{source !== "imported" && etf?.synthetic ? " (simulated)" : ""} {legend.date}</span>
              <span className="dim">O <span className="text-[var(--text)]">{fmt(legend.open)}</span></span>
              <span className="dim">H <span className="up">{fmt(legend.high)}</span></span>
              <span className="dim">L <span className="down">{fmt(legend.low)}</span></span>
              <span className="dim">C <span className={legend.close >= legend.open ? "up" : "down"}>{fmt(legend.close)}</span></span>
              {source !== "imported" && <span className="dim">Adj C <span className="text-[var(--text)]">{fmt(legend.adjClose)}</span></span>}
              <span className="dim">Vol <span className="text-[var(--text)]">{fmtBig(legend.volume)}</span></span>
            </div>
            {(eventsByTime.get(legend.time) ?? []).map((e) => (
              <div key={e.eventId} className="flex gap-2 flex-wrap" data-testid="legend-event">
                <span style={{ color: MARK_STYLE[e.status].color }}>EVENT {e.title}</span>
                <span className="dim">{MARK_STYLE[e.status].label} · {markTime(e)}</span>
              </div>
            ))}
            {indicatorRows.length > 0 && (
              <div className="flex gap-3 flex-wrap">
                {indicatorRows.map((r) => (
                  <span key={r.label} className="dim">{r.label} <span style={{ color: r.color }}>{r.value}</span></span>
                ))}
              </div>
            )}
          </div>
        )}
        <div ref={containerRef} className="w-full h-full" />
      </div>
      {source === "demo" && eventsInDemoDates !== null && (
        <div className="px-2 py-0.5 dim text-[10px] shrink-0" role="status" data-testid="event-none">
          Event markers: {eventsInDemoDates === 0
            ? `none — no release-desk event falls within this dataset (${first} to ${last}).`
            : `${eventsInDemoDates} release-desk events fall within these dates, but markers are drawn only on the event-overlay dataset.`}
          {" "}Select EVENT OVERLAY to see official 2026 release dates on separately simulated bars.
        </div>
      )}
      {source === "overlay" && plan?.kind === "error" && (
        <div className="px-2 py-0.5 down text-[11px] shrink-0" role="alert" data-testid="event-error">
          Event markers unavailable: {plan.reason}. No markers are drawn.
        </div>
      )}
      {insufficient.length > 0 && (
        <div className="px-2 py-0.5 dim text-[10px] shrink-0" role="status" data-testid="indicator-insufficient">
          Not enough bars in this range for {insufficient.map((i) => `${i} (needs ${MIN_BARS[i]})`).join(", ")}: nothing is drawn for{" "}
          {insufficient.length > 1 ? "them" : "it"}. This range has {candles.length}.
        </div>
      )}
      {source === "overlay" && plan?.kind === "ok" && (
        <details className="px-2 py-0.5 text-[10px] shrink-0 max-h-24 overflow-auto" data-testid="event-list">
          <summary className="cursor-pointer dim" data-testid="event-summary">
            Event markers: {inView.length} shown ({shownConfirmed} confirmed, {inView.length - shownConfirmed} not confirmed)
            {outOfRange > 0 ? `, ${outOfRange} outside the selected range` : ""}
            {plan.omitted.length > 0 ? `, ${plan.omitted.length} not drawn` : ""} · {plan.later} later scheduled events are listed in Macro →
            Release schedule (no future prices are simulated)
          </summary>
          <ul className="mt-1 flex flex-col gap-1">
            {plan.marks.map((m) => (
              <li key={m.eventId} data-testid="event-row" data-event-id={m.eventId} data-status={m.status} data-date={m.date}
                data-shown={inView.includes(m) ? "yes" : "no"}>
                <span style={{ color: MARK_STYLE[m.status].color }}>{MARK_STYLE[m.status].shape === "circle" ? "●" : "■"} {m.title}</span>
                {" — "}{MARK_STYLE[m.status].label}. {m.status === "confirmed" ? "Official release time" : "Scheduled time"}: {markTime(m)}
                {m.documentIds.length > 0 ? ` · ${m.documentIds.join(", ")}` : ""} · {m.sources.map((x, i) => (
                  <a key={i} href={x.url} target="_blank" rel="noopener noreferrer" className="underline decoration-dotted mr-1">{x.publisher}</a>
                ))}
                <span className="dim">
                  {inView.includes(m) ? ` Marker on the ${m.date} bar (same US Eastern calendar date; daily bars do not show intraday timing).` : " Outside the selected range."}
                </span>
              </li>
            ))}
            {plan.omitted.map((o) => (
              <li key={o.eventId} data-testid="event-omitted" data-event-id={o.eventId} className="dim">
                Not drawn: {o.eventId}{o.mark ? ` (${o.mark.date})` : ""} — {o.reason}.
              </li>
            ))}
          </ul>
        </details>
      )}
      <div className="px-2 py-0.5 dim text-[10px] shrink-0">
        {source === "imported" && imported
          ? `Imported daily bars ${imported.first} to ${imported.last} (${imported.candles.length} rows), checked locally for structure and numerical consistency only. Volume as supplied; no adjustment is applied. Indicators are computed in the browser from these values. Not live.`
          : etf?.synthetic
          ? `Simulated daily bars to ${etf.bound}, ${etf.generator ? `${etf.generator.name}, seed ${etf.generator.seed}` : "generated"}; no market data was used${etf.overlay ? " and no event effect is simulated" : ""}. Adj C equals C (no dividends are simulated). Indicators are computed in the browser from these values. Not live.`
          : `Daily bars to ${etf?.bound ?? "2023-12-29"}. Indicators are computed in the browser from these values. Not live.`}
      </div>
    </div>
  );
}
