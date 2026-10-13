// The translation assistant: a chat about one paragraph, per user. The user
// asks questions, runs a built-in analysis skill, or asks for changes; when
// the AI proposes a new Vietnamese translation it is kept as a revision
// (before/after) that someone with books.edit approves or rejects. Nothing
// the AI writes reaches the paragraph without that approval.
import { db } from './db.js';
import { chatText } from './llm/chat.js';
import { bookContextText, bookOfParagraph } from './bookContext.js';
import { glossaryFor } from './discussions.js';
import { containsTerm } from '../src/lib/vocabMatch.js';
import { plainText } from '../src/lib/inlineMarkdown.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS assistant_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    paragraph_id INTEGER NOT NULL REFERENCES paragraphs(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content TEXT NOT NULL DEFAULT '',
    skill TEXT,
    revision_before TEXT,
    revision_after TEXT,
    revision_status TEXT CHECK (revision_status IN ('pending', 'approved', 'rejected', 'reverted')),
    decided_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_assistant_thread ON assistant_messages(user_id, paragraph_id, id);
`);

// Built-in analysis skills. `prompt` is what the AI is asked; `revises`
// says whether the skill may come back with a proposed translation.
export const SKILLS = [
  {
    key: 'accuracy',
    label: 'Kiểm tra độ chính xác',
    description: 'Tìm chỗ dịch sai nghĩa, bỏ sót hoặc thêm ý',
    revises: true,
    prompt: 'Đối chiếu từng câu của bản dịch với bản gốc. Liệt kê các chỗ (1) dịch sai nghĩa, (2) bỏ sót ý, (3) thêm ý không có trong gốc. Mỗi mục: trích EN → VI, nêu vấn đề, cách sửa ngắn gọn. Cuối cùng chấm độ chính xác trên thang 10. Nếu có lỗi, đưa bản dịch đã sửa trong <revision>.',
  },
  {
    key: 'natural',
    label: 'Văn phong tự nhiên',
    description: 'Viết lại cho trôi chảy như người Việt viết',
    revises: true,
    prompt: 'Viết lại bản dịch cho tự nhiên, trôi chảy như người Việt viết: tránh dịch từng chữ, câu bị động gượng, từ Hán Việt nặng nề không cần thiết; giữ đúng và đủ ý gốc. Nêu 3–5 thay đổi chính, rồi đưa bản mới trong <revision>.',
  },
  {
    key: 'terms',
    label: 'Thuật ngữ nhất quán',
    description: 'Đối chiếu với bảng thuật ngữ trong kho',
    revises: true,
    prompt: 'Kiểm tra các thuật ngữ và cụm từ quan trọng trong đoạn: đã dịch thống nhất với bảng thuật ngữ chưa, có thuật ngữ nào bị dịch mỗi chỗ một kiểu không. Liệt kê: **thuật ngữ** — cách dịch hiện tại — đề xuất. Nếu cần sửa, đưa bản đã sửa trong <revision>.',
  },
  {
    key: 'intent',
    label: 'Ý tác giả & giọng văn',
    description: 'Tác giả muốn nói gì, bản dịch giữ được giọng chưa',
    revises: true,
    prompt: 'Phân tích: tác giả muốn nói điều gì ở đoạn này, lập luận ra sao, giọng văn thế nào (trang trọng, ấm áp, cảnh báo, mỉa mai…). Sau đó đánh giá bản dịch có giữ được ý và giọng đó không. Nếu chưa, đưa bản dịch điều chỉnh trong <revision>.',
  },
  {
    key: 'explain',
    label: 'Giải thích câu khó',
    description: 'Thành ngữ, ẩn dụ, cấu trúc ngữ pháp phức tạp',
    revises: false,
    prompt: 'Chọn 2–4 câu hoặc cụm khó nhất trong đoạn gốc (thành ngữ, ẩn dụ, cấu trúc phức tạp). Với mỗi cái: trích nguyên văn, phân tích cấu trúc, giải nghĩa, và cho biết bản dịch hiện tại đã truyền tải đúng chưa. Không đề xuất bản dịch mới.',
  },
  {
    key: 'vocab',
    label: 'Từ vựng đáng học',
    description: 'Cụm động từ, collocation, thành ngữ nên nhớ',
    revises: false,
    prompt: 'Chọn 4–6 từ hoặc cụm từ tiếng Anh đáng học nhất trong đoạn (ưu tiên cụm động từ, collocation, thành ngữ). Mỗi mục một dòng: **từ** /IPA/ (loại từ): nghĩa trong ngữ cảnh — thêm một ví dụ ngắn khác. Không đề xuất bản dịch mới.',
  },
  {
    key: 'summary',
    label: 'Tóm tắt ý chính',
    description: '2–4 ý và một câu cốt lõi',
    revises: false,
    prompt: 'Tóm tắt đoạn trong 2–4 gạch đầu dòng tiếng Việt, mỗi dòng một ý, rồi một câu "Ý cốt lõi: …". Không đề xuất bản dịch mới.',
  },
];

// Not shown as a chip: the "Áp dụng góp ý" button under an analysis turns
// that analysis into a proposed translation.
const APPLY_SKILL = { key: 'apply', label: 'Áp dụng góp ý vào bản dịch', revises: true, prompt: '' };

// A free-text message asking for a change (rather than a question).
const CHANGE_REQUEST = /(sửa|dịch lại|viết lại|đổi|thay|bổ sung|thêm|bỏ|lược|rút gọn|chỉnh|trau chuốt|trang trọng|tự nhiên|ngắn gọn|mượt|gọn)/i;

const HISTORY_LIMIT = 10;
const REVISION_STATE = { pending: 'chờ duyệt', approved: 'đã áp dụng', rejected: 'đã bỏ qua', reverted: 'đã hoàn tác' };

const words = (s) => plainText(s).toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];

// The reply often repeats the proposed paragraph in full; that copy is
// dropped (it is shown as the proposal), with the line introducing it.
function stripRepeatedRevision(reply, revision) {
  if (!revision) return reply;
  const rev = new Set(words(revision));
  const blocks = reply.split(/\n\s*\n/);
  const kept = blocks.filter((b) => {
    const w = words(b);
    if (w.length < 12) return true;
    const shared = w.filter((x) => rev.has(x)).length;
    return !(shared / w.length > 0.85 && w.length > rev.size * 0.5);
  });
  while (kept.length && /:\s*$/.test(kept[kept.length - 1].trim())) kept.pop();
  return kept.join('\n\n').trim();
}
const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);

function paragraphContext(paragraphId) {
  const p = db.prepare(`
    SELECT p.*, s.chapter_id, s.order_index AS section_order, c.title AS chapter_title, b.title_en, b.title_vi, b.domain, b.specialty, b.context_note
    FROM paragraphs p JOIN sections s ON s.id = p.section_id JOIN chapters c ON c.id = s.chapter_id JOIN books b ON b.id = c.book_id
    WHERE p.id = ?
  `).get(paragraphId);
  if (!p) return null;
  const neighbours = db.prepare(`
    SELECT p.id, p.english_md FROM paragraphs p JOIN sections s ON s.id = p.section_id
    WHERE s.chapter_id = ? ORDER BY s.order_index, p.order_index
  `).all(p.chapter_id);
  const i = neighbours.findIndex((n) => n.id === p.id);
  const english = plainText(p.english_md);
  // Terms the team decided come first and are marked as binding; the
  // vocabulary fills in the rest.
  const decided = glossaryFor(bookOfParagraph(paragraphId)?.id, p.english_md);
  const decidedKeys = new Set(decided.map((g) => g.term_normalized));
  const glossary = [
    ...decided.map((g) => ({ term: g.term, meaning_vi: `${g.meaning_vi} (nhóm dịch đã chốt, bắt buộc dùng)` })),
    ...db.prepare('SELECT term, term_normalized, meaning_vi FROM vocabulary WHERE owner_id IS NULL').all()
      .filter((v) => !decidedKeys.has(v.term_normalized) && containsTerm(english, v.term)),
  ].slice(0, 40);
  return {
    paragraph: p,
    before: i > 0 ? plainText(neighbours[i - 1].english_md) : '',
    after: i >= 0 && i < neighbours.length - 1 ? plainText(neighbours[i + 1].english_md) : '',
    glossary,
  };
}

function systemPrompt(ctx) {
  const { paragraph: p, before, after, glossary } = ctx;
  return `Bạn là trợ lý biên dịch Anh → Việt, làm việc cùng người dịch trên MỘT đoạn văn của cuốn sách "${p.title_en}"${p.title_vi ? ` (bản Việt: "${p.title_vi}")` : ''}, chương "${p.chapter_title}".
${bookContextText(p) ? `${bookContextText(p)}\n` : ''}Bạn trả lời câu hỏi, phân tích bản dịch, và khi được yêu cầu thì đề xuất bản dịch mới.

Quy tắc:
- Trả lời bằng tiếng Việt, ngắn gọn, đi thẳng vào ý. Liệt kê bằng gạch đầu dòng "- ". Dùng **đậm** cho từ hoặc cụm từ đang bàn.
- Khi chỉ ra lỗi, trích đúng câu chữ: EN "…" → VI "…".
- Chỉ khi người dùng yêu cầu sửa/dịch lại/bổ sung, hoặc khi phân tích cho thấy cần sửa, thì đặt TOÀN BỘ đoạn tiếng Việt đã sửa giữa <revision> và </revision> ở cuối câu trả lời. Chỉ một khối; bên trong chỉ có bản dịch, không giải thích.
- Bản đề xuất dịch đủ ý, không thêm ý; giữ định dạng **đậm**/*nghiêng* ở các cụm tương ứng như bản hiện tại; giữ cách dịch thuật ngữ trong bảng thuật ngữ trừ khi được yêu cầu đổi.
- Không bịa thông tin ngoài nội dung được cung cấp.

ĐOẠN GỐC (tiếng Anh):
${p.english_md}

BẢN DỊCH HIỆN TẠI:
${p.vietnamese_md?.trim() || '(chưa có bản dịch)'}
${before ? `\nĐoạn ngay trước (để hiểu ngữ cảnh): ${clip(before, 500)}` : ''}${after ? `\nĐoạn ngay sau: ${clip(after, 500)}` : ''}${glossary.length ? `\n\nBẢNG THUẬT NGỮ (đã dùng trong sách):\n${glossary.map((g) => `- ${g.term} = ${g.meaning_vi}`).join('\n')}` : ''}${p.remarks_note?.trim() ? `\n\nGHI CHÚ CỦA NGƯỜI DỊCH: ${p.remarks_note.trim()}` : ''}`;
}

// Splits the AI's answer into the reply shown in chat and an optional
// proposed translation.
const REVISION_HEADING = /\n\s*\**(?:bản dịch (?:đã |được )?(?:sửa|đề xuất|mới|chỉnh sửa|hoàn chỉnh)(?: lại)?|đề xuất bản dịch)\s*:?\**\s*:?\s*\n/i;

export function cleanRevision(text) {
  return String(text || '').trim()
    .replace(/^```\w*\n?|```$/g, '').trim()
    .replace(/^(?:\**\s*bản dịch[^:\n]{0,30}:\s*\**\s*\n?)/i, '')
    .replace(/^["“](.*)["”]$/s, '$1').trim();
}

export function parseAnswer(text, current) {
  const m = text.match(/<revision>([\s\S]*?)(?:<\/revision>|$)/i);
  let reply = text.replace(/<revision>[\s\S]*?(?:<\/revision>|$)/i, '').trim();
  let revision = m ? cleanRevision(m[1]) : '';
  // Smaller models often ignore the tags and write "Bản dịch sửa:" followed
  // by the paragraph instead.
  if (!revision) {
    const h = reply.match(REVISION_HEADING);
    if (h) {
      revision = cleanRevision(reply.slice(h.index + h[0].length));
      reply = reply.slice(0, h.index).trim();
    }
  }
  if (!revision || revision === (current || '').trim()) revision = '';
  return { reply: reply || (revision ? 'Đây là bản dịch đề xuất.' : ''), revision };
}

export function listMessages(userId, paragraphId) {
  return db.prepare('SELECT * FROM assistant_messages WHERE user_id = ? AND paragraph_id = ? ORDER BY id')
    .all(userId, paragraphId);
}

const insert = db.prepare(`
  INSERT INTO assistant_messages (paragraph_id, user_id, role, content, skill, revision_before, revision_after, revision_status)
  VALUES (@paragraph_id, @user_id, @role, @content, @skill, @revision_before, @revision_after, @revision_status)
`);
const getMessage = (id) => db.prepare('SELECT * FROM assistant_messages WHERE id = ?').get(id);

// One turn: stores the user's message (free text or a skill), asks the AI
// with the paragraph as context and the recent conversation, stores and
// returns both messages.
export async function ask({ userId, paragraphId, message = '', skill = '' }) {
  const ctx = paragraphContext(paragraphId);
  if (!ctx) throw Object.assign(new Error('Không tìm thấy đoạn văn.'), { status: 404 });
  const skillDef = skill === APPLY_SKILL.key ? APPLY_SKILL : SKILLS.find((s) => s.key === skill);
  const text = String(message || '').trim();
  if (!skillDef && !text) throw Object.assign(new Error('Hãy nhập câu hỏi hoặc chọn một kỹ năng.'), { status: 400 });

  // Earlier proposals are summarised, not repeated: given the full text, a
  // small model tends to copy it back into every later answer. The current
  // translation (with any approved change) is in the system prompt.
  const thread = listMessages(userId, paragraphId);
  const history = thread.slice(-HISTORY_LIMIT).map((m) => ({
    role: m.role,
    content: m.role === 'assistant' && m.revision_after
      ? `${m.content}\n[Đã đề xuất một bản dịch mới — ${REVISION_STATE[m.revision_status] || 'chờ duyệt'}.]`
      : m.content,
  }));
  // Small models forget the output format over a long system prompt, so it
  // is repeated at the end of each turn.
  const reminder = skillDef && !skillDef.revises
    ? ''
    : '\n\n(Nếu đề xuất bản dịch mới hoặc sửa bản dịch, đặt TOÀN BỘ đoạn tiếng Việt đã sửa giữa <revision> và </revision> ở cuối câu trả lời.)';
  const userContent = `${skillDef ? `${skillDef.prompt}${text ? `\nYêu cầu thêm: ${text}` : ''}` : text}${reminder}`;
  const system = systemPrompt(ctx);
  const current = ctx.paragraph.vietnamese_md || '';
  let reply = '';
  let revision = '';
  let turn = [...history];

  if (skillDef !== APPLY_SKILL) {
    const answer = await chatText({ system, messages: [...history, { role: 'user', content: userContent }] });
    if (!answer) throw Object.assign(new Error('AI không trả lời. Thử lại sau.'), { status: 502 });
    ({ reply, revision } = parseAnswer(answer, current));
    turn = [...history, { role: 'user', content: userContent }, { role: 'assistant', content: answer }];
  }

  // Proposals are taken only where one can be expected: a revising skill, or
  // a message asking for a change. A plain question gets an answer; the
  // "Áp dụng góp ý" button can still turn it into a proposal.
  const wantsRevision = skillDef === APPLY_SKILL || skillDef?.key === 'natural' || (!skillDef && CHANGE_REQUEST.test(text));
  if (!wantsRevision && !skillDef?.revises) revision = '';
  // …and not a copy of one already proposed in this thread.
  if (revision && thread.some((m) => m.revision_after?.trim() === revision.trim())) revision = '';

  // A change was asked for but the answer carried no full paragraph: ask for
  // just the revised paragraph, in a call of its own.
  if (!revision && wantsRevision) {
    const rewritten = await chatText({
      system,
      temperature: 0.2,
      messages: [...turn, {
        role: 'user',
        content: 'Bây giờ viết lại TOÀN BỘ đoạn tiếng Việt, áp dụng đúng những thay đổi đã nêu ở trên; phần không cần đổi thì giữ nguyên từng chữ. Chỉ trả về đoạn văn, không tiêu đề, không giải thích, không dấu ngoặc kép bao quanh.',
      }],
    });
    revision = cleanRevision(rewritten);
    if (revision.trim() === current.trim()) revision = '';
    if (!reply) reply = revision ? 'Đây là bản dịch đã áp dụng các góp ý.' : 'Không có thay đổi nào cần áp dụng vào bản dịch.';
  }
  reply = stripRepeatedRevision(reply, revision) || (revision ? 'Đây là bản dịch đề xuất.' : reply);
  const ids = db.transaction(() => {
    const u = insert.run({
      paragraph_id: paragraphId, user_id: userId, role: 'user',
      content: skillDef ? (text ? `${skillDef.label}: ${text}` : skillDef.label) : text,
      skill: skillDef?.key || null, revision_before: null, revision_after: null, revision_status: null,
    }).lastInsertRowid;
    const a = insert.run({
      paragraph_id: paragraphId, user_id: userId, role: 'assistant', content: reply, skill: skillDef?.key || null,
      revision_before: revision ? current : null, revision_after: revision || null, revision_status: revision ? 'pending' : null,
    }).lastInsertRowid;
    return [u, a];
  })();
  return ids.map(getMessage);
}

function ownRevision(userId, paragraphId, messageId) {
  const m = getMessage(messageId);
  if (!m || m.user_id !== userId || m.paragraph_id !== paragraphId || !m.revision_after) {
    throw Object.assign(new Error('Không tìm thấy bản đề xuất.'), { status: 404 });
  }
  return m;
}

const setRevision = db.prepare(`
  UPDATE assistant_messages SET revision_before = @before, revision_after = @after, revision_status = @status, decided_at = datetime('now')
  WHERE id = @id
`);
const setTranslation = db.prepare(`
  UPDATE paragraphs SET vietnamese_md = ?, status = 'translated', updated_at = datetime('now') WHERE id = ?
`);

// Applies a proposed translation to the paragraph. If the translation was
// changed after the proposal was made, refuses unless `force` — the user
// then sees the conflict and decides. `text` lets the user adjust the
// proposal before applying it.
export function approve({ userId, paragraphId, messageId, text, force = false }) {
  const m = ownRevision(userId, paragraphId, messageId);
  if (m.revision_status === 'approved') throw Object.assign(new Error('Bản này đã được áp dụng.'), { status: 409 });
  const current = db.prepare('SELECT vietnamese_md FROM paragraphs WHERE id = ?').get(paragraphId)?.vietnamese_md ?? '';
  if (!force && current.trim() !== (m.revision_before || '').trim()) {
    throw Object.assign(new Error('Bản dịch đã thay đổi sau khi AI đề xuất. Xem lại so sánh trước khi áp dụng.'), { status: 409, code: 'changed', current });
  }
  const after = typeof text === 'string' && text.trim() ? text.trim() : m.revision_after;
  db.transaction(() => {
    setTranslation.run(after, paragraphId);
    setRevision.run({ id: m.id, before: current, after, status: 'approved' });
  })();
  return getMessage(m.id);
}

export function reject({ userId, paragraphId, messageId }) {
  const m = ownRevision(userId, paragraphId, messageId);
  if (m.revision_status !== 'pending') throw Object.assign(new Error('Bản này đã được xử lý.'), { status: 409 });
  setRevision.run({ id: m.id, before: m.revision_before, after: m.revision_after, status: 'rejected' });
  return getMessage(m.id);
}

// Undoes an approval, as long as nobody has changed the translation since.
export function revert({ userId, paragraphId, messageId }) {
  const m = ownRevision(userId, paragraphId, messageId);
  if (m.revision_status !== 'approved') throw Object.assign(new Error('Chỉ hoàn tác được bản đã áp dụng.'), { status: 409 });
  const current = db.prepare('SELECT vietnamese_md FROM paragraphs WHERE id = ?').get(paragraphId)?.vietnamese_md ?? '';
  if (current.trim() !== m.revision_after.trim()) {
    throw Object.assign(new Error('Bản dịch đã được sửa tiếp sau khi áp dụng, không hoàn tác tự động được.'), { status: 409 });
  }
  db.transaction(() => {
    db.prepare("UPDATE paragraphs SET vietnamese_md = ?, updated_at = datetime('now') WHERE id = ?").run(m.revision_before || '', paragraphId);
    setRevision.run({ id: m.id, before: m.revision_before, after: m.revision_after, status: 'reverted' });
  })();
  return getMessage(m.id);
}

export function clearThread(userId, paragraphId) {
  db.prepare('DELETE FROM assistant_messages WHERE user_id = ? AND paragraph_id = ?').run(userId, paragraphId);
}


// ---------------------------------------------------------------------------
// Inline AI for one field of the paragraph editor. Stateless: the editor
// sends its unsaved draft and the short conversation it holds; a proposed
// change goes back into the draft only when the user applies it, and into
// the book only when the paragraph is saved.

export const FIELD_SPECS = {
  english_md: { label: 'đoạn gốc tiếng Anh', format: 'văn xuôi tiếng Anh; giữ **đậm** và *nghiêng* như hiện có' },
  vietnamese_md: { label: 'bản dịch tiếng Việt', format: 'văn xuôi tiếng Việt; giữ **đậm** ở các cụm tương ứng với cụm **đậm** trong bản tiếng Anh' },
  phrases_verbs_md: { label: 'ghi chú Phrases & Verbs', format: 'mỗi dòng một mục dạng "- **cụm từ tiếng Anh**: nghĩa tiếng Việt trong ngữ cảnh"' },
  vocabulary_md: { label: 'ghi chú Vocabulary', format: 'mỗi dòng một mục dạng "- **từ** /IPA/ (loại từ): nghĩa tiếng Việt"' },
  citation_en_md: { label: 'trích dẫn & chú thích (tiếng Anh)', format: 'giữ nguyên định dạng hiện có' },
  citation_vi_md: { label: 'trích dẫn & chú thích (tiếng Việt)', format: 'bản dịch tiếng Việt của phần trích dẫn tiếng Anh, cùng định dạng' },
  citations_md: { label: 'ghi chú trích dẫn', format: 'mỗi dòng một mục "- …"' },
  remarks_note: { label: 'ghi chú của người dịch', format: 'văn bản ngắn tiếng Việt' },
};

// Where the selected (rendered) text sits in the field's markdown: the
// selection has no ** == <u> markers, the stored text may have them
// anywhere inside it. Returns [start, end] or null.
function locateSelection(markdown, selection) {
  if (!selection) return null;
  const direct = markdown.indexOf(selection);
  if (direct >= 0) return [direct, direct + selection.length];
  const marks = '(?:\\*\\*|\\*|==|<\\/?u>)*';
  const chars = [...selection].map((c) => (/\s/.test(c) ? '\\s+' : c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const m = markdown.match(new RegExp(marks + chars.join(marks) + marks));
  if (!m) return null;
  // A part that would cut a bold/italic/highlight span in two cannot be
  // replaced on its own; the whole field is rewritten instead.
  const balanced = [/\*\*/g, /==/g, /<u>/g].every((re) => (m[0].match(re) || []).length % 2 === 0 || re.source === '<u>')
    && (m[0].match(/<u>/g) || []).length === (m[0].match(/<\/u>/g) || []).length
    && ((m[0].replace(/\*\*/g, '').match(/\*/g) || []).length % 2 === 0);
  return balanced ? [m.index, m.index + m[0].length] : null;
}

export async function askField({ paragraphId, field, instruction = '', selection = '', revise, draft = {}, history = [] }) {
  const spec = FIELD_SPECS[field];
  if (!spec) throw Object.assign(new Error('Ô không hợp lệ.'), { status: 400 });
  const ctx = paragraphContext(paragraphId);
  if (!ctx) throw Object.assign(new Error('Không tìm thấy đoạn văn.'), { status: 404 });
  const text = String(instruction || '').trim();
  if (!text) throw Object.assign(new Error('Hãy nhập yêu cầu.'), { status: 400 });

  // The draft wins over the saved paragraph: it is what the user sees.
  const p = { ...ctx.paragraph };
  for (const f of Object.keys(FIELD_SPECS)) if (typeof draft[f] === 'string') p[f] = draft[f];
  const value = p[field] || '';
  const sel = String(selection || '').trim();
  const wantsRevision = revise ?? CHANGE_REQUEST.test(text);
  // With a selection that can be found in the field, the AI rewrites only
  // that part and it is spliced back in, so the rest of the field cannot
  // change — small models otherwise rework neighbouring sentences too.
  const range = locateSelection(value, sel);
  const part = range ? value.slice(range[0], range[1]) : '';

  const system = `Bạn là trợ lý biên dịch Anh → Việt, giúp người dịch soạn MỘT Ô trong trình soạn thảo đoạn văn của cuốn sách "${p.title_en}", chương "${p.chapter_title}".
${bookContextText(p)}

ĐOẠN GỐC (tiếng Anh):
${p.english_md}

BẢN DỊCH (tiếng Việt):
${p.vietnamese_md?.trim() || '(chưa có)'}
${ctx.glossary.length ? `\nBẢNG THUẬT NGỮ:\n${ctx.glossary.map((g) => `- ${g.term} = ${g.meaning_vi}`).join('\n')}\n` : ''}
Ô ĐANG SOẠN: ${spec.label}
Định dạng của ô: ${spec.format}
Nội dung hiện tại của ô:
${value.trim() || '(trống)'}
${range ? `\nPHẦN ĐANG CHỌN (yêu cầu chỉ áp dụng cho phần này):\n${part}\n` : sel ? `\nNgười dùng đang chọn phần: «${sel}». Chỉ thay đổi phần này; phần còn lại của ô giữ nguyên từng chữ.\n` : ''}
Quy tắc:
- Trả lời bằng tiếng Việt, ngắn gọn.
- Nếu yêu cầu là sửa, viết lại hoặc bổ sung, đặt ${range ? 'CHỈ phần chọn đã viết lại (không kèm phần khác của ô)' : 'TOÀN BỘ nội dung mới của ô'} giữa <revision> và </revision> ở cuối câu trả lời, đúng định dạng của ô.
- Nếu chỉ là câu hỏi, chỉ trả lời, không kèm <revision>.`;

  // A change to a located selection: a short request of its own that shows
  // the model only the text to rewrite (the English paragraph is there for
  // meaning). Given the whole field, small models rewrite the whole field.
  if (range && wantsRevision) {
    const sentences = (s) => s.match(/[^.!?…]+(?:[.!?…]+["”’)]*|$)\s*/g) || [s];
    const n = sentences(part.trim()).length;
    const ask = (insist) => chatText({
      system: 'Bạn là biên tập viên bản dịch Anh → Việt. Bạn chỉ viết lại ĐÚNG phần văn bản được giao, không viết thêm câu nào khác, không giải thích.',
      temperature: insist ? 0.6 : 0.3,
      maxTokens: 600,
      messages: [{
        role: 'user',
        content: `Đoạn gốc tiếng Anh (chỉ để hiểu nghĩa, KHÔNG dịch lại cả đoạn):\n${p.english_md}\n\nPhần tiếng Việt cần viết lại:\n${part.trim()}\n\nYêu cầu: ${text}${insist ? '\nPhần viết lại phải có cách diễn đạt KHÁC phần hiện tại, nhưng giữ đúng ý của câu gốc tiếng Anh.' : ''}\n\nChỉ trả về phần đã viết lại, ${n} câu như phần gốc, giữ **đậm** nếu có.`,
      }],
    });
    // Guard: never more sentences than the selection had. A small model
    // often hands the text back unchanged at first; it is asked once more.
    const shorten = (s) => sentences(cleanRevision(s)).slice(0, n).join('').trim();
    let kept = shorten(await ask(false));
    if (!kept || kept === part.trim()) kept = shorten(await ask(true));
    if (!kept || kept === part.trim()) return { reply: 'Không có thay đổi nào cho phần chọn.', revision: '' };
    const lead = part.match(/^\s*/)[0];
    const trail = part.match(/\s*$/)[0];
    return {
      reply: 'Đã viết lại phần chọn; phần còn lại của ô giữ nguyên.',
      revision: value.slice(0, range[0]) + lead + kept + trail + value.slice(range[1]),
    };
  }

  const turns = (Array.isArray(history) ? history : []).slice(-6)
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));
  const target = range ? 'CHỈ phần chọn đã viết lại' : 'TOÀN BỘ nội dung mới của ô';
  const userContent = `${text}${wantsRevision ? `\n\n(Đặt ${target} giữa <revision> và </revision> ở cuối.)` : ''}`;
  const answer = await chatText({ system, messages: [...turns, { role: 'user', content: userContent }], maxTokens: 1600 });
  let { reply, revision } = parseAnswer(answer, range ? part : value);
  if (!wantsRevision) revision = '';

  if (wantsRevision && !revision) {
    const rewritten = await chatText({
      system,
      temperature: 0.2,
      messages: [...turns, { role: 'user', content: userContent }, { role: 'assistant', content: answer },
        { role: 'user', content: `Bây giờ chỉ viết ${range ? 'phần chọn đã viết lại (không kèm phần khác)' : 'TOÀN BỘ nội dung mới của ô'} theo yêu cầu trên, đúng định dạng của ô. Không tiêu đề, không giải thích.` }],
    });
    revision = cleanRevision(rewritten);
  }
  if (revision && range) {
    // Keep the spacing that surrounded the selection.
    const lead = part.match(/^\s*/)[0];
    const trail = part.match(/\s*$/)[0];
    revision = value.slice(0, range[0]) + lead + revision.trim() + trail + value.slice(range[1]);
  }
  if (revision.trim() === value.trim()) revision = '';
  reply = stripRepeatedRevision(reply, revision) || (revision ? 'Đây là nội dung đề xuất cho ô này.' : reply || 'Không có thay đổi nào cần làm.');
  return { reply, revision };
}
