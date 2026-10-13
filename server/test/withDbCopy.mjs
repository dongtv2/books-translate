// Runs a test script against a throwaway copy of the database, for tests
// that expect BOOKS_DB_PATH to be set by the caller:
//   node server/test/withDbCopy.mjs server/workflow/test/engine.test.mjs
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-copy-'));
try {
  await new Database(process.env.SOURCE_DB || path.join(root, 'server/data/books.db'), { readonly: true }).backup(path.join(tmp, 'books.db'));
  const r = spawnSync(process.execPath, process.argv.slice(2), {
    cwd: root, stdio: 'inherit',
    env: { ...process.env, BOOKS_DB_PATH: path.join(tmp, 'books.db'), BACKUP_DIR: path.join(tmp, 'backups'), BACKUP_AUTO: '0', COVER_DIR: path.join(tmp, 'covers') },
  });
  process.exitCode = r.status ?? 1;
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
