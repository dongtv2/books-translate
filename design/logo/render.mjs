import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const dir = fileURLToPath(new URL('.', import.meta.url));
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', '--remote-debugging-port=9334', `--user-data-dir=${dir}profile`, '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let targets; for (let i = 0; i < 40; i++) { try { targets = await (await fetch('http://127.0.0.1:9334/json/list')).json(); if (targets.length) break; } catch {} await sleep(250); }
const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl); await new Promise((r) => ws.addEventListener('open', r));
let id = 0; const pend = new Map(); ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
await send('Page.enable');
await send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
async function render(html, w, h, out) {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: 'data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html><html><body style="margin:0;background:transparent">${html}</body></html>`) });
  await sleep(500);
  const r = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: w, height: h, scale: 1 } });
  fs.writeFileSync(`${dir}${out}`, Buffer.from(r.result.data, 'base64')); console.log('rendered', out, `${w}×${h}`);
}
const raster = JSON.parse(fs.readFileSync(`${dir}raster.json`, 'utf8'));
for (const [name, svgText] of Object.entries(raster)) { const m = svgText.match(/viewBox="0 0 (\d+) (\d+)"/); await render(svgText, +m[1], +m[2], name); }
await render(fs.readFileSync(`${dir}og-image.svg`, 'utf8'), 1200, 630, 'og-image.png');
// Review sheet: icons at real sizes, lockups on light and dark
const img = (f, w) => `<img src="data:image/svg+xml;base64,${Buffer.from(fs.readFileSync(dir + f)).toString('base64')}" width="${w}">`;
const png = (f, w, style = '') => `<img src="data:image/png;base64,${fs.readFileSync(dir + f).toString('base64')}" width="${w}" style="${style}">`;
const sheet = `<div style="font-family:sans-serif;padding:24px;background:#f7f3ea;display:flex;flex-direction:column;gap:20px">
<div style="display:flex;align-items:end;gap:20px">${img('favicon.svg', 16)}${img('favicon.svg', 32)}${png('icon-192.png', 64)}${png('apple-touch-icon.png', 120, 'border-radius:26px')}${png('icon-maskable-512.png', 120, 'border-radius:50%')}${img('logo-mark.svg', 32)}${img('logo-mark.svg', 120)}</div>
<div style="display:flex;gap:20px;align-items:center"><div style="background:#fff;padding:16px;border-radius:12px">${img('logo.svg', 380)}</div><div style="background:#1a1f29;padding:16px;border-radius:12px">${img('logo-dark.svg', 380)}</div></div>
<div style="display:flex;gap:20px;align-items:center"><div style="background:#fff;padding:16px;border-radius:12px">${img('logo-stacked.svg', 220)}</div>
<div style="display:flex;gap:8px;align-items:center;background:#dee1e6;padding:8px 12px;border-radius:8px;height:fit-content"><span style="display:flex;gap:8px;align-items:center;background:#fff;padding:6px 12px;border-radius:8px 8px 0 0;font-size:13px">${img('favicon.svg', 16)} books.metta.family</span></div></div>
</div>`;
await render(sheet, 900, 620, 'review.png');
ws.close(); chrome.kill();
