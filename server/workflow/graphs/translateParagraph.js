// Translating one paragraph as a graph instead of a fixed chain:
//
//   load → route ─┬─ single ──┐
//                 └─ chunked ─┴→ verify ─┬─ ok / out of tries ─────────────→ persist
//                                        ├─ empty → retry → verify
//                                        └─ issues → repair ─┬ repairText     ┐ side
//                                                            └ repairCitation ┘ by side
//                                                              → repairBold → verify …
//
// The draft comes from the same steps as the linear pipeline
// (paragraphTranslation.js). verify runs the cheap checks of checks.js; only
// what they find goes back to the model, as a narrow edit ("add the missing
// sentences", "translate X as Y"), not a new translation. The best-scoring
// draft is kept, so a repair that makes things worse is dropped. What still
// fails after the allowed repairs is saved with the paragraph flagged for
// review (the reader's own 🚩 mark) and reported to the caller.
import { db } from '../../db.js';
import { defineGraph, parallel, END } from '../engine.js';
import { checkTranslation, issueScore } from '../checks.js';
import { loadVocabState, translationContext, draftTranslation, saveTranslation } from '../../paragraphTranslation.js';
import { translatePlainText } from '../../llm/index.js';
import { chatText } from '../../llm/chat.js';
import { alignBold } from '../../llm/compactPipeline.js';
import { htmlToMarkdown, mergeAdjacentBold, cleanTranslationResult } from '../../modelOutput.js';
import { setUserMarks } from '../../auth/marks.js';
import { getSettings } from '../../settingsStore.js';

const SMALL_MODEL_PROVIDERS = ['metta'];
const ALIGNABLE = ['openai', 'nvidia', 'ollama', 'lmstudio', 'metta'];
// A long paragraph is split for a small model, which drops sentences from
// long inputs; bigger models take it whole.
const CHUNK_OVER = 1400;
const CHUNK_TARGET = 700;

function splitSentences(text) {
  return text.match(/[^.!?…]+(?:[.!?…]+["”’)*]*\s*|$)/g)?.filter((s) => s.trim()) || [text];
}

function chunksOf(text) {
  const out = [];
  let cur = '';
  for (const s of splitSentences(text)) {
    if (cur && cur.length + s.length > CHUNK_TARGET) { out.push(cur.trim()); cur = ''; }
    cur += s;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

// ---- nodes ---------------------------------------------------------------------

async function load(state) {
  const paragraph = db.prepare('SELECT * FROM paragraphs WHERE id = ?').get(state.paragraphId);
  if (!paragraph) throw new Error('Không tìm thấy đoạn văn.');
  const vocabState = state.vocabState || loadVocabState();
  const ctx = translationContext(paragraph, vocabState);
  return { paragraph, vocabState, ctx, glossary: ctx.decided, repairs: 0, best: null, bestScore: Infinity };
}

function route(state) {
  const { paragraph, ctx } = state;
  const small = SMALL_MODEL_PROVIDERS.includes(ctx.settings.provider);
  const long = paragraph.english_md.length > CHUNK_OVER;
  const strategy = small && long ? 'chunked' : 'single';
  return { plan: { strategy, reason: small && long ? `model nhỏ, đoạn dài ${paragraph.english_md.length} ký tự` : 'dịch cả đoạn' } };
}

async function single(state, run) {
  run.llmCalls += 1;
  return { draft: await draftTranslation(state.paragraph, state.vocabState, state.ctx, { reexplainAll: state.reexplainAll }) };
}

// Each chunk is translated as if it were a paragraph (same context, same
// glossary), one after another with the chunk before as the worked example,
// so voice and forms of address carry across (translating them side by side
// switched "bạn" and "mình" between chunks). Pieces that are not English
// (notes pasted into the source) are left out: a small model asked to
// translate them invents text. The citation goes with the last chunk.
const notEnglish = (t) => (t.match(/[ăâđêôơưáàảãạấầẩẫậắằẳẵặéèẻẽẹếềểễệíìỉĩịóòỏõọốồổỗộớờởỡợúùủũụứừửữựýỳỷỹỵ]/gi) || []).length > t.length * 0.03
  || !/[a-z]{3,}/i.test(t);
async function chunked(state, run) {
  const { paragraph, vocabState, ctx } = state;
  const parts = chunksOf(paragraph.english_md).filter((t) => !notEnglish(t));
  const drafts = [];
  for (const [i, text] of parts.entries()) {
    run.llmCalls += 1;
    const piece = { ...paragraph, english_md: text, citation_en_md: i === parts.length - 1 ? paragraph.citation_en_md : '' };
    const before = drafts.at(-1);
    drafts.push(await draftTranslation(piece, vocabState, ctx, {
      reexplainAll: state.reexplainAll,
      ...(before ? { previous: { english: parts[i - 1].replace(/\*\*/g, ''), vietnamese: before.vietnamese_md.replace(/\*\*/g, '') } } : {}),
    }));
  }
  const seen = new Set();
  const uniq = (items, key) => items.filter((x) => { const k = String(x?.[key] || '').toLowerCase(); if (!k || seen.has(`${key}:${k}`)) return false; seen.add(`${key}:${k}`); return true; });
  const draft = {
    english_md: drafts.map((d) => d.english_md).join(' '),
    vietnamese_md: drafts.map((d) => d.vietnamese_md).join(' '),
    citation_vi_md: drafts.at(-1).citation_vi_md || '',
    remarks_note: drafts.map((d) => d.remarks_note).filter(Boolean)[0] || '',
    new_words: uniq(drafts.flatMap((d) => d.new_words || []), 'term'),
    phrases: uniq(drafts.flatMap((d) => d.phrases || []), 'term'),
    citations: uniq(drafts.flatMap((d) => d.citations || []), 'source'),
    already_known: drafts.flatMap((d) => d.already_known || []),
  };
  // The joined English must still be the original text (with bold added).
  return { draft: cleanTranslationResult(draft, paragraph.english_md, paragraph.citation_en_md || ''), chunks: parts.length };
}

// A draft with no Vietnamese at all is tried again from scratch, once.
async function retry(state, run) {
  return { ...(await single(state, run)), repairs: state.repairs + 1 };
}

function verify(state) {
  const issues = checkTranslation(state.draft, state.paragraph, state.glossary);
  const score = issueScore(issues);
  const better = score < state.bestScore;
  return {
    issues,
    best: better ? state.draft : state.best,
    bestScore: better ? score : state.bestScore,
    bestIssues: better ? issues : state.bestIssues,
    // Repairs always start from the best draft so far.
    draft: better ? state.draft : state.best,
    history: [...(state.history || []), { score, issues: issues.map((i) => i.type) }],
  };
}

const mainRendering = (meaning) => meaning.split(/[;/,]| hoặc /)[0].replace(/\([^)]*\)/g, '').trim();

const TEXT_FIXES = {
  extra: () => 'The Vietnamese contains sentences that are not in the English. Remove every sentence that has no counterpart in the English.',
  short: () => 'Some English sentences are missing from the Vietnamese. Compare sentence by sentence and add a translation of every missing sentence in its place.',
  sentences: (i) => `The English has ${i.en} sentences but the Vietnamese only ${i.vi}. Add the sentences that are missing, in their place.`,
  // Only the main rendering: given a whole entry ("xu hướng X, khuynh hướng
  // Y hơn Z") a small model pastes all of it into the sentence.
  glossary: (i) => `Translate "${i.term}" as "${mainRendering(i.meaning)}" (the team's decided terminology).`,
  untranslated: (i) => `These English words were left untranslated: ${i.words.join(', ')}. Translate them into Vietnamese.`,
};

// One narrow edit of the Vietnamese for the problems found. The answer must
// still look like the full translation, or it is ignored.
async function repairText(state, run) {
  const fixes = state.issues.filter((i) => TEXT_FIXES[i.type]);
  if (!fixes.length) return {};
  run.llmCalls += 1;
  const { paragraph, draft, glossary } = state;
  const answer = await chatText({
    temperature: 0,
    maxTokens: 2500,
    system: 'You are a careful Vietnamese copy editor. You get an English paragraph, its Vietnamese translation and a list of problems. '
      + 'Return ONLY the corrected, complete Vietnamese translation: no explanation, no English, no heading. '
      + 'Keep every sentence that is already right as it is, keep the **bold** marks around the same terms, and fix exactly the listed problems.',
    messages: [{
      role: 'user',
      content: `English:\n${paragraph.english_md}\n\nVietnamese translation:\n${draft.vietnamese_md}\n\nProblems:\n${fixes.map((i) => `- ${TEXT_FIXES[i.type](i)}`).join('\n')}`
        + `${glossary.length ? `\n\nRequired terminology:\n${glossary.map((g) => `- ${g.term} = ${mainRendering(g.meaning_vi)}`).join('\n')}` : ''}`,
    }],
  });
  const text = mergeAdjacentBold(htmlToMarkdown(answer)).replace(/^(?:here is|dưới đây là|bản dịch)[^\n]*:\s*\n+/i, '').trim();
  const usable = text.length > draft.vietnamese_md.length * 0.6 && !/^(english|problems):/im.test(text);
  return { textFix: usable ? text : null };
}

async function repairCitation(state, run) {
  if (!state.issues.some((i) => i.type === 'citation')) return {};
  run.llmCalls += 1;
  try {
    const vi = await translatePlainText(state.paragraph.citation_en_md.trim());
    return { citationFix: vi ? mergeAdjacentBold(htmlToMarkdown(vi)) : null };
  } catch {
    return { citationFix: null };
  }
}

// Applies the fixes, then re-aligns bold if the columns disagree.
async function repairBold(state, run) {
  const draft = { ...state.draft };
  if (state.textFix) draft.vietnamese_md = state.textFix;
  if (state.citationFix) draft.citation_vi_md = state.citationFix;
  const count = (s) => ((s || '').match(/\*\*[^*]+\*\*/g) || []).length;
  const { provider } = getSettings();
  if (count(draft.english_md) !== count(draft.vietnamese_md) && ALIGNABLE.includes(provider)) {
    run.llmCalls += 1;
    try {
      const terms = [...(draft.new_words || []), ...(draft.phrases || [])].map((i) => i.term).filter(Boolean);
      const settings = getSettings();
      const aligned = await alignBold({ english: draft.english_md, vietnamese: draft.vietnamese_md, terms, config: settings[provider], providerKey: provider });
      draft.english_md = aligned.english;
      draft.vietnamese_md = aligned.vietnamese;
    } catch {
      // keep the unaligned draft; verify will weigh it
    }
  }
  return { draft, repairs: state.repairs + 1, textFix: null, citationFix: null };
}

function persist(state, run) {
  const result = state.best || state.draft;
  const remaining = state.bestIssues || [];
  const serious = remaining.filter((i) => i.severity >= 5);
  if (run.dryRun) return { result, remaining };
  const saved = saveTranslation(state.paragraph, result, state.vocabState);
  // What the checks could not fix is left for a person: the paragraph is
  // flagged "cần xem lại" for whoever ran the translation.
  if (serious.length && run.userId) setUserMarks(run.userId, state.paragraph.id, { is_flagged: 1 });
  return { result, remaining, saved };
}

// ---- edges ----------------------------------------------------------------------

export function maxRepairs() {
  return Math.max(0, Math.min(4, Number(getSettings().workflow?.maxRepairs ?? 2)));
}

export default defineGraph({
  name: 'translateParagraph',
  start: 'load',
  nodes: { load, route, single, chunked, verify, retry, repair: () => ({}), repairText, repairCitation, repairBold, persist },
  edges: {
    load: 'route',
    route: (s) => s.plan.strategy,
    single: 'verify',
    chunked: 'verify',
    verify: (s) => {
      if (!s.issues.length) return 'persist';
      if (s.issues.some((i) => i.type === 'empty')) return s.repairs < 1 ? 'retry' : 'persist';
      // Mismatched bold alone is only worth a repair where it can be re-aligned.
      const onlyBold = s.issues.every((i) => i.type === 'bold');
      if (onlyBold && !ALIGNABLE.includes(getSettings().provider)) return 'persist';
      return s.repairs < (s.maxRepairs ?? maxRepairs()) ? 'repair' : 'persist';
    },
    retry: 'verify',
    repair: parallel(['repairText', 'repairCitation'], 'repairBold'),
    repairBold: 'verify',
    persist: END,
  },
  limits: { maxSteps: 24, timeoutMs: 240000, fallback: 'persist' },
});
