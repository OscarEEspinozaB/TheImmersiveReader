// Rebuild ONLY the inflections table:  node server/ingest/forms.js [lang]
//
// The full ingest (run.js) rewrites entries, senses and relations too — hours of
// work to redo when all that changed is how a form is labelled. This pass streams
// the same dump but writes nothing except `inflections`, so the AI-refined entries
// and the relation graph are left completely untouched. Run it after any change to
// the form-labelling rules (or to the curated closed-class table).

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { normalize } from '../../src/normalize.js';
import { getDb } from '../db.js';
import { inflectionsOf } from './kaikki.js';
import { curatedLemmas, seedCurated } from '../paradigms.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const lang = process.argv[2] || 'en';
const file = process.env.KAIKKI_FILE || join(__dirname, '..', '..', 'data', `kaikki-${lang}.jsonl`);

if (!existsSync(file)) {
  console.error(`Dump not found: ${file} (set KAIKKI_FILE=/path/to/dump.jsonl)`);
  process.exit(1);
}

const db = getDb();
const curated = curatedLemmas(lang);

// The dump lists an entry's forms under other entries too, so a partial rebuild
// would leave stale rows behind: start from an empty table for this language.
db.prepare('DELETE FROM inflections WHERE entry_id LIKE ?').run(`${lang}:%`);

// Only insert a form for a word that HAS an entry — the FK would otherwise point
// nowhere, and a form whose lemma we can't define is of no use to the reader.
const hasEntry = db.prepare('SELECT 1 FROM entries WHERE id = ?').pluck();
const insert = db.prepare(
  'INSERT OR IGNORE INTO inflections (entry_id, pos, tag, form, curated) VALUES (?, ?, ?, ?, 0)',
);

const stats = { lines: 0, forms: 0 };
const flush = db.transaction((objs) => {
  for (const obj of objs) {
    const word = normalize(obj?.word || '');
    if (!word || /\s/.test(obj.word)) continue;
    const id = `${lang}:${word}`;
    if (!hasEntry.get(id)) continue;
    for (const { pos, tag, form } of inflectionsOf(obj, curated, word)) {
      if (insert.run(id, pos, tag, form).changes) stats.forms += 1;
    }
  }
});

console.log(`Rebuilding ${lang} inflections from ${file} …`);
const started = Date.now();
const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });

const BATCH = 2000;
let batch = [];
for await (const line of rl) {
  stats.lines += 1;
  // Cheap prefilter: a line with no forms[] can't contribute one, and skipping
  // its JSON.parse is most of the runtime saved on a 3 GB dump.
  if (line.includes('"forms"')) {
    try {
      batch.push(JSON.parse(line));
    } catch {
      continue; // tolerate a stray malformed line
    }
  }
  if (batch.length >= BATCH) {
    flush(batch);
    batch = [];
    process.stdout.write(`\r  ${stats.lines.toLocaleString()} lines · ${stats.forms.toLocaleString()} forms`);
  }
}
if (batch.length) flush(batch);

const seeded = seedCurated(db, lang);
const secs = ((Date.now() - started) / 1000).toFixed(1);
console.log(
  `\nDone in ${secs}s: ${stats.forms.toLocaleString()} forms from the dump + ` +
    `${seeded.forms} curated (${seeded.paradigms} curated paradigms).`,
);
db.close();
