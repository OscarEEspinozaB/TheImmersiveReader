// Build-and-store pipeline (read-through, lazy-then-batch): turn a list of words
// into stored, AI-refined entries. Each word is processed once — the refined row
// is written to the KB and every later /define serves it prebuilt, with zero
// further LLM cost. Re-runs skip words already refined (unless force is set).
//
// Refinement reads the raw Kaikki data the KB already holds and condenses it into
// one simple-English definition (see generate/ollama.js); it does not touch the
// raw senses/inflections, so it is safe to re-run with a better model later.
//
// A word the dump never had is not a dead end any more: it is fetched from a public
// dictionary first (generate/gapfill.js) and stored, then refined. That is also how
// languages with no dump here (es/fr/it/pt) get a KB at all — those are SEEDED and
// never refined, because their definitions already arrive in their own language.
//
// REFINED ENTRIES ARE KEYED BY LEMMA. Asking to build "aimed" builds "aim": an
// inflected form is not a word of its own, it is a form of one, and /define serves
// it the lemma's entry under a banner ("Past tense of aim"). Refining each form
// separately produced five mediocre definitions where one good one was needed —
// the synonyms of "aimed" (shot, hit, struck) were visibly worse than those of
// "aim" — and multiplied the LLM cost by the size of the paradigm.

import { normalize } from '../../src/normalize.js';
import { formOf } from '../lemma.js';
import { gapFill, isRefinedLanguage } from './gapfill.js';
import { refineEntry, REFINE_MODEL, REFINE_REV } from './ollama.js';

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
  };
}

/**
 * The entry a word's meaning lives under: itself, or its lemma when it is an
 * inflected form. The one place that decides "what do we actually refine".
 * @returns {string} normalized lemma
 */
export function refineTarget(db, lang, word) {
  return formOf(db, lang, word)?.lemma || word;
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
  const hasRefined = db.prepare('SELECT 1 FROM refined WHERE entry_id = ? AND rev >= ?');
  const upsertRefined = db.prepare(`
    INSERT INTO refined (entry_id, definition, synonyms, antonyms, model, rev, generated_at)
    VALUES (@id, @definition, @synonyms, @antonyms, @model, @rev, @at)
    ON CONFLICT(entry_id) DO UPDATE SET
      definition = excluded.definition, synonyms = excluded.synonyms,
      antonyms = excluded.antonyms, model = excluded.model, rev = excluded.rev,
      generated_at = excluded.generated_at
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
    const asked = normalize(surface);
    if (!asked) continue;
    // "aimed" and "aiming" both resolve to "aim": one build, one entry, one good
    // definition — and the dedupe below then skips the rest of the paradigm.
    const word = refineTarget(db, lang, asked);
    if (seen.has(word)) continue;
    seen.add(word);
    const id = `${lang}:${word}`;

    if (!force && hasRefined.get(id, REFINE_REV)) {
      const r = { word, status: 'skipped' };
      results.push(r); onResult?.(r);
      continue;
    }
    let raw = readRaw(db, lang, word);
    if (!raw) {
      // Not in the offline dump. Before giving up, ask a public dictionary and
      // store what it says (generate/gapfill.js): this is what fills the English
      // dump's holes ("Quidditch") and what seeds a language that has no dump here
      // at all (es/fr/it/pt read their OWN Wiktionary edition, so the definition
      // comes back in that language). A language with no validated source stays
      // absent rather than storing something wrong.
      // A word already on the miss list costs nothing here — it is skipped without
      // a network call. `force` is the way to make it try the sources again.
      if (await gapFill(db, lang, word, { retry: force })) raw = readRaw(db, lang, word);
    }
    if (!raw) {
      const r = { word, status: 'absent' }; // a true miss — nothing anywhere
      results.push(r); onResult?.(r);
      continue;
    }

    // Refinement rewrites an entry into simple ENGLISH, so it only speaks for
    // English books. A seeded Spanish/French entry is already a clean definition
    // in its own language — serving it raw is the right answer, and running the
    // English refiner over it would replace it with a translation.
    if (!isRefinedLanguage(lang)) {
      const r = { word, status: 'seeded' };
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
        rev: REFINE_REV,
        at,
      });
      stampProv.run(id, model, at);
    })();
    const r = { word, status: 'refined', definition: refined.definition };
    results.push(r); onResult?.(r);
  }
  return results;
}
