// /api/admin/database — backups, size and integrity of the database, and the
// vocabulary merge history with undo (users.manage, via the /api/admin/ rule).
import { Router } from 'express';
import { db } from '../db.js';
import {
  backupDir, backupPath, createBackup, dbFileSize, freeBytes, integrityReport, listBackups, status, tableStats,
} from '../backup.js';
import { mergeHistory, undoMerge } from '../vocabStore.js';

const router = Router();

// GET /status — sizes, tables, free disk and the backup schedule's state.
router.get('/status', (_req, res) => {
  const backups = listBackups();
  const files = dbFileSize();
  res.json({
    path: db.name,
    ...files,
    pageSize: db.pragma('page_size', { simple: true }),
    freelistPages: db.pragma('freelist_count', { simple: true }),
    tables: tableStats(),
    backupDir: backupDir(),
    freeBytes: freeBytes(backupDir().replace(/\/backups$/, '')),
    autoBackup: process.env.BACKUP_AUTO !== '0',
    schedule: status,
    lastBackup: backups[0] || null,
    lastAuto: backups.find((b) => b.kind === 'auto') || null,
    backupCount: backups.length,
    backupBytes: backups.reduce((n, b) => n + (b.size || 0), 0),
  });
});

// GET /backups — newest first.
router.get('/backups', (_req, res) => {
  res.json(listBackups());
});

// POST /backups — { note } → a manual backup now.
router.post('/backups', (req, res) => {
  try {
    res.status(201).json(createBackup({ kind: 'manual', userId: req.user.id, note: req.body?.note }));
  } catch (err) {
    res.status(507).json({ error: err.message });
  }
});

// GET /backups/:name/download — only names from the listing are served.
router.get('/backups/:name/download', (req, res) => {
  const file = backupPath(req.params.name);
  if (!file) return res.status(404).json({ error: 'Không tìm thấy bản sao lưu.' });
  res.download(file, req.params.name);
});

// POST /integrity — full integrity and foreign-key check of the live database.
router.post('/integrity', (_req, res) => {
  res.json(integrityReport());
});

// GET /merges — vocabulary merges, newest first; POST /merges/:id/undo.
router.get('/merges', (_req, res) => {
  res.json(mergeHistory({ limit: 200 }));
});
router.post('/merges/:id/undo', (req, res) => {
  try {
    res.json(undoMerge(Number(req.params.id), { userId: req.user.id }));
  } catch (err) {
    res.status(409).json({ error: err.message });
  }
});

export default router;
