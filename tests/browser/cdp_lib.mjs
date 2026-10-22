// Chrome DevTools Protocol helpers (no extra packages; Node's built-in fetch and WebSocket). Headless Chrome, every
// external host unresolvable, every request / console message / exception recorded. Loopback only.
// The browser is CHROME_PATH if set, otherwise the first existing standard Chrome/Chromium location.
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

export { sleep };
const CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/snap/bin/chromium",
];

/** The browser executable, or null when none is configured or found. */
export function findChrome() {
  if (process.env.CHROME_PATH) return existsSync(process.env.CHROME_PATH) ? process.env.CHROME_PATH : null;
  return CANDIDATES.find((p) => existsSync(p)) ?? null;
}

// Collects Event Timing entries (discrete input -> next paint) and long tasks from the first script on.
const PERF_PROBE = `
  window.__perf = { events: [], longtasks: [] };
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__perf.events.push({ name: e.name, dur: e.duration, t: e.startTime }); })
    .observe({ type: "event", durationThreshold: 16, buffered: true }); } catch {}
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__perf.longtasks.push({ dur: e.duration, t: e.startTime }); })
    .observe({ type: "longtask", buffered: true }); } catch {}
`;

export async function launch({ profileDir, port = 9334, width = 1440, height = 790, dpr = 1 }) {
  const exe = findChrome();
  if (!exe) throw new Error("No Chrome/Chromium found. Set CHROME_PATH to a Chrome or Chromium executable.");
  const chrome = spawn(exe, [
    "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--disable-background-networking",
    "--disable-component-update", "--disable-sync", "--disable-features=OptimizationHints,MediaRouter",
    `--user-data-dir=${profileDir}`, `--remote-debugging-port=${port}`, `--window-size=${width},${height}`,
    "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1", "about:blank",
  ], { stdio: "ignore" });
  // browserLog: Log domain (only if Log.enable is sent). requestDetails: method and whether a body was sent (OS-P2B privacy checks).
  // fileChooser: Page.fileChooserOpened events (only with Page.setInterceptFileChooserDialog).
  const log = { requests: [], requestDetails: [], failed: [], console: [], exceptions: [], browserLog: [], fileChooser: [] };
  let target;
  for (let i = 0; i < 150 && !target; i++) { // up to 30 s: a first start with a new profile can be slow
    await sleep(200);
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === "page"); } catch { /* not up yet */ }
  }
  if (!target) { chrome.kill("SIGTERM"); throw new Error("the browser did not open a debugging target"); }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0; const pending = new Map();
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
    if (msg.method === "Network.requestWillBeSent") {
      log.requests.push(msg.params.request.url);
      log.requestDetails.push({ url: msg.params.request.url, method: msg.params.request.method, body: !!(msg.params.request.hasPostData || msg.params.request.postData) });
    }
    if (msg.method === "Page.fileChooserOpened") log.fileChooser.push(msg.params);
    if (msg.method === "Log.entryAdded") log.browserLog.push({ level: msg.params.entry.level, text: String(msg.params.entry.text).slice(0, 300), url: msg.params.entry.url });
    if (msg.method === "Network.loadingFailed") log.failed.push({ error: msg.params.errorText, canceled: msg.params.canceled });
    if (msg.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(msg.params.type))
      log.console.push({ type: msg.params.type, text: msg.params.args.map((a) => a.value ?? a.description).join(" ").slice(0, 400) });
    if (msg.method === "Runtime.exceptionThrown") log.exceptions.push((msg.params.exceptionDetails.text + " " + (msg.params.exceptionDetails.exception?.description ?? "")).slice(0, 600));
  };
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  await send("Network.enable"); await send("Page.enable"); await send("Runtime.enable");
  await send("Page.addScriptToEvaluateOnNewDocument", { source: PERF_PROBE });
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: dpr, mobile: false });

  const evaluate = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error("evaluate failed: " + expr.slice(0, 120) + " :: " + (r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text));
    return r.result?.result?.value;
  };
  const page = {
    send, evaluate, log,
    async goto(url, wait = 3500) { await send("Page.navigate", { url }); await sleep(wait); },
    async reload(wait = 3500) { await send("Page.reload", { ignoreCache: false }); await sleep(wait); },
    async viewport(w, h, d = dpr) { await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: d, mobile: false }); await sleep(900); },
    /** Records rAF frame gaps and long tasks while fn runs. */
    async frames(fn) {
      await evaluate(`(window.__perf.longtasks = [], window.__frames = [], window.__fr = true, (function f(t){ window.__frames.push(t); if (window.__fr) requestAnimationFrame(f); })(performance.now()), true)`);
      await fn();
      await sleep(300);
      const r = await evaluate(`(() => { window.__fr = false; const f = window.__frames; const g = f.slice(1).map((t, i) => t - f[i]).sort((a, b) => a - b);
        return { frames: f.length, worstGapMs: Math.round(g.at(-1) ?? 0), p95GapMs: Math.round(g[Math.floor(g.length * 0.95)] ?? 0), gapsOver50: g.filter(x => x > 50).length,
          longtasks: window.__perf.longtasks.length, longtaskMaxMs: Math.round(Math.max(0, ...window.__perf.longtasks.map(l => l.dur))), longtaskTotalMs: Math.round(window.__perf.longtasks.reduce((s, l) => s + l.dur, 0)) }; })()`);
      return r;
    },
    async shot(path) { writeFileSync(path, Buffer.from((await send("Page.captureScreenshot", { format: "png" })).result.data, "base64")); },
    rect: (sel) => evaluate(`(() => { const r = document.querySelector(${JSON.stringify(sel)})?.getBoundingClientRect(); return r ? {x:r.x,y:r.y,w:r.width,h:r.height} : null })()`),
    async move(x, y) { await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }); },
    async click(x, y) {
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
    },
    /** Real pointer drag in small steps (what react-draggable / react-resizable listen to). */
    async drag(x0, y0, x1, y1, steps = 12) {
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: x0, y: y0 });
      await send("Input.dispatchMouseEvent", { type: "mousePressed", x: x0, y: y0, button: "left", clickCount: 1 });
      for (let i = 1; i <= steps; i++) {
        await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: x0 + ((x1 - x0) * i) / steps, y: y0 + ((y1 - y0) * i) / steps, button: "left", buttons: 1 });
        await sleep(16);
      }
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: x1, y: y1, button: "left", clickCount: 1 });
      await sleep(400);
    },
    /** Key as Chrome on macOS delivers it: Option+digit gives a symbol in `key`, the digit only in `code`. */
    async key({ key, code, vk, modifiers = 0, text }) {
      await send("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", modifiers, key, code, windowsVirtualKeyCode: vk, text });
      await send("Input.dispatchKeyEvent", { type: "keyUp", modifiers, key, code, windowsVirtualKeyCode: vk });
    },
    async type(text) { await send("Input.insertText", { text }); },
    /** Click an element found by a JS expression returning it, at its centre; returns ms until two frames painted. */
    async clickEl(expr) {
      const r = await evaluate(`(() => { const e = (${expr}); if (!e) return null; e.scrollIntoView({block:'nearest'}); const r = e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
      if (!r) return null;
      const t0 = await evaluate("performance.now()");
      await page.click(r.x, r.y);
      const t1 = await evaluate("new Promise(res => requestAnimationFrame(() => requestAnimationFrame(() => res(performance.now()))))");
      return t1 - t0;
    },
    perf: () => evaluate("JSON.parse(JSON.stringify(window.__perf || {}))"),
    resetPerf: () => evaluate("window.__perf && (window.__perf.events = [], window.__perf.longtasks = [], true)"),
    // The migration-repair build persists under -v2 (and never writes -v1); older builds only have -v1.
    store: () => evaluate(`(() => { try { return JSON.parse(localStorage.getItem('macro-research-workspace-v2') ?? localStorage.getItem('macro-research-workspace-v1')) } catch { return null } })()`),
    storageKeys: () => evaluate("Object.keys(localStorage)"),
    panels: () => evaluate(`[...document.querySelectorAll('.react-grid-item[data-widget]')].map(e => { const r = e.getBoundingClientRect(); return { type: e.dataset.widget, title: e.querySelector('.panel-title')?.innerText.replace(/\\s+/g,' ').trim(), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } })`),
    legend: () => evaluate(`document.querySelector('[data-testid="chart-legend"]')?.innerText`),
    // ---- regression-campaign additions (backward compatible) ----
    /** Every localStorage key with its raw serialized value. */
    rawStorage: () => evaluate(`Object.fromEntries(Object.keys(localStorage).sort().map(k => [k, localStorage.getItem(k)]))`),
    /** Seeds localStorage from a same-origin page that does not run the app, then opens the app. */
    async seedStorage(appUrl, entries, wait = 4000) {
      await page.goto(new URL("data/manifest.json", appUrl).href, 800); // same origin, no app scripts
      await evaluate(`(() => { localStorage.clear(); const e = ${JSON.stringify(entries)}; for (const [k, v] of Object.entries(e)) localStorage.setItem(k, v); return Object.keys(localStorage); })()`);
      await page.goto(appUrl, wait);
    },
    /** SHA-256 of the pixels of every canvas in the n-th chart panel (detects leftover / missing series). */
    chartHash: (n = 0) => evaluate(`(async () => { const w = document.querySelectorAll('[data-widget="chart"]')[${n}]; if (!w) return null;
      const s = [...w.querySelectorAll('canvas')].map(c => c.width + 'x' + c.height + ':' + c.toDataURL()).join('|');
      const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)); return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16); })()`),
    /** Pane structure of the n-th chart: LWC renders one table row per pane plus the time-axis row. */
    chartGeom: (n = 0) => evaluate(`(() => { const w = document.querySelectorAll('[data-widget="chart"]')[${n}]; if (!w) return null; const t = w.querySelector('table');
      const rows = t ? [...t.querySelectorAll(':scope > tbody > tr, :scope > tr')] : [];
      return { canvases: w.querySelectorAll('canvas').length, rows: rows.length, rowHeights: rows.map(r => Math.round(r.getBoundingClientRect().height)),
               canvasW: Math.round(w.querySelector('canvas')?.getBoundingClientRect().width ?? 0) }; })()`),
    async wheel(x, y, deltaY) { await send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 0, deltaY }); await sleep(400); },
    /** Click with Event Timing (input -> next paint), long tasks and frame gaps; CDP round trips excluded from eventMs. */
    async timedClick(expr, settle = 400) {
      await evaluate(`(window.__perf.events = [], true)`);
      let wall = null;
      const f = await page.frames(async () => { wall = await page.clickEl(expr); await sleep(settle); });
      const ev = await evaluate(`window.__perf.events.filter(e => ['pointerdown','pointerup','mousedown','mouseup','click'].includes(e.name)).map(e => e.dur)`);
      return { eventMs: ev.length ? Math.round(Math.max(...ev)) : "<16", wallToPaintMs: wall && Math.round(wall), ...f };
    },
    async close() { try { ws.close(); } catch {} chrome.kill("SIGTERM"); await sleep(500); },
  };
  return page;
}

export function external(requests, origin) {
  return requests.filter((u) => !u.startsWith(origin) && !u.startsWith("data:") && !u.startsWith("blob:") && u !== "about:blank");
}

export function save(path, obj) { writeFileSync(path, JSON.stringify(obj, null, 2)); }
