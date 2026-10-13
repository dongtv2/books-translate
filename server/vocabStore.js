// The vocabulary as one set of entries with one entry per term: the dedupe
// key (normalizeTerm) is unique in the table, entries can be merged without
// losing anyone's review history, exported and imported in a format another
// install can read back, and each entry knows where it occurs in the books
// and which other entries belong to its word family.
import { db } from './db.js';
import { normalizeTerm, NORMALIZE_VERSION } from './normalize.js';
import { containsTerm } from '../src/lib/vocabMatch.js';
import { plainText } from '../src/lib/inlineMarkdown.js';
import { WORD_TYPES } from './wordTypes.js';
import { isValidTopic } from './vocabTopics.js';
import { backupBeforeMigration } from './backup.js';
import { moveSenses, restoreSenses, upsertSense } from './vocabSenses.js';

// Every merge and every re-key is logged with the full row it replaced, so a
// wrong merge can be looked up and undone by hand.
db.exec(`
  CREATE TABLE IF NOT EXISTS vocab_merge_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kept_id INTEGER,
    merged_id INTEGER,
    merged_json TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);
// Private words and proposals (owner_id NULL = the shared vocabulary; a
// user id = that user's own word, which they may propose for the shared
// vocabulary), and each user's personal list of shared words with a note.
for (const [col, def] of [
  ['owner_id', 'owner_id INTEGER REFERENCES users(id) ON DELETE CASCADE'],
  ['proposal_status', 'proposal_status TEXT'],
  ['proposal_note', "proposal_note TEXT NOT NULL DEFAULT ''"],
  ['proposed_at', 'proposed_at TEXT'],
  ['reviewed_by', 'reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL'],
  ['reviewed_at', 'reviewed_at TEXT'],
]) {
  if (!db.prepare('PRAGMA table_info(vocabulary)').all().some((c) => c.name === col)) db.exec(`ALTER TABLE vocabulary ADD COLUMN ${def}`);
}
db.exec(`
  CREATE TABLE IF NOT EXISTS user_vocab (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    vocabulary_id INTEGER NOT NULL REFERENCES vocabulary(id) ON DELETE CASCADE,
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, vocabulary_id)
  );
  CREATE INDEX IF NOT EXISTS idx_user_vocab_entry ON user_vocab(vocabulary_id);
  CREATE INDEX IF NOT EXISTS idx_vocab_owner ON vocabulary(owner_id);
`);

// One entry per key in the shared vocabulary, and one per key in each
// user's own words. Partial indexes, so inserts into the shared vocabulary
// can say ON CONFLICT(term_normalized) WHERE owner_id IS NULL.
function createKeyIndexes() {
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_vocab_term_unique ON vocabulary(term_normalized) WHERE owner_id IS NULL');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_vocab_private_term ON vocabulary(owner_id, term_normalized) WHERE owner_id IS NOT NULL');
}
export const SHARED_ON_CONFLICT = 'ON CONFLICT(term_normalized) WHERE owner_id IS NULL DO NOTHING';

// What an undo needs (see undoMerge), added after the table first shipped.
for (const [col, def] of [['undo_json', "undo_json TEXT NOT NULL DEFAULT ''"], ['undone_at', 'undone_at TEXT'], ['undone_by', 'undone_by INTEGER']]) {
  if (!db.prepare('PRAGMA table_info(vocab_merge_log)').all().some((c) => c.name === col)) db.exec(`ALTER TABLE vocab_merge_log ADD COLUMN ${def}`);
}

const CONTENT_FIELDS = ['ipa', 'word_type', 'meaning_vi', 'example', 'topic'];

// Which of several entries for the same word survives a merge: the one in
// dictionary form (shortest term), then the oldest.
function pickKeeper(rows) {
  return [...rows].sort((a, b) => a.term.length - b.term.length || a.id - b.id)[0];
}

// The kept entry's meaning, with the merged one's added when it says
// something the kept one does not.
function mergeMeaning(kept, other) {
  const a = (kept || '').trim();
  const b = (other || '').trim();
  if (!b || a.toLowerCase().includes(b.toLowerCase())) return a;
  if (!a || b.toLowerCase().includes(a.toLowerCase())) return b;
  // Senses are ";"-separated; only the other entry's new ones are added.
  const senses = a.split(/\s*;\s*/);
  const have = new Set(senses.map((x) => x.toLowerCase().replace(/[.\s]+$/, '')));
  for (const sense of b.split(/\s*;\s*/)) {
    if (sense && !have.has(sense.toLowerCase().replace(/[.\s]+$/, ''))) senses.push(sense);
  }
  return senses.join('; ');
}

// Folds `mergeIds` into `keepId`: content fills the kept entry's gaps, each
// user's review progress keeps whichever entry they had practised more,
// review history, glossary links and the source paragraph move over, and
// the merged rows are logged and deleted. Runs inside the caller's
// transaction if there is one.
export function mergeVocab(keepId, mergeIds, { reason = 'merge', userId = null, keepMeaning = false } = {}) {
  const keep = db.prepare('SELECT * FROM vocabulary WHERE id = ?').get(keepId);
  if (!keep) throw new Error('Không tìm thấy từ được giữ lại.');
  const others = mergeIds
    .filter((id) => Number(id) !== Number(keepId))
    .map((id) => db.prepare('SELECT * FROM vocabulary WHERE id = ?').get(id))
    .filter(Boolean);
  if (!others.length) return keep;

  const KEEP_FIELDS = ['meaning_vi', 'ipa', 'example', 'topic', 'source_paragraph_id', 'date_added'];
  const keepBefore = Object.fromEntries(KEEP_FIELDS.map((f) => [f, keep[f]]));
  const keepProgressBefore = db.prepare('SELECT * FROM vocab_progress WHERE vocabulary_id = ?').all(keep.id);
  const logIds = [];

  db.transaction(() => {
    const next = { ...keep };
    for (const o of others) {
      // Recorded before anything moves, so undoMerge can put it all back.
      const undo = {
        keepBefore,
        keepProgressBefore,
        progress: db.prepare('SELECT * FROM vocab_progress WHERE vocabulary_id = ?').all(o.id),
        reviewLogIds: db.prepare('SELECT id FROM review_log WHERE vocabulary_id = ?').all(o.id).map((r) => r.id),
        glossaryIds: db.prepare('SELECT id FROM glossary WHERE vocabulary_id = ?').all(o.id).map((r) => r.id),
        userVocab: db.prepare('SELECT * FROM user_vocab WHERE vocabulary_id = ?').all(o.id),
        senses: db.prepare('SELECT * FROM vocab_senses WHERE vocabulary_id = ?').all(o.id),
      };
      if (!keepMeaning) next.meaning_vi = mergeMeaning(next.meaning_vi, o.meaning_vi);
      for (const f of ['ipa', 'example']) if (!String(next[f] || '').trim() && o[f]) next[f] = o[f];
      if ((!next.topic || next.topic === 'Khác') && isValidTopic(o.topic)) next.topic = o.topic;
      if (!next.source_paragraph_id && o.source_paragraph_id) next.source_paragraph_id = o.source_paragraph_id;
      if (o.date_added && o.date_added < next.date_added) next.date_added = o.date_added;

      for (const p of db.prepare('SELECT * FROM vocab_progress WHERE vocabulary_id = ?').all(o.id)) {
        const mine = db.prepare('SELECT * FROM vocab_progress WHERE vocabulary_id = ? AND user_id = ?').get(keep.id, p.user_id);
        if (!mine || p.repetitions > mine.repetitions || (p.repetitions === mine.repetitions && (p.last_reviewed_at || '') > (mine.last_reviewed_at || ''))) {
          db.prepare(`
            INSERT INTO vocab_progress (user_id, vocabulary_id, status, ease_factor, interval_days, repetitions, due_date, last_reviewed_at)
            VALUES (@user_id, @kid, @status, @ease_factor, @interval_days, @repetitions, @due_date, @last_reviewed_at)
            ON CONFLICT(user_id, vocabulary_id) DO UPDATE SET status = excluded.status, ease_factor = excluded.ease_factor,
              interval_days = excluded.interval_days, repetitions = excluded.repetitions, due_date = excluded.due_date,
              last_reviewed_at = excluded.last_reviewed_at
          `).run({ ...p, kid: keep.id });
        }
      }
      db.prepare('UPDATE review_log SET vocabulary_id = ? WHERE vocabulary_id = ?').run(keep.id, o.id);
      db.prepare('UPDATE glossary SET vocabulary_id = ? WHERE vocabulary_id = ?').run(keep.id, o.id);
      // Book-specific meanings move too (the kept entry's own win).
      moveSenses(o.id, keep.id);
      // Personal notes follow the word (joined when both entries had one).
      for (const u of undo.userVocab) {
        db.prepare(`INSERT INTO user_vocab (user_id, vocabulary_id, note) VALUES (?, ?, ?)
          ON CONFLICT(user_id, vocabulary_id) DO UPDATE SET note = TRIM(user_vocab.note || CASE WHEN user_vocab.note != '' AND excluded.note != '' THEN char(10) ELSE '' END || excluded.note), updated_at = datetime('now')`)
          .run(u.user_id, keep.id, u.note);
      }
      logIds.push(db.prepare('INSERT INTO vocab_merge_log (kept_id, merged_id, merged_json, reason, created_by, undo_json) VALUES (?, ?, ?, ?, ?, ?)')
        .run(keep.id, o.id, JSON.stringify(o), reason, userId, JSON.stringify(undo)).lastInsertRowid);
      db.prepare('DELETE FROM vocabulary WHERE id = ?').run(o.id);
    }
    db.prepare(`
      UPDATE vocabulary SET meaning_vi = @meaning_vi, ipa = @ipa, example = @example, topic = @topic,
        source_paragraph_id = @source_paragraph_id, date_added = @date_added, updated_at = datetime('now')
      WHERE id = @id
    `).run(next);
    // One merge = one batch: undone together, and only while the kept
    // entry has not been edited since (keepUpdatedAt).
    const keepUpdatedAt = db.prepare('SELECT updated_at FROM vocabulary WHERE id = ?').get(keep.id).updated_at;
    for (const id of logIds) {
      const row = db.prepare('SELECT undo_json FROM vocab_merge_log WHERE id = ?').get(id);
      db.prepare('UPDATE vocab_merge_log SET undo_json = ? WHERE id = ?')
        .run(JSON.stringify({ ...JSON.parse(row.undo_json), batch: logIds[0], keepUpdatedAt }), id);
    }
  })();
  return db.prepare('SELECT * FROM vocabulary WHERE id = ?').get(keep.id);
}

// Puts back the entries one merge folded away: the rows with their own ids,
// their review progress and history, their glossary links, and the kept
// entry's content and progress as they were — unless someone has edited the
// kept entry or reviewed it since, in which case that newer state stays and
// is reported. Merges made by the key normalisation (same key) and log rows
// from before undo was recorded cannot be undone.
export function undoMerge(logId, { userId = null } = {}) {
  const first = db.prepare('SELECT * FROM vocab_merge_log WHERE id = ?').get(logId);
  if (!first) throw new Error('Không tìm thấy lần gộp này.');
  if (!first.undo_json) throw new Error('Lần gộp này được ghi trước khi có chức năng hoàn tác.');
  if (first.undone_at) throw new Error('Lần gộp này đã được hoàn tác.');
  const batch = JSON.parse(first.undo_json).batch;
  const rows = db.prepare("SELECT * FROM vocab_merge_log WHERE undo_json != '' AND undone_at IS NULL").all()
    .filter((r) => JSON.parse(r.undo_json).batch === batch);
  const keep = db.prepare('SELECT * FROM vocabulary WHERE id = ?').get(first.kept_id);
  if (!keep) throw new Error('Mục được giữ lại đã bị xoá, không thể hoàn tác.');

  const notes = [];
  db.transaction(() => {
    let keepRestored = false;
    for (const r of rows) {
      const undo = JSON.parse(r.undo_json);
      const row = JSON.parse(r.merged_json);
      if (db.prepare('SELECT 1 FROM vocabulary WHERE id = ?').get(row.id)) throw new Error(`Mã #${row.id} đã được dùng lại, không thể hoàn tác.`);
      const clash = db.prepare('SELECT term FROM vocabulary WHERE term_normalized = ? AND owner_id IS ?').get(normalizeTerm(row.term), row.owner_id ?? null);
      if (clash) throw new Error(`"${row.term}" trùng khoá với "${clash.term}" (gộp do chuẩn hoá), không thể tách lại.`);
      const cols = Object.keys(row).filter((c) => c !== 'term_normalized');
      db.prepare(`INSERT INTO vocabulary (${cols.join(', ')}, term_normalized) VALUES (${cols.map((c) => `@${c}`).join(', ')}, @term_normalized)`)
        .run({ ...row, term_normalized: normalizeTerm(row.term) });
      for (const p of undo.progress) {
        db.prepare(`INSERT OR REPLACE INTO vocab_progress (user_id, vocabulary_id, status, ease_factor, interval_days, repetitions, due_date, last_reviewed_at)
          VALUES (@user_id, @vocabulary_id, @status, @ease_factor, @interval_days, @repetitions, @due_date, @last_reviewed_at)`).run(p);
      }
      const moveBack = (table, ids) => {
        for (const id of ids) db.prepare(`UPDATE ${table} SET vocabulary_id = ? WHERE id = ? AND vocabulary_id = ?`).run(row.id, id, keep.id);
      };
      moveBack('review_log', undo.reviewLogIds);
      moveBack('glossary', undo.glossaryIds);
      restoreSenses(undo.senses, row.id);
      for (const u of undo.userVocab || []) {
        db.prepare('INSERT OR REPLACE INTO user_vocab (user_id, vocabulary_id, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
          .run(u.user_id, row.id, u.note, u.created_at, u.updated_at);
      }

      if (!keepRestored) {
        keepRestored = true;
        if (keep.updated_at === undo.keepUpdatedAt) {
          const f = undo.keepBefore;
          db.prepare(`UPDATE vocabulary SET meaning_vi = ?, ipa = ?, example = ?, topic = ?, source_paragraph_id = ?, date_added = ? WHERE id = ?`)
            .run(f.meaning_vi, f.ipa, f.example, f.topic, f.source_paragraph_id, f.date_added, keep.id);
        } else {
          notes.push(`"${keep.term}" đã được sửa sau khi gộp nên giữ nội dung hiện tại.`);
        }
        // Each user's progress on the kept entry goes back to its pre-merge
        // state, unless they have reviewed it since the merge.
        const before = new Map(undo.keepProgressBefore.map((p) => [p.user_id, p]));
        for (const p of db.prepare('SELECT * FROM vocab_progress WHERE vocabulary_id = ?').all(keep.id)) {
          const reviewedSince = p.last_reviewed_at && p.last_reviewed_at > r.created_at.replace(' ', 'T');
          if (reviewedSince) { notes.push('Có người đã ôn mục được giữ lại sau khi gộp; tiến độ mới của họ được giữ.'); continue; }
          if (before.has(p.user_id)) {
            const b = before.get(p.user_id);
            db.prepare(`UPDATE vocab_progress SET status = ?, ease_factor = ?, interval_days = ?, repetitions = ?, due_date = ?, last_reviewed_at = ?
              WHERE user_id = ? AND vocabulary_id = ?`).run(b.status, b.ease_factor, b.interval_days, b.repetitions, b.due_date, b.last_reviewed_at, p.user_id, keep.id);
          } else {
            db.prepare('DELETE FROM vocab_progress WHERE user_id = ? AND vocabulary_id = ?').run(p.user_id, keep.id);
          }
        }
      }
      db.prepare("UPDATE vocab_merge_log SET undone_at = datetime('now'), undone_by = ? WHERE id = ?").run(userId, r.id);
    }
  })();
  return { restored: rows.map((r) => JSON.parse(r.merged_json).term), kept: keep.term, notes: [...new Set(notes)] };
}

// The merge log, newest first, for the admin's data page.
export function mergeHistory({ limit = 100 } = {}) {
  return db.prepare(`
    SELECT m.id, m.kept_id, m.merged_id, m.reason, m.created_at, m.undone_at, m.undo_json != '' AS undoable,
      json_extract(m.merged_json, '$.term') AS merged_term, json_extract(m.merged_json, '$.meaning_vi') AS merged_meaning,
      v.term AS kept_term, u.email AS by_email
    FROM vocab_merge_log m LEFT JOIN vocabulary v ON v.id = m.kept_id LEFT JOIN users u ON u.id = m.created_by
    ORDER BY m.id DESC LIMIT ?
  `).all(limit).map((r) => ({ ...r, undoable: Boolean(r.undoable) && !r.undone_at && r.merged_id != null }));
}

// Once per NORMALIZE_VERSION: recompute every stored key (vocabulary,
// glossary, discussions), merge entries that now share one, and make the
// key unique so no code path can insert a duplicate again.
function migrateKeys() {
  const done = db.prepare("SELECT value FROM settings WHERE key = 'vocab_normalize_version'").get()?.value;
  const hasUnique = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_vocab_term_unique'").get();
  if (Number(done) === NORMALIZE_VERSION && hasUnique) return;
  // This rewrites keys and merges rows: no backup, no migration (the app
  // keeps working on the previous keys and tries again at the next start).
  if (!backupBeforeMigration(`vocabulary keys v${NORMALIZE_VERSION}`)) {
    console.error('[vocabulary] key migration postponed: the backup before it failed.');
    return;
  }

  db.transaction(() => {
    db.exec('DROP INDEX IF EXISTS idx_vocab_term_unique');
    db.exec('DROP INDEX IF EXISTS idx_vocab_private_term');
    // keys are unique per scope: the shared vocabulary, or one user's words
    const groups = new Map();
    for (const r of db.prepare('SELECT * FROM vocabulary').all()) {
      const scope = `${r.owner_id ?? 0}|${normalizeTerm(r.term)}`;
      if (!groups.has(scope)) groups.set(scope, []);
      groups.get(scope).push(r);
    }
    let merged = 0;
    for (const [scope, rows] of groups) {
      const key = scope.slice(scope.indexOf('|') + 1);
      const keeper = pickKeeper(rows);
      if (rows.length > 1) {
        mergeVocab(keeper.id, rows.map((r) => r.id), { reason: `normalize v${NORMALIZE_VERSION}: ${key}` });
        merged += rows.length - 1;
      }
      db.prepare('UPDATE vocabulary SET term_normalized = ? WHERE id = ?').run(key, keeper.id);
    }
    // glossary and term_threads come from discussions.js, loaded later: a
    // fresh database does not have them yet (and has nothing to re-key)
    const hasTable = (name) => db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
    for (const g of hasTable('glossary') ? db.prepare('SELECT id, term FROM glossary').all() : []) {
      db.prepare('UPDATE OR IGNORE glossary SET term_normalized = ? WHERE id = ?').run(normalizeTerm(g.term), g.id);
    }
    for (const t of hasTable('term_threads') ? db.prepare('SELECT id, term FROM term_threads').all() : []) {
      db.prepare('UPDATE term_threads SET term_normalized = ? WHERE id = ?').run(normalizeTerm(t.term), t.id);
    }
    createKeyIndexes();
    db.prepare("INSERT INTO settings (key, value) VALUES ('vocab_normalize_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(String(NORMALIZE_VERSION));
    if (merged) console.log(`[vocabulary] normalize v${NORMALIZE_VERSION}: merged ${merged} duplicate entries`);
  })();
}
migrateKeys();

// Once: the shared-key index becomes partial (shared entries only) so that
// users' own words can use keys the shared vocabulary also has.
function migrateScopes() {
  const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_vocab_term_unique'").get()?.sql || '';
  const hasPrivate = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_vocab_private_term'").get();
  if (/WHERE owner_id IS NULL/i.test(sql) && hasPrivate) return;
  backupBeforeMigration('vocabulary scopes (private words)');
  db.transaction(() => {
    db.exec('DROP INDEX IF EXISTS idx_vocab_term_unique');
    createKeyIndexes();
  })();
  console.log('[vocabulary] key index now per scope (shared / each user)');
}
migrateScopes();

// ---- scopes: shared words, a user's own words ---------------------------

// SQL limiting `alias` to the entries user `uid` may see: the shared ones
// and their own. Every list of vocabulary goes through this.
export function visibleVocabSql(alias, uid) {
  return `(${alias}.owner_id IS NULL OR ${alias}.owner_id = ${Number(uid) || -1})`;
}

// When a word enters the shared vocabulary, users' own copies of it fold
// into it: their review progress and history move over, and what they had
// written as its meaning is kept as their personal note.
export function absorbPrivateCopies(sharedId) {
  const shared = db.prepare('SELECT * FROM vocabulary WHERE id = ? AND owner_id IS NULL').get(sharedId);
  if (!shared) return 0;
  const copies = db.prepare('SELECT * FROM vocabulary WHERE term_normalized = ? AND owner_id IS NOT NULL').all(shared.term_normalized);
  for (const c of copies) {
    db.transaction(() => {
      if (c.meaning_vi && c.meaning_vi.trim().toLowerCase() !== shared.meaning_vi.trim().toLowerCase()) {
        db.prepare(`INSERT INTO user_vocab (user_id, vocabulary_id, note) VALUES (?, ?, ?)
          ON CONFLICT(user_id, vocabulary_id) DO NOTHING`).run(c.owner_id, c.id, `Nghĩa tôi ghi: ${c.meaning_vi}`);
      } else {
        db.prepare('INSERT OR IGNORE INTO user_vocab (user_id, vocabulary_id) VALUES (?, ?)').run(c.owner_id, c.id);
      }
      mergeVocab(shared.id, [c.id], { reason: 'absorb', userId: c.owner_id, keepMeaning: true });
    })();
  }
  return copies.length;
}

// ---- proposals: a user's word into the shared vocabulary ----------------

export function proposeVocab(id, uid, note = '') {
  const row = db.prepare('SELECT * FROM vocabulary WHERE id = ? AND owner_id = ?').get(id, uid);
  if (!row) throw Object.assign(new Error('Không tìm thấy từ riêng này.'), { status: 404 });
  db.prepare("UPDATE vocabulary SET proposal_status = 'pending', proposal_note = ?, proposed_at = datetime('now'), reviewed_by = NULL, reviewed_at = NULL WHERE id = ?")
    .run(String(note || '').slice(0, 500), id);
}

export function withdrawProposal(id, uid) {
  const info = db.prepare("UPDATE vocabulary SET proposal_status = NULL, proposal_note = '' WHERE id = ? AND owner_id = ? AND proposal_status = 'pending'").run(id, uid);
  if (!info.changes) throw Object.assign(new Error('Không có đề xuất nào đang chờ cho từ này.'), { status: 404 });
}

export function listProposals() {
  return db.prepare(`
    SELECT v.id, v.term, v.ipa, v.word_type, v.meaning_vi, v.example, v.topic, v.proposal_note, v.proposed_at, v.source_paragraph_id,
      u.id AS owner_id, u.name AS owner_name, u.email AS owner_email,
      s.id AS shared_id, s.term AS shared_term, s.meaning_vi AS shared_meaning
    FROM vocabulary v JOIN users u ON u.id = v.owner_id
    LEFT JOIN vocabulary s ON s.term_normalized = v.term_normalized AND s.owner_id IS NULL
    WHERE v.proposal_status = 'pending' ORDER BY v.proposed_at
  `).all();
}

// Approves a proposal: the word becomes shared (same id, so the proposer's
// progress stays), or — when the shared vocabulary already has it — folds
// into the shared entry. Edits from the reviewer apply first. Returns the
// shared entry's id.
export function approveProposal(id, reviewerId, edits = {}) {
  const row = db.prepare("SELECT * FROM vocabulary WHERE id = ? AND owner_id IS NOT NULL AND proposal_status = 'pending'").get(id);
  if (!row) throw Object.assign(new Error('Không tìm thấy đề xuất đang chờ.'), { status: 404 });
  let sharedId;
  db.transaction(() => {
    const fields = ['ipa', 'word_type', 'meaning_vi', 'example', 'topic'].filter((f) => edits[f] !== undefined && String(edits[f]).trim());
    for (const f of fields) db.prepare(`UPDATE vocabulary SET ${f} = ? WHERE id = ?`).run(String(edits[f]).trim(), id);
    const shared = db.prepare('SELECT id FROM vocabulary WHERE term_normalized = ? AND owner_id IS NULL').get(row.term_normalized);
    if (shared) {
      db.prepare('INSERT OR IGNORE INTO user_vocab (user_id, vocabulary_id) VALUES (?, ?)').run(row.owner_id, row.id);
      mergeVocab(shared.id, [row.id], { reason: 'proposal', userId: reviewerId, keepMeaning: !edits.mergeMeaning });
      sharedId = shared.id;
    } else {
      db.prepare(`UPDATE vocabulary SET owner_id = NULL, proposal_status = NULL, reviewed_by = ?, reviewed_at = datetime('now'), updated_at = datetime('now')
        WHERE id = ?`).run(reviewerId, id);
      db.prepare('INSERT OR IGNORE INTO user_vocab (user_id, vocabulary_id) VALUES (?, ?)').run(row.owner_id, id);
      sharedId = id;
    }
  })();
  absorbPrivateCopies(sharedId);
  return sharedId;
}

export function rejectProposal(id, reviewerId, note = '') {
  const info = db.prepare(`UPDATE vocabulary SET proposal_status = 'rejected', proposal_note = ?, reviewed_by = ?, reviewed_at = datetime('now')
    WHERE id = ? AND owner_id IS NOT NULL AND proposal_status = 'pending'`).run(String(note || '').slice(0, 500), reviewerId, id);
  if (!info.changes) throw Object.assign(new Error('Không tìm thấy đề xuất đang chờ.'), { status: 404 });
}

// ---- word families and near-duplicates -------------------------------

// Articles never make a different entry; spaces go too, so "non adaptiv"
// meets "nonadaptiv".
const ARTICLES = new Set(['a', 'an', 'the']);
const looseKey = (key) => key.split(' ').filter((w) => !ARTICLES.has(w)).join('');
// A trailing preposition, as in "comply with" next to "comply".
const TRAILING_PREPOSITION = / (?:of|to|in|on|at|for|with|by|from|about|into)$/;

// Two single-word keys are one family when one is a prefix of the other
// and the shared part is long enough to be a real root (attach →
// attachment, internaliz → internalization; not psych → psychologist).
function sameFamily(a, b) {
  if (a === b || a.includes(' ') || b.includes(' ')) return false;
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  return s.length >= 6 && l.startsWith(s);
}

// Groups of entries that are probably the same item stored twice: they
// differ only by articles or spacing ("a sense of" / "sense of",
// "non-adaptive" / "nonadaptive"), or one is the other plus the
// preposition it takes ("comply" / "comply with"). Two phrases with
// different prepositions ("keep on" / "keep at") are different items, and
// so are members of a word family (shown as links instead). Pairs someone
// already marked as distinct are left out.
export function duplicateCandidates() {
  const rows = db.prepare('SELECT id, term, term_normalized, ipa, word_type, meaning_vi, topic, source_paragraph_id FROM vocabulary WHERE owner_id IS NULL ORDER BY id').all();
  const dismissed = new Set(db.prepare("SELECT value FROM settings WHERE key = 'vocab_not_duplicates'").get()?.value?.split(',') || []);
  const parent = new Map(rows.map((r) => [r.id, r.id]));
  const find = (x) => (parent.get(x) === x ? x : find(parent.get(x)));
  const union = (a, b) => {
    if (dismissed.has(`${Math.min(a, b)}-${Math.max(a, b)}`)) return;
    parent.set(find(a), find(b));
  };

  const byLoose = new Map();
  for (const r of rows) {
    const k = looseKey(r.term_normalized);
    if (!k) continue;
    if (byLoose.has(k)) union(byLoose.get(k), r.id);
    else byLoose.set(k, r.id);
  }
  for (const r of rows) {
    const base = r.term_normalized.replace(TRAILING_PREPOSITION, '');
    if (base !== r.term_normalized && byLoose.has(looseKey(base))) union(byLoose.get(looseKey(base)), r.id);
  }

  const groups = new Map();
  for (const r of rows) {
    const root = find(r.id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(r);
  }
  return [...groups.values()].filter((g) => g.length > 1);
}

// Remembers that a group is not a duplicate, so it stops being suggested.
export function dismissDuplicates(ids) {
  const sorted = [...new Set(ids.map(Number))].sort((a, b) => a - b);
  const prev = db.prepare("SELECT value FROM settings WHERE key = 'vocab_not_duplicates'").get()?.value?.split(',').filter(Boolean) || [];
  const pairs = new Set(prev);
  for (let i = 0; i < sorted.length; i += 1) for (let j = i + 1; j < sorted.length; j += 1) pairs.add(`${sorted[i]}-${sorted[j]}`);
  db.prepare("INSERT INTO settings (key, value) VALUES ('vocab_not_duplicates', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run([...pairs].join(','));
}

// ---- links -----------------------------------------------------------

// Everything one entry is connected to: the paragraphs it occurs in (any
// book), its word family and the phrases built on it, the glossary
// decisions and the term discussions about it.
export function entryLinks(id, { limit = 40, uid = null } = {}) {
  const entry = db.prepare(`SELECT id, term, term_normalized, owner_id FROM vocabulary v WHERE id = ? AND ${visibleVocabSql('v', uid)}`).get(id);
  if (!entry) return null;

  const paragraphs = db.prepare(`
    SELECT p.id, p.english_md, p.vietnamese_md, c.id AS chapter_id, c.title AS chapter_title, c.order_index AS chapter_order,
      s.order_index AS section_order, p.order_index, b.id AS book_id, COALESCE(NULLIF(b.title_vi, ''), b.title_en) AS book_title
    FROM paragraphs p JOIN sections s ON s.id = p.section_id JOIN chapters c ON c.id = s.chapter_id JOIN books b ON b.id = c.book_id
    ORDER BY b.id, c.order_index, s.order_index, p.order_index
  `).all();
  const occurrences = [];
  for (const p of paragraphs) {
    const text = plainText(p.english_md || '');
    if (!containsTerm(text, entry.term)) continue;
    const sentence = (text.match(/[^.!?]+[.!?]+["”’)]*\s*|[^.!?]+$/g) || [text]).find((s) => containsTerm(s, entry.term)) || '';
    occurrences.push({
      paragraph_id: p.id, chapter_id: p.chapter_id, chapter_title: p.chapter_title, book_id: p.book_id, book_title: p.book_title,
      sentence: sentence.trim(), translated: Boolean(p.vietnamese_md),
    });
  }

  const key = entry.term_normalized;
  const words = key.split(' ');
  const family = [];
  const phrases = [];
  for (const r of db.prepare(`SELECT id, term, term_normalized, ipa, word_type, meaning_vi FROM vocabulary v WHERE id != ? AND ${visibleVocabSql('v', uid)}`).all(id)) {
    const rk = r.term_normalized;
    if (sameFamily(key, rk)) family.push(r);
    else if (!key.includes(' ') && rk.includes(' ') && rk.split(' ').some((w) => w === key || sameFamily(key, w))) phrases.push(r);
    else if (key.includes(' ') && !rk.includes(' ') && rk.length >= 4 && words.includes(rk)) family.push(r);
  }

  return {
    id: entry.id,
    owner_id: entry.owner_id,
    occurrences: occurrences.slice(0, limit),
    occurrenceCount: occurrences.length,
    family,
    phrases: phrases.slice(0, 30),
    glossary: db.prepare(`
      SELECT g.id, g.book_id, g.term, g.meaning_vi, g.note, COALESCE(NULLIF(b.title_vi, ''), b.title_en) AS book_title
      FROM glossary g LEFT JOIN books b ON b.id = g.book_id WHERE g.vocabulary_id = ? OR g.term_normalized = ?
    `).all(id, key),
    threads: db.prepare('SELECT id, book_id, paragraph_id, chapter_id, term, status, resolution_vi FROM term_threads WHERE term_normalized = ? ORDER BY id DESC LIMIT 20').all(key),
  };
}

// ---- exchange --------------------------------------------------------

export const EXCHANGE_FORMAT = 'books-translate/vocabulary';
// 2: entries may carry `senses` (meaning per book, by the book's English title)
export const EXCHANGE_VERSION = 2;

// Entries in the exchange shape: content plus where it came from, and the
// user's own review progress when asked for.
export function exportEntries(rows, { withProgress = false } = {}) {
  return {
    format: EXCHANGE_FORMAT,
    version: EXCHANGE_VERSION,
    exported_at: new Date().toISOString(),
    count: rows.length,
    entries: rows.map((r) => ({
      term: r.term,
      ipa: r.ipa || '',
      word_type: r.word_type,
      meaning_vi: r.meaning_vi,
      example: r.example || '',
      topic: r.topic || '',
      date_added: r.date_added,
      source: r.source_book_title_en ? { book: r.source_book_title_en, chapter: r.source_chapter_title || '' } : null,
      ...(r.senses?.length ? { senses: r.senses.map((x) => ({ book: x.book_title_en, meaning_vi: x.meaning_vi, example: x.example || '', note: x.note || '' })) } : {}),
      ...(withProgress ? {
        progress: {
          status: r.status, ease_factor: r.ease_factor, interval_days: r.interval_days,
          repetitions: r.repetitions, due_date: r.due_date, last_reviewed_at: r.last_reviewed_at,
        },
      } : {}),
    })),
  };
}

const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();

// One incoming entry checked and tidied, or a reason it cannot be used.
function validEntry(raw) {
  const term = clean(raw?.term);
  if (!term) return { error: 'thiếu từ' };
  const meaning_vi = clean(raw.meaning_vi);
  if (!meaning_vi) return { error: 'thiếu nghĩa' };
  const word_type = WORD_TYPES.find((t) => t.toLowerCase() === clean(raw.word_type).toLowerCase()) || '';
  return {
    entry: {
      term,
      term_normalized: normalizeTerm(term),
      ipa: clean(raw.ipa),
      word_type,
      meaning_vi,
      example: clean(raw.example),
      topic: isValidTopic(clean(raw.topic)) ? clean(raw.topic) : '',
      date_added: /^\d{4}-\d{2}-\d{2}$/.test(clean(raw.date_added)) ? clean(raw.date_added) : null,
      progress: raw.progress && typeof raw.progress === 'object' ? raw.progress : null,
      senses: Array.isArray(raw.senses) ? raw.senses.filter((x) => x && clean(x.book) && clean(x.meaning_vi)).slice(0, 50) : [],
    },
  };
}

// Imports entries into the shared vocabulary, one entry per key:
//   mode "skip"      — only add terms that are not in the vocabulary yet
//   mode "fill"      — also fill the empty fields of existing entries
//   mode "overwrite" — also replace existing entries' content with the file's
// Several rows of the file with the same key count as one (the first wins).
// Progress in the file is applied to `userId` only for words that user has
// never reviewed, so an import never rewinds someone's schedule.
// dryRun reports what would happen without writing.
export function importEntries(rawEntries, { mode = 'fill', dryRun = false, userId = null, withProgress = false } = {}) {
  const report = { added: 0, updated: 0, unchanged: 0, invalid: 0, duplicatesInFile: 0, progress: 0, senses: 0, unknownBooks: [], items: [] };
  const bookByTitle = (t) => db.prepare('SELECT id FROM books WHERE title_en = ? COLLATE NOCASE').get(clean(t))?.id;
  const seen = new Set();
  const findByKey = db.prepare('SELECT * FROM vocabulary WHERE term_normalized = ? AND owner_id IS NULL');

  const run = () => {
    for (const [index, raw] of (rawEntries || []).entries()) {
      const { entry, error } = validEntry(raw);
      if (error) {
        report.invalid += 1;
        report.items.push({ index, term: clean(raw?.term), action: 'invalid', note: error });
        continue;
      }
      if (seen.has(entry.term_normalized)) {
        report.duplicatesInFile += 1;
        report.items.push({ index, term: entry.term, action: 'duplicate', note: 'trùng một dòng trước trong file' });
        continue;
      }
      seen.add(entry.term_normalized);
      const existing = findByKey.get(entry.term_normalized);
      let id = existing?.id;

      if (!existing) {
        report.added += 1;
        report.items.push({ index, term: entry.term, action: 'add' });
        if (!dryRun) {
          id = db.prepare(`
            INSERT INTO vocabulary (term, term_normalized, ipa, word_type, meaning_vi, example, topic, date_added, status)
            VALUES (@term, @term_normalized, @ipa, @word_type, @meaning_vi, @example, @topic, COALESCE(@date_added, date('now')), 'Đang học')
          `).run({ ...entry, word_type: entry.word_type || 'Noun', topic: entry.topic || 'Khác' }).lastInsertRowid;
          absorbPrivateCopies(id);
        }
      } else {
        const changes = {};
        for (const f of CONTENT_FIELDS) {
          const incoming = entry[f];
          if (!incoming) continue;
          const current = String(existing[f] || '').trim();
          if (mode === 'overwrite' ? incoming !== current : (mode === 'fill' && (!current || (f === 'topic' && current === 'Khác')))) changes[f] = incoming;
        }
        if (Object.keys(changes).length) {
          report.updated += 1;
          report.items.push({ index, term: entry.term, action: 'update', existing: existing.term, fields: Object.keys(changes) });
          if (!dryRun) {
            const sets = Object.keys(changes).map((f) => `${f} = @${f}`).join(', ');
            db.prepare(`UPDATE vocabulary SET ${sets}, updated_at = datetime('now') WHERE id = @id`).run({ ...changes, id: existing.id });
          }
        } else {
          report.unchanged += 1;
          report.items.push({ index, term: entry.term, action: 'unchanged', existing: existing.term });
        }
      }

      // Meanings per book, matched to this install's books by English title.
      for (const sense of entry.senses) {
        const bookId = bookByTitle(sense.book);
        if (!bookId) { if (!report.unknownBooks.includes(clean(sense.book))) report.unknownBooks.push(clean(sense.book)); continue; }
        if (dryRun) { report.senses += 1; continue; }
        if (id && upsertSense({ vocabularyId: id, bookId, meaning_vi: sense.meaning_vi, example: clean(sense.example), note: clean(sense.note) })) report.senses += 1;
      }

      const p = entry.progress;
      if (withProgress && userId && p && id && !dryRun) {
        const has = db.prepare('SELECT 1 FROM vocab_progress WHERE user_id = ? AND vocabulary_id = ?').get(userId, id);
        if (!has && ['Thành thạo', 'Đang học', 'Cần ôn gấp'].includes(p.status)) {
          db.prepare(`
            INSERT INTO vocab_progress (user_id, vocabulary_id, status, ease_factor, interval_days, repetitions, due_date, last_reviewed_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).run(userId, id, p.status, Number(p.ease_factor) || 2.5, Number(p.interval_days) || 0, Number(p.repetitions) || 0,
            String(p.due_date || ''), p.last_reviewed_at || null);
          report.progress += 1;
        }
      }
    }
  };
  if (dryRun) run();
  else db.transaction(run)();
  return report;
}
