// A/B comparison of the linear pipeline and the graph workflow on the same
// paragraphs, nothing saved. Run it on a copy of the database:
//
//   BOOKS_DB_PATH=/tmp/copy.db node server/workflow/compare.js --book 1 --count 10 --out report.json
//
// Both are scored with the same checks (checks.js) — which are also what the
// graph repairs against, so the scores favour it by construction; the report
// therefore also keeps the texts, for reading side by side.
import { db } from '../db.js';
import { loadVocabState, translationContext, draftTranslation } from '../paragraphTranslation.js';
import { runGraph } from './engine.js';
import graph from './graphs/translateParagraph.js';
import { checkTranslation, issueScore } from './checks.js';
import { getSettings } from '../settingsStore.js';
import fs from 'node:fs';

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};
const bookId = Number(arg('book', 1));
const count = Number(arg('count', 10));
const out = arg('out', 'workflow-ab.json');

// A spread of lengths: short, medium, long, and any with a citation.
const all = db.prepare(`
  SELECT p.* FROM paragraphs p JOIN sections s ON s.id = p.section_id JOIN chapters c ON c.id = s.chapter_id
  WHERE c.book_id = ? AND length(p.english_md) > 200 ORDER BY c.order_index, s.order_index, p.order_index
`).all(bookId);
const by = (lo, hi) => all.filter((p) => p.english_md.length >= lo && p.english_md.length < hi);
const pick = (list, n) => list.filter((_, i) => i % Math.max(1, Math.floor(list.length / n)) === 0).slice(0, n);
const chosen = [...new Map([
  ...pick(by(200, 700), Math.ceil(count * 0.3)),
  ...pick(by(700, 1400), Math.ceil(count * 0.3)),
  ...pick(by(1400, 99999), Math.ceil(count * 0.3)),
  ...all.filter((p) => p.citation_en_md?.trim()).slice(0, 1),
].map((p) => [p.id, p])).values()].slice(0, count);

const vocabState = loadVocabState();
const rows = [];
console.log(`Provider: ${getSettings().provider}; ${chosen.length} paragraphs`);
for (const p of chosen) {
  const ctx = translationContext(p, vocabState);
  const reference = checkTranslation(p, p, ctx.decided);
  const row = { id: p.id, length: p.english_md.length, glossaryTerms: ctx.decided.length, english: p.english_md, existing: p.vietnamese_md, existingIssues: reference };

  let t = Date.now();
  try {
    const draft = await draftTranslation(p, vocabState, ctx);
    const issues = checkTranslation(draft, p, ctx.decided);
    row.linear = { ms: Date.now() - t, llmCalls: 1, score: issueScore(issues), issues, vietnamese: draft.vietnamese_md };
  } catch (e) {
    row.linear = { ms: Date.now() - t, error: e.message };
  }

  t = Date.now();
  try {
    const run = await runGraph(graph, { paragraphId: p.id, vocabState }, { dryRun: true });
    const issues = run.state.remaining || [];
    row.graph = {
      ms: run.ms, llmCalls: run.llmCalls, score: issueScore(issues), issues, vietnamese: run.state.result?.vietnamese_md,
      path: run.trace.map((s) => s.node), strategy: run.state.plan?.strategy, history: run.state.history,
    };
  } catch (e) {
    row.graph = { ms: Date.now() - t, error: e.message, path: e.workflow?.trace?.map((s) => s.node) };
  }
  rows.push(row);
  console.log(`#${p.id} (${p.english_md.length} ch): linear ${row.linear.score ?? 'ERR'} [${(row.linear.issues || []).map((i) => i.type)}] ${row.linear.ms}ms | graph ${row.graph.score ?? 'ERR'} [${(row.graph.issues || []).map((i) => i.type)}] ${row.graph.ms}ms ${row.graph.path?.join('→')}`);
  fs.writeFileSync(out, JSON.stringify({ provider: getSettings().provider, model: getSettings()[getSettings().provider]?.model, rows }, null, 2));
}
console.log(`written ${out}`);
