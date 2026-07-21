// GET /words?lang=en&q=&sort=a-z|recent&limit=
//
// Lists the words that have been BUILT (AI-refined) in the KB, with just the basic
// info a browse row needs: word, its refined definition, and part of speech. The
// reader's Dictionary tab uses this to show the dictionary growing as words are
// refined; the full detail (verb tenses, synonyms, antonyms) is fetched per word
// via /define when a row is opened.

import { Router } from 'express';
import { getDb } from '../db.js';
import { listMisses, isRefinedLanguage } from '../generate/gapfill.js';

export const wordsRouter = Router();

// GET /words/missing?lang=en&limit=
//
// The "not processed" list: words a build asked of every source and never got an
// answer for. In practice these are proper nouns (Gringotts, Quirrell), dialect
// spellings (Hagrid's "yeh'll"), stutters ("bbook") and ingest artifacts — the
// honest residue of a book, and the shortlist a reader may want to mark Discarded.
// This route only REPORTS: it never sets a state (Discarded is manual-only).
wordsRouter.get('/words/missing', (req, res) => {
  const lang = String(req.query.lang || 'en');
  const limit = Math.min(Number(req.query.limit) || 2000, 10000);
  const words = listMisses(getDb(), lang, { limit });
  res.json({ total: words.length, words });
});

wordsRouter.get('/words', (req, res) => {
  const lang = String(req.query.lang || 'en');
  const q = String(req.query.q || '').trim().toLowerCase();
  const sort = req.query.sort === 'recent' ? 'recent' : 'a-z';
  const limit = Math.min(Number(req.query.limit) || 5000, 10000);

  const db = getDb();

  // A seeded language has no `refined` rows at all — its dictionary IS its entries
  // (see generate/gapfill.js). Listing from `refined` showed an empty Spanish
  // dictionary while the KB held thousands of Spanish definitions.
  const seeded = !isRefinedLanguage(lang);
  const params = seeded ? [lang] : [`${lang}:%`];
  let where = seeded ? 'e.lang = ?' : 'r.entry_id LIKE ?';
  if (q) {
    where += ' AND e.word LIKE ?';
    params.push(`%${q}%`);
  }

  // Seeded entries carry no build timestamp of their own; their provenance row is
  // when they were fetched, which is the same idea for a "Recent" sort.
  const from = seeded
    ? `entries e LEFT JOIN provenance p ON p.entry_id = e.id AND p.field_path = 'senses'`
    : 'refined r JOIN entries e ON e.id = r.entry_id';
  const definition = seeded
    ? '(SELECT definition FROM senses WHERE entry_id = e.id ORDER BY ord LIMIT 1)'
    : 'r.definition';
  const recentCol = seeded ? 'p.generated_at' : 'r.generated_at';
  const order = sort === 'recent' ? `${recentCol} DESC` : 'e.word ASC';

  const rows = db
    .prepare(
      `SELECT e.word AS word, e.pos AS pos, ${definition} AS definition
       FROM ${from} WHERE ${where} ORDER BY ${order} LIMIT ?`,
    )
    .all(...params, limit);
  const total = db.prepare(`SELECT COUNT(*) AS c FROM ${from} WHERE ${where}`).get(...params).c;

  res.json({
    total,
    words: rows.map((r) => ({ word: r.word, definition: r.definition, pos: JSON.parse(r.pos || '[]') })),
  });
});
