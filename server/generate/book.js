// Batch dictionary builder for a whole study book.
//
//   node server/generate/book.js <file> [--lang en] [--limit N] [--min-count M] [--force]
//   npm run build:book -- "Book 1 - The Philosopher's Stone.pdf"
//
// Extracts the book's text (PDF via pdfjs, or plain .txt/.md), counts word
// frequencies, and refines + stores each unique word MOST-FREQUENT FIRST — so the
// words you actually read most are built first and you can stop any time. The job
// is resumable: already-refined words are skipped, so re-running continues where
// it left off. CPU inference is slow (~5–15s per new word), so a full book is a
// multi-hour background job; --limit builds just the top N words.

import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { normalize } from '../../src/normalize.js';
import { getDb } from '../db.js';
import { refineWords } from './build.js';
import { extractPdfText } from '../ingest/pdfText.js';

function parseArgs(argv) {
  const opts = { lang: 'en', file: null, limit: 0, minCount: 1, force: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--force') opts.force = true;
    else if (a === '--lang') opts.lang = argv[++i];
    else if (a === '--limit') opts.limit = Number(argv[++i]) || 0;
    else if (a === '--min-count') opts.minCount = Number(argv[++i]) || 1;
    else if (!opts.file) opts.file = a;
  }
  return opts;
}

async function loadText(file) {
  return extname(file).toLowerCase() === '.pdf'
    ? extractPdfText(file)
    : readFileSync(file, 'utf8');
}

// Unique words ordered by descending frequency, filtered by --min-count / --limit.
function orderByFrequency(text, { minCount, limit }) {
  const counts = new Map();
  for (const tok of text.split(/\s+/)) {
    const w = normalize(tok);
    if (w) counts.set(w, (counts.get(w) || 0) + 1);
  }
  let words = [...counts.entries()]
    .filter(([, c]) => c >= minCount)
    .sort((a, b) => b[1] - a[1])
    .map(([w]) => w);
  if (limit > 0) words = words.slice(0, limit);
  return { words, totalUnique: counts.size };
}

const opts = parseArgs(process.argv.slice(2));
if (!opts.file) {
  console.error('Usage: node server/generate/book.js <file> [--lang en] [--limit N] [--min-count M] [--force]');
  process.exit(1);
}

console.log(`Reading ${opts.file} …`);
const text = await loadText(opts.file);
const { words, totalUnique } = orderByFrequency(text, opts);
console.log(
  `${totalUnique.toLocaleString()} unique words; building ${words.length.toLocaleString()} ` +
    `(lang=${opts.lang}, min-count=${opts.minCount}${opts.limit ? `, limit=${opts.limit}` : ''}` +
    `${opts.force ? ', force' : ''}). Already-refined words are skipped.\n`,
);

const db = getDb();
const total = words.length;
const started = Date.now();
let done = 0;
const counts = { refined: 0, skipped: 0, absent: 0, failed: 0 };

await refineWords({
  db,
  lang: opts.lang,
  words,
  force: opts.force,
  onResult: (r) => {
    done += 1;
    counts[r.status] = (counts[r.status] || 0) + 1;
    if (r.status === 'skipped') return; // already built — keep the log quiet
    const perWord = (Date.now() - started) / done;
    const etaMin = ((total - done) * perWord) / 60000;
    const tag = r.status.toUpperCase().padEnd(7);
    const def = r.definition ? `  ${r.definition}` : '';
    console.log(`[${done}/${total}] ${tag} ${r.word}${def}  (~${etaMin.toFixed(0)}m left)`);
  },
});

const secs = ((Date.now() - started) / 1000).toFixed(0);
console.log(`\nDone in ${secs}s:`, counts);
db.close();
