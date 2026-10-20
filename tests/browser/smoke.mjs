// Browser checks of the built demo (headless Chrome over CDP; no npm packages).
//
//   cd web && npm ci && npm run build && cd ..
//   node tests/browser/smoke.mjs [--out <dir>]          # CHROME_PATH=/path/to/chrome if not in a standard place
//
// Starts its own loopback servers (python3 -m terminal_demo.serve) on free ports: one with demo-data/, and three with
// temporary, deliberately incomplete data directories (missing research, missing market data, an empty instrument).
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
const TMP = mkdtempSync(join(tmpdir(), "mit-smoke-data-"));

if (!findChrome()) {
  console.error("SKIPPED: no Chrome/Chromium found; set CHROME_PATH. No browser check was run.");
  process.exit(2);
}

const freePort = () => new Promise((res) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });
const json = (p) => JSON.parse(readFileSync(p, "utf8"));
const etf = json(join(REPO, "demo-data", "etf_prices.json"));
const research = json(join(REPO, "demo-data", "research.json"));
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

async function serve(dataDirPath) {
  const port = await freePort();
  const proc = spawn(process.env.PYTHON ?? "python3", ["-B", "-m", "terminal_demo.serve", "--port", String(port), "--data-dir", dataDirPath],
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
const clickButton = (page, label, scope = '[data-widget="chart"]') =>
  page.clickEl(`[...document.querySelectorAll('${scope} button')].find(b => b.innerText.trim() === ${JSON.stringify(label)})`);

const chrome = await launch({ profileDir: join(TMP, "profile"), port: await freePort() });
const servers = [];
try {
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
    /release metadata \(BLS, BEA\) is real/.test(intro ?? "") && /simulated/.test(intro ?? "") && /^DEMO · SIMULATED MARKET DATA TO 2023-12-29 · NOT LIVE$/.test(badge ?? ""), { intro, badge });

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

  // ---------------------------------------------------------------- data boundary and network
  const probe = await page.evaluate(`Promise.all(["data/macro_series.json", "data/ALLOWLIST.json", "data/", "data/etf_prices.json", "intel/"].map(p => fetch(p, { cache: "no-store" }).then(r => [p, r.status, r.headers.get("cache-control")])))`);
  check("security", "X1", "From the page: unlisted data paths 404, listed data 200, no listing; all no-store",
    JSON.stringify(probe.map((p) => p[1])) === JSON.stringify([404, 404, 404, 200, 404]) && probe.every((p) => p[2] === "no-store"), probe);
  const ext = external(page.log.requests, O);
  const dataReq = [...new Set(page.log.requests.filter((u) => u.includes("/data/")).map((u) => new URL(u).pathname))].sort();
  check("security", "X2", "No external requests; the app requested only the three demo data files (plus the X1 probes)",
    ext.length === 0 && JSON.stringify(dataReq) === JSON.stringify(["/data/", "/data/ALLOWLIST.json", "/data/etf_prices.json", "/data/macro_series.json", "/data/manifest.json", "/data/research.json"]), { ext, dataReq });
  const appDataBeforeProbe = page.log.requests.slice(0, page.log.requests.findIndex((u) => u.endsWith("/data/macro_series.json"))).filter((u) => u.includes("/data/")).map((u) => new URL(u).pathname);
  check("security", "X3", "Before the probes, the app never requested macro_series.json or the allowlist",
    appDataBeforeProbe.length > 0 && appDataBeforeProbe.every((p) => ["/data/etf_prices.json", "/data/research.json", "/data/manifest.json"].includes(p)), [...new Set(appDataBeforeProbe)]);
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
  check("failure", "F4", "Failure scenarios raised no exceptions", page.log.exceptions.length === 0, page.log.exceptions);
} catch (e) {
  check("harness", "E0", "Harness completed without an internal error", false, String(e?.stack ?? e));
} finally {
  for (const s of servers) s.stop();
  await chrome.close();
  rmSync(TMP, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
save(join(OUT, "smoke.json"), { results, requests: chrome.log.requests.map((u) => u.replace(/127\.0\.0\.1:\d+/, "127.0.0.1:<port>")) });
console.log(`\n${results.length - failed.length}/${results.length} checks passed; results in ${OUT}`);
process.exit(failed.length ? 1 : 0);
