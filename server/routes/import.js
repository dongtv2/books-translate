import { Router } from 'express';
import multer from 'multer';
import { parseDocxBuffer } from '../importers/docxImporter.js';
import { parseBookText } from '../importers/textImporter.js';
import { persistParsedBook } from '../importers/persistBook.js';
import { classifyTopics } from '../vocabTopics.js';
import { setOwner } from '../bookAccess.js';
import { autoAssignBooks } from '../genres.js';

// Imported words arrive without a topic; file them in the background so the
// import itself returns right away. Without an AI provider they stay
// unclassified and the vocabulary page offers to classify them later.
function classifyInBackground() {
  classifyTopics().catch(() => {});
}

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

// POST /api/import/docx — multipart form, field "file"
router.post('/docx', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Thiếu file .docx.' });
  try {
    const parsed = await parseDocxBuffer(req.file.buffer);
    if (parsed.parts.length === 0) {
      return res.status(422).json({ error: 'Không tìm thấy nội dung dịch nào trong file (không có bảng English/Vietnamese/Phrase & Remark hoặc đoạn văn nào).' });
    }
    const result = persistParsedBook(parsed);
    setOwner(result.bookId, req.user.id);
    autoAssignBooks(result.bookId);
    res.json(result);
    classifyInBackground();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Import thất bại.' });
  }
});

// POST /api/import/text — JSON { title_en, title_vi, author, ..., rawText }
router.post('/text', (req, res) => {
  const { rawText, ...meta } = req.body || {};
  if (!rawText || !rawText.trim()) {
    return res.status(400).json({ error: 'Thiếu văn bản cần import.' });
  }
  try {
    const parsed = parseBookText(rawText, meta);
    if (parsed.parts.length === 0) {
      return res.status(422).json({ error: 'Không tách được đoạn văn nào từ văn bản này.' });
    }
    const result = persistParsedBook(parsed);
    setOwner(result.bookId, req.user.id);
    autoAssignBooks(result.bookId);
    res.json(result);
    classifyInBackground();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Import thất bại.' });
  }
});

export default router;
