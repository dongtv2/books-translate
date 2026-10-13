import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = path.join(__dirname, 'riva_nmt_server.py');
// Homebrew's system Python refuses direct `pip install` (PEP 668), so
// nvidia-riva-client lives in its own venv right next to this file —
// same reasoning as the dedicated venv server/tts/kokoroProcess.js uses.
const DEFAULT_PYTHON = path.join(__dirname, 'venv', 'bin', 'python3');
const PYTHON_BIN = process.env.RIVA_PYTHON || DEFAULT_PYTHON;

let child = null;
let childConfigKey = null;
let readyPromise = null;
let nextId = 1;
const pending = new Map();

function configKey({ apiKey, functionId, server }) {
  return `${apiKey}::${functionId}::${server}`;
}

function spawnWorker({ apiKey, functionId, server }) {
  // the key goes in the environment, not argv (visible to `ps`)
  const proc = spawn(PYTHON_BIN, [SCRIPT_PATH, functionId, server], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, RIVA_API_KEY: apiKey } });

  const rl = createInterface({ input: proc.stdout });
  let resolveReady;
  let rejectReady;
  const ready = new Promise((res, rej) => { resolveReady = res; rejectReady = rej; });
  let sawReady = false;

  rl.on('line', (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }

    if (!sawReady && 'ready' in msg) {
      sawReady = true;
      if (msg.ready) resolveReady();
      else rejectReady(new Error(msg.error || 'Riva NMT worker báo lỗi khi khởi động.'));
      return;
    }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.success) resolve(msg.translation);
      else reject(new Error(msg.error || 'Riva NMT dịch thất bại.'));
    }
  });

  let stderrBuf = '';
  proc.stderr.on('data', (d) => { stderrBuf += d.toString(); });

  proc.on('exit', (code) => {
    if (!sawReady) rejectReady(new Error(stderrBuf.trim() || `Tiến trình Riva NMT thoát với mã ${code}.`));
    for (const { reject } of pending.values()) reject(new Error('Tiến trình Riva NMT đã dừng.'));
    pending.clear();
    if (child === proc) { child = null; childConfigKey = null; readyPromise = null; }
  });

  child = proc;
  return ready;
}

// Respawns automatically if the API key/function-id/server changed since the
// last call (e.g. the user just edited Settings) — otherwise reuses the
// already-authenticated worker.
function ensureWorker(cfg) {
  const key = configKey(cfg);
  if (!child || childConfigKey !== key) {
    if (child) child.kill();
    childConfigKey = key;
    readyPromise = spawnWorker(cfg);
  }
  return readyPromise;
}

// Translates one piece of text via NVIDIA's cloud Riva NMT service.
export async function translate({ text, sourceLang = 'en', targetLang = 'vi', apiKey, functionId, server }) {
  if (!apiKey) throw new Error('Thiếu API key cho NVIDIA Riva NMT — vào Cài đặt để nhập.');
  if (!functionId) throw new Error('Thiếu Function ID cho NVIDIA Riva NMT — vào Cài đặt để nhập.');
  if (!server) throw new Error('Thiếu địa chỉ gRPC server cho NVIDIA Riva NMT.');
  if (!text || !text.trim()) throw new Error('Thiếu nội dung cần dịch.');

  await ensureWorker({ apiKey, functionId, server });

  const id = String(nextId++);
  const payload = JSON.stringify({ id, text, sourceLang, targetLang }) + '\n';

  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    child.stdin.write(payload, (err) => {
      if (err) { pending.delete(id); reject(err); }
    });
  });
}
