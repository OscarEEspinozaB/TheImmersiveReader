// GET /words?lang=en&q=&sort=a-z|recent&limit=
//
// Lists the words that have been BUILT (AI-refined) in the KB, with just the basic
// info a browse row needs: word, its refined definition, and part of speech. The
// reader's Dictionary tab uses this to show the dictionary growing as words are
// refined; the full detail (verb tenses, synonyms, antonyms) is fetched per word
// via /define when a row is opened.

import { Router } from 'express';
import { getDb } from '../db.js';

export const wordsRouter = Router();

wordsRouter.get('/words', (req, res) => {
  const lang = String(req.query.lang || 'en');
  const q = String(req.query.q || '').trim().toLowerCase();
  const sort = req.query.sort === 'recent' ? 'recent' : 'a-z';
  const limit = Math.min(Number(req.query.limit) || 5000, 10000);

  const db = getDb();
  const params = [`${lang}:%`];
  let where = 'r.entry_id LIKE ?';
  if (q) {
    where += ' AND e.word LIKE ?';
    params.push(`%${q}%`);
  }
  const order = sort === 'recent' ? 'r.generated_at DESC' : 'e.word ASC';

  const rows = db
    .prepare(
      `SELECT e.word AS word, e.pos AS pos, r.definition AS definition
       FROM refined r JOIN entries e ON e.id = r.entry_id
       WHERE ${where} ORDER BY ${order} LIMIT ?`,
    )
    .all(...params, limit);
  const total = db
    .prepare(`SELECT COUNT(*) AS c FROM refined r JOIN entries e ON e.id = r.entry_id WHERE ${where}`)
    .get(...params).c;

  res.json({
    total,
    words: rows.map((r) => ({ word: r.word, definition: r.definition, pos: JSON.parse(r.pos || '[]') })),
  });
});
