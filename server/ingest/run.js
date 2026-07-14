// One-shot ingestion CLI:  node server/ingest/run.js [lang]
//
// Reads data/kaikki-<lang>.jsonl into the KB. Defaults to English. Run once per
// language whenever you drop in a fresh dump.

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { getDb } from '../db.js';
import { ingestKaikki } from './kaikki.js';
import { seedCurated } from '../paradigms.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const lang = process.argv[2] || 'en';
const file = process.env.KAIKKI_FILE || join(__dirname, '..', '..', 'data', `kaikki-${lang}.jsonl`);

if (!existsSync(file)) {
  console.error(`Dump not found: ${file}`);
  console.error(`Download the Wiktextract (Kaikki.org) ${lang} dump and place it there, ` +
    `or set KAIKKI_FILE=/path/to/dump.jsonl`);
  process.exit(1);
}

console.log(`Ingesting ${lang} from ${file} …`);
const db = getDb();
const started = Date.now();
const stats = await ingestKaikki({
  lang,
  file,
  db,
  onProgress: (n) => process.stdout.write(`\r  ${n.toLocaleString()} lines`),
});
// The hand-written paradigms overwrite whatever the dump left on the pronouns,
// BE/HAVE/DO and the modals — they are the words a wrong grouping would hurt most.
const seeded = seedCurated(db, lang);
const secs = ((Date.now() - started) / 1000).toFixed(1);
console.log(`\nDone in ${secs}s:`, { ...stats, curatedForms: seeded.forms });
db.close();
