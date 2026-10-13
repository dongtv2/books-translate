// Brings one book's table of contents to the standard of server/toc.js.
//
//   npm run toc:normalize -- --book 2 [--spec server/scripts/toc-specs/art-of-dying.json]   (dry run)
//   npm run toc:normalize -- --book 2 [--spec …] --apply
//   npm run toc:normalize -- --undo <run id>
//   … --titles server/scripts/toc-titles/<book>.json   (bilingual titles, see below)
//   … --outline server/scripts/toc-outlines/<book>.json (the book's full TOC, see below)
//
// Without --spec, rules only: "PART 2:" / "CHAPTER 3:" prefixes leave the
// titles (the number is computed), leading/trailing front and back matter is
// recognized by title, a first section heading that repeats the chapter
// title is cleared, and a first paragraph that only repeats the chapter
// title becomes the chapter's English/Vietnamese title.
//
// With --spec, the book's real TOC (a JSON list of chapters, each found by the
// text its first paragraph starts with) decides where chapters and sections
// begin; worksheets that bundle several chapters are split, heading lines
// leave the paragraph text and become titles. Every spec entry must be found,
// in order, or nothing is written.
//
// --titles: a JSON of { book: { title_vi }, parts / chapters: [{ en, title_en?,
// title_vi }], sections: [{ en, heading_en?, heading_vi }] }, each entry found
// by its English title after the steps above; every entry must match.
//
// --outline: the book's complete table of contents { front: [...], parts:
// [{ title_en, title_vi, chapters: [...] }], chapters: [...], back: [...] }
// with { title_en, title_vi } per chapter. Chapters already in the book are
// found by English title and get the outline's exact title; the ones not
// imported yet are created empty (only editors see empty chapters), in
// order, so the TOC matches the printed book. Every existing chapter must be
// in the outline.
//
// Paragraph ids never change (marks, vocabulary, discussions stay attached).
// --apply takes a required backup first, writes in one transaction, logs
// every changed row (toc_changes) and checks integrity afterwards.
import 'dotenv/config';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { db } from '../db.js';
import { backupBeforeMigration } from '../backup.js';
import { CHAPTER_KINDS, BLOCK_TYPES, classifyTitle, cleanTitle, plainTitle, stripNumberPrefix, titleCase, titleKey, numberToc } from '../toc.js';

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const flag = (name) => args.includes(`--${name}`);

// ---- undo -------------------------------------------------------------------------

function undo(runId) {
  const rows = db.prepare('SELECT * FROM toc_changes WHERE run_id = ? AND undone_at IS NULL ORDER BY id DESC').all(runId);
  if (!rows.length) throw new Error(`Không có thay đổi nào của lượt ${runId} để hoàn tác.`);
  backupBeforeMigration(`trước khi hoàn tác chuẩn hoá TOC ${runId}`, { required: true });
  db.transaction(() => {
    for (const r of rows) {
      if (r.action === 'insert') db.prepare(`DELETE FROM ${r.tbl} WHERE id = ?`).run(r.row_id);
      else {
        const before = JSON.parse(r.before_json);
        const cols = Object.keys(before);
        if (r.action === 'update') db.prepare(`UPDATE ${r.tbl} SET ${cols.filter((c) => c !== 'id').map((c) => `${c} = @${c}`).join(', ')} WHERE id = @id`).run(before);
        else db.prepare(`INSERT INTO ${r.tbl} (${cols.join(', ')}) VALUES (${cols.map((c) => `@${c}`).join(', ')})`).run(before);
      }
    }
    db.prepare("UPDATE toc_changes SET undone_at = datetime('now') WHERE run_id = ?").run(runId);
  })();
  console.log(`✓ Đã hoàn tác ${rows.length} thay đổi của lượt ${runId}.`);
}

// ---- reading the book ---------------------------------------------------------------

const splitBlocks = (md) => String(md || '').split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
const joinBlocks = (blocks) => blocks.join('\n\n');

function loadBook(bookId) {
  const book = db.prepare('SELECT id, title_en FROM books WHERE id = ?').get(bookId);
  if (!book) throw new Error(`Không có sách #${bookId}.`);
  const parts = db.prepare('SELECT * FROM parts WHERE book_id = ? ORDER BY order_index').all(bookId);
  const chapters = db.prepare('SELECT * FROM chapters WHERE book_id = ? ORDER BY order_index').all(bookId);
  for (const c of chapters) {
    c.sections = db.prepare('SELECT * FROM sections WHERE chapter_id = ? ORDER BY order_index').all(c.id);
    for (const s of c.sections) s.paragraphs = db.prepare('SELECT * FROM paragraphs WHERE section_id = ? ORDER BY order_index').all(s.id);
  }
  return { book, parts, chapters };
}

// The target tree both modes produce: chapters → sections → paragraphs, each
// row carrying the fields it should end up with (and `id` when it reuses a row).
// Paragraph `strip` = how many leading English/Vietnamese blocks are heading
// text to remove; `remove` = the paragraph was only a heading.

// ---- rules mode -------------------------------------------------------------------

function headingLike(block) {
  const t = plainTitle(block);
  return t.length > 0 && t.length <= 120 && t.split(/\s+/).length <= 16 && !/[.?!,;]["”’)]*$/.test(t);
}

function planByRules({ parts, chapters }, warnings) {
  const partTargets = parts.map((p) => {
    const { title, number } = stripNumberPrefix(p.title, 'part');
    return { id: p.id, title: titleCase(title), title_vi: cleanTitle(p.title_vi), number, was: p };
  });
  const kinds = chapters.map((c) => c.kind);
  for (let i = 0; i < chapters.length && classifyTitle(stripNumberPrefix(chapters[i].title).title) === 'front' && !chapters[i].part_id; i += 1) kinds[i] = 'front';
  for (let i = chapters.length - 1; i >= 0 && classifyTitle(stripNumberPrefix(chapters[i].title).title) === 'back' && !chapters[i].part_id; i -= 1) kinds[i] = 'back';

  const targets = chapters.map((c, ci) => {
    const stripped = stripNumberPrefix(c.title, 'chapter');
    const title = titleCase(stripped.title);
    const number = stripped.number;
    const t = { id: c.id, kind: kinds[ci], title, title_vi: cleanTitle(c.title_vi), part_id: c.part_id, statedNumber: number, sections: [] };
    c.sections.forEach((s, si) => {
      let heading = s.heading ? titleCase(s.heading) : s.heading;
      // A first section heading that only repeats the chapter title.
      if (si === 0 && heading && titleKey(stripNumberPrefix(heading).title) === titleKey(title)) heading = null;
      t.sections.push({ id: s.id, heading, heading_vi: cleanTitle(s.heading_vi), paragraphs: s.paragraphs.map((p) => ({ id: p.id })) });
    });
    // A first paragraph that only repeats the chapter title.
    const first = c.sections[0]?.paragraphs[0];
    if (first) {
      const en = splitBlocks(first.english_md);
      const vi = splitBlocks(first.vietnamese_md);
      if (en.length && headingLike(en[0]) && titleKey(en[0]) === titleKey(title)) {
        const p = t.sections[0].paragraphs[0];
        p.strip = 1;
        p.remove = en.length === 1;
        if (vi.length && headingLike(vi[0]) && !t.title_vi) t.title_vi = plainTitle(vi[0]);
      }
    }
    return t;
  });
  // A stated chapter number that disagrees with the reading order is worth a look.
  const numbered = numberToc({ chapters: targets.map((t, i) => ({ ...t, order_index: i })) }).chapters;
  numbered.forEach((c) => {
    if (c.statedNumber != null && c.statedNumber !== c.number) warnings.push(`"${c.title}": tiêu đề ghi số ${c.statedNumber}, theo thứ tự là ${c.number ?? '(không đánh số)'}.`);
  });
  return { parts: partTargets, chapters: targets };
}

// ---- spec mode ----------------------------------------------------------------------

function planBySpec({ chapters }, spec, warnings) {
  const flat = chapters.flatMap((c) => c.sections.flatMap((s) => s.paragraphs.map((p) => ({ p, chapterId: c.id, sectionId: s.id }))));
  let cursor = 0;
  const find = (start, what) => {
    const key = titleKey(start);
    for (let i = cursor; i < flat.length; i += 1) {
      if (titleKey(flat[i].p.english_md).startsWith(key)) { cursor = i; return i; }
    }
    throw new Error(`Không tìm thấy ${what} bắt đầu bằng "${start}" (sau đoạn #${flat[cursor]?.p.id ?? '?'}). Kiểm tra lại spec.`);
  };
  const starts = [];
  for (const [ci, sc] of spec.chapters.entries()) {
    if (!CHAPTER_KINDS.includes(sc.kind || 'chapter')) throw new Error(`Spec chương ${ci + 1}: loại "${sc.kind}" không hợp lệ.`);
    if (sc.blockType && !BLOCK_TYPES.includes(sc.blockType)) throw new Error(`Spec chương ${ci + 1}: blockType "${sc.blockType}" không hợp lệ.`);
    const at = find(sc.start ?? sc.title_en, `chương "${sc.title_en}"`);
    if (ci === 0 && at !== 0) throw new Error(`Chương đầu tiên của spec phải bắt đầu ở đoạn đầu tiên của sách (đang ở vị trí ${at}).`);
    if (ci > 0 && at <= starts.at(-1).at) throw new Error(`Chương "${sc.title_en}" bắt đầu trước hoặc trùng chương trước.`);
    const sections = (sc.sections || []).map((ss) => ({ ss, at: (cursor += 1, find(ss.start ?? ss.heading_en, `mục "${ss.heading_en}"`)) }));
    starts.push({ sc, at, sections });
    cursor = Math.max(cursor, at) + 1;
  }

  const claimedChapters = new Set();
  const claimedSections = new Set();
  const stripFor = (entry, sc, headingBlocks) => {
    const en = splitBlocks(entry.p.english_md);
    const vi = splitBlocks(entry.p.vietnamese_md);
    const n = headingBlocks ?? 1;
    if (n === 0) return { strip: 0, vi: [] };
    if (en.length < n) throw new Error(`Đoạn #${entry.p.id} có ${en.length} khối, ít hơn ${n} dòng tiêu đề của "${sc}".`);
    if (en.slice(0, n).some((b) => !headingLike(b))) warnings.push(`Đoạn #${entry.p.id}: dòng bỏ đi không giống tiêu đề: ${JSON.stringify(en.slice(0, n).map((b) => b.slice(0, 60)))}`);
    if (vi.length && vi.slice(0, n).some((b) => !headingLike(b))) warnings.push(`Đoạn #${entry.p.id}: dòng tiếng Việt bỏ đi không giống tiêu đề — kiểm tra bản dịch.`);
    return { strip: n, remove: en.length === n, vi: vi.slice(0, n).map((b) => plainTitle(b).replace(/:$/, '')) };
  };

  const targets = starts.map(({ sc, at, sections }, i) => {
    const end = i + 1 < starts.length ? starts[i + 1].at : flat.length;
    const head = flat[at];
    const reuseChapter = !claimedChapters.has(head.chapterId) ? head.chapterId : null;
    if (reuseChapter) claimedChapters.add(reuseChapter);
    const h = stripFor(head, sc.title_en, sc.headingBlocks);
    const t = {
      id: reuseChapter, kind: sc.kind || 'chapter', title: sc.title_en, title_vi: cleanTitle(sc.title_vi ?? h.vi.join(': ')),
      part_id: null, sections: [],
    };
    const bounds = [{ at, heading: null, heading_vi: '', h }, ...sections.map(({ ss, at: sat }) => {
      if (sat >= end) throw new Error(`Mục "${ss.heading_en}" nằm ngoài chương "${sc.title_en}".`);
      const sh = stripFor(flat[sat], ss.heading_en, ss.headingBlocks);
      return { at: sat, heading: ss.heading_en, heading_vi: ss.heading_vi ?? sh.vi.join(': '), h: sh };
    })];
    bounds.forEach((b, bi) => {
      const bEnd = bi + 1 < bounds.length ? bounds[bi + 1].at : end;
      const reuseSection = !claimedSections.has(flat[b.at].sectionId) && flat[b.at].chapterId === reuseChapter ? flat[b.at].sectionId : null;
      if (reuseSection) claimedSections.add(reuseSection);
      const paragraphs = flat.slice(b.at, bEnd).map((e, k) => ({
        id: e.p.id,
        ...(k === 0 && b.h.strip ? { strip: b.h.strip, remove: b.h.remove } : {}),
        ...(sc.blockType ? { block_type: sc.blockType } : {}),
      }));
      t.sections.push({ id: reuseSection, heading: b.heading, heading_vi: b.heading_vi, paragraphs });
    });
    return t;
  });
  return { parts: [], chapters: targets };
}

// ---- bilingual titles -----------------------------------------------------------------

function applyTitles(plan, titles) {
  const missing = [];
  const pick = (list, label, key, apply) => {
    for (const entry of titles[label] || []) {
      const hits = list.filter((x) => x[key] && titleKey(x[key]) === titleKey(entry.en));
      if (hits.length !== 1) { missing.push(`${label}: "${entry.en}" (${hits.length} kết quả)`); continue; }
      apply(hits[0], entry);
    }
  };
  pick(plan.parts, 'parts', 'title', (p, e) => { if (e.title_en) p.title = cleanTitle(e.title_en); p.title_vi = cleanTitle(e.title_vi); });
  pick(plan.chapters, 'chapters', 'title', (c, e) => { if (e.title_en) c.title = cleanTitle(e.title_en); c.title_vi = cleanTitle(e.title_vi); });
  pick(plan.chapters.flatMap((c) => c.sections), 'sections', 'heading', (s, e) => { if (e.heading_en) s.heading = cleanTitle(e.heading_en); s.heading_vi = cleanTitle(e.heading_vi); });
  if (missing.length) throw new Error(`File tiêu đề không khớp:\n  - ${missing.join('\n  - ')}`);
  plan.book = titles.book || null;
}

// ---- full outline ---------------------------------------------------------------------

function applyOutline(plan, outline) {
  const byKey = new Map(plan.chapters.map((c) => [titleKey(c.title), c]));
  const partsByKey = new Map(plan.parts.map((p) => [titleKey(p.title), p]));
  const used = new Set();
  const chapters = [];
  const take = (entry, kind, partKey) => {
    const keys = [entry.title_en, ...(entry.match || [])].map(titleKey);
    const hit = keys.map((k) => byKey.get(k)).find(Boolean);
    if (hit && used.has(hit)) throw new Error(`Chương "${entry.title_en}" xuất hiện hai lần trong outline.`);
    const c = hit || { id: null, sections: [{ id: null, heading: null, heading_vi: '', paragraphs: [] }] };
    if (hit) used.add(hit);
    Object.assign(c, { kind, title: cleanTitle(entry.title_en), title_vi: cleanTitle(entry.title_vi ?? c.title_vi ?? ''), part_id: partKey });
    chapters.push(c);
  };
  for (const e of outline.front || []) take(e, 'front', null);
  const parts = (outline.parts || []).map((op, i) => {
    const hit = [op.title_en, ...(op.match || [])].map(titleKey).map((k) => partsByKey.get(k)).find(Boolean);
    const p = hit || { id: null, was: null };
    Object.assign(p, { key: p.id ?? `new-part-${i}`, title: cleanTitle(op.title_en), title_vi: cleanTitle(op.title_vi ?? p.title_vi ?? '') });
    for (const e of op.chapters || []) take(e, 'chapter', p.key);
    return p;
  });
  for (const e of outline.chapters || []) take(e, 'chapter', null);
  for (const e of outline.back || []) take(e, 'back', null);
  const left = plan.chapters.filter((c) => !used.has(c));
  if (left.length) throw new Error(`Các chương sau có trong sách nhưng không có trong outline: ${left.map((c) => `"${c.title}"`).join(', ')}.`);
  const partsLeft = plan.parts.filter((p) => !parts.includes(p));
  if (partsLeft.length) throw new Error(`Các phần sau có trong sách nhưng không có trong outline: ${partsLeft.map((p) => `"${p.title}"`).join(', ')}.`);
  plan.parts = parts;
  plan.chapters = chapters;
}

// ---- applying a plan --------------------------------------------------------------

function apply(bookId, current, plan, runId) {
  const log = db.prepare('INSERT INTO toc_changes (run_id, book_id, tbl, row_id, action, before_json, note) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const row = (tbl, id) => db.prepare(`SELECT * FROM ${tbl} WHERE id = ?`).get(id);
  const stats = { insert: 0, update: 0, delete: 0 };
  const changed = (before, after) => Object.keys(after).some((k) => (before[k] ?? null) !== (after[k] ?? null));
  function update(tbl, id, fields, note = '') {
    const before = row(tbl, id);
    if (!changed(before, fields)) return;
    log.run(runId, bookId, tbl, id, 'update', JSON.stringify(before), note);
    db.prepare(`UPDATE ${tbl} SET ${Object.keys(fields).map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`).run({ ...fields, id });
    stats.update += 1;
  }
  function insert(tbl, fields, note = '') {
    const id = db.prepare(`INSERT INTO ${tbl} (${Object.keys(fields).join(', ')}) VALUES (${Object.keys(fields).map((k) => `@${k}`).join(', ')})`).run(fields).lastInsertRowid;
    log.run(runId, bookId, tbl, id, 'insert', null, note);
    stats.insert += 1;
    return id;
  }
  function remove(tbl, id, note = '') {
    log.run(runId, bookId, tbl, id, 'delete', JSON.stringify(row(tbl, id)), note);
    db.prepare(`DELETE FROM ${tbl} WHERE id = ?`).run(id);
    stats.delete += 1;
  }
  // Rows elsewhere that point at a paragraph's chapter/section move with it.
  // (A reading position, user_reading, is not blocking: its paragraph_id
  // falls back to NULL — the start of the chapter — when that row goes.)
  const followers = [
    ['term_threads', ['chapter_id', 'section_id']],
    ['work_assignments', ['chapter_id', 'section_id']],
  ].filter(([t]) => db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t));
  const references = (pid) => [
    ['vocabulary', 'source_paragraph_id'], ['term_threads', 'paragraph_id'], ['work_assignments', 'paragraph_id'],
    ['paragraph_marks', 'paragraph_id'], ['assistant_messages', 'paragraph_id'],
  ].filter(([t]) => db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t))
    .reduce((n, [t, c]) => n + db.prepare(`SELECT COUNT(*) AS c FROM ${t} WHERE ${c} = ?`).get(pid).c, 0);

  if (plan.book?.title_vi !== undefined) update('books', bookId, { title_vi: cleanTitle(plan.book.title_vi) }, 'tên sách tiếng Việt');
  // Parts in plan order; a new part (from an outline) is created here. A
  // chapter's part_id in the plan is the part's id or its temporary key.
  const partIds = new Map();
  plan.parts.forEach((p, i) => {
    if (!p.id) {
      p.id = insert('parts', { book_id: bookId, order_index: i, title: p.title, title_vi: p.title_vi || '' }, 'phần mới theo mục lục gốc');
    } else {
      update('parts', p.id, {
        title: p.title, title_vi: p.title_vi || '', order_index: i,
        title_original: p.title !== p.was.title ? (p.was.title_original ?? p.was.title) : p.was.title_original,
      }, 'phần');
    }
    partIds.set(p.key ?? p.id, p.id);
  });

  const keepChapters = new Set();
  const keepSections = new Set();
  plan.chapters.forEach((c, ci) => {
    const was = c.id ? row('chapters', c.id) : null;
    const fields = { kind: c.kind, title: c.title, title_vi: c.title_vi || '', part_id: c.part_id == null ? null : partIds.get(c.part_id) ?? c.part_id, order_index: ci };
    if (was) update('chapters', c.id, { ...fields, title_original: was.title !== c.title ? (was.title_original ?? was.title) : was.title_original }, 'chương');
    else c.id = insert('chapters', { book_id: bookId, ...fields }, 'chương mới');
    keepChapters.add(c.id);

    c.sections.forEach((s, si) => {
      const sWas = s.id ? row('sections', s.id) : null;
      const sFields = { chapter_id: c.id, order_index: si, heading: s.heading ?? null, heading_vi: s.heading_vi || '' };
      if (sWas) update('sections', s.id, { ...sFields, heading_original: sWas.heading !== sFields.heading ? (sWas.heading_original ?? sWas.heading) : sWas.heading_original }, 'mục');
      else s.id = insert('sections', sFields, 'mục mới');
      keepSections.add(s.id);

      let order = 0;
      for (const p of s.paragraphs) {
        const pWas = row('paragraphs', p.id);
        if (p.remove) {
          if (references(p.id)) throw new Error(`Đoạn #${p.id} chỉ là tiêu đề nhưng đang được tham chiếu (đánh dấu, từ vựng, thảo luận…); hãy xử lý tay.`);
          remove('paragraphs', p.id, 'đoạn chỉ chứa tiêu đề');
          continue;
        }
        const fields = { section_id: s.id, order_index: order };
        order += 1;
        if (p.strip) {
          fields.english_md = joinBlocks(splitBlocks(pWas.english_md).slice(p.strip));
          fields.vietnamese_md = joinBlocks(splitBlocks(pWas.vietnamese_md).slice(p.strip));
        }
        if (p.block_type) fields.block_type = p.block_type;
        update('paragraphs', p.id, fields, p.strip ? 'bỏ dòng tiêu đề khỏi đoạn' : 'đoạn');
        if (pWas.section_id !== s.id) {
          for (const [t, cols] of followers) {
            for (const r of db.prepare(`SELECT id FROM ${t} WHERE paragraph_id = ?`).all(p.id)) {
              update(t, r.id, Object.fromEntries(cols.map((col) => [col, col === 'chapter_id' ? c.id : s.id])), 'đi theo đoạn văn');
            }
          }
        }
      }
    });
  });
  // Sections and chapters whose paragraphs all moved elsewhere.
  for (const c of current.chapters) {
    for (const s of c.sections) if (!keepSections.has(s.id)) remove('sections', s.id, 'mục rỗng sau khi chuẩn hoá');
  }
  for (const c of current.chapters) if (!keepChapters.has(c.id)) remove('chapters', c.id, 'chương rỗng sau khi chuẩn hoá');
  return stats;
}

// ---- report -------------------------------------------------------------------------

function report(plan, current) {
  const { chapters } = numberToc({ chapters: plan.chapters.map((c, i) => ({ ...c, id: c.id ?? `new${i}`, order_index: i })) });
  const lines = [];
  const partOf = new Map(plan.parts.map((p, i) => [p.key ?? p.id, `Phần ${i + 1}  ${p.title}${p.title_vi ? `  —  ${p.title_vi}` : ''}${!p.was ? '  [mới]' : p.title !== p.was.title ? `   (trước: "${p.was.title}")` : ''}`]));
  let lastKind = null;
  let lastPart = null;
  for (const c of chapters) {
    if (c.kind !== lastKind) { lines.push(`\n  ── ${{ front: 'PHẦN ĐẦU SÁCH', chapter: 'THÂN SÁCH', back: 'PHẦN CUỐI SÁCH' }[c.kind]} ──`); lastKind = c.kind; }
    if ((c.part_id ?? null) !== lastPart) { if (c.part_id) lines.push(`  ${partOf.get(c.part_id) ?? `Phần #${c.part_id}`}`); lastPart = c.part_id ?? null; }
    const n = c.sections.reduce((k, s) => k + s.paragraphs.filter((p) => !p.remove).length, 0);
    lines.push(`  ${(c.number ? `Chương ${c.number}` : '').padEnd(10)} ${c.title}${c.title_vi ? `  —  ${c.title_vi}` : ''}  (${n} đoạn)${String(c.id).startsWith('new') ? '  [mới]' : ''}`);
    if (c.number && c.statedNumber != null && c.statedNumber !== c.number) lines.push(`  ${''.padEnd(10)}   ⚠ tiêu đề cũ ghi số ${c.statedNumber}`);
    for (const s of c.sections) if (s.heading) lines.push(`  ${''.padEnd(10)}   · ${s.heading}${s.heading_vi ? `  —  ${s.heading_vi}` : ''}`);
  }
  const all = plan.chapters.flatMap((c) => c.sections.flatMap((s) => s.paragraphs));
  const before = current.chapters.reduce((k, c) => k + c.sections.reduce((m, s) => m + s.paragraphs.length, 0), 0);
  lines.push(`\n  Chương: ${current.chapters.length} → ${plan.chapters.length}. Đoạn: ${before} → ${all.filter((p) => !p.remove).length} (${all.filter((p) => p.remove).length} đoạn chỉ là tiêu đề bị bỏ, ${all.filter((p) => p.strip && !p.remove).length} đoạn được bỏ dòng tiêu đề).`);
  if (all.length !== before) throw new Error(`Kế hoạch có ${all.length} đoạn, sách có ${before} — spec bỏ sót đoạn.`);
  return lines.join('\n');
}

// ---- main ---------------------------------------------------------------------------

try {
  if (opt('undo')) { undo(opt('undo')); process.exit(0); }
  const bookId = Number(opt('book'));
  if (!bookId) throw new Error('Dùng: --book <id> [--spec file.json] [--apply]  hoặc  --undo <run id>');
  const current = loadBook(bookId);
  const warnings = [];
  const plan = opt('spec')
    ? planBySpec(current, JSON.parse(fs.readFileSync(opt('spec'), 'utf8')), warnings)
    : planByRules(current, warnings);
  if (opt('outline')) applyOutline(plan, JSON.parse(fs.readFileSync(opt('outline'), 'utf8')));
  if (opt('titles')) applyTitles(plan, JSON.parse(fs.readFileSync(opt('titles'), 'utf8')));
  console.log(`Sách #${bookId}: ${current.book.title_en}${opt('spec') ? `  (spec: ${opt('spec')})` : '  (quy tắc)'}`);
  console.log(report(plan, current));
  if (warnings.length) console.log(`\n  Cần xem lại:\n  - ${warnings.join('\n  - ')}`);

  if (!flag('apply')) { console.log('\n(Chạy thử — chưa ghi gì. Thêm --apply để áp dụng.)'); process.exit(0); }
  const backup = backupBeforeMigration(`trước khi chuẩn hoá TOC sách #${bookId}`, { required: true });
  const runId = `toc-${bookId}-${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}-${crypto.randomBytes(2).toString('hex')}`;
  const stats = db.transaction(() => apply(bookId, current, plan, runId))();
  const integrity = db.pragma('integrity_check', { simple: true });
  const fk = db.pragma('foreign_key_check');
  console.log(`\n✓ Đã áp dụng (lượt ${runId}): ${stats.update} sửa, ${stats.insert} thêm, ${stats.delete} xoá. Backup: ${backup?.name}.`);
  console.log(`  integrity_check: ${integrity}; foreign_key_check: ${fk.length ? JSON.stringify(fk.slice(0, 5)) : 'ok'}`);
  console.log(`  Hoàn tác: npm run toc:normalize -- --undo ${runId}`);
} catch (err) {
  console.error(`✗ ${err.message}`);
  process.exit(1);
}
