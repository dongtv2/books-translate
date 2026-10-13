// Takes a manual backup from the command line (the server may be running):
//   npm run db:backup
import 'dotenv/config';
import { createBackup } from '../backup.js';

try {
  const b = createBackup({ kind: 'manual', note: 'dòng lệnh' });
  console.log(`✓ ${b.name}  ${(b.size / 1048576).toFixed(1)} MB  ${b.ms} ms  ${JSON.stringify(b.counts)}`);
} catch (err) {
  console.error(`✗ ${err.message}`);
  process.exit(1);
}
