// Browser checks of the built demo (headless Chrome over CDP; no npm packages).
//
//   cd web && npm ci && npm run build && cd ..
//   node tests/browser/smoke.mjs [--out <dir>]          # CHROME_PATH=/path/to/chrome if not in a standard place
//
// Starts its own loopback servers (python3 -m terminal_demo.serve) on free ports: one with demo-data/, and others with
// temporary, deliberately broken data (missing research, missing market data, an empty instrument; OS-P2A: event
// snapshot mismatch, a missing event bar, a missing release-desk export, a missing overlay file).
// Expected values are read independently from demo-data/. Exit code 0 only if every check passes; 2 if no browser.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { external, findChrome, launch, save, sleep } from "./cdp_lib.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const outArg = process.argv.indexOf("--out");
const OUT = outArg > 0 ? resolve(process.argv[outArg + 1]) : mkdtempSync(join(tmpdir(), "mit-smoke-"));
mkdirSync(OUT, { recursive: true });
if (!findChrome()) {
  console.error("SKIPPED: no Chrome/Chromium found; set CHROME_PATH. No browser check was run.");
  process.exit(2);
}
const TMP = mkdtempSync(join(tmpdir(), "mit-smoke-data-"));

const freePort = () => new Promise((res) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });
const json = (p) => JSON.parse(readFileSync(p, "utf8"));
const etf = json(join(REPO, "demo-data", "etf_prices.json"));
const research = json(join(REPO, "demo-data", "research.json"));
const overlay = json(join(REPO, "demo-data", "event_overlay_prices.json"));
const desk = json(join(REPO, "web", "public", "intel", "release_desk.v1.json"));
// OS-P2A oracle, from the export itself: confirmed -> official release time; due but unconfirmed -> scheduled time.
const EXPECTED_EVENTS = desk.events.flatMap((e) => {
  const st = e.publication.status;
  const t = st === "CONFIRMED" ? e.publication.official_release_time : st === "DUE_UNCONFIRMED" ? e.schedule.current : null;
  return t ? [{ id: e.event_id, status: st === "CONFIRMED" ? "confirmed" : "unconfirmed", date: t.local_date, time: t.local_time, utc: t.utc,
    docs: e.publication.evidence.map((x) => x.document_id).filter(Boolean) }] : [];
}).sort((a, b) => a.date.localeCompare(b.date));
const LATER_EVENTS = desk.events.filter((e) => e.publication.status === "NOT_YET_DUE").length;
const NAME = Object.fromEntries(desk.events.map((e) => [e.event_id, e.release_name]));
/** First bar on or after a range start, from the data file (independent of the UI code). */
const firstOnOrAfter = (rows, start) => rows.find((c) => c.date >= start)?.date;
const fmt = (n, d = 2) => n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const signed = (n, d = 4) => (n >= 0 ? "+" : "−") + Math.abs(n).toFixed(d);

/** A data directory with the given demo files (optionally transformed) and a matching ALLOWLIST.json. */
function dataDir(name, files, transform = {}) {
  const d = join(TMP, name);
  mkdirSync(d, { recursive: true });
  const allow = {};
  for (const f of files) {
    let body = readFileSync(join(REPO, "demo-data", f));
    if (transform[f]) body = Buffer.from(JSON.stringify(transform[f](JSON.parse(body.toString()))) + "\n");
    writeFileSync(join(d, f), body);
    allow[f] = createHash("sha256").update(body).digest("hex");
  }
  writeFileSync(join(d, "ALLOWLIST.json"), JSON.stringify({ version: 1, files: allow }));
  return d;
}

async function serve(dataDirPath, docroot = null) {
  const port = await freePort();
  const proc = spawn(process.env.PYTHON ?? "python3", ["-B", "-m", "terminal_demo.serve", "--port", String(port), "--data-dir", dataDirPath,
    ...(docroot ? ["--docroot", docroot] : [])],
    { cwd: REPO, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  proc.stdout.on("data", (b) => (out += b));
  for (let i = 0; i < 50 && !out.includes("serving"); i++) await sleep(100);
  if (!out.includes("serving")) { proc.kill(); throw new Error("demo server did not start: " + out.trim()); }
  return { port, origin: `http://127.0.0.1:${port}/`, stop: () => proc.kill("SIGTERM") };
}

const results = [];
const check = (group, id, name, ok, info = null) => {
  results.push({ group, id, name, ok: !!ok, info });
  console.log(`${ok ? "PASS" : "FAIL"} ${id} ${name}${ok || info === null ? "" : " :: " + JSON.stringify(info).slice(0, 300)}`);
};

async function waitFor(page, expr, ms = 8000) {
  for (let t = 0; t < ms; t += 150) {
    try { if (await page.evaluate(`!!(${expr})`)) return true; } catch { /* page not ready */ }
    await sleep(150);
  }
  return false;
}
const text = (page, sel) => page.evaluate(`document.querySelector(${JSON.stringify(sel)})?.innerText ?? null`);
const chartReady = (page) => waitFor(page, `document.querySelector('[data-widget="chart"] canvas') && document.querySelector('[data-testid="chart-legend"]')`);
const chartRoot = (page) => page.evaluate(`(() => { const r = document.querySelector('[data-testid="chart-root"]'); return r ? { ...r.dataset } : null })()`);
/** Pixels of exactly the given RGB colours in the chart canvases (markers use colours no other chart element uses in LINE mode). */
const colourPixels = (page) => page.evaluate(`(() => { let g = 0, s = 0; for (const c of document.querySelectorAll('[data-widget="chart"] canvas')) {
  const d = c.getContext("2d")?.getImageData(0, 0, c.width, c.height)?.data; if (!d) continue;
  for (let i = 0; i < d.length; i += 4) { if (d[i] === 0 && d[i+1] === 200 && d[i+2] === 83 && d[i+3] === 255) g++; if (d[i] === 176 && d[i+1] === 176 && d[i+2] === 176 && d[i+3] === 255) s++; } }
  return { confirmed: g, unconfirmed: s }; })()`);
/** Moves the crosshair until the legend shows the given bar date; returns the legend text or null. */
async function hoverDate(page, date) {
  const r = await page.rect('[data-widget="chart"] canvas');
  const y = r.y + r.h * 0.5;
  const legendDate = async (x) => { await page.move(x, y); await sleep(60); return (await page.legend())?.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? null; };
  let lo = r.x + 2, hi = r.x + r.w - 2;
  for (let i = 0; i < 18 && hi - lo > 1; i++) {
    const mid = Math.round((lo + hi) / 2);
    const d = await legendDate(mid);
    if (!d) { hi = mid; continue; }
    if (d < date) lo = mid; else hi = mid;
  }
  for (let x = lo - 3; x <= hi + 3; x++) if ((await legendDate(x)) === date) return page.legend();
  return null;
}
const clickButton = (page, label, scope = '[data-widget="chart"]') =>
  page.clickEl(`[...document.querySelectorAll('${scope} button')].find(b => b.innerText.trim() === ${JSON.stringify(label)})`);

let chrome = null;
const servers = [];
try {
  chrome = await launch({ profileDir: join(TMP, "profile"), port: await freePort() }); // inside try: temp data is always removed
  // ---------------------------------------------------------------- main scenario: demo-data/
  const main = await serve(join(REPO, "demo-data"));
  servers.push(main);
  const page = chrome;
  const O = main.origin;

  await page.goto(O, 4000);
  await waitFor(page, `document.documentElement.hasAttribute("data-app-ready")`);
  const cards = await page.evaluate(`[...document.querySelectorAll('[aria-label="Product areas"] > li')].map(li => li.innerText)`);
  check("home", "H1", "Home shows the four product areas with demo statuses", cards.length === 4
    && cards.some((c) => c.includes("SIMULATED DATA")) && cards.some((c) => c.includes("ILLUSTRATIVE DEMO")) && cards.some((c) => c.includes("REAL METADATA")), cards.map((c) => c.split("\n")[0]));
  const intro = await text(page, '[data-testid="home-intro"]');
  const badge = await text(page, ".hist-badge");
  check("home", "H2", "Intro and header badge say what is real and what is simulated",
    /release metadata \(BLS, BEA\) is real/.test(intro ?? "") && /simulated/.test(intro ?? "") && /^LOCAL TERMINAL · NO LIVE MARKET FEED$/.test(badge ?? ""), { intro, badge }); // OS-P2B: source-neutral (panels state provenance)

  // navigation through the shared header, then Back
  const visited = [];
  for (const [label, ws] of [["MACRO", "macro"], ["MARKET", "market"], ["RESEARCH", "research"], ["SETTINGS", "settings"], ["HOME", null]]) {
    await page.clickEl(`[...document.querySelectorAll('nav[aria-label="Workspaces"] a')].find(a => a.innerText.trim() === ${JSON.stringify(label)})`);
    await sleep(900);
    visited.push(await page.evaluate("new URLSearchParams(location.search).get('ws')") ?? "home");
    if (ws && visited.at(-1) !== ws) break;
  }
  await page.evaluate("history.back()"); await sleep(900);
  const afterBack = await page.evaluate("new URLSearchParams(location.search).get('ws')");
  check("nav", "N1", "All five workspaces reachable from the header; Back returns to the previous one",
    visited.join(",") === "macro,market,research,settings,home" && afterBack === "settings", { visited, afterBack });

  // ---------------------------------------------------------------- Market
  await page.evaluate("localStorage.clear()");
  await page.goto(O + "?ws=market", 4000);
  const ready = await chartReady(page);
  const label = await text(page, '[data-testid="simulated-label"]');
  check("market", "M1", "Chart renders simulated bars with the fixed SIMULATED label", ready && label === "SIMULATED DATA — NOT REAL MARKET PRICES", { ready, label });
  const lastA = etf.candles["DEMO-A"].at(-1);
  let legend = await page.legend();
  check("market", "M2", "Legend shows DEMO-A (simulated) and the last generated bar",
    legend?.startsWith(`DEMO-A (simulated) ${lastA.date}`) && legend.includes(`C ${fmt(lastA.close)}`) && legend.includes(`H ${fmt(lastA.high)}`), legend);
  const caption = await page.evaluate(`[...document.querySelectorAll('[data-widget="chart"] div')].map(d => d.innerText).find(t => t.startsWith("Simulated daily bars")) ?? null`);
  check("market", "M3", "Caption names the generator and seed; no provider wording",
    !!caption && caption.includes(`seed ${etf.generator.seed}`) && !/Yahoo|FRED|recorded by/i.test(caption), caption);
  const attribution = await page.evaluate(`!!document.querySelector('[data-widget="chart"] a[href*="tradingview.com"]')`);
  check("market", "M4", "TradingView attribution link is shown on the chart", attribution);

  const h0 = await page.chartHash();
  await clickButton(page, "1Y"); await sleep(700);
  const h1 = await page.chartHash();
  const st1 = await page.store();
  check("market", "M5", "Range 1Y redraws the chart and is saved on the widget", h1 && h1 !== h0 && st1?.state?.widgets?.find((w) => w.type === "chart")?.view?.range === "1Y", { h0, h1 });
  await clickButton(page, "+"); await sleep(600);
  const h2 = await page.chartHash();
  await clickButton(page, "−"); await sleep(600);
  const h3 = await page.chartHash();
  check("market", "M6", "Zoom in and zoom out change the visible window", h2 !== h1 && h3 !== h2, { h1, h2, h3 });
  const r = await page.rect('[data-widget="chart"] canvas');
  await page.drag(r.x + r.w * 0.6, r.y + r.h * 0.4, r.x + r.w * 0.2, r.y + r.h * 0.4, 14);
  const h4 = await page.chartHash();
  check("market", "M7", "Dragging pans the chart", h4 !== h3, { h3, h4 });
  const g0 = await page.chartGeom();
  await clickButton(page, "RSI"); await sleep(700);
  const g1 = await page.chartGeom();
  await clickButton(page, "MACD"); await sleep(700);
  const g2 = await page.chartGeom();
  // Lightweight Charts 5 renders each pane as a table row and puts a thin separator row between panes: count tall rows only.
  const panes = (g) => g.rowHeights.filter((h) => h > 5).length;
  check("market", "M8", "RSI and MACD each add an indicator pane", panes(g1) === panes(g0) + 1 && panes(g2) === panes(g1) + 1,
    { panes: [panes(g0), panes(g1), panes(g2)], rowHeights: [g0.rowHeights, g1.rowHeights, g2.rowHeights] });
  await clickButton(page, "LINE"); await sleep(600);
  const h5 = await page.chartHash();
  await clickButton(page, "CANDLES"); await sleep(600);
  const h6 = await page.chartHash();
  check("market", "M9", "Chart type LINE and back to CANDLES redraw the chart", h5 !== h4 && h6 !== h5, { h4, h5, h6 });

  // instrument switch through the command palette (Ctrl+K)
  await page.key({ key: "k", code: "KeyK", vk: 75, modifiers: 2 }); await sleep(500);
  const paletteOpen = await waitFor(page, `document.querySelector('input[aria-label="Search instruments and macro series"]')`, 3000);
  const options = await page.evaluate(`[...document.querySelectorAll('[role="option"]')].map(o => o.innerText.split("\\n")[0])`);
  await page.type("DEMO-B"); await sleep(300);
  await page.key({ key: "Enter", code: "Enter", vk: 13, text: "\r" }); await sleep(1200);
  legend = await page.legend();
  const lastB = etf.candles["DEMO-B"].at(-1);
  check("market", "M10", "Command palette lists the four demo instruments and switches to DEMO-B",
    paletteOpen && options.join(",") === "DEMO-A,DEMO-B,DEMO-C,DEMO-D" && legend?.startsWith(`DEMO-B (simulated) ${lastB.date}`) && legend.includes(`C ${fmt(lastB.close)}`), { options, legend });

  // saved layout survives a reload
  const before = { geom: await page.chartGeom(), store: await page.store() };
  await page.reload(4000); await chartReady(page); await sleep(800);
  const after = { geom: await page.chartGeom(), store: await page.store(), legend: await page.legend() };
  const cw = after.store?.state?.widgets?.find((w) => w.type === "chart");
  check("market", "M11", "Reload restores instrument, range, indicators and panes",
    after.store?.state?.activeSymbol === "DEMO-B" && cw?.view?.range === "1Y" && ["RSI", "MACD"].every((i) => cw?.view?.indicators?.includes(i))
    && after.geom.rows === before.geom.rows && after.legend?.startsWith("DEMO-B (simulated)"), { rowsBefore: before.geom.rows, rowsAfter: after.geom.rows, view: cw?.view });
  const macroPanel = await page.evaluate(`!!document.querySelector('[data-widget="macro"] [data-testid="not-included"][data-file="macro_series.json"]')`);
  check("market", "M12", "Point-in-time macro panel shows its honest not-included state", macroPanel);
  const mktResearch = await text(page, '[data-widget="research"] [data-testid="illustrative-label"]');
  check("market", "M13", "Market's research panel is labelled illustrative", mktResearch === "ILLUSTRATIVE FIGURES — RANDOMLY GENERATED, NOT RESEARCH RESULTS", mktResearch);
  await page.shot(join(OUT, "01_market.png"));

  // ---------------------------------------------------------------- OS-P2A: event overlay
  await page.goto(O + "?ws=market", 3500); await chartReady(page);
  await page.clickEl(`document.querySelector('[data-testid="dataset-overlay"]')`);
  await waitFor(page, `document.querySelector('[data-testid="chart-root"]')?.dataset.dataset === "overlay" && document.querySelector('[data-testid="event-list"]')`);
  await sleep(800);
  let root = await chartRoot(page);
  const overlayNotice = await text(page, '[data-testid="overlay-notice"]');
  const overlayCaption = await page.evaluate(`[...document.querySelectorAll('[data-widget="chart"] div')].map(d => d.innerText).find(t => t.startsWith("Simulated daily bars")) ?? null`);
  check("overlay", "E1", "EVENT OVERLAY loads the separate simulated set (2025-01-02 to 2026-10-16) with both labels",
    root?.dataset === "overlay" && root.firstBar === "2025-01-02" && root.lastBar === "2026-10-16" && Number(root.bars) === overlay.candles["DEMO-B"].length
    && (await text(page, '[data-testid="simulated-label"]')) === "SIMULATED DATA — NOT REAL MARKET PRICES"
    && /REAL OFFICIAL EVENT METADATA/.test(overlayNotice ?? "") && /SIMULATED PRICES/.test(overlayNotice ?? "") && /no market reaction, trading edge or causal link/.test(overlayNotice ?? "")
    && /snapshot 2026-10-17/.test(overlayNotice ?? "") && /no event effect is simulated/.test(overlayCaption ?? "") && overlayCaption.includes(`seed ${overlay.generator.seed}`),
    { root, overlayNotice, overlayCaption });
  await page.clickEl(`document.querySelector('[data-testid="event-list"] summary')`); await sleep(300); // open the list before reading it
  const evRows = await page.evaluate(`[...document.querySelectorAll('[data-testid="event-row"]')].map(r => ({ id: r.dataset.eventId, status: r.dataset.status, date: r.dataset.date, shown: r.dataset.shown, text: r.innerText,
    links: [...r.querySelectorAll('a')].map(a => a.href) }))`);
  const omittedRows = await page.evaluate(`document.querySelectorAll('[data-testid="event-omitted"]').length`);
  const summary = await text(page, '[data-testid="event-summary"]');
  const nConf = EXPECTED_EVENTS.filter((e) => e.status === "confirmed").length;
  check("overlay", "E2", `Exactly the ${EXPECTED_EVENTS.length} due events are marked (${nConf} confirmed, ${EXPECTED_EVENTS.length - nConf} not confirmed); the chart library holds ${EXPECTED_EVENTS.length} markers`,
    JSON.stringify(evRows.map((r) => [r.id, r.status, r.date, r.shown])) === JSON.stringify(EXPECTED_EVENTS.map((e) => [e.id, e.status, e.date, "yes"]))
    && Number(root.markers) === EXPECTED_EVENTS.length && omittedRows === 0
    && summary?.includes(`${EXPECTED_EVENTS.length} shown (${nConf} confirmed, ${EXPECTED_EVENTS.length - nConf} not confirmed)`) && summary.includes(`${LATER_EVENTS} later scheduled events`),
    { rows: evRows.map((r) => [r.id, r.status, r.date, r.shown]), markers: root?.markers, omittedRows, summary });
  const detailOk = EXPECTED_EVENTS.every((e) => {
    const r = evRows.find((x) => x.id === e.id);
    if (!r) return false;
    const tm = `${e.date} ${e.time} ET (${e.utc.slice(11, 16)}Z)`;
    const kind = e.status === "confirmed" ? /publication confirmed\. Official release time/ : /publication not confirmed\. Scheduled time/;
    return r.text.includes(tm) && kind.test(r.text) && e.docs.every((d) => r.text.includes(d)) && r.links.length > 0
      && r.links.every((u) => /^https:\/\/www\.(bls|bea)\.gov\//.test(u)) && r.text.includes(`Marker on the ${e.date} bar`);
  });
  check("overlay", "E3", "Each event shows its official (confirmed) or scheduled (unconfirmed) time, document ids and official source links, on its own date",
    detailOk, evRows.map((r) => r.text));

  await clickButton(page, "1Y"); await sleep(900);
  const cpi = EXPECTED_EVENTS.find((e) => e.id === "BLS.CPI.2026-09"), gdp = EXPECTED_EVENTS.find((e) => e.status === "unconfirmed" && e.date >= "2026-01-01");
  const legCpi = await hoverDate(page, cpi.date);
  const legGdp = await hoverDate(page, gdp.date);
  const legPlain = await hoverDate(page, "2026-10-13");
  check("overlay", "E5", "Hovering the event bars shows the event in the legend with its status and time; a plain bar shows none",
    (legCpi ?? "").includes(`EVENT ${NAME[cpi.id]} · Sep 2026`) && (legCpi ?? "").includes(`publication confirmed · ${cpi.date} ${cpi.time} ET (${cpi.utc.slice(11, 16)}Z)`)
    && (legGdp ?? "").includes(`EVENT ${NAME[gdp.id]}`) && (legGdp ?? "").includes(`publication not confirmed · ${gdp.date} ${gdp.time} ET (${gdp.utc.slice(11, 16)}Z)`)
    && !!legPlain && !/EVENT/.test(legPlain),
    { legCpi, legGdp, legPlain });
  await page.shot(join(OUT, "05_overlay_hover.png"));

  // range presets, both datasets, against the data files
  const presetResults = {};
  for (const [ds, rowsData, spanLabel] of [["overlay", overlay.candles["DEMO-B"], "2025–26"], ["demo", etf.candles["DEMO-B"], "2016–23"]]) {
    await page.clickEl(`document.querySelector('[data-testid="dataset-${ds}"]')`); await sleep(1000);
    const lastY = Number(rowsData.at(-1).date.slice(0, 4)), firstY = rowsData[0].date.slice(0, 4);
    const starts = { "1Y": `${lastY}-01-01`, "3Y": `${lastY - 2}-01-01`, "5Y": `${lastY - 4}-01-01`, SPAN: `${firstY}-01-01`, ALL: "0000-00-00" };
    const labels = await page.evaluate(`Object.fromEntries([...document.querySelectorAll('[data-widget="chart"] button[data-range]')].map(b => [b.dataset.range, b.innerText.trim()]))`);
    for (const [r, start] of Object.entries(starts)) {
      await page.clickEl(`document.querySelector('[data-widget="chart"] button[data-range="${r}"]')`); await sleep(500);
      const rt = await chartRoot(page);
      presetResults[`${ds}:${r}`] = [rt.firstBar, rt.lastBar, firstOnOrAfter(rowsData, start), rt.markers];
    }
    presetResults[`${ds}:labels`] = labels;
    presetResults[`${ds}:spanLabel`] = labels.SPAN === spanLabel;
  }
  const presetsOk = Object.entries(presetResults).every(([k, v]) => k.endsWith(":labels") ? true : k.endsWith(":spanLabel") ? v
    : v[0] === v[2] && v[1] === (k.startsWith("overlay") ? "2026-10-16" : "2023-12-29") && (k.startsWith("demo") ? v[3] === "0" : v[3] === String(EXPECTED_EVENTS.length)));
  check("overlay", "E6", "Range presets follow each dataset's own dates (demo set: the OS-P1 values 2023/2021/2019/2016)", presetsOk, presetResults);

  // switching datasets does not carry over the range or markers; the choice persists; legacy saved ranges still load
  await page.clickEl(`document.querySelector('[data-testid="dataset-overlay"]')`); await sleep(900);
  await clickButton(page, "1Y"); await sleep(600);
  await page.clickEl(`document.querySelector('[data-testid="dataset-demo"]')`); await sleep(1200);
  const afterSwitch = { root: await chartRoot(page), view: (await page.store())?.state?.widgets?.find((w) => w.type === "chart")?.view,
    none: await text(page, '[data-testid="event-none"]'), notice: await text(page, '[data-testid="overlay-notice"]') };
  await page.clickEl(`document.querySelector('[data-testid="dataset-overlay"]')`); await sleep(1200);
  await page.reload(4000); await chartReady(page); await sleep(1000);
  const afterReload = await chartRoot(page);
  await page.seedStorage(O + "?ws=market", { "macro-research-workspace-v2": JSON.stringify({ state: { activeSymbol: "DEMO-A",
    widgets: [{ id: "w-chart", type: "chart", linked: true, view: { range: "2016–23", indicators: ["SMA50"] } }], layout: [{ i: "w-chart", x: 0, y: 0, w: 8, h: 14 }] }, version: 2 }) });
  await chartReady(page); await sleep(800);
  const legacy = { root: await chartRoot(page), active: await page.evaluate(`document.querySelector('[data-widget="chart"] button[data-range].active')?.innerText`) };
  check("overlay", "E7", "Switching resets the range to 5Y and leaves no markers or overlay notice; the dataset persists across reload; an OS-P1 saved range still loads",
    afterSwitch.root.dataset === "demo" && afterSwitch.view?.range === "5Y" && afterSwitch.view?.dataset === "demo" && afterSwitch.root.markers === "0"
    && afterSwitch.root.lastBar === "2023-12-29" && afterSwitch.notice === null && /none — no release-desk event falls within this dataset \(2016-01-04 to 2023-12-29\)/.test(afterSwitch.none ?? "")
    && afterReload.dataset === "overlay" && afterReload.markers === String(EXPECTED_EVENTS.length)
    && legacy.root.dataset === "demo" && legacy.active === "2016–23" && legacy.root.firstBar === "2016-01-04",
    { afterSwitch, afterReload, legacy });

  // every chart type keeps the warning, the notice and the markers
  await page.clickEl(`document.querySelector('[data-testid="dataset-overlay"]')`); await sleep(1000);
  const modes = {};
  for (const t of ["BARS", "LINE", "AREA", "CANDLES"]) {
    await clickButton(page, t); await sleep(700);
    const rt = await chartRoot(page);
    modes[t] = [rt.markers, !!(await text(page, '[data-testid="simulated-label"]')), !!(await text(page, '[data-testid="overlay-notice"]'))];
  }
  check("overlay", "E8", "Every chart type keeps the SIMULATED label, the overlay notice and all markers",
    Object.values(modes).every(([m, a, b]) => m === String(EXPECTED_EVENTS.length) && a && b), modes);
  // UX-2: label density follows the markers' actual on-screen spacing; markers never change. Spacing is changed by
  // zooming (a wider window does not change it: the chart keeps its bar spacing on resize; see the UX-1 note).
  const labelMap = async () => Object.fromEntries(((await chartRoot(page)).markerLabels || "").split("|").filter(Boolean).map((x) => {
    const [id, rest] = x.split("="); const at = rest.lastIndexOf("@"); return [id, { text: rest.slice(0, at), on: rest.slice(at + 1) === "on" }];
  }));
  const JOBS = "BLS.EMPSIT.2026-09", CPI = "BLS.CPI.2026-09";
  const gdpIds = EXPECTED_EVENTS.filter((e) => e.status === "unconfirmed").map((e) => e.id);
  const overlayAll = JSON.stringify({ state: { activeSymbol: "DEMO-A", widgets: [{ id: "w-chart", type: "chart", linked: true,
    view: { dataset: "overlay", range: "ALL", chartType: "candles", indicators: ["SMA50"] } }], layout: [{ i: "w-chart", x: 0, y: 0, w: 8, h: 14 }] }, version: 2 });
  await page.seedStorage(O + "?ws=market", { "macro-research-workspace-v2": overlayAll }); await chartReady(page); await sleep(1000);
  const lA = await labelMap(); const mA = (await chartRoot(page)).markers;
  const legShapeOnly = await hoverDate(page, cpi.date); // CPI has no text label here: the legend must still name it
  await page.shot(join(OUT, "10_labels_A_all_shapes.png"));
  await clickButton(page, "1Y"); await sleep(900);
  const lB = await labelMap();
  await page.shot(join(OUT, "11_labels_B_1y_status.png"));
  for (let i = 0; i < 2; i++) { await clickButton(page, "+"); await sleep(500); }
  const rz = await page.rect('[data-widget="chart"] canvas');
  for (let i = 0; i < 8; i++) { // pan to the latest bars until Jobs and CPI are both inside the plot
    const l = await labelMap(); if (l[JOBS]?.on && l[CPI]?.on) break;
    await page.drag(rz.x + rz.w * 0.7, rz.y + rz.h * 0.3, rz.x + rz.w * 0.3, rz.y + rz.h * 0.3, 10);
  }
  const lC = await labelMap(); const mC = (await chartRoot(page)).markers;
  await page.shot(join(OUT, "12_labels_C_zoomed_full.png"));
  for (let i = 0; i < 2; i++) { await clickButton(page, "−"); await sleep(500); }
  const lD = await labelMap();
  await clickButton(page, "ALL"); await sleep(900);
  const lE = await labelMap(); const mE = (await chartRoot(page)).markers;
  const gdpFull = (l) => gdpIds.every((id) => l[id]?.text === "GDP ?");
  const both = (l, text) => l[JOBS]?.on && l[CPI]?.on && l[JOBS].text === (text === "full" ? "Jobs ✓" : text) && l[CPI].text === (text === "full" ? "CPI ✓" : text);
  check("overlay", "E9", "Marker labels follow actual spacing: ALL shapes only, 1Y status sign, zoomed-in full labels (both on screen), back again on zoom-out and ALL; 5 markers throughout; the legend names an unlabelled marker",
    [mA, mC, mE].every((m) => m === "5") && Object.keys(lA).length === 5 && Object.values(lA).every((x) => x.on) && gdpFull(lA) && both(lA, "")
    && gdpFull(lB) && both(lB, "✓") && both(lC, "full") && both(lD, "✓") && both(lE, "") && gdpFull(lE)
    && (legShapeOnly ?? "").includes(`EVENT ${NAME[cpi.id]}`) && (legShapeOnly ?? "").includes("publication confirmed"),
    { lA, lB, lC, lD, lE, mA, mC, mE, legShapeOnly });
  await page.shot(join(OUT, "06_overlay_candles.png"));
  await page.clickEl(`document.querySelector('[data-testid="dataset-demo"]')`); await sleep(800);

  // ---------------------------------------------------------------- OS-P2B: local import (fictional fixtures)
  const FIX = join(REPO, "tests", "fixtures", "import");
  const SENTINEL = "271.8281"; // first close in valid_daily_250.csv; must never leave the page or reach storage
  const fx250 = readFileSync(join(FIX, "valid_daily_250.csv"), "utf8").trim().split("\n").slice(1).map((l) => l.split(","));
  await page.goto(O + "?ws=market", 3500); await chartReady(page);
  const persistedBefore = await page.evaluate(`localStorage.getItem("macro-research-workspace-v2")`);
  const viewBefore = (await page.store())?.state?.widgets?.find((w) => w.type === "chart")?.view;
  const reqStart = page.log.requests.length;
  await page.send("Page.setInterceptFileChooserDialog", { enabled: true });
  /** The real picker flow: click IMPORT LOCAL DATA, wait for the file chooser, choose the file. */
  async function pickFile(path) {
    const n = page.log.fileChooser.length;
    await page.clickEl(`document.querySelector('[data-widget="chart"] [data-testid="import-button"]')`);
    for (let i = 0; i < 40 && page.log.fileChooser.length === n; i++) await sleep(100);
    const ev = page.log.fileChooser[n];
    if (!ev) throw new Error("the file chooser did not open");
    await page.send("DOM.setFileInputFiles", { files: [path], backendNodeId: ev.backendNodeId });
    await sleep(1200);
  }
  const ensureIndicator = async (name, on) => {
    const isOn = await page.evaluate(`[...document.querySelectorAll('[data-widget="chart"] button')].find(b => b.innerText.trim() === ${JSON.stringify(name)})?.classList.contains("active")`);
    if (isOn !== on) { await clickButton(page, name); await sleep(600); }
  };

  await pickFile(join(FIX, "valid_daily_250.csv"));
  let ir = await chartRoot(page);
  const impLabel = await text(page, '[data-testid="imported-label"]');
  const impNotice = await text(page, '[data-testid="imported-notice"]');
  const impOk = await text(page, '[data-testid="import-ok"]');
  const impTitle = await page.evaluate(`document.querySelector('[data-widget="chart"] .panel-title span')?.textContent`);
  check("import", "I1", "IMPORT LOCAL DATA opens the file chooser; a valid CSV is charted with its own label and none of the simulated ones",
    page.log.fileChooser.length >= 1 && ir?.dataset === "imported" && ir.bars === "250" && ir.firstBar === "2024-01-02" && ir.lastBar === fx250.at(-1)[0]
    && impLabel === "USER-IMPORTED DATA — LOCAL FILE" && /supplied by you/.test(impNotice ?? "") && /has not verified its\s+source, accuracy, authenticity or your right/.test(impNotice ?? "")
    && /not uploaded, not saved, gone after a\s+reload/.test(impNotice ?? "") && /250 daily bars, 2024-01-02 to/.test(impOk ?? "")
    && (await text(page, '[data-testid="simulated-label"]')) === null && impTitle === "Price History (imported file)"
    && (await text(page, ".hist-badge")) === "LOCAL TERMINAL · NO LIVE MARKET FEED", { ir, impLabel, impNotice, impOk, impTitle, badge: await text(page, ".hist-badge") });
  const lastRow = fx250.at(-1);
  legend = await page.legend();
  check("import", "I2", "Legend shows the imported last bar exactly, without the simulated tag or an Adj C value",
    legend?.startsWith(`IMPORTED ${lastRow[0]}`) && legend.includes(`C ${fmt(Number(lastRow[4]))}`) && legend.includes(`H ${fmt(Number(lastRow[2]))}`)
    && !/simulated|Adj C/.test(legend), legend);
  check("import", "I3", "No event markers, overlay notice or event list on imported data",
    ir.markers === "0" && (await text(page, '[data-testid="overlay-notice"]')) === null && (await text(page, '[data-testid="event-list"]')) === null
    && /Event markers are not shown on imported data/.test(impNotice ?? ""), ir);

  // chart behaviour on imported data (state kept in memory)
  const ih0 = await page.chartHash();
  await ensureIndicator("RSI", true); await ensureIndicator("MACD", true); await ensureIndicator("SMA50", true);
  const ig = await page.chartGeom();
  await clickButton(page, "+"); await sleep(500); const ih1 = await page.chartHash();
  const ir2 = await page.rect('[data-widget="chart"] canvas');
  await page.drag(ir2.x + ir2.w * 0.6, ir2.y + ir2.h * 0.3, ir2.x + ir2.w * 0.3, ir2.y + ir2.h * 0.3, 12); const ih2 = await page.chartHash();
  const typeOk = {};
  for (const t of ["BARS", "LINE", "AREA", "CANDLES"]) { await clickButton(page, t); await sleep(600); typeOk[t] = [(await chartRoot(page)).bars, await page.chartHash()]; }
  const presetsImp = {};
  for (const r of ["1Y", "3Y", "5Y", "SPAN", "ALL"]) {
    await page.clickEl(`document.querySelector('[data-widget="chart"] button[data-range="${r}"]')`); await sleep(400);
    presetsImp[r] = (await chartRoot(page)).firstBar;
  }
  const spanLabel = await page.evaluate(`document.querySelector('[data-widget="chart"] button[data-range="SPAN"]')?.innerText`);
  check("import", "I4", "Indicators, zoom, pan, all chart types and data-relative ranges work on imported data",
    ig.rowHeights.filter((h) => h > 5).length === 4 && ih1 !== ih0 && ih2 !== ih1 && Object.values(typeOk).every(([b]) => b === "250")
    && new Set(Object.values(typeOk).map(([, h]) => h)).size === 4 && Object.values(presetsImp).every((d) => d === "2024-01-02") && spanLabel === "2024–24",
    { panes: ig.rowHeights, ih0, ih1, ih2, typeOk, presetsImp, spanLabel });
  check("import", "I5", "The saved workspace layout is untouched by everything done on imported data",
    (await page.evaluate(`localStorage.getItem("macro-research-workspace-v2")`)) === persistedBefore);

  await pickFile(join(FIX, "short_15.csv"));
  ir = await chartRoot(page);
  const insuff = await text(page, '[data-testid="indicator-insufficient"]');
  check("import", "I6", "A 15-bar file is charted; indicators without enough history are named and not drawn",
    ir.bars === "15" && /SMA50 \(needs 50\)/.test(insuff ?? "") && /MACD \(needs 26\)/.test(insuff ?? "") && !/RSI/.test(insuff ?? "") && /This range has 15/.test(insuff ?? ""),
    { ir, insuff });

  const failCases = [
    ["duplicate_dates.csv", /row 4 \(line 5\): duplicate date 2025-02-05/],
    ["high_below_low.csv", /row 5 \(line 6\): inconsistent prices/],
    ["unsupported.txt", /unsupported file type/],
    ["empty.csv", /the file is empty/],
    ["invalid.json", /not valid JSON/],
    ["bad_quoting.csv", /quoted field is never closed/],
  ];
  const big = join(TMP, "oversized.csv");
  writeFileSync(big, "date,open,high,low,close,volume\n" + "2025-01-02,1,1,1,1,1\n".repeat(300_000)); // > 5 MiB
  failCases.push([big, /limit is 5 MiB/]);
  const failSeen = {};
  for (const [file, pattern] of failCases) {
    await pickFile(file.startsWith("/") ? file : join(FIX, file));
    const err = await page.evaluate(`[...document.querySelectorAll('[data-testid="import-issue"]')].map(li => li.innerText).join(" | ")`);
    const head = await page.evaluate(`document.querySelector('[data-testid="import-error"] b')?.innerText ?? ""`);
    const rt = await chartRoot(page);
    failSeen[file.split("/").pop()] = { ok: pattern.test(err) && /was not loaded\. Nothing else was changed\./.test(head) && rt.dataset === "imported" && rt.bars === "15"
      && (await text(page, '[data-testid="imported-label"]')) === "USER-IMPORTED DATA — LOCAL FILE", err };
  }
  check("import", "I7", "Rejected files (duplicate date, bad OHLC, wrong type, empty, bad JSON, bad quoting, > 5 MiB) show the reason with row references and leave the previous import displayed",
    Object.values(failSeen).every((x) => x.ok), failSeen);

  await pickFile(join(FIX, "valid_daily_40.json"));
  ir = await chartRoot(page);
  check("import", "I8", "A valid JSON file replaces the previous import", ir.bars === "40" && ir.firstBar === "2025-03-03", ir);

  // privacy: nothing leaves the page, nothing is stored
  const stored = await page.evaluate(`(async () => ({ local: JSON.stringify({ ...localStorage }), session: JSON.stringify({ ...sessionStorage }), cookie: document.cookie,
    idb: (await indexedDB.databases()).map(d => d.name), caches: await caches.keys() }))()`);
  const importReqs = page.log.requestDetails.slice(reqStart);
  const anyBody = page.log.requestDetails.filter((r) => r.body || !["GET", "HEAD"].includes(r.method));
  const leaks = page.log.requests.filter((u) => u.includes(SENTINEL) || /valid_daily|short_15|fixtures/.test(u));
  check("import", "I9", "Importing sent no request at all, no request in the session carried a body, and no storage holds the file's data or name",
    importReqs.length === 0 && anyBody.length === 0 && leaks.length === 0 && ![stored.local, stored.session, stored.cookie].some((x) => x.includes(SENTINEL) || /valid_daily|short_15|\.json"|\.csv/.test(x))
    && stored.idb.length === 0 && stored.caches.length === 0,
    { importReqs, anyBody, leaks, idb: stored.idb, caches: stored.caches, cookie: stored.cookie });

  await page.viewport(1024, 800); await sleep(800);
  await pickFile(join(FIX, "missing_column.csv"));
  const ov1024 = await page.evaluate("document.documentElement.scrollWidth - window.innerWidth");
  await page.shot(join(OUT, "07_import_error_1024.png"));
  await page.viewport(1440, 790); await sleep(800);
  check("import", "I10", "Imported chart with an error notice has no horizontal overflow at 1024 px", ov1024 <= 0, ov1024);
  await page.clickEl(`document.querySelector('[data-testid="import-error"] button')`); await sleep(300);
  await page.shot(join(OUT, "08_import_json.png"));

  // back to the built-in datasets
  await page.clickEl(`document.querySelector('[data-testid="dataset-demo"]')`); await sleep(1200);
  const backDemo = { root: await chartRoot(page), view: (await page.store())?.state?.widgets?.find((w) => w.type === "chart")?.view, sim: await text(page, '[data-testid="simulated-label"]'),
    imp: await text(page, '[data-testid="imported-label"]'), persisted: await page.evaluate(`localStorage.getItem("macro-research-workspace-v2")`),
    title: await page.evaluate(`document.querySelector('[data-widget="chart"] .panel-title span')?.textContent`) };
  await page.clickEl(`document.querySelector('[data-testid="dataset-overlay"]')`); await sleep(1500);
  const backOverlay = await chartRoot(page);
  await page.clickEl(`document.querySelector('[data-testid="dataset-imported"]')`); await sleep(1000);
  const backImported = await chartRoot(page);
  check("import", "I11", "DEMO SET restores the saved view exactly; EVENT OVERLAY still has its 5 markers; IMPORTED FILE returns to the import without re-reading",
    backDemo.root.dataset === "demo" && JSON.stringify(backDemo.view) === JSON.stringify(viewBefore) && backDemo.persisted === persistedBefore
    && backDemo.sim === "SIMULATED DATA — NOT REAL MARKET PRICES" && backDemo.imp === null && backDemo.root.markers === "0" && /^Price History \(simulated\)/.test(backDemo.title ?? "")
    && backOverlay.dataset === "overlay" && backOverlay.markers === String(EXPECTED_EVENTS.length) && backImported.dataset === "imported" && backImported.bars === "40",
    { backDemo, backOverlay, backImported });
  await page.reload(4000); await chartReady(page); await sleep(800);
  const afterReloadImp = { root: await chartRoot(page), btn: await page.evaluate(`!!document.querySelector('[data-testid="dataset-imported"]')`), label: await text(page, '[data-testid="imported-label"]'),
    badge: await text(page, ".hist-badge"), sim: await text(page, '[data-testid="simulated-label"]'), notice: await text(page, '[data-testid="overlay-notice"]') };
  check("import", "I12", "After a reload the import is gone; the panel shows its saved overlay dataset with its own labels under the neutral header",
    afterReloadImp.root.dataset === "overlay" && !afterReloadImp.btn && afterReloadImp.label === null && afterReloadImp.badge === "LOCAL TERMINAL · NO LIVE MARKET FEED"
    && afterReloadImp.sim === "SIMULATED DATA — NOT REAL MARKET PRICES" && /REAL OFFICIAL EVENT METADATA/.test(afterReloadImp.notice ?? ""), afterReloadImp);
  // ---------------------------------------------------------------- OS-P2 UX-3: instrument picker vs imported data
  const picker = async () => page.evaluate(`(() => { const b = document.querySelector('[data-testid="instrument-picker"]'); return b ? { text: b.innerText.replace(/\\s+/g, " ").trim(), ctx: b.dataset.context } : null })()`);
  const choose = async (sym) => { // keyboard: Ctrl+K, type, Enter
    await page.key({ key: "k", code: "KeyK", vk: 75, modifiers: 2 }); await sleep(500);
    const note = await text(page, '[data-testid="palette-imported-note"]');
    await page.type(sym); await sleep(300); await page.key({ key: "Enter", code: "Enter", vk: 13, text: "\r" }); await sleep(1200);
    return note;
  };
  const savedLayout = async () => { const st = (await page.store())?.state; return JSON.stringify({ widgets: st?.widgets, layout: st?.layout }); };
  await page.clickEl(`document.querySelector('[data-testid="dataset-demo"]')`); await sleep(1000);
  await page.clickEl(`document.querySelector('[data-testid="instrument-picker"]')`); await sleep(500); // pointer opens the palette
  const pointerOpen = !!(await text(page, 'input[aria-label="Search instruments and macro series"]') !== null);
  await page.key({ key: "Escape", code: "Escape", vk: 27 }); await sleep(300);
  const noteDemo = await choose("DEMO-C");
  const u1 = { picker: await picker(), legend: await page.legend(), noteDemo, pointerOpen };
  await page.clickEl(`document.querySelector('[data-testid="dataset-overlay"]')`); await sleep(1500);
  await choose("DEMO-D");
  const u1o = { picker: await picker(), legend: await page.legend(), root: await chartRoot(page) };
  check("ux3", "U1", "Built-in context: the picker names the instrument; pointer and Ctrl+K both work; it switches DEMO SET and EVENT OVERLAY charts",
    u1.pointerOpen && u1.picker.ctx === "built-in" && u1.picker.text.startsWith("DEMO-C — search instruments…") && u1.legend?.startsWith("DEMO-C (simulated)") && u1.noteDemo === null
    && u1o.picker.text.startsWith("DEMO-D — search instruments…") && u1o.legend?.startsWith("DEMO-D (simulated)") && u1o.root.dataset === "overlay" && u1o.root.markers === String(EXPECTED_EVENTS.length),
    { u1, u1o });
  const layoutBeforeImport = await savedLayout();
  await pickFile(join(FIX, "valid_daily_250.csv"));
  const u2 = { picker: await picker(), root: await chartRoot(page) };
  const noteImp = await choose("DEMO-C");
  const u2b = { picker: await picker(), root: await chartRoot(page), legend: await page.legend(), active: (await page.store())?.state?.activeSymbol };
  check("ux3", "U2", "Imported context: the picker says IMPORTED FILE (built-in kept), the palette explains, and a pick changes only the built-in instrument",
    u2.picker.ctx === "imported" && u2.picker.text.startsWith("IMPORTED FILE · built-in: DEMO-D — search…") && !/^DEMO-/.test(u2.picker.text)
    && /imported chart does not change/.test(noteImp ?? "") && u2b.root.dataset === "imported" && u2b.root.bars === "250" && u2b.legend?.startsWith("IMPORTED ")
    && u2b.picker.text.startsWith("IMPORTED FILE · built-in: DEMO-C") && u2b.active === "DEMO-C", { u2, noteImp, u2b });
  await page.clickEl(`document.querySelector('[data-testid="dataset-demo"]')`); await sleep(1200);
  const u3 = { picker: await picker(), legend: await page.legend(), root: await chartRoot(page), layout: await savedLayout() };
  check("ux3", "U3", "Back on DEMO SET: the chosen built-in instrument is shown and named; panels and layout unchanged apart from the chosen dataset",
    u3.picker.ctx === "built-in" && u3.picker.text.startsWith("DEMO-C — search instruments…") && u3.legend?.startsWith("DEMO-C (simulated)") && u3.root.dataset === "demo"
    && JSON.stringify(JSON.parse(u3.layout).layout) === JSON.stringify(JSON.parse(layoutBeforeImport).layout)
    && JSON.parse(u3.layout).widgets.length === JSON.parse(layoutBeforeImport).widgets.length, { u3: { ...u3, layout: undefined } });
  await page.reload(4000); await chartReady(page); await sleep(800);
  const u4 = { picker: await picker(), legend: await page.legend(), imported: await page.evaluate(`!!document.querySelector('[data-testid="dataset-imported"]')`) };
  check("ux3", "U4", "After a reload: built-in context, the chosen instrument kept, no imported file",
    u4.picker.ctx === "built-in" && u4.picker.text.startsWith("DEMO-C — search instruments…") && u4.legend?.startsWith("DEMO-C (simulated)") && !u4.imported, u4);
  await page.send("Page.setInterceptFileChooserDialog", { enabled: false });
  await page.clickEl(`document.querySelector('[data-testid="dataset-demo"]')`); await sleep(800);

  // ---------------------------------------------------------------- Research
  await page.goto(O + "?ws=research", 3500);
  await waitFor(page, `document.querySelector('[data-testid="research"]')`);
  const rows = await page.evaluate(`Object.fromEntries([...document.querySelectorAll('[data-testid^="result-"]')].map(tr => [tr.dataset.testid.slice(7), [...tr.cells].map(c => c.innerText)]))`);
  const expected = Object.fromEntries(Object.entries(research.results).map(([k, v]) => [k, [v.label, signed(v.estimate), `${signed(v.interval[0])} to ${signed(v.interval[1])}`]]));
  const rowsOk = Object.keys(expected).every((k) => JSON.stringify(rows[k]?.slice(1)) === JSON.stringify(expected[k]));
  check("research", "R1", "Research page shows exactly the illustrative file's figures", rowsOk, { rows, expected });
  const body = await page.evaluate("document.body.innerText");
  check("research", "R2", "Research page is labelled illustrative and shows no study identifiers or conclusions",
    body.includes("ILLUSTRATIVE FIGURES — RANDOMLY GENERATED, NOT RESEARCH RESULTS") && body.includes("Demo figures.") && !/C5C|C5c|NO_EDGE|Target_Up_Open/.test(body));
  await page.shot(join(OUT, "02_research.png"));

  // ---------------------------------------------------------------- Macro release desk
  await page.goto(O + "?ws=macro", 3500);
  await waitFor(page, `document.querySelector('[data-testid="release-schedule"]')`);
  const desk = await page.evaluate(`({ mode: document.querySelector('[data-testid="desk-mode"]')?.dataset.mode, title: document.querySelector('[data-testid="snapshot-title"]')?.innerText,
    rows: document.querySelectorAll('[data-testid^="family-"] tbody tr').length, badge: document.querySelector('.hist-badge')?.innerText,
    doc: document.body.innerText.includes("USDL-26-1574"), simulated: !!document.querySelector('[data-testid="simulated-label"]') })`);
  check("macro", "D1", "Release desk shows 38 real official-metadata events, labelled real and never simulated",
    desk.mode === "SOURCE_DERIVED" && desk.title?.startsWith("REAL OFFICIAL METADATA") && desk.rows === 38 && desk.badge?.startsWith("REAL OFFICIAL METADATA") && desk.doc && !desk.simulated, desk);
  await page.shot(join(OUT, "03_macro.png"));

  // ---------------------------------------------------------------- Settings
  await page.goto(O + "?ws=settings", 3000);
  await waitFor(page, `document.querySelector('[data-testid="settings-view"]')`);
  const status = await page.evaluate(`Object.fromEntries(["desk", "prices", "macro", "research"].map(id => [id, document.querySelector('[data-testid="data-row-' + id + '"] td:nth-child(3)')?.innerText]))`);
  const buildId = await text(page, '[data-testid="settings-build-id"]');
  check("settings", "S1", "Settings lists each dataset with its real / simulated / illustrative status and the build id",
    status.desk === "INCLUDED" && status.prices === "INCLUDED · SIMULATED" && status.macro === "NOT INCLUDED" && status.research === "INCLUDED · ILLUSTRATIVE" && /^[0-9a-f]{64}$/.test(buildId ?? ""), { status, buildId });

  const overlayRow = await page.evaluate(`[...document.querySelectorAll('[data-testid="data-row-overlay"] td')].map(td => td.innerText)`);
  check("settings", "S2", "Settings lists the event-overlay data as simulated, ending at the snapshot",
    overlayRow[2] === "INCLUDED · SIMULATED" && /2025-01-02 to 2026-10-16/.test(overlayRow[0] ?? "") && /simulate no reaction/.test(overlayRow[3] ?? ""), overlayRow);

  // ---------------------------------------------------------------- data boundary and network
  const probe = await page.evaluate(`Promise.all(["data/macro_series.json", "data/ALLOWLIST.json", "data/", "data/etf_prices.json", "intel/"].map(p => fetch(p, { cache: "no-store" }).then(r => [p, r.status, r.headers.get("cache-control")])))`);
  check("security", "X1", "From the page: unlisted data paths 404, listed data 200, no listing; all no-store",
    JSON.stringify(probe.map((p) => p[1])) === JSON.stringify([404, 404, 404, 200, 404]) && probe.every((p) => p[2] === "no-store"), probe);
  const ext = external(page.log.requests, O);
  const dataReq = [...new Set(page.log.requests.filter((u) => u.includes("/data/")).map((u) => new URL(u).pathname))].sort();
  // OS-P2A: the event-overlay file is the fourth demo data file.
  check("security", "X2", "No external requests; the app requested only the four demo data files (plus the X1 probes)",
    ext.length === 0 && JSON.stringify(dataReq) === JSON.stringify(["/data/", "/data/ALLOWLIST.json", "/data/etf_prices.json", "/data/event_overlay_prices.json", "/data/macro_series.json", "/data/manifest.json", "/data/research.json"]), { ext, dataReq });
  const appDataBeforeProbe = page.log.requests.slice(0, page.log.requests.findIndex((u) => u.endsWith("/data/macro_series.json"))).filter((u) => u.includes("/data/")).map((u) => new URL(u).pathname);
  check("security", "X3", "Before the probes, the app never requested macro_series.json or the allowlist",
    appDataBeforeProbe.length > 0 && appDataBeforeProbe.every((p) => ["/data/etf_prices.json", "/data/event_overlay_prices.json", "/data/research.json", "/data/manifest.json"].includes(p)), [...new Set(appDataBeforeProbe)]);
  check("security", "X4", "No exceptions and no console errors", page.log.exceptions.length === 0 && page.log.console.filter((c) => c.type === "error").length === 0,
    { exceptions: page.log.exceptions, console: page.log.console });

  // ---------------------------------------------------------------- layout
  const overflow = {};
  for (const w of [1440, 1280, 1024]) {
    await page.viewport(w, 800);
    for (const ws of ["", "?ws=market", "?ws=macro", "?ws=research", "?ws=settings"]) {
      await page.goto(O + ws, 2200);
      overflow[`${w}${ws || "?ws=home"}`] = await page.evaluate("document.documentElement.scrollWidth - window.innerWidth");
    }
  }
  check("layout", "W1", "No horizontal page overflow at 1440, 1280 and 1024 px", Object.values(overflow).every((v) => v <= 0), overflow);
  await page.viewport(1440, 790);

  // ---------------------------------------------------------------- failure scenarios
  const noResearch = await serve(dataDir("no-research", ["etf_prices.json", "manifest.json"]));
  servers.push(noResearch);
  await page.goto(noResearch.origin + "?ws=research", 3500);
  await waitFor(page, `document.querySelector('[data-testid="research-error"]')`);
  const rErr = await text(page, '[data-testid="research-error"]');
  await page.goto(noResearch.origin + "?ws=market", 3500);
  const stillCharts = await chartReady(page);
  check("failure", "F1", "Missing research file: an explicit 'unavailable' message; charts still work", /unavailable/i.test(rErr ?? "") && /HTTP 404/.test(rErr ?? "") && stillCharts, rErr);

  const noMarket = await serve(dataDir("no-market", ["research.json", "manifest.json"]));
  servers.push(noMarket);
  await page.goto(noMarket.origin + "?ws=market", 4000);
  await waitFor(page, `[...document.querySelectorAll('[data-widget="chart"] .down')].some(e => e.innerText.includes("etf_prices.json"))`);
  const mErr = await page.evaluate(`[...document.querySelectorAll('[data-widget="chart"] .down')].map(e => e.innerText).join(" | ")`);
  const noLabel = await page.evaluate(`!document.querySelector('[data-testid="simulated-label"]') && !document.querySelector('[data-widget="chart"] canvas')`);
  check("failure", "F2", "Missing market data: an explicit error, no chart and no data shown as if it existed",
    mErr.includes("Missing local data file etf_prices.json (HTTP 404)") && noLabel, mErr);

  const emptyD = await serve(dataDir("empty-instrument", ["etf_prices.json", "research.json", "manifest.json"],
    { "etf_prices.json": (d) => ({ ...d, candles: { ...d.candles, "DEMO-D": [] } }) }));
  servers.push(emptyD);
  await page.goto(emptyD.origin + "?ws=market", 4000);
  await chartReady(page);
  await page.key({ key: "k", code: "KeyK", vk: 75, modifiers: 2 }); await sleep(500);
  await page.type("DEMO-D"); await sleep(300);
  await page.key({ key: "Enter", code: "Enter", vk: 13, text: "\r" }); await sleep(1200);
  const empty = await text(page, '[data-testid="chart-empty"]');
  check("failure", "F3", "Instrument without bars: an explicit empty state instead of a blank chart", empty?.startsWith("No bars for DEMO-D"), empty);
  // OS-P2A negative cases
  const openOverlay = async (origin) => {
    await page.goto(origin + "?ws=market", 3500); await chartReady(page);
    await page.clickEl(`document.querySelector('[data-testid="dataset-overlay"]')`); await sleep(1500);
  };
  const allFiles = ["etf_prices.json", "event_overlay_prices.json", "research.json", "manifest.json"];
  const mismatch = await serve(dataDir("snapshot-mismatch", allFiles, { "event_overlay_prices.json": (d) => ({ ...d, event_snapshot: "2026-10-10", bound: "2026-10-09",
    candles: Object.fromEntries(Object.entries(d.candles).map(([k, v]) => [k, v.filter((c) => c.date <= "2026-10-09")])) }) }));
  servers.push(mismatch);
  await openOverlay(mismatch.origin);
  const mm = { err: await text(page, '[data-testid="event-error"]'), root: await chartRoot(page), list: await text(page, '[data-testid="event-list"]') };
  check("failure", "F5", "Event snapshot and chart data disagree: an explicit error and no markers",
    /does not match the chart data's snapshot 2026-10-10/.test(mm.err ?? "") && mm.root.markers === "0" && mm.list === null, mm);

  const gap = await serve(dataDir("missing-event-bar", allFiles, { "event_overlay_prices.json": (d) => ({ ...d,
    candles: Object.fromEntries(Object.entries(d.candles).map(([k, v]) => [k, v.filter((c) => c.date !== "2026-10-14")])) }) }));
  servers.push(gap);
  await openOverlay(gap.origin);
  await page.clickEl(`document.querySelector('[data-testid="event-list"] summary')`); await sleep(300);
  const g = { root: await chartRoot(page), rows: await page.evaluate(`[...document.querySelectorAll('[data-testid="event-row"]')].map(r => r.dataset.eventId + "@" + r.dataset.date)`),
    omitted: await page.evaluate(`[...document.querySelectorAll('[data-testid="event-omitted"]')].map(r => r.innerText)`) };
  check("failure", "F6", "An event with no bar on its date is listed as not drawn with the reason, never moved to another day",
    g.root.markers === String(EXPECTED_EVENTS.length - 1) && !g.rows.some((r) => r.startsWith("BLS.CPI.2026-09"))
    && g.omitted.length === 1 && /BLS\.CPI\.2026-09 \(2026-10-14\) — no bar on 2026-10-14 in this dataset \(not moved to another day\)/.test(g.omitted[0]), g);

  const noDeskRoot = join(TMP, "docroot-without-desk");
  cpSync(join(REPO, "web", "out"), noDeskRoot, { recursive: true });
  rmSync(join(noDeskRoot, "intel", "release_desk.v1.json"));
  const noDesk = await serve(join(REPO, "demo-data"), noDeskRoot);
  servers.push(noDesk);
  await openOverlay(noDesk.origin);
  const nd = { err: await text(page, '[data-testid="event-error"]'), root: await chartRoot(page), chart: !!(await text(page, '[data-testid="simulated-label"]')) };
  check("failure", "F7", "Release-desk export missing: the simulated chart still works, with an explicit 'no markers' message",
    /release-desk export is not available/.test(nd.err ?? "") && nd.root.markers === "0" && nd.chart, nd);

  // E4 (visual): identical overlay view rendered with and without the release-desk export; the markers' exact colours
  // must add pixels on the chart canvases only when markers exist.
  const sameView = JSON.stringify({ state: { activeSymbol: "DEMO-A", widgets: [{ id: "w-chart", type: "chart", linked: true,
    view: { dataset: "overlay", range: "ALL", chartType: "line", indicators: [] } }], layout: [{ i: "w-chart", x: 0, y: 0, w: 8, h: 14 }] }, version: 2 });
  await page.seedStorage(O + "?ws=market", { "macro-research-workspace-v2": sameView }); await chartReady(page); await sleep(1500);
  const withMarkers = { px: await colourPixels(page), root: await chartRoot(page) };
  await page.shot(join(OUT, "04_overlay_line_markers.png"));
  await page.seedStorage(noDesk.origin + "?ws=market", { "macro-research-workspace-v2": sameView }); await chartReady(page); await sleep(1500);
  const withoutMarkers = { px: await colourPixels(page), root: await chartRoot(page) };
  check("overlay", "E4", "Markers are drawn: both marker colours add pixels only when markers exist (same data, view and chart type)",
    withMarkers.root.markers === String(EXPECTED_EVENTS.length) && withoutMarkers.root.markers === "0" && withMarkers.root.bars === withoutMarkers.root.bars
    && withMarkers.px.confirmed > withoutMarkers.px.confirmed && withMarkers.px.unconfirmed > withoutMarkers.px.unconfirmed, { withMarkers, withoutMarkers });

  const noOverlay = await serve(dataDir("no-overlay-file", ["etf_prices.json", "research.json", "manifest.json"]));
  servers.push(noOverlay);
  await openOverlay(noOverlay.origin);
  const no = { err: await page.evaluate(`[...document.querySelectorAll('[data-widget="chart"] .down')].map(e => e.innerText).join(" | ")`), root: await chartRoot(page) };
  await page.clickEl(`document.querySelector('[data-testid="dataset-demo"]')`); await sleep(1200);
  const demoStill = await chartRoot(page);
  check("failure", "F8", "Overlay data missing: an explicit error and no markers; the demo set still works",
    no.err.includes("Missing local data file event_overlay_prices.json (HTTP 404)") && no.root.markers === "0" && no.root.bars === "0"
    && demoStill.dataset === "demo" && Number(demoStill.bars) > 0, { no, demoStill });
  check("failure", "F4", "Failure scenarios raised no exceptions", page.log.exceptions.length === 0, page.log.exceptions);
} catch (e) {
  check("harness", "E0", "Harness completed without an internal error", false, String(e?.stack ?? e));
} finally {
  for (const s of servers) s.stop();
  if (chrome) await chrome.close();
  rmSync(TMP, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
save(join(OUT, "smoke.json"), { results, requests: (chrome?.log.requests ?? []).map((u) => u.replace(/127\.0\.0\.1:\d+/, "127.0.0.1:<port>")) });
console.log(`\n${results.length - failed.length}/${results.length} checks passed; results in ${OUT}`);
process.exit(failed.length ? 1 : 0);
