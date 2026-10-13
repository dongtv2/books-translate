import { db } from '../db.js';
import { DEFAULT_SYSTEM_PROMPT } from './prompt.js';

function ensureAtLeastOneTemplate() {
  const count = db.prepare('SELECT COUNT(*) AS c FROM prompt_templates').get().c;
  if (count === 0) {
    db.prepare('INSERT INTO prompt_templates (name, content, is_default) VALUES (?, ?, 1)')
      .run('Mặc định', DEFAULT_SYSTEM_PROMPT);
  }
}

export function listPromptTemplates() {
  ensureAtLeastOneTemplate();
  return db.prepare('SELECT * FROM prompt_templates ORDER BY is_default DESC, id ASC').all();
}

export function getPromptTemplate(id) {
  return db.prepare('SELECT * FROM prompt_templates WHERE id = ?').get(id);
}

export function createPromptTemplate({ name, content }) {
  const cleanName = (name || '').trim();
  const cleanContent = (content || '').trim();
  if (!cleanName) throw new Error('Thiếu tên prompt.');
  if (!cleanContent) throw new Error('Thiếu nội dung prompt.');
  const info = db.prepare('INSERT INTO prompt_templates (name, content, is_default) VALUES (?, ?, 0)')
    .run(cleanName, cleanContent);
  return getPromptTemplate(info.lastInsertRowid);
}

export function updatePromptTemplate(id, { name, content }) {
  const existing = getPromptTemplate(id);
  if (!existing) throw new Error('Không tìm thấy prompt.');
  const nextName = name != null ? name.trim() : existing.name;
  const nextContent = content != null ? content.trim() : existing.content;
  if (!nextName) throw new Error('Thiếu tên prompt.');
  if (!nextContent) throw new Error('Thiếu nội dung prompt.');
  db.prepare(`UPDATE prompt_templates SET name = ?, content = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(nextName, nextContent, id);
  return getPromptTemplate(id);
}

export function deletePromptTemplate(id) {
  const all = listPromptTemplates();
  const target = all.find((t) => t.id === Number(id));
  if (!target) throw new Error('Không tìm thấy prompt.');
  if (all.length <= 1) throw new Error('Phải còn ít nhất 1 prompt trong danh sách.');
  if (target.is_default) throw new Error('Không thể xoá prompt mặc định — hãy đặt prompt khác làm mặc định trước.');
  db.prepare('DELETE FROM prompt_templates WHERE id = ?').run(id);
}

export function setDefaultPromptTemplate(id) {
  const target = getPromptTemplate(id);
  if (!target) throw new Error('Không tìm thấy prompt.');
  db.transaction(() => {
    db.prepare('UPDATE prompt_templates SET is_default = 0').run();
    db.prepare('UPDATE prompt_templates SET is_default = 1 WHERE id = ?').run(id);
  })();
  return getPromptTemplate(id);
}

export function getDefaultPromptTemplate() {
  ensureAtLeastOneTemplate();
  return db.prepare('SELECT * FROM prompt_templates WHERE is_default = 1').get()
    || db.prepare('SELECT * FROM prompt_templates ORDER BY id ASC LIMIT 1').get();
}

// Resolves the prompt text to actually send to the AI for a given book:
// the book's assigned template if it has one, otherwise the library's
// default template, otherwise the hardcoded fallback constant.
export function getEffectivePromptForBook(bookId) {
  if (bookId) {
    const book = db.prepare('SELECT prompt_template_id FROM books WHERE id = ?').get(bookId);
    if (book?.prompt_template_id) {
      const tpl = getPromptTemplate(book.prompt_template_id);
      if (tpl) return tpl.content;
    }
  }
  const def = getDefaultPromptTemplate();
  return def?.content || DEFAULT_SYSTEM_PROMPT;
}
