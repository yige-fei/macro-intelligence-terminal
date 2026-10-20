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

import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  createChart,
  CandlestickSeries,
  LineSeries,
  HistogramSeries,
  AreaSeries,
  BarSeries,
  type IChartApi,
  type ISeriesApi,
  type SeriesType,
  type UTCTimestamp,
} from "lightweight-charts";
import { fmt, fmtBig, isNotIncluded, loadLocal, type Candle, type EtfExport } from "../../lib/api";
import NotIncluded from "../NotIncluded";
import { sma, ema, rsi, macd, bollinger, type Point } from "../../lib/indicators";
import { useTerminal, useWidgetSymbol, type WidgetInstance } from "../../store/terminal";

const RANGES = ["1Y", "3Y", "5Y", "2016–23", "ALL"] as const;
const CHART_TYPES = ["candles", "bars", "line", "area"] as const;
const INDICATORS = ["SMA20", "SMA50", "SMA200", "EMA20", "BOLL", "RSI", "MACD"] as const;

type Range = (typeof RANGES)[number];
type ChartType = (typeof CHART_TYPES)[number];
type Indicator = (typeof INDICATORS)[number];

const ts = (t: number) => t as UTCTimestamp;
const toMap = (pts: Point[]) => new Map(pts.map((p) => [p.time, p.value]));
const RANGE_START: Record<Range, string> = {
  "1Y": "2023-01-01", "3Y": "2021-01-01", "5Y": "2019-01-01", "2016–23": "2016-01-01", ALL: "0000-00-00",
};

const INDICATOR_COLOR: Record<string, string> = {
  SMA20: "#ffd966", SMA50: "#4fc3f7", SMA200: "#ba68c8", EMA20: "#ff8a65", RSI: "#ff9900", BOLL: "#ff9900", MACD: "#4fc3f7",
};

const DEFAULT_INDICATORS: Indicator[] = ["SMA50"];
const ZOOM_STEP = 1.5;     // visible span is divided (+) or multiplied (−) by this per click
const MIN_ZOOM_BARS = 20;  // narrowest window, about one trading month

export default function ChartWidget({ widget }: { widget: WidgetInstance }) {
  const symbol = useWidgetSymbol(widget);
  const setWidgetView = useTerminal((s) => s.setWidgetView);
  const v = widget.view;
  const range: Range = (RANGES as readonly string[]).includes(v?.range ?? "") ? (v!.range as Range) : "5Y";
  const chartType: ChartType = (CHART_TYPES as readonly string[]).includes(v?.chartType ?? "") ? (v!.chartType as ChartType) : "candles";
  const storedIndicators = v?.indicators;
  const active = useMemo(
    () => new Set<Indicator>(storedIndicators ? storedIndicators.filter((i): i is Indicator => (INDICATORS as readonly string[]).includes(i)) : DEFAULT_INDICATORS),
    [storedIndicators]
  );
  const setRange = (r: Range) => setWidgetView(widget.id, { range: r });
  const setChartType = (t: ChartType) => setWidgetView(widget.id, { chartType: t });
  const [legend, setLegend] = useState<Candle | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const [chart, setChart] = useState<IChartApi | null>(null);

  const { data: etf, error } = useQuery({
    queryKey: ["etf"],
    queryFn: () => loadLocal<EtfExport>("etf_prices.json"),
    staleTime: Infinity,
  });
  const candles = useMemo(
    () => (etf?.candles[symbol] ?? []).filter((c) => c.date >= RANGE_START[range]),
    [etf, symbol, range]
  );

  const byTime = useMemo(() => {
    const m = new Map<number, Candle>();
    for (const c of candles) m.set(c.time, c);
    return m;
  }, [candles]);

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

    if (chartType === "candles") {
      chart
        .addSeries(CandlestickSeries, { upColor, downColor, borderUpColor: upColor, borderDownColor: downColor, wickUpColor: upColor, wickDownColor: downColor })
        .setData(candles.map((c) => ({ time: ts(c.time), open: c.open, high: c.high, low: c.low, close: c.close })));
    } else if (chartType === "bars") {
      chart.addSeries(BarSeries, { upColor, downColor })
        .setData(candles.map((c) => ({ time: ts(c.time), open: c.open, high: c.high, low: c.low, close: c.close })));
    } else if (chartType === "line") {
      chart.addSeries(LineSeries, { color: "#ff9900", lineWidth: 1 }).setData(candles.map((c) => ({ time: ts(c.time), value: c.close })));
    } else {
      chart
        .addSeries(AreaSeries, { lineColor: "#ff9900", topColor: "rgba(255,153,0,0.25)", bottomColor: "rgba(255,153,0,0)" })
        .setData(candles.map((c) => ({ time: ts(c.time), value: c.close })));
    }

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
      chart.remove();
    };
  }, [candles, chartType, byTime]);

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
    setWidgetView(widget.id, { indicators: INDICATORS.filter((i) => next.has(i)) });
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

  return (
    <div className="flex flex-col h-full">
      <div className="flex gap-1 p-1 flex-wrap shrink-0">
        {RANGES.map((r) => (
          <button key={r} className={`term-btn ${range === r ? "active" : ""}`} onClick={() => setRange(r)}>{r}</button>
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
      {error && (isNotIncluded(error) ? <NotIncluded file={error.file} /> : <div className="p-2 down">Error: {(error as Error).message}</div>)}
      {!etf && !error && <div className="p-2 dim">Loading local data…</div>}
      {etf?.synthetic && (
        <div className="mx-1 mb-1 px-2 py-0.5 border border-[var(--amber)] text-[var(--amber)] text-[11px] font-bold tracking-wider shrink-0" role="note" data-testid="simulated-label">
          SIMULATED DATA — NOT REAL MARKET PRICES
        </div>
      )}
      {etf && candles.length === 0 && (
        <div className="p-2 dim" role="status" data-testid="chart-empty">No bars for {symbol} in this range. Nothing is drawn rather than an empty chart.</div>
      )}
      <div className="relative flex-1 min-h-0">
        {legend && (
          <div className="absolute top-1 left-2 z-10 flex flex-col gap-0.5 text-[11px] pointer-events-none bg-[rgba(10,10,10,0.7)] px-2 py-1 rounded max-w-[95%]" data-testid="chart-legend">
            <div className="flex gap-3 flex-wrap">
              <span className="amber">{symbol}{etf?.synthetic ? " (simulated)" : ""} {legend.date}</span>
              <span className="dim">O <span className="text-[var(--text)]">{fmt(legend.open)}</span></span>
              <span className="dim">H <span className="up">{fmt(legend.high)}</span></span>
              <span className="dim">L <span className="down">{fmt(legend.low)}</span></span>
              <span className="dim">C <span className={legend.close >= legend.open ? "up" : "down"}>{fmt(legend.close)}</span></span>
              <span className="dim">Adj C <span className="text-[var(--text)]">{fmt(legend.adjClose)}</span></span>
              <span className="dim">Vol <span className="text-[var(--text)]">{fmtBig(legend.volume)}</span></span>
            </div>
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
      <div className="px-2 py-0.5 dim text-[10px] shrink-0">
        {etf?.synthetic
          ? `Simulated daily bars to ${etf.bound}, ${etf.generator ? `${etf.generator.name}, seed ${etf.generator.seed}` : "generated"}; no market data was used. Adj C equals C (no dividends are simulated). Indicators are computed in the browser from these values. Not live.`
          : `Daily bars to ${etf?.bound ?? "2023-12-29"}. Indicators are computed in the browser from these values. Not live.`}
      </div>
    </div>
  );
}
