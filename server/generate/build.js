// Build-and-store pipeline (read-through, lazy-then-batch): turn a list of words
// into stored, AI-refined entries. Each word is processed once — the refined row
// is written to the KB and every later /define serves it prebuilt, with zero
// further LLM cost. Re-runs skip words already refined (unless force is set).
//
// Refinement reads the raw Kaikki data the KB already holds and condenses it into
// one simple-English definition (see generate/ollama.js); it does not touch the
// raw senses/inflections, so it is safe to re-run with a better model later.

import { normalize } from '../../src/normalize.js';
import { formOf } from '../lemma.js';
import { refineEntry, REFINE_MODEL } from './ollama.js';

// Pull the raw data the refiner needs for one entry, or null if the word is not
// in the KB at all (a true miss — nothing to refine from yet).
function readRaw(db, lang, word) {
  const id = `${lang}:${word}`;
  const entry = db.prepare('SELECT pos FROM entries WHERE id = ?').get(id);
  if (!entry) return null;
  const senses = db
    .prepare('SELECT id, definition FROM senses WHERE entry_id = ? ORDER BY ord')
    .all(id);
  const relStmt = db.prepare('SELECT to_word, type FROM relations WHERE from_sense = ?');
  const synonyms = new Set();
  const antonyms = new Set();
  for (const s of senses) {
    for (const r of relStmt.all(s.id)) {
      (r.type === 'antonym' ? antonyms : synonyms).add(r.to_word);
    }
  }
  return {
    pos: JSON.parse(entry.pos || '[]'),
    // Cap the source definitions fed to the model — a few are enough to pick a sense.
    definitions: senses.slice(0, 8).map((s) => s.definition),
    synonyms: [...synonyms].slice(0, 20),
    antonyms: [...antonyms].slice(0, 20),
    // "came" → { lemma: "come", tags: ["past", ...] } so the prompt keeps the link.
    formOf: formOf(db, lang, word),
  };
}

/**
 * Refine and store a list of words.
 * @param {object} opts
 * @param {import('better-sqlite3').Database} opts.db
 * @param {string} opts.lang
 * @param {string[]} opts.words surface or normalized words (deduped internally)
 * @param {boolean} [opts.force] re-refine even if a refined row already exists
 * @param {string} [opts.model] Ollama model to refine with (default REFINE_MODEL)
 * @param {(word: string) => void} [opts.onStart] called just before a word's slow LLM build
 * @param {(r: { word: string, status: string, definition?: string }) => void} [opts.onResult]
 * @returns {Promise<{ word: string, status: string, definition?: string }[]>}
 */
export async function refineWords({ db, lang, words, force = false, model = REFINE_MODEL, onStart, onResult }) {
  const hasRefined = db.prepare('SELECT 1 FROM refined WHERE entry_id = ?');
  const upsertRefined = db.prepare(`
    INSERT INTO refined (entry_id, definition, synonyms, antonyms, model, generated_at)
    VALUES (@id, @definition, @synonyms, @antonyms, @model, @at)
    ON CONFLICT(entry_id) DO UPDATE SET
      definition = excluded.definition, synonyms = excluded.synonyms,
      antonyms = excluded.antonyms, model = excluded.model, generated_at = excluded.generated_at
  `);
  const stampProv = db.prepare(`
    INSERT INTO provenance (entry_id, field_path, source, source_name, generated_at, locked)
    VALUES (?, 'refined.definition', 'ai', ?, ?, 0)
    ON CONFLICT(entry_id, field_path) DO UPDATE SET
      source = 'ai', source_name = excluded.source_name, generated_at = excluded.generated_at
    WHERE provenance.locked = 0
  `);

  const seen = new Set();
  const results = [];
  for (const surface of words) {
    const word = normalize(surface);
    if (!word || seen.has(word)) continue;
    seen.add(word);
    const id = `${lang}:${word}`;

    if (!force && hasRefined.get(id)) {
      const r = { word, status: 'skipped' };
      results.push(r); onResult?.(r);
      continue;
    }
    const raw = readRaw(db, lang, word);
    if (!raw) {
      const r = { word, status: 'absent' }; // not in KB — a true miss (future LLM-from-scratch)
      results.push(r); onResult?.(r);
      continue;
    }
    onStart?.(word);
    const refined = await refineEntry({ word, ...raw }, model);
    if (!refined) {
      const r = { word, status: 'failed' };
      results.push(r); onResult?.(r);
      continue;
    }
    const at = Date.now();
    db.transaction(() => {
      upsertRefined.run({
        id,
        definition: refined.definition,
        synonyms: JSON.stringify(refined.synonyms),
        antonyms: JSON.stringify(refined.antonyms),
        model,
        at,
      });
      stampProv.run(id, model, at);
    })();
    const r = { word, status: 'refined', definition: refined.definition };
    results.push(r); onResult?.(r);
  }
  return results;
}
