import 'dotenv/config';
import express from 'express';
import compression from 'compression';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

import vocabularyRouter from './routes/vocabulary.js';
import booksRouter from './routes/books.js';
import partsRouter from './routes/parts.js';
import chaptersRouter from './routes/chapters.js';
import sectionsRouter from './routes/sections.js';
import paragraphsRouter from './routes/paragraphs.js';
import assistantRouter from './routes/assistant.js';
import importRouter from './routes/import.js';
import settingsRouter from './routes/settings.js';
import promptsRouter from './routes/prompts.js';
import ttsRouter from './routes/tts.js';
import authRouter, { announceSetupTokenIfNeeded } from './routes/auth.js';
import adminRouter from './routes/admin.js';
import meRouter from './routes/me.js';
import discussionsRouter from './routes/discussions.js';
import glossaryRouter from './routes/glossary.js';
import assignmentsRouter from './routes/assignments.js';
import activityRouter from './routes/activity.js';
import databaseRouter from './routes/database.js';
import genresRouter from './routes/genres.js';
import { startBackupSchedule } from './backup.js';
import { authenticate, authorize } from './auth/middleware.js';
import { activityMiddleware, startBackgroundJobs as startActivityLog } from './activityLog.js';
import { guardBookContent } from './bookAccess.js';
import { errorHandler, rateLimits, securityHeaders } from './security.js';
import './db.js'; // ensure schema is created on boot

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.disable('x-powered-by');

// Behind a reverse proxy (Cloudflare / nginx) in production: trust its
// X-Forwarded-* headers for the client IP and https detection. Set
// TRUST_PROXY=0 when the server is exposed directly.
app.set('trust proxy', process.env.TRUST_PROXY === '0' ? false : 'loopback, linklocal, uniquelocal');
// No CORS: the frontend is served from the same origin (Vite proxies /api in
// development), and cross-origin access to a signed-in session is unwanted.
const distDir = path.join(__dirname, '..', 'dist');
// Security headers on every response (server/security.js); the CSP allows
// the built index.html's inline theme script by hash.
app.use(securityHeaders({ indexHtml: path.join(distDir, 'index.html') }));
// gzip/brotli for JSON, HTML, JS, CSS (a long chapter: ~330 KB → ~60 KB);
// images and audio pass through untouched.
app.use(compression({ threshold: 1024 }));
app.use(express.json({ limit: '5mb' }));

// Every /api request: note it for the activity log if it changes something
// (server/activityLog.js — written after the response, never blocks it),
// identify the user from the session cookie, then check the route's
// permission (server/auth/permissions.js), then hide books the user may not
// see (server/bookAccess.js). /api/auth/* and /api/health are public.
app.use('/api', activityMiddleware, authenticate, authorize, guardBookContent, rateLimits);
app.use('/api/auth', authRouter);
app.use('/api/admin/activity', activityRouter);
app.use('/api/admin/database', databaseRouter);
app.use('/api/admin', adminRouter);
app.use('/api/me', meRouter);

app.use('/api/vocabulary', vocabularyRouter);
app.use('/api/books', booksRouter);
app.use('/api/parts', partsRouter);
app.use('/api/chapters', chaptersRouter);
app.use('/api/sections', sectionsRouter);
app.use('/api/paragraphs', assistantRouter);
app.use('/api/paragraphs', paragraphsRouter);
app.use('/api/import', importRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/prompts', promptsRouter);
app.use('/api/tts', ttsRouter);
app.use('/api/discussions', discussionsRouter);
app.use('/api/glossary', glossaryRouter);
app.use('/api/genres', genresRouter);
app.use('/api/assignments', assignmentsRouter);

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, hasApiKey: Boolean(process.env.ANTHROPIC_API_KEY) });
});

// Unknown API paths answer JSON, not the app's HTML.
app.use('/api', (_req, res) => res.status(404).json({ error: 'Không tìm thấy.' }));

// Serve the built frontend in production (`npm run build` then `npm start`).
// Vite names built assets by content hash, so they are cached for a year;
// index.html is revalidated every time, so a new build shows up at once.
if (fs.existsSync(distDir)) {
  app.use('/assets', express.static(path.join(distDir, 'assets'), { immutable: true, maxAge: '1y', index: false, fallthrough: false }));
  app.use(express.static(distDir, {
    index: false,
    maxAge: '1d',
    setHeaders: (res, file) => { if (file.endsWith('.html')) res.set('Cache-Control', 'no-cache'); },
  }));
  app.get('/{*splat}', (_req, res) => {
    res.set('Cache-Control', 'no-cache');
    res.sendFile(path.join(distDir, 'index.html'));
  });
}

// Last: errors become a JSON answer without internals (security.js).
app.use(errorHandler);

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Books Translate API đang chạy tại http://localhost:${PORT}`);
  announceSetupTokenIfNeeded();
  startActivityLog();
  startBackupSchedule();
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('⚠️  ANTHROPIC_API_KEY chưa được cấu hình — tính năng dịch sẽ báo lỗi. Xem .env.example.');
  }
});
