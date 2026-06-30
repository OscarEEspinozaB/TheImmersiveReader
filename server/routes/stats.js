// GET /stats?lang=en
//
// Counts about the dictionary data, for the app's Dictionary stats card. The
// headline numbers are about what the user has BUILT (the refined table): how many
// words, how many carry synonyms/antonyms, how many were built recently, and by
// which model — plus the raw KB base size for context, and the most recent builds.

import { Router } from 'express';
import { getDb } from '../db.js';

export const statsRouter = Router();

const DAY = 86400000;

statsRouter.get('/stats', (req, res) => {
  const lang = String(req.query.lang || 'en');
  const db = getDb();
  const like = `${lang}:%`;
  const now = Date.now();

  const one = (sql, ...params) => db.prepare(sql).get(...params).c;

  const refined = one('SELECT COUNT(*) AS c FROM refined WHERE entry_id LIKE ?', like);
  const withSynonyms = one(
    "SELECT COUNT(*) AS c FROM refined WHERE entry_id LIKE ? AND synonyms <> '[]'",
    like,
  );
  const withAntonyms = one(
    "SELECT COUNT(*) AS c FROM refined WHERE entry_id LIKE ? AND antonyms <> '[]'",
    like,
  );
  const builtToday = one(
    'SELECT COUNT(*) AS c FROM refined WHERE entry_id LIKE ? AND generated_at >= ?',
    like,
    now - DAY,
  );
  const builtWeek = one(
    'SELECT COUNT(*) AS c FROM refined WHERE entry_id LIKE ? AND generated_at >= ?',
    like,
    now - 7 * DAY,
  );
  const lastBuiltAt = db
    .prepare('SELECT MAX(generated_at) AS c FROM refined WHERE entry_id LIKE ?')
    .get(like).c;

  const byModel = db
    .prepare(
      'SELECT COALESCE(model, $unknown) AS model, COUNT(*) AS count FROM refined ' +
        'WHERE entry_id LIKE $like GROUP BY model ORDER BY count DESC',
    )
    .all({ like, unknown: '(unknown)' });

  const recent = db
    .prepare(
      `SELECT e.word AS word, r.definition AS definition, r.generated_at AS at
       FROM refined r JOIN entries e ON e.id = r.entry_id
       WHERE r.entry_id LIKE ? ORDER BY r.generated_at DESC LIMIT 8`,
    )
    .all(like);

  // Raw KB base (the offline Kaikki data the refined entries draw from).
  const baseEntries = one('SELECT COUNT(*) AS c FROM entries WHERE lang = ?', lang);

  res.json({
    lang,
    refined,
    withSynonyms,
    withAntonyms,
    builtToday,
    builtWeek,
    lastBuiltAt,
    byModel,
    recent,
    baseEntries,
  });
});
