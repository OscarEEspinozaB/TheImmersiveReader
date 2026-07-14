// GET /define?word=run&lang=en
//
// Read-through of the KB: normalize the word, resolve it to the entry its MEANING
// lives under, assemble that entry (senses + refined + relations) and return it
// together with the grammar that explains the link (`formOf`, `family`). 404 on a
// miss — this route does no generation, so the reader's provider chain stays the
// fallback for anything not in the dataset.
//
// The meaning of an inflected form lives on its LEMMA. Asking for "aimed" returns
// aim's definition under a "Past tense of aim" banner: an inflected form is not a
// word of its own, and refining each one separately gave five mediocre entries
// (the synonyms stored for "aimed" — shot, hit, struck — were plainly worse than
// aim's) where one good entry was needed. `word` stays the word that was ASKED
// for, so the client keeps caching and coloring per surface form.

import { Router } from 'express';
import { normalize } from '../../src/normalize.js';
import { getDb } from '../db.js';
import { formOf, family } from '../lemma.js';
import { kbLog, KB_COLORS as C } from '../log.js';

export const defineRouter = Router();

defineRouter.get('/define', (req, res) => {
  const lang = String(req.query.lang || 'en');
  const word = normalize(String(req.query.word || ''));
  if (!word) return res.status(400).json({ error: 'word required' });

  const db = getDb();

  // Grammar first: it decides which entry to serve.
  const inflected = formOf(db, lang, word);
  const forms = family(db, lang, word);
  const head = inflected ? inflected.lemma : word; // the entry that holds the meaning
  const id = `${lang}:${head}`;

  const entry = db.prepare('SELECT id, lang, word, pos FROM entries WHERE id = ?').get(id);
  if (!entry) {
    kbLog(C.red, 'MISS', word);
    return res.status(404).json({ error: 'not found' });
  }

  const senses = db
    .prepare('SELECT id, definition, example, ord FROM senses WHERE entry_id = ? ORDER BY ord')
    .all(id);
  const relStmt = db.prepare('SELECT to_word, type FROM relations WHERE from_sense = ?');
  const inflections = db.prepare('SELECT tag, form FROM inflections WHERE entry_id = ?').all(id);

  // The AI-refined "clean" definition, if this entry has been built (read-through).
  // When present it is the entry's primary definition; the raw senses stay below.
  const refinedRow = db
    .prepare('SELECT definition, synonyms, antonyms, model FROM refined WHERE entry_id = ?')
    .get(id);
  const refined = refinedRow
    ? {
        definition: refinedRow.definition,
        synonyms: JSON.parse(refinedRow.synonyms || '[]'),
        antonyms: JSON.parse(refinedRow.antonyms || '[]'),
        model: refinedRow.model || undefined,
      }
    : undefined;

  const shown = head === word ? word : `${word} → ${head}`;
  if (refined) kbLog(C.green, 'HAVE·ai', shown, refined.definition);
  else kbLog(C.yellow, 'HAVE·raw', shown, 'not refined yet');

  res.json({
    entry: {
      id: entry.id,
      lang: entry.lang,
      word, // what was asked for — the client keys its cache by it
      lemma: entry.word, // where the meaning came from (equal to `word` for a lemma)
      pos: JSON.parse(entry.pos || '[]'),
      inflections,
      formOf: inflected || undefined,
      family: forms || undefined,
      refined,
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
