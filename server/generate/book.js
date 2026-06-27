// Batch dictionary builder for a whole study book.
//
//   node server/generate/book.js <file> [--batch N] [--lang en] [--limit N] [--min-count M] [--force]
//   npm run build:book -- "Book 1 - The Philosopher's Stone.pdf" --batch 500
//
// Extracts the book's text (PDF via pdfjs, or plain .txt/.md) and refines + stores
// each unique word IN READING ORDER (the order it first appears in the book) — a
// book is read front to back, so the dictionary is built the same way you'll meet
// the words. The job is resumable: already-refined words are dropped before
// processing, so each run works on PENDING words only.
//
// --batch N is the key knob: send the next N PENDING (not-yet-refined) words to
// process, regardless of how many are already done. Re-running grabs the next N.
// --by-frequency orders by most-frequent-first instead (useful for non-book text,
// not for reading a book). CPU inference is slow (~5–15s/word), full book ~hours.

import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { normalize } from '../../src/normalize.js';
import { getDb } from '../db.js';
import { refineWords } from './build.js';
import { extractPdfText } from '../ingest/pdfText.js';

function parseArgs(argv) {
  const opts = { lang: 'en', file: null, batch: 0, limit: 0, minCount: 1, force: false, byFrequency: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--force') opts.force = true;
    else if (a === '--by-frequency') opts.byFrequency = true;
    else if (a === '--lang') opts.lang = argv[++i];
    else if (a === '--batch') opts.batch = Number(argv[++i]) || 0;
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

// Unique words in READING ORDER (first appearance) by default, or by descending
// frequency with --by-frequency. Filtered by --min-count, then capped by --limit.
function orderWords(text, { minCount, limit, byFrequency }) {
  const counts = new Map();
  const appearance = []; // each word once, in the order it first appears
  for (const tok of text.split(/\s+/)) {
    const w = normalize(tok);
    if (!w) continue;
    if (!counts.has(w)) {
      counts.set(w, 0);
      appearance.push(w);
    }
    counts.set(w, counts.get(w) + 1);
  }
  const base = byFrequency
    ? [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([w]) => w)
    : appearance;
  let words = base.filter((w) => counts.get(w) >= minCount);
  if (limit > 0) words = words.slice(0, limit);
  return { words, totalUnique: counts.size };
}

const opts = parseArgs(process.argv.slice(2));
if (!opts.file) {
  console.error('Usage: node server/generate/book.js <file> [--lang en] [--limit N] [--min-count M] [--force]');
  process.exit(1);
}

console.log(`Reading ${opts.file} …`);
const db = getDb();
const text = await loadText(opts.file);
const { words, totalUnique } = orderWords(text, opts);

// Drop already-refined words BEFORE the batch cap, so --batch counts PENDING words
// to process — not how many get skipped. With --force, everything is a candidate.
const hasRefined = db.prepare('SELECT 1 FROM refined WHERE entry_id = ?');
const pendingAll = opts.force
  ? words
  : words.filter((w) => !hasRefined.get(`${opts.lang}:${w}`));
const toProcess = opts.batch > 0 ? pendingAll.slice(0, opts.batch) : pendingAll;

console.log(
  `${totalUnique.toLocaleString()} unique words · ` +
    `${(words.length - pendingAll.length).toLocaleString()} already refined · ` +
    `${pendingAll.length.toLocaleString()} pending → processing ${toProcess.length.toLocaleString()} this run ` +
    `(order=${opts.byFrequency ? 'frequency' : 'reading'}, lang=${opts.lang}, min-count=${opts.minCount}` +
    `${opts.limit ? `, limit=${opts.limit}` : ''}${opts.batch ? `, batch=${opts.batch}` : ''}` +
    `${opts.force ? ', force' : ''}).\n`,
);

if (!toProcess.length) {
  console.log('Nothing pending. Increase --batch, raise --limit, or use --force.');
  db.close();
  process.exit(0);
}

const total = toProcess.length;
const started = Date.now();
let done = 0;
const counts = { refined: 0, skipped: 0, absent: 0, failed: 0 };

await refineWords({
  db,
  lang: opts.lang,
  words: toProcess,
  force: opts.force,
  onResult: (r) => {
    done += 1;
    counts[r.status] = (counts[r.status] || 0) + 1;
    if (r.status === 'skipped') return; // (only possible with --force) keep it quiet
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
