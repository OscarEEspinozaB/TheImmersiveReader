// Build-and-store CLI:  node server/generate/run.js [lang] < text
//   echo "some text" | node server/generate/run.js en
//   node server/generate/run.js en path/to/chapter.txt
//
// Tokenizes the input text, then refines + stores every unique word that is not
// already refined. CPU inference is slow (~10–25s/word), so this is a background
// job — each word is committed immediately, so it can be stopped and resumed.

import { readFileSync } from 'node:fs';
import { getDb } from '../db.js';
import { refineWords } from './build.js';

const lang = process.argv[2] || 'en';
const fileArg = process.argv[3];

const text = fileArg ? readFileSync(fileArg, 'utf8') : readFileSync(0, 'utf8');
const words = text.split(/\s+/).filter(Boolean);
if (!words.length) {
  console.error('No input text. Pipe text in or pass a file path.');
  process.exit(1);
}

const db = getDb();
const started = Date.now();
let done = 0;
const counts = { refined: 0, skipped: 0, absent: 0, failed: 0 };

console.log(`Refining ${lang} from ${words.length} tokens …`);
await refineWords({
  db,
  lang,
  words,
  onResult: (r) => {
    counts[r.status] = (counts[r.status] || 0) + 1;
    done += 1;
    const tag = r.status.toUpperCase().padEnd(8);
    const extra = r.definition ? ` — ${r.definition}` : '';
    console.log(`  [${done}] ${tag} ${r.word}${extra}`);
  },
});

const secs = ((Date.now() - started) / 1000).toFixed(1);
console.log(`\nDone in ${secs}s:`, counts);
db.close();
