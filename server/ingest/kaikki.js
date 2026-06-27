// Kaikki.org / Wiktextract JSONL ingester.
//
// The dump is one JSON object per line, each describing one word + part-of-speech
// (so "run" appears as separate verb/noun lines). We read it line by line with a
// readline stream — it is large and must never be loaded whole into memory.
//
// Per object we populate, deterministically and with zero LLM:
//   entries      one row per `${lang}:${normalize(word)}` (POS merged across lines)
//   senses       one row per gloss
//   inflections  verb-tense forms from forms[] (past / past participle / …)
//   relations    synonyms + antonyms (top-level + per-sense), as a relation graph
//
// Provenance for everything here is "offline-dataset" — stamped in a later pass /
// milestone; this milestone just seeds the linguistic data.

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { normalize } from '../../src/normalize.js';
import { KB_SCHEMA_VERSION } from '../db.js';

// Map a Wiktextract form's tag set to one canonical verb-tense label, or null if
// the form isn't a tense we surface. Wiktextract splits tags into arrays like
// ["past"], ["past","participle"], ["present","participle"], ["third-person",
// "singular","present"].
function tenseLabel(tags = []) {
  const t = new Set(tags);
  if (t.has('past') && t.has('participle')) return 'past participle';
  if (t.has('present') && t.has('participle')) return 'present participle';
  if (t.has('past')) return 'past';
  if (t.has('third-person') && t.has('singular')) return 'third-person singular';
  return null;
}

/**
 * Ingest a Wiktextract JSONL dump into the KB.
 * @param {object} opts
 * @param {string} opts.lang ISO code stored on every entry (e.g. "en")
 * @param {string} opts.file absolute path to the .jsonl dump
 * @param {import('better-sqlite3').Database} opts.db open KB connection
 * @param {(n: number) => void} [opts.onProgress] called every N lines with lines read
 * @returns {Promise<{ lines: number, entries: number, senses: number, inflections: number, relations: number }>}
 */
export async function ingestKaikki({ lang, file, db, onProgress }) {
  // Prepared statements (better-sqlite3 is synchronous).
  const upsertEntry = db.prepare(`
    INSERT INTO entries (id, lang, word, pos, schema_version) VALUES (@id, @lang, @word, @pos, @sv)
    ON CONFLICT(id) DO UPDATE SET pos = (
      SELECT json_group_array(DISTINCT value) FROM (
        SELECT value FROM json_each(entries.pos)
        UNION SELECT value FROM json_each(excluded.pos)
      )
    )
  `);
  const senseOrd = db.prepare('SELECT COALESCE(MAX(ord), -1) + 1 AS next FROM senses WHERE entry_id = ?');
  const insertSense = db.prepare('INSERT OR IGNORE INTO senses (entry_id, definition, example, ord) VALUES (?, ?, ?, ?)');
  const getSenseId = db.prepare('SELECT id FROM senses WHERE entry_id = ? AND definition = ?');
  const insertInflection = db.prepare('INSERT OR IGNORE INTO inflections (entry_id, tag, form) VALUES (?, ?, ?)');
  const insertRelation = db.prepare('INSERT OR IGNORE INTO relations (from_sense, to_word, type) VALUES (?, ?, ?)');

  const stats = { lines: 0, entries: 0, senses: 0, inflections: 0, relations: 0 };

  // One object → its DB rows. Wrapped per-object in a transaction by the caller's
  // batching below.
  const ingestObject = (obj) => {
    const surface = obj?.word;
    if (typeof surface !== 'string') return;
    if (/\s/.test(surface)) return; // skip multi-word phrases — reader tokenizes single words
    const word = normalize(surface);
    if (!word) return;
    const id = `${lang}:${word}`;

    upsertEntry.run({
      id, lang, word,
      pos: JSON.stringify(obj.pos ? [obj.pos] : []),
      sv: KB_SCHEMA_VERSION,
    });

    // Inflections (verb tenses) from forms[].
    for (const f of obj.forms || []) {
      const label = tenseLabel(f.tags);
      if (!label || typeof f.form !== 'string' || /\s/.test(f.form)) continue;
      const form = normalize(f.form);
      if (!form) continue; // skip placeholder forms like "-" that normalize to ""
      const r = insertInflection.run(id, label, form);
      if (r.changes) stats.inflections += 1;
    }

    // Attach a word↔word relation list ([{word}], synonyms or antonyms) to a sense,
    // normalizing each target and skipping multi-word phrases.
    const addRelations = (senseId, list, type) => {
      for (const rel of list || []) {
        const to = rel?.word && normalize(rel.word);
        if (to && !/\s/.test(to)) {
          const r = insertRelation.run(senseId, to, type);
          if (r.changes) stats.relations += 1;
        }
      }
    };

    // Senses → rows; collect synonym/antonym graphs (per-sense + top-level on the
    // first sense). Identical glosses repeated across the dump's split entries are
    // deduped by the unique index — INSERT OR IGNORE leaves the existing row, whose
    // id we look up so a repeat's relations still attach to it.
    let firstSenseId = null;
    let ord = senseOrd.get(id).next;
    for (const s of obj.senses || []) {
      const gloss = Array.isArray(s.glosses) ? s.glosses[0] : null;
      if (!gloss) continue;
      const info = insertSense.run(id, gloss, null, ord);
      let senseId;
      if (info.changes) {
        senseId = info.lastInsertRowid;
        ord += 1;
        stats.senses += 1;
      } else {
        senseId = getSenseId.get(id, gloss).id; // duplicate gloss — reuse existing
      }
      if (firstSenseId === null) firstSenseId = senseId;
      addRelations(senseId, s.synonyms, 'synonym');
      addRelations(senseId, s.antonyms, 'antonym');
    }
    // Top-level synonyms/antonyms attach to the entry's first sense, if any.
    if (firstSenseId !== null) {
      addRelations(firstSenseId, obj.synonyms, 'synonym');
      addRelations(firstSenseId, obj.antonyms, 'antonym');
    }
  };

  const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });

  // Commit in batches for speed; a transaction per line would be far slower.
  const BATCH = 2000;
  let batch = [];
  const flush = db.transaction((objs) => objs.forEach(ingestObject));

  for await (const line of rl) {
    if (!line) continue;
    stats.lines += 1;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue; // tolerate a stray malformed line
    }
    batch.push(obj);
    if (batch.length >= BATCH) {
      flush(batch);
      batch = [];
      onProgress?.(stats.lines);
    }
  }
  if (batch.length) flush(batch);
  onProgress?.(stats.lines);
  // `entries` reflects upserts (insert OR update), so report the true row count.
  stats.entries = db.prepare('SELECT COUNT(*) AS c FROM entries WHERE lang = ?').get(lang).c;
  return stats;
}
