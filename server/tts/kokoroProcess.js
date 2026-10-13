import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = path.join(__dirname, 'kokoro_server.py');

// The Kokoro assets and Python venv are per machine: set KOKORO_PYTHON,
// KOKORO_MODEL_PATH and KOKORO_VOICES_PATH in .env. Without them, read-aloud
// answers with an error instead of starting a worker.
const PYTHON_BIN = process.env.KOKORO_PYTHON || '';
const MODEL_PATH = process.env.KOKORO_MODEL_PATH || '';
const VOICES_PATH = process.env.KOKORO_VOICES_PATH || '';

let child = null;
let readyPromise = null;
let nextId = 1;
const pending = new Map();

function spawnWorker() {
  if (!PYTHON_BIN || !MODEL_PATH || !VOICES_PATH) {
    throw new Error('Chưa cấu hình đọc to (Kokoro TTS): đặt KOKORO_PYTHON, KOKORO_MODEL_PATH, KOKORO_VOICES_PATH trong .env.');
  }
  const proc = spawn(PYTHON_BIN, [SCRIPT_PATH, MODEL_PATH, VOICES_PATH], { stdio: ['pipe', 'pipe', 'pipe'] });

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
      else rejectReady(new Error(msg.error || 'Kokoro worker báo lỗi khi khởi động.'));
      return;
    }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.success) resolve(Buffer.from(msg.audio, 'base64'));
      else reject(new Error(msg.error || 'Kokoro TTS thất bại.'));
    }
  });

  let stderrBuf = '';
  proc.stderr.on('data', (d) => { stderrBuf += d.toString(); });

  // e.g. the Python binary is missing: reject instead of crashing the server
  proc.stdin.on('error', () => { /* worker gone; 'exit'/'error' below settle the requests */ });
  proc.on('error', (err) => {
    if (!sawReady) rejectReady(new Error(`Không chạy được Kokoro TTS (${err.code || err.message}).`));
    for (const { reject } of pending.values()) reject(new Error('Tiến trình Kokoro TTS lỗi.'));
    pending.clear();
    if (child === proc) { child = null; readyPromise = null; }
  });

  proc.on('exit', (code) => {
    if (!sawReady) rejectReady(new Error(stderrBuf.trim() || `Tiến trình Kokoro thoát với mã ${code}.`));
    for (const { reject } of pending.values()) reject(new Error('Tiến trình Kokoro TTS đã dừng.'));
    pending.clear();
    if (child === proc) { child = null; readyPromise = null; }
  });

  child = proc;
  return ready;
}

function ensureWorker() {
  if (!child) readyPromise = spawnWorker();
  return readyPromise;
}

// Synthesizes speech for one paragraph. Spawns (and warms up) the worker on
// first call; subsequent calls reuse the already-loaded model.
export async function synthesize({ text, voice, speed, lang }) {
  if (!text || !text.trim()) throw new Error('Thiếu văn bản cần đọc.');
  await ensureWorker();

  const id = String(nextId++);
  const payload = JSON.stringify({ id, text, voice, speed, lang }) + '\n';

  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    child.stdin.write(payload, (err) => {
      if (err) { pending.delete(id); reject(err); }
    });
  });
}
