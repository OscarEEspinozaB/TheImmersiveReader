// Building a book's dictionary FROM THE APP: how much of a server book is already
// refined, and the background job that refines the rest.
//
// The batch CLI (book.js) does the same work from a terminal on the home machine —
// which means only the person sitting at that machine can do it. A book that is
// already in the server library is already a processed `.tir`, so the server can
// read its text, ask what it costs, and build it on request from any device.
//
// Nothing here ingests anything: the `.tir` was produced by the client (the
// invariant holds), and this only reads its text.txt with the same segmenter the
// reader uses, so the words match exactly what will be clickable on the page.
//
// ONE job at a time, on purpose. The bottleneck is CPU inference (5-25 s per word);
// two books in parallel would not go faster, they would just heat the machine and
// make both slower. Every entry commits as it is written, so stopping is free and
// resuming costs nothing — progress is derived from the KB, never from memory.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { unzipSync, strFromU8 } from 'fflate';
import { extractWords } from '../../src/words.js';
import { getDb } from '../db.js';
import { getLibraryDb, BOOKS_DIR } from '../library-db.js';
import { refineWords, refineTarget } from './build.js';
import { isRefinedLanguage } from './gapfill.js';
import { REFINE_REV, REFINE_MODEL } from './ollama.js';
import { kbLog, KB_COLORS as C } from '../log.js';

// Words per chunk, and the breather between chunks. The pause is the "less heavy"
// part: it gives the CPU (and the rest of the LAN service) room between bursts, at
// a cost of a few seconds over a job that takes hours anyway.
const CHUNK = 25;
const BREATHER_MS = 1500;

const tirPath = (id) => join(BOOKS_DIR, `${id}.tir`);

/**
 * The lemmas a book is made of, in reading order — cached in library.sqlite. This
 * is the honest measure of what a book costs: "aim", "aimed", "aiming" and "aims"
 * are ONE entry to build, not four.
 * @returns {{ lang: string, lemmas: string[], words: number } | null} null if the
 *   book (or its payload) is gone.
 */
export function bookLemmas(bookId) {
  const lib = getLibraryDb();
  const book = lib.prepare('SELECT id, lang FROM books WHERE id = ?').get(bookId);
  if (!book) return null;
  const lang = book.lang || 'en';

  const cached = lib.prepare('SELECT lang, lemmas, words FROM book_lemmas WHERE book_id = ?').get(bookId);
  if (cached && cached.lang === lang) {
    return { lang, lemmas: JSON.parse(cached.lemmas), words: cached.words };
  }

  const path = tirPath(bookId);
  if (!existsSync(path)) return null;
  let text = '';
  try {
    const files = unzipSync(new Uint8Array(readFileSync(path)));
    text = files['text.txt'] ? strFromU8(files['text.txt']) : '';
  } catch {
    return null; // a corrupt payload is not worth failing the shelf for
  }

  const db = getDb();
  const seenWords = new Set();
  const seenLemmas = new Set();
  const lemmas = [];
  for (const w of extractWords(text, lang)) {
    if (seenWords.has(w)) continue;
    seenWords.add(w);
    const lemma = refineTarget(db, lang, w);
    if (seenLemmas.has(lemma)) continue;
    seenLemmas.add(lemma);
    lemmas.push(lemma);
  }

  lib
    .prepare(
      `INSERT INTO book_lemmas (book_id, lang, lemmas, words, computed_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(book_id) DO UPDATE SET
         lang = excluded.lang, lemmas = excluded.lemmas,
         words = excluded.words, computed_at = excluded.computed_at`,
    )
    .run(bookId, lang, JSON.stringify(lemmas), seenWords.size, Date.now());

  return { lang, lemmas, words: seenWords.size };
}

/**
 * The lemmas of this book that still need building (under the CURRENT contract).
 *
 * What "built" MEANS depends on the language. An English book is built when its
 * words carry an AI-refined entry. A non-English book is never refined — the
 * refiner writes simple English, and a Spanish word's definition should stay
 * Spanish — so there it means the KB simply HAS the word, seeded from that
 * language's own Wiktionary (generate/gapfill.js). Measuring non-English books by
 * the `refined` table would peg them at 0% forever.
 */
function isBuiltCheck(db, lang) {
  if (isRefinedLanguage(lang)) {
    const isRefined = db.prepare('SELECT 1 FROM refined WHERE entry_id = ? AND rev >= ?');
    // Ask about the entry that HOLDS THE MEANING, which for an inflected form is its
    // lemma: "bore" never gets a refined row, it is served bear's (the same
    // refineTarget the build itself uses). Checking only the surface form leaves
    // words pending that have nothing left to build — a `book_lemmas` cache computed
    // before the inflections table was rebuilt is full of exactly those, which is
    // how a finished book sat at "20 words left" forever.
    //
    // Two tiers, because this runs for every lemma of every book on a shelf render:
    // the direct hit answers most words with one indexed lookup, and only the residue
    // pays for lemma resolution. Resolving every word up front measured 13x slower
    // (2.7 s vs 0.2 s across the library) — enough to leave the shelf looking like it
    // never finished loading.
    return (w) => {
      if (isRefined.get(`${lang}:${w}`, REFINE_REV)) return true;
      const lemma = refineTarget(db, lang, w);
      return lemma !== w && !!isRefined.get(`${lang}:${lemma}`, REFINE_REV);
    };
  }
  // Seeded languages store one entry per word, so there is no lemma to resolve to.
  const hasEntry = db.prepare('SELECT 1 FROM entries WHERE id = ?');
  return (w) => !!hasEntry.get(`${lang}:${w}`);
}

/**
 * Split a book's lemmas into what is built, what no dictionary has, and what is
 * genuinely left to do.
 *
 * A confirmed miss is DONE, not pending. Every source was asked and answered "no
 * such word" (generate/gapfill.js keeps that apart from "could not ask"), so there
 * is no work left on it — a novel's invented names and dialect spellings are a
 * permanent residue, ~150 per Harry Potter book. Counting them as pending forever
 * would park every book just short of 100% and claim work that does not exist.
 * They stay VISIBLE as their own number rather than being folded into `built`.
 */
function splitLemmas(lang, lemmas) {
  const db = getDb();
  const isBuilt = isBuiltCheck(db, lang);
  const isMiss = db.prepare('SELECT 1 FROM gapfill_misses WHERE lang = ? AND word = ?');
  const built = [];
  const missing = [];
  const pending = [];
  for (const w of lemmas) {
    if (isBuilt(w)) built.push(w);
    else if (isMiss.get(lang, w)) missing.push(w);
    else pending.push(w);
  }
  return { built, missing, pending };
}

/**
 * How much of a book's dictionary is already built. `pct` is how much has been
 * PROCESSED — built plus the words no dictionary anywhere has — so a finished book
 * reads 100% and `missing` says how much of that was unresolvable.
 * @returns {{ words: number, total: number, built: number, missing: number,
 *   pending: number, pct: number } | null}
 */
export function coverage(bookId) {
  const info = bookLemmas(bookId);
  if (!info) return null;
  const { built, missing, pending } = splitLemmas(info.lang, info.lemmas);
  const total = info.lemmas.length;
  // 100% is reserved for "nothing left": rounding 99.51% up to it (4097 of 4117
  // processed, 20 still to build) claims a finished book and reads as a bug next to
  // the "20 words left" beside it. Round DOWN while anything is pending.
  const processed = total - pending.length;
  const pct = !total || !pending.length ? 100 : Math.min(99, Math.floor((processed / total) * 100));

  return {
    words: info.words,
    total,
    built: built.length,
    missing: missing.length,
    pending: pending.length,
    pct,
  };
}

// --- The job -----------------------------------------------------------------

/** @type {{ bookId: string, title: string, total: number, done: number, current: string, failed: number, startedAt: number, stopping: boolean } | null} */
let job = null;

/** What the app polls: the running job, or null when the machine is idle. */
export function jobStatus() {
  if (!job) return null;
  const elapsed = Date.now() - job.startedAt;
  const perWord = job.done ? elapsed / job.done : 0;
  return {
    bookId: job.bookId,
    title: job.title,
    total: job.total,
    done: job.done,
    failed: job.failed,
    current: job.current,
    stopping: job.stopping,
    // Only an estimate, and an honest one: it is whatever the last words took.
    etaMs: perWord ? Math.round((job.total - job.done) * perWord) : null,
  };
}

/** Ask the running job to stop after the word it is on. Finished words are kept. */
export function stopJob() {
  if (job) job.stopping = true;
  return jobStatus();
}

/**
 * Start building a book's pending dictionary in the background.
 * @returns {{ started: boolean, reason?: string, status: object | null }}
 */
export function startJob(bookId, { model = REFINE_MODEL } = {}) {
  if (job) {
    return {
      started: false,
      reason: job.bookId === bookId ? 'already-running' : 'busy',
      status: jobStatus(),
    };
  }
  const lib = getLibraryDb();
  const book = lib.prepare('SELECT id, title, lang FROM books WHERE id = ?').get(bookId);
  if (!book) return { started: false, reason: 'not-found', status: null };

  const info = bookLemmas(bookId);
  if (!info) return { started: false, reason: 'no-payload', status: null };
  // Only genuinely unresolved words are queued: a confirmed miss would just be
  // skipped word by word, and counting it here would make the job's own progress
  // bar promise work it cannot do.
  const { pending } = splitLemmas(info.lang, info.lemmas);
  if (!pending.length) return { started: false, reason: 'nothing-pending', status: null };

  job = {
    bookId,
    title: book.title || 'Untitled',
    total: pending.length,
    done: 0,
    failed: 0,
    current: '',
    startedAt: Date.now(),
    stopping: false,
  };

  // Fire and forget: the HTTP request that started it returns immediately, and the
  // app follows the work by polling the status.
  run(info.lang, pending, model).catch((err) => {
    console.error('book build failed:', err);
    job = null;
  });
  return { started: true, status: jobStatus() };
}

async function run(lang, pending, model) {
  const db = getDb();
  const active = job;
  kbLog(C.yellow, 'BUILDING', active.title, `${pending.length} words`);

  // One word per call, so "stop" means the word it is on and not the chunk it is
  // in: a chunk of 25 would take minutes to abandon, which is not a stop button.
  for (let i = 0; i < pending.length && !active.stopping; i += 1) {
    await refineWords({
      db,
      lang,
      words: [pending[i]],
      model,
      onStart: (word) => {
        active.current = word;
      },
      onResult: (r) => {
        active.done += 1;
        if (r.status === 'failed' || r.status === 'absent') active.failed += 1;
      },
    });
    // A breather every CHUNK words: this runs on the machine the household also
    // uses, and inference pins a core for as long as it lasts.
    const last = i === pending.length - 1;
    if (!active.stopping && !last && (i + 1) % CHUNK === 0) {
      await new Promise((resolve) => setTimeout(resolve, BREATHER_MS));
    }
  }

  kbLog(
    C.green,
    active.stopping ? 'STOPPED' : 'BUILT',
    active.title,
    `${active.done}/${active.total} words`,
  );
  job = null;
}
