import { bookById, bookContextText } from './bookContext.js';
import { db } from './db.js';
import { translateParagraph, translatePlainText } from './llm/index.js';
import { normalizeTerm, relevantTerms } from './normalize.js';
import { WORD_TYPES, WORD_TYPE_ABBR } from './wordTypes.js';
import { getEffectivePromptForBook } from './llm/promptTemplates.js';
import { buildSystemPrompt, isLegacyPrompt } from './llm/prompt.js';
import { cleanTranslationResult } from './modelOutput.js';
import { translateParagraphCompact, alignBold } from './llm/compactPipeline.js';
import { translateParagraphHybrid } from './llm/hybridPipeline.js';
import { getSettings } from './settingsStore.js';
import { isValidTopic } from './vocabTopics.js';
import { glossaryFor, glossaryPromptBlock } from './discussions.js';
// Loaded for its migration: the dedupe key must be unique before inserting.
import { absorbPrivateCopies } from './vocabStore.js';
import { knownForBook, loadSenseIndex, meaningForBook, upsertSense } from './vocabSenses.js';

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

// Translation writes to the shared vocabulary only; users' own words never
// steer it (see vocabStore: owner_id).
const findExisting = db.prepare('SELECT id FROM vocabulary WHERE term_normalized = ? AND owner_id IS NULL');
const insertVocab = db.prepare(`
  INSERT INTO vocabulary
    (term, term_normalized, ipa, word_type, meaning_vi, example, topic, date_added, status, source_paragraph_id)
  VALUES (@term, @term_normalized, @ipa, @word_type, @meaning_vi, @example, @topic, @date_added, 'Đang học', @source_paragraph_id)
  ON CONFLICT(term_normalized) WHERE owner_id IS NULL DO NOTHING
`);
const linkGlossary = db.prepare('UPDATE glossary SET vocabulary_id = ? WHERE term_normalized = ? AND vocabulary_id IS NULL');
const updateParagraph = db.prepare(`
  UPDATE paragraphs SET
    english_md = @english_md,
    vietnamese_md = @vietnamese_md,
    phrases_verbs_md = @phrases_verbs_md,
    vocabulary_md = @vocabulary_md,
    citations_md = @citations_md,
    citation_vi_md = @citation_vi_md,
    remarks_note = @remarks_note,
    status = 'translated',
    updated_at = datetime('now')
  WHERE id = @id
`);
const findBookIdForParagraph = db.prepare(`
  SELECT c.book_id AS book_id
  FROM paragraphs p
  JOIN sections s ON s.id = p.section_id
  JOIN chapters c ON c.id = s.chapter_id
  WHERE p.id = ?
`);

// Providers whose model is small enough that the split, context-rich
// pipeline in llm/compactPipeline.js translates better than the single
// all-in-one prompt (measured on Llama 3.1 8B: correct terminology, no
// dropped sentences, matching bold in both columns). Note it uses its own
// built-in prompts, not the book's prompt from the prompt library.
const COMPACT_PROVIDERS = ['metta'];
// Providers that speak the OpenAI chat format, so alignBold() can call them.
const ALIGNABLE_PROVIDERS = ['openai', 'nvidia', 'ollama', 'lmstudio', 'metta'];


// The translated paragraph just before this one in reading order (same
// chapter), used as a worked example and for narrative continuity.
const findPrevious = db.prepare(`
  SELECT p.english_md, p.vietnamese_md
  FROM paragraphs p JOIN sections s ON s.id = p.section_id
  WHERE s.chapter_id = (SELECT chapter_id FROM sections WHERE id = @sectionId)
    AND (s.order_index < (SELECT order_index FROM sections WHERE id = @sectionId)
      OR (p.section_id = @sectionId AND p.order_index < @orderIndex))
    AND p.vietnamese_md != ''
  ORDER BY s.order_index DESC, p.order_index DESC
  LIMIT 1
`);

function previousTranslated(paragraph) {
  const row = findPrevious.get({ sectionId: paragraph.section_id, orderIndex: paragraph.order_index });
  if (!row) return null;
  const plain = (s) => s.replace(/\*\*/g, '');
  // Keep the example short enough not to crowd out the paragraph itself.
  if (row.english_md.length > 1500) return null;
  return { english: plain(row.english_md), vietnamese: plain(row.vietnamese_md) };
}

// Loads every vocabulary term once; callers reuse + extend this set across a
// whole translate-chapter run so paragraph N+1 already "knows about" a word
// newly saved while translating paragraph N.
export function loadVocabState() {
  const rows = db.prepare('SELECT term, term_normalized, meaning_vi FROM vocabulary WHERE owner_id IS NULL').all();
  return {
    terms: rows.map((r) => r.term),
    meanings: new Map(rows.map((r) => [r.term, r.meaning_vi])),
    normalizedSet: new Set(rows.map((r) => r.term_normalized)),
    // each entry's source book and book-specific senses (vocabSenses.js)
    index: loadSenseIndex(),
  };
}

// Translates one paragraph, applies the same server-side dedupe safety net
// as the old flat-text flow, persists the result, inserts the accepted new
// vocabulary, and mutates vocabState in place so the caller can keep looping
// over more paragraphs in the same book/chapter. This is the linear pipeline;
// the graph workflow (workflow/graphs/translateParagraph.js) runs the same
// steps — translationContext, draftTranslation, saveTranslation — with
// checking and repair in between.
export async function translateAndSaveParagraph(paragraph, vocabState, { reexplainAll = false } = {}) {
  const ctx = translationContext(paragraph, vocabState);
  const result = await draftTranslation(paragraph, vocabState, ctx, { reexplainAll });
  return saveTranslation(paragraph, result, vocabState);
}

// Everything the model is told about this paragraph besides its text.
export function translationContext(paragraph, vocabState) {
  const bookId = findBookIdForParagraph.get(paragraph.id)?.book_id;
  const guide = getEffectivePromptForBook(bookId);
  const book = bookById(bookId);
  // The book's field and specialty steer terminology (bookContext.js).
  const context = bookContextText(book);
  // Terms the team decided in discussions (glossary) bind the translation;
  // they are the book's own entries plus those for every book.
  const decided = glossaryFor(bookId, `${paragraph.english_md}\n${paragraph.citation_en_md || ''}`);
  const systemPrompt = [
    buildSystemPrompt(guide),
    context ? `NGỮ CẢNH SÁCH: ${context}` : '',
    glossaryPromptBlock(decided),
  ].filter(Boolean).join('\n\n');

  // Only the vocabulary that can occur in this paragraph goes to the model;
  // the full set is still enforced below via vocabState.normalizedSet.
  // A word counts as known in this book only when its meaning holds here
  // (vocabSenses.js): in a book of another field the model may explain it
  // again, and that meaning is kept as the word's sense for this book.
  const info = (term) => vocabState.index?.get(normalizeTerm(term));
  const existingTerms = relevantTerms(`${paragraph.english_md}\n${paragraph.citation_en_md || ''}`, vocabState.terms)
    .filter((term) => knownForBook(info(term), book));
  const meanings = new Map(existingTerms.map((term) => [term, info(term) ? meaningForBook(info(term), book).meaning : vocabState.meanings?.get(term)]));
  return { bookId, book, guide, decided, systemPrompt, existingTerms, meanings, settings: getSettings() };
}

// One translation of the paragraph, cleaned, with its citation and bold
// repaired where possible. Nothing is saved.
export async function draftTranslation(paragraph, vocabState, ctx, { reexplainAll = false, previous } = {}) {
  const { book, guide, decided, systemPrompt, existingTerms, settings } = ctx;
  // Hybrid (Settings → AI): a translation-only model translates, a chat
  // model annotates (llm/hybridPipeline.js). The chat model is then the one
  // whose output the bold check below repairs.
  const hybrid = settings.pipeline?.mode === 'hybrid';
  const writer = hybrid ? settings.pipeline.annotator : settings.provider;
  const raw = hybrid
    ? await translateParagraphHybrid({
      text: paragraph.english_md,
      citation: paragraph.citation_en_md || '',
      existingTerms,
      reexplainAll,
      systemPrompt,
    })
    : COMPACT_PROVIDERS.includes(settings.provider)
    ? await translateParagraphCompact({
      text: paragraph.english_md,
      citation: paragraph.citation_en_md || '',
      glossary: [
        ...decided.map((g) => ({ term: g.term, meaning_vi: g.meaning_vi })),
        ...existingTerms
          .filter((term) => (ctx.meanings || vocabState.meanings)?.get(term) && !decided.some((g) => g.term_normalized === normalizeTerm(term)))
          .map((term) => ({ term, meaning_vi: (ctx.meanings || vocabState.meanings).get(term) })),
      ].slice(0, 25),
      // `previous`: the caller's own example (the graph passes the chunk
      // before this one); otherwise the paragraph before, from the book.
      previous: previous !== undefined ? previous : previousTranslated(paragraph),
      book,
      existingTerms: reexplainAll ? [] : existingTerms,
      // The book's translation guide steers style and fidelity; legacy
      // all-in-one prompts are mostly output-format rules, so they are left out.
      guide: isLegacyPrompt(guide) ? '' : guide,
      config: settings[settings.provider],
      providerKey: settings.provider,
    })
    : await translateParagraph({
      text: paragraph.english_md,
      existingTerms,
      reexplainAll,
      citation: paragraph.citation_en_md || '',
      systemPrompt,
    });
  const result = cleanTranslationResult(raw, paragraph.english_md, paragraph.citation_en_md || '');
  if (raw._pipeline) result._pipeline = raw._pipeline;

  // The citation must come back translated; if the structured answer left
  // it empty (or just stray ** marks), ask for that part on its own.
  const citationEn = paragraph.citation_en_md?.trim();
  if (citationEn && result.citation_vi_md.replace(/[*\s"“”]/g, '').length < 3) {
    try {
      result.citation_vi_md = cleanTranslationResult({ vietnamese_md: (await translatePlainText(citationEn)) || '' }, '', '').vietnamese_md;
    } catch {
      // Keep the paragraph translation; the citation can be retried or typed in.
    }
  }

  // Single-call results from OpenAI-style providers can still disagree
  // between the columns; re-align the bold from the result's own terms.
  const bolds = (s) => ((s || '').match(/\*\*[^*]+\*\*/g) || []).length;
  if ((hybrid || !COMPACT_PROVIDERS.includes(settings.provider)) && ALIGNABLE_PROVIDERS.includes(writer)
      && bolds(result.english_md) !== bolds(result.vietnamese_md)) {
    try {
      const terms = [...(result.new_words || []), ...(result.phrases || [])].map((i) => i.term).filter(Boolean);
      const aligned = await alignBold({ english: result.english_md, vietnamese: result.vietnamese_md, terms, config: settings[writer], providerKey: writer });
      result.english_md = aligned.english;
      result.vietnamese_md = aligned.vietnamese;
    } catch {
      // Keep the translation; bold can be repaired later from the paragraph menu.
    }
  }
  return result;
}

// Writes a translation result: the paragraph's fields and the accepted new
// vocabulary.
export function saveTranslation(paragraph, result, vocabState) {
  const seenInBatch = new Set();
  const acceptedWords = [];
  // Words the vocabulary has, explained again for a book where their
  // meaning did not hold yet: saved as that book's sense.
  const senseWords = [];
  const book = bookById(findBookIdForParagraph.get(paragraph.id)?.book_id);
  for (const w of result.new_words || []) {
    const norm = normalizeTerm(w.term || '');
    if (!norm) continue;
    if (seenInBatch.has(norm)) continue;
    if (vocabState.normalizedSet.has(norm)) {
      const info = vocabState.index?.get(norm);
      if (info && book && !knownForBook(info, book) && w.meaning_vi?.trim()) {
        seenInBatch.add(norm);
        senseWords.push({ ...w, info });
      }
      continue;
    }
    seenInBatch.add(norm);
    acceptedWords.push({ ...w, word_type: WORD_TYPES.includes(w.word_type) ? w.word_type : 'Noun' });
  }

  const dateAdded = todayISO();
  const insertedIds = [];
  const insertMany = db.transaction(() => {
    for (const w of acceptedWords) {
      const term = w.term.trim();
      const term_normalized = normalizeTerm(term);
      if (findExisting.get(term_normalized)) continue; // race safety
      const info = insertVocab.run({
        term,
        term_normalized,
        ipa: w.ipa || '',
        word_type: w.word_type,
        meaning_vi: w.meaning_vi || '',
        example: w.example || '',
        topic: isValidTopic(w.topic) ? w.topic : 'Khác',
        date_added: dateAdded,
        source_paragraph_id: paragraph.id,
      });
      if (!info.changes) continue;
      insertedIds.push(info.lastInsertRowid);
      // A term the team already decided in the glossary now has its entry.
      linkGlossary.run(info.lastInsertRowid, term_normalized);
      // Users who had it as their own word now share this one.
      absorbPrivateCopies(info.lastInsertRowid);
      vocabState.normalizedSet.add(term_normalized);
      vocabState.terms.push(term);
      vocabState.index?.set(term_normalized, { id: Number(info.lastInsertRowid), term, term_normalized, meaning: w.meaning_vi || '', bookId: book?.id ?? null, domain: book?.domain ?? '', senses: [] });
    }
    const savedSenses = [];
    for (const w of senseWords) {
      const sense = upsertSense({ vocabularyId: w.info.id, bookId: book.id, meaning_vi: w.meaning_vi, example: w.example || '' });
      if (!sense) continue;
      w.info.senses.push({ ...sense, domain: book.domain });
      savedSenses.push(w);
    }

    // Smaller local models sometimes return list items under the wrong keys;
    // drop those rather than save "**undefined**: undefined" into the notes.
    const phrasesVerbsMd = (result.phrases || [])
      .filter((p) => p?.term && p?.meaning_vi)
      .map((p) => `- **${p.term}**: ${p.meaning_vi}`)
      .join('\n');
    const vocabularyMd = [
      ...acceptedWords.map((w) => `- **${w.term}** ${w.ipa ? `${w.ipa} ` : ''}(${WORD_TYPE_ABBR[w.word_type] || w.word_type}): ${w.meaning_vi}`),
      ...savedSenses.map((w) => `- **${w.term}** ${w.ipa ? `${w.ipa} ` : ''}(${WORD_TYPE_ABBR[w.word_type] || w.word_type}): ${w.meaning_vi} *(nghĩa trong sách này)*`),
    ].join('\n');
    const citationsMd = (result.citations || [])
      .filter((c) => c?.source && c?.note)
      .map((c) => `- **${c.source}**: ${c.note}`)
      .join('\n');

    updateParagraph.run({
      id: paragraph.id,
      english_md: result.english_md || paragraph.english_md,
      vietnamese_md: result.vietnamese_md || '',
      phrases_verbs_md: phrasesVerbsMd,
      vocabulary_md: vocabularyMd,
      citations_md: citationsMd,
      // Keep a hand-written citation translation when the model returns none.
      citation_vi_md: paragraph.citation_en_md?.trim() ? (result.citation_vi_md || paragraph.citation_vi_md || '') : (paragraph.citation_vi_md || ''),
      remarks_note: result.remarks_note || '',
    });
  });
  insertMany();

  return {
    paragraph: db.prepare('SELECT * FROM paragraphs WHERE id = ?').get(paragraph.id),
    insertedWordCount: insertedIds.length,
    // how a hybrid draft was made (llm/hybridPipeline.js), warnings included
    ...(result._pipeline ? { pipeline: { ...result._pipeline, base: undefined } } : {}),
    alreadyKnown: result.already_known || [],
  };
}
