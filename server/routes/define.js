// GET /define?word=run&lang=en
//
// Pure read-through of the KB: normalize the word, build the `${lang}:${word}` id,
// assemble the entry from entries + senses + inflections + relations, and return
// it. 404 on a miss — this milestone does no generation, so the reader's existing
// on-demand provider chain stays the fallback for anything not in the dataset.

import { Router } from 'express';
import { normalize } from '../../src/normalize.js';
import { getDb } from '../db.js';

export const defineRouter = Router();

defineRouter.get('/define', (req, res) => {
  const lang = String(req.query.lang || 'en');
  const word = normalize(String(req.query.word || ''));
  if (!word) return res.status(400).json({ error: 'word required' });

  const db = getDb();
  const id = `${lang}:${word}`;
  const entry = db.prepare('SELECT id, lang, word, pos FROM entries WHERE id = ?').get(id);
  if (!entry) return res.status(404).json({ error: 'not found' });

  const senses = db
    .prepare('SELECT id, definition, example, ord FROM senses WHERE entry_id = ? ORDER BY ord')
    .all(id);
  const relStmt = db.prepare('SELECT to_word, type FROM relations WHERE from_sense = ?');
  const inflections = db.prepare('SELECT tag, form FROM inflections WHERE entry_id = ?').all(id);

  res.json({
    entry: {
      id: entry.id,
      lang: entry.lang,
      word: entry.word,
      pos: JSON.parse(entry.pos || '[]'),
      inflections,
      senses: senses.map((s) => {
        const relations = relStmt.all(s.id);
        return {
          definition: s.definition,
          example: s.example || undefined,
          synonyms: relations.filter((r) => r.type === 'synonym').map((r) => r.to_word),
          antonyms: relations.filter((r) => r.type === 'antonym').map((r) => r.to_word),
        };
      }),
    },
  });
});
