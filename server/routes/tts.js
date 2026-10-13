import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { synthesize } from '../tts/kokoroProcess.js';
import { KOKORO_VOICES, DEFAULT_VOICE, isKnownVoice } from '../tts/voices.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cacheDir = path.join(__dirname, '..', 'data', 'tts-cache');
if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });

const router = Router();

router.get('/voices', (_req, res) => {
  res.json({ voices: KOKORO_VOICES, defaultVoice: DEFAULT_VOICE });
});

// POST /api/tts/speak — { text, voice, speed } -> audio/wav bytes.
// Strips the app's **bold** / *italic* markdown before synthesis so Kokoro
// doesn't try to pronounce the asterisks, and caches by content hash so
// re-reading the same paragraph/voice/speed doesn't re-run inference.
// One paragraph is read at a time; the longest in the library is ~2,500
// characters. Anything far longer is not a paragraph and would tie up the
// speech engine for minutes.
const MAX_CHARS = Number(process.env.TTS_MAX_CHARS) || 4000;
// The cache keeps the most recently used audio up to this size.
const CACHE_LIMIT = (Number(process.env.TTS_CACHE_MB) || 300) * 1024 * 1024;

// Deletes the least recently used files until the cache fits its limit.
// Reading a cached file refreshes its time (see below), so what people
// listen to stays.
let pruning = null;
function pruneCache() {
  pruning ??= (async () => {
    try {
      const files = await Promise.all((await fs.promises.readdir(cacheDir)).filter((f) => f.endsWith('.wav')).map(async (name) => {
        const st = await fs.promises.stat(path.join(cacheDir, name));
        return { name, size: st.size, used: st.mtimeMs };
      }));
      let total = files.reduce((n, f) => n + f.size, 0);
      for (const f of files.sort((a, b) => a.used - b.used)) {
        if (total <= CACHE_LIMIT) break;
        await fs.promises.rm(path.join(cacheDir, f.name), { force: true });
        total -= f.size;
      }
    } catch (err) {
      console.error('[tts] cache prune failed:', err.message);
    }
  })().finally(() => { pruning = null; });
  return pruning;
}
pruneCache();

router.post('/speak', async (req, res) => {
  const { text, speed } = req.body || {};
  const voice = isKnownVoice(req.body?.voice) ? req.body.voice : DEFAULT_VOICE;
  const safeSpeed = Math.min(2, Math.max(0.5, Number(speed) || 1));

  if (typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'Thiếu văn bản cần đọc.' });
  }
  if (text.length > MAX_CHARS) {
    return res.status(413).json({ error: `Đoạn quá dài để đọc một lần (tối đa ${MAX_CHARS} ký tự).` });
  }

  const plainText = text.replace(/\*\*|\*/g, '').trim();
  const cacheKey = crypto.createHash('sha256').update(`${plainText}|${voice}|${safeSpeed}`).digest('hex');
  const cachePath = path.join(cacheDir, `${cacheKey}.wav`);

  try {
    let audio;
    if (fs.existsSync(cachePath)) {
      audio = await fs.promises.readFile(cachePath);
      const now = new Date();
      fs.promises.utimes(cachePath, now, now).catch(() => {});
    } else {
      audio = await synthesize({ text: plainText, voice, speed: safeSpeed });
      fs.promises.writeFile(cachePath, audio).then(pruneCache).catch(() => {});
    }
    res.set({ 'Content-Type': 'audio/wav', 'Content-Length': audio.length });
    res.send(audio);
  } catch (err) {
    console.error('Kokoro TTS error:', err.message);
    res.status(500).json({ error: err.message || 'Đọc văn bản thất bại.' });
  }
});

export default router;
