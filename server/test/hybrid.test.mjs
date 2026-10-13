// The hybrid pipeline (llm/hybridPipeline.js) against a fake local
// OpenAI-compatible server that plays both the translation-only model and
// the chat model: the base translation reaches the annotator, the agreed
// terms are passed on, and each fallback works. Also the Metta model list
// remembered for when the GPU server is offline (routes/settings.js).
// Runs on a throwaway copy of the database whose real keys are wiped:
//   npm run test:hybrid
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import express from 'express';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-hybrid-'));
const dbPath = path.join(tmp, 'books.db');
await new Database(process.env.SOURCE_DB || path.join(root, 'server/data/books.db'), { readonly: true }).backup(dbPath);
Object.assign(process.env, { BOOKS_DB_PATH: dbPath, BACKUP_DIR: path.join(tmp, 'backups'), BACKUP_AUTO: '0', COVER_DIR: path.join(tmp, 'covers'), SETTINGS_SECRET: 'test-only-secret' });

const { db } = await import('../db.js');
const settings = await import('../settingsStore.js');
const { translateParagraphHybrid, machineTranslate } = await import('../llm/hybridPipeline.js');
const { default: settingsRouter } = await import('../routes/settings.js');
const { translateParagraphCompact } = await import('../llm/compactPipeline.js');

let passed = 0;
const test = async (name, fn) => { await fn(); passed += 1; console.log(`  ✓ ${name}`); };

// ---- the fake server ---------------------------------------------------------
const BASE = 'Con cáo nâu nhanh nhẹn nhảy qua con chó lười biếng.';
const state = { mt: 'ok', annotator: 'ok', models: 'ok', tools: 'ok', calls: [] };
const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const send = (status, json) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(json)); };
    if (req.url.endsWith('/models')) {
      if (state.models !== 'ok') return send(503, {});
      return send(200, { data: [{ id: 'meta/llama-3.1-8b-instruct' }, { id: 'nvidia/riva-translate-4b-instruct-v2' }, { id: 'qwen/qwen3-32b' }] });
    }
    const req_ = JSON.parse(body || '{}');
    state.calls.push(req_);
    if (/riva-translate/.test(req_.model)) {
      if (state.mt !== 'ok') return send(500, { error: 'mt down' });
      return send(200, { choices: [{ message: { content: `"${BASE}"` } }] });
    }
    if (state.annotator === 'fail') return send(500, { error: 'annotator down' });
    if (req_.tools && state.tools === 'reject') return send(400, { error: { message: 'tool_choice requires --tool-call-parser to be set' } });
    if (!req_.tools) return send(200, { choices: [{ message: { content: BASE } }] });
    const vi = state.annotator === 'short' ? 'Con cáo.' : 'Con **cáo** nâu nhanh nhẹn nhảy qua con chó lười biếng.';
    const result = {
      english_md: 'The quick brown **fox** jumps over the lazy dog.', vietnamese_md: vi, citation_vi_md: '',
      phrases: [], new_words: [{ term: 'fox', ipa: '', pos: 'noun', meaning_vi: 'con cáo', example_en: '', example_vi: '' }],
      already_known: [], citations: [], remarks_note: '',
    };
    return send(200, { choices: [{ message: { tool_calls: [{ function: { name: 'x', arguments: JSON.stringify(result) } }] } }] });
  });
});
await new Promise((r) => fake.listen(0, '127.0.0.1', r));
const fakeUrl = `http://127.0.0.1:${fake.address().port}/v1`;

// Wipe real keys, point Metta at the fake server, hybrid on.
db.prepare("DELETE FROM settings WHERE key = 'llm_config'").run();
settings.saveSettings({
  provider: 'metta',
  metta: { baseUrl: fakeUrl, model: 'meta/llama-3.1-8b-instruct' },
  pipeline: { mode: 'hybrid', translator: 'metta', translatorModel: 'nvidia/riva-translate-4b-instruct-v2', annotator: 'metta' },
});
const TEXT = 'The quick brown fox jumps over the lazy dog.';
const args = { text: TEXT, existingTerms: ['fox — con cáo'], systemPrompt: 'SYSTEM' };
const lastAnnotatorCall = () => state.calls.filter((c) => !/riva-translate/.test(c.model)).at(-1);

try {
  await test('the MT model gets the model-card prompt and its quotes are stripped', async () => {
    state.calls = [];
    assert.equal(await machineTranslate(TEXT), BASE);
    const call = state.calls[0];
    assert.equal(call.model, 'nvidia/riva-translate-4b-instruct-v2');
    assert.match(call.messages[1].content, /^What is the Vietnamese translation of the sentence: The quick/);
  });

  await test('the annotator gets the base translation and the agreed terms', async () => {
    state.calls = [];
    const r = await translateParagraphHybrid(args);
    const system = lastAnnotatorCall().messages.find((m) => m.role === 'system').content;
    assert.match(system, /^SYSTEM/);
    assert.ok(system.includes(`<base_translation>\n${BASE}\n</base_translation>`));
    assert.ok(JSON.stringify(lastAnnotatorCall().messages).includes('fox — con cáo'), 'agreed terms reach the annotator');
    assert.match(r.vietnamese_md, /\*\*cáo\*\*/);
    assert.equal(r.new_words.length, 1);
    assert.deepEqual(r._pipeline.warnings, []);
    assert.equal(r._pipeline.base, BASE);
    assert.equal(r._pipeline.translator, 'nvidia/riva-translate-4b-instruct-v2');
  });

  await test('MT down: the annotator translates alone, with a warning', async () => {
    state.mt = 'fail';
    state.calls = [];
    const r = await translateParagraphHybrid(args);
    assert.ok(!lastAnnotatorCall().messages[0].content.includes('<base_translation>'));
    assert.match(r.vietnamese_md, /cáo/);
    assert.match(r._pipeline.warnings[0], /Máy dịch lỗi/);
    state.mt = 'ok';
  });

  await test('annotator down: the MT translation is saved without notes', async () => {
    state.annotator = 'fail';
    const r = await translateParagraphHybrid(args);
    assert.equal(r.vietnamese_md, BASE);
    assert.deepEqual(r.new_words, []);
    assert.match(r._pipeline.warnings[0], /Model ghi chú lỗi/);
    state.annotator = 'ok';
  });

  await test('both down: an error, nothing saved', async () => {
    state.mt = 'fail';
    state.annotator = 'fail';
    await assert.rejects(translateParagraphHybrid(args));
    state.mt = 'ok';
    state.annotator = 'ok';
  });

  await test('annotator drops sentences: the base is kept, bold removed on both sides', async () => {
    state.annotator = 'short';
    const r = await translateParagraphHybrid(args);
    assert.equal(r.vietnamese_md, BASE);
    assert.ok(!r.english_md.includes('**'));
    assert.match(r._pipeline.warnings[0], /ngắn hơn hẳn/);
    state.annotator = 'ok';
  });

  await test('an MT-only model as annotator is refused', async () => {
    settings.saveSettings({ metta: { model: 'nvidia/riva-translate-4b-instruct-v2' } });
    await assert.rejects(translateParagraphHybrid(args), /chỉ dịch/);
    settings.saveSettings({ metta: { model: 'meta/llama-3.1-8b-instruct' } });
  });

  await test('settings validate the pipeline fields', async () => {
    const s = settings.saveSettings({ pipeline: { mode: 'weird', translator: 'anthropic', annotator: 'riva' } });
    assert.equal(s.pipeline.mode, 'single');
    assert.equal(s.pipeline.translator, 'nvidia');
    assert.equal(s.pipeline.annotator, 'anthropic');
    settings.saveSettings({ pipeline: { mode: 'hybrid', translator: 'metta', annotator: 'metta' } });
  });

  // ---- Metta in single mode (compact pipeline) ------------------------------
  await test('compact: an MT-only model translates with its own prompt, no notes, a warning', async () => {
    state.calls = [];
    const r = await translateParagraphCompact({ text: 'The **fox** jumps.', config: { baseUrl: fakeUrl, model: 'nvidia/riva-translate-4b-instruct-v2' }, providerKey: 'metta' });
    assert.equal(r.vietnamese_md, BASE);
    assert.equal(r.english_md, 'The fox jumps.');
    assert.equal(state.calls.length, 1);
    assert.ok(!state.calls[0].tools);
    assert.match(state.calls[0].messages[1].content, /^What is the Vietnamese translation of the sentence: The fox jumps\./);
    assert.match(r._pipeline.warnings[0], /chỉ dịch/);
  });

  await test('compact: a server without tool calling keeps the translation, with a warning', async () => {
    state.tools = 'reject';
    const r = await translateParagraphCompact({ text: TEXT, config: { baseUrl: fakeUrl, model: 'meta/llama-3.1-8b-instruct' }, providerKey: 'metta' });
    assert.equal(r.vietnamese_md, BASE);
    assert.deepEqual(r.new_words, []);
    assert.match(r._pipeline.warnings[0], /tool-call-parser/);
    state.tools = 'ok';
  });

  // ---- the Metta model list -------------------------------------------------
  const app = express();
  app.use(express.json());
  app.use('/api/settings', settingsRouter);
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const api = async (p, body) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/settings${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    return { status: res.status, body: await res.json() };
  };
  try {
    await test('a live Metta list is returned and remembered', async () => {
      const { body } = await api('/models', { provider: 'metta', config: {} });
      assert.equal(body.source, 'live');
      assert.equal(body.models.length, 3);
      assert.deepEqual(settings.getSettings().metta.knownModels, ['meta/llama-3.1-8b-instruct', 'nvidia/riva-translate-4b-instruct-v2', 'qwen/qwen3-32b']);
    });

    await test('offline: the remembered list, then the static extras', async () => {
      state.models = 'down';
      const { body } = await api('/models', { provider: 'metta', config: {} });
      assert.equal(body.source, 'cached');
      assert.ok(body.cachedAt);
      assert.deepEqual(body.models.map((m) => m.id), ['meta/llama-3.1-8b-instruct', 'nvidia/riva-translate-4b-instruct-v2', 'qwen/qwen3-32b']);
      state.models = 'ok';
    });

    await test('another address neither uses nor overwrites the remembered list', async () => {
      const { body } = await api('/models', { provider: 'metta', config: { baseUrl: 'http://127.0.0.1:9/v1' } });
      assert.equal(body.source, 'fallback');
      assert.ok(!body.models.some((m) => m.id === 'qwen/qwen3-32b'));
      assert.equal(settings.getSettings().metta.knownModels.length, 3);
    });

    await test('test-pipeline reports both stages', async () => {
      const { status, body } = await api('/test-pipeline');
      assert.equal(status, 200, JSON.stringify(body));
      assert.equal(body.ok, true);
      assert.equal(body.base, BASE);
      assert.equal(body.notes, 1);
      assert.ok(Array.isArray(body.warnings));
    });
  } finally {
    server.close();
  }

  console.log(`hybrid: ${passed} passed`);
} finally {
  fake.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
